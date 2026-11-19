package server

import (
	"cmp"
	"context"
	"encoding/json"
	"math"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/navidrome/navidrome/db"
	"github.com/navidrome/navidrome/model"
	"github.com/navidrome/navidrome/model/id"
	"github.com/navidrome/navidrome/model/request"
)

type roomEntry struct {
	ID          string  `json:"id"`
	SongID      string  `json:"songId"`
	Name        string  `json:"name"`
	Artist      string  `json:"artist"`
	ArtistID    string  `json:"artistId"`
	Album       string  `json:"album,omitempty"`
	AlbumID     string  `json:"albumId"`
	Year        int     `json:"year,omitempty"`
	AddedBy     string  `json:"addedBy"`
	Duration    float64 `json:"duration"`
	LibraryID   int     `json:"-"`
	Unavailable bool    `json:"unavailable,omitempty"`
}
type roomDevice struct {
	UserID        string
	Name          string
	AvatarVersion int64
	JoinedAt      time.Time
	Seen          time.Time
}

type roomMember struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Devices       int    `json:"devices"`
	JoinedAt      int64  `json:"joinedAt"`
	Online        bool   `json:"online"`
	AvatarVersion int64  `json:"avatarVersion,omitempty"`
}

// 房间广播提醒消息，随房间快照分发给在线成员与站内听友
type roomAnnouncement struct {
	ID        int64  `json:"id"`
	UserID    string `json:"userId"`
	UserName  string `json:"userName"`
	Message   string `json:"message"`
	CreatedAt int64  `json:"createdAt"`
}

type roomState struct {
	sync.Mutex
	Queue           []roomEntry           `json:"queue"`
	Index           int                   `json:"index"`
	Playing         bool                  `json:"playing"`
	Position        float64               `json:"position"`
	UpdatedAt       int64                 `json:"updatedAt"`
	Version         int64                 `json:"version"`
	Session         string                `json:"session"`
	Devices         map[string]roomDevice `json:"-"`
	Online          map[string]time.Time  `json:"-"`
	Announcement    *roomAnnouncement     `json:"-"`
	AnnouncementSeq int64                 `json:"-"`
	AnnouncedAt     map[string]time.Time  `json:"-"`
}

const sharedQueueProperty = "ndfork_shared_queue"

type savedRoomQueue struct {
	SongIDs  []string `json:"songIds"`
	Index    int      `json:"index"`
	Position float64  `json:"position"`
}

func (s *Server) roomEntries(ctx context.Context, user model.User, songIDs []string) ([]roomEntry, bool) {
	entries := make([]roomEntry, 0, len(songIDs))
	for _, songID := range songIDs {
		song, err := s.ds.MediaFile(ctx).Get(songID)
		if err != nil || song.Duration <= 0 || !user.HasLibraryAccess(song.LibraryID) {
			return nil, false
		}
		entries = append(entries, roomEntry{
			ID:        id.NewRandom(),
			SongID:    songID,
			Name:      song.Title,
			Artist:    song.Artist,
			ArtistID:  song.ArtistID,
			Album:     song.FullAlbumName(),
			AlbumID:   song.AlbumID,
			Year:      cmp.Or(song.Year, song.ReleaseYear, song.OriginalYear),
			AddedBy:   user.Name,
			Duration:  float64(song.Duration),
			LibraryID: song.LibraryID,
		})
	}
	return entries, true
}

var listeningRoom = roomState{
	Queue:       []roomEntry{},
	Devices:     map[string]roomDevice{},
	Online:      map[string]time.Time{},
	AnnouncedAt: map[string]time.Time{},
	UpdatedAt:   time.Now().UnixMilli(),
	Session:     id.NewRandom(),
}

func (room *roomState) advance() {
	now := time.Now()
	for device, member := range room.Devices {
		if now.Sub(member.Seen) > 30*time.Second {
			delete(room.Devices, device)
		}
	}
	for userID, seen := range room.Online {
		if now.Sub(seen) > 30*time.Second {
			delete(room.Online, userID)
		}
	}
	if room.Playing && len(room.Queue) > 0 {
		position := room.Position + float64(now.UnixMilli()-room.UpdatedAt)/1000
		for position >= room.Queue[room.Index].Duration {
			position -= room.Queue[room.Index].Duration
			if room.Index+1 >= len(room.Queue) {
				room.Playing = false
				position = room.Queue[room.Index].Duration
				room.Version++
				break
			}
			room.Index++
			room.Version++
		}
		room.Position = position
	}
	if len(room.Devices) == 0 {
		room.Announcement = nil
		if room.Playing {
			room.Playing = false
			room.Version++
		}
	}
	room.UpdatedAt = now.UnixMilli()
}

func roomSnapshot(w http.ResponseWriter, user model.User, device string) {
	room := &listeningRoom
	now := time.Now()
	members := make(map[string]roomMember)
	for _, member := range room.Devices {
		peer, ok := members[member.UserID]
		if !ok {
			peer = roomMember{ID: member.UserID, Name: member.Name, JoinedAt: member.JoinedAt.UnixMilli(), AvatarVersion: member.AvatarVersion}
		}
		peer.Devices++
		peer.Online = peer.Online || now.Sub(member.Seen) <= 15*time.Second
		members[member.UserID] = peer
	}
	onlineCount := len(members)
	for userID := range room.Online {
		if _, joined := members[userID]; !joined {
			onlineCount++
		}
	}
	member, joined := room.Devices[device]
	joined = joined && member.UserID == user.ID
	memberCount := len(members)
	if !joined {
		for userID := range members {
			if userID != user.ID && room.Online[userID].IsZero() {
				delete(members, userID)
			}
		}
	}
	queue := slices.Clone(room.Queue)
	for index, entry := range queue {
		if !user.HasLibraryAccess(entry.LibraryID) {
			queue[index] = roomEntry{ID: entry.ID, Duration: entry.Duration, Unavailable: true}
		}
	}
	payload := map[string]any{
		"queue":        queue,
		"index":        room.Index,
		"playing":      room.Playing,
		"position":     room.Position,
		"updatedAt":    room.UpdatedAt,
		"serverTime":   now.UnixMilli(),
		"version":      room.Version,
		"session":      room.Session,
		"joined":       joined,
		"memberCount":  memberCount,
		"members":      members,
		"onlineCount":  onlineCount,
		"announcement": room.Announcement,
	}
	_ = json.NewEncoder(w).Encode(payload)
}

func (s *Server) getRoom(w http.ResponseWriter, r *http.Request) {
	room := &listeningRoom
	room.Lock()
	defer room.Unlock()
	room.advance()
	u, _ := request.UserFrom(r.Context())
	device := r.URL.Query().Get("device")
	if member, ok := room.Devices[device]; ok && member.UserID == u.ID {
		member.Seen = time.Now()
		room.Devices[device] = member
	}
	if device == "" || room.Devices[device].UserID == u.ID {
		var included bool
		_ = db.Db().QueryRowContext(r.Context(), "SELECT online_count FROM site_privacy WHERE user_id=?", u.ID).Scan(&included)
		if included {
			room.Online[u.ID] = time.Now()
		}
	}
	roomSnapshot(w, u, device)
}

func (s *Server) changeRoom(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Action         string   `json:"action"`
		Device         string   `json:"device"`
		Session        string   `json:"session"`
		SongIDs        []string `json:"songIds"`
		SkipDuplicates bool     `json:"skipDuplicates"`
		EntryID        string   `json:"entryId"`
		Edge           string   `json:"edge"`
		PlaySongID     string   `json:"playSongId"`
		Order          []string `json:"order"`
		Position       float64  `json:"position"`
		Version        *int64   `json:"version"`
		Message        string   `json:"message"`
		Overwrite      bool     `json:"overwrite"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 32<<10)
	if json.NewDecoder(r.Body).Decode(&input) != nil || len(input.Device) < 1 || len(input.Device) > 100 {
		siteError(w, 400, "房间操作无效")
		return
	}
	room := &listeningRoom
	room.Lock()
	defer room.Unlock()
	room.advance()
	u, _ := request.UserFrom(r.Context())
	now := time.Now()
	member, joined := room.Devices[input.Device]
	if joined && member.UserID != u.ID {
		siteError(w, 409, "设备标识已使用")
		return
	}
	if input.Action == "join" {
		if !joined {
			member = roomDevice{UserID: u.ID, Name: u.Name, JoinedAt: now}
			member.Name, member.AvatarVersion = siteDisplayName(r.Context(), u)
			for _, connected := range room.Devices {
				if connected.UserID == u.ID {
					member.JoinedAt = connected.JoinedAt
					break
				}
			}
		}
		member.Seen = now
		room.Devices[input.Device] = member
		var included bool
		_ = db.Db().QueryRowContext(r.Context(), "SELECT online_count FROM site_privacy WHERE user_id=?", u.ID).Scan(&included)
		if included {
			room.Online[u.ID] = now
		}
		roomSnapshot(w, u, input.Device)
		return
	}
	if input.Action == "leave" {
		delete(room.Devices, input.Device)
		room.advance()
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if !joined {
		siteError(w, 403, "请先加入房间")
		return
	}
	member.Seen = now
	room.Devices[input.Device] = member
	if input.Session != room.Session || (input.Action == "reorder" && input.Version == nil) || (input.Version != nil && *input.Version != room.Version) {
		w.WriteHeader(http.StatusConflict)
		roomSnapshot(w, u, input.Device)
		return
	}
	if input.Action == "announce" {
		message := strings.TrimSpace(input.Message)
		if message == "" {
			siteError(w, 400, "请输入提醒内容")
			return
		}
		if utf8.RuneCountInString(message) > 120 {
			siteError(w, 400, "提醒内容最多 120 字")
			return
		}
		if room.AnnouncedAt == nil {
			room.AnnouncedAt = map[string]time.Time{}
		}
		if last, ok := room.AnnouncedAt[u.ID]; ok && now.Sub(last) < 3*time.Second {
			siteError(w, 429, "发送过于频繁，请稍后再试")
			return
		}
		room.AnnouncedAt[u.ID] = now
		room.AnnouncementSeq++
		room.Announcement = &roomAnnouncement{
			ID:        room.AnnouncementSeq,
			UserID:    u.ID,
			UserName:  u.Name,
			Message:   message,
			CreatedAt: now.UnixMilli(),
		}
		roomSnapshot(w, u, input.Device)
		return
	}
	if input.Action == "saveQueue" {
		if len(room.Queue) == 0 {
			siteError(w, 400, "共享队列为空")
			return
		}
		saved := savedRoomQueue{Index: room.Index, Position: room.Position}
		for _, entry := range room.Queue {
			saved.SongIDs = append(saved.SongIDs, entry.SongID)
		}
		data, err := json.Marshal(saved)
		if err != nil || s.ds.Property(r.Context()).Put(sharedQueueProperty, string(data)) != nil {
			siteError(w, 500, "保存共享队列失败")
			return
		}
		roomSnapshot(w, u, input.Device)
		return
	}
	if input.Action == "add" || input.Action == "addNext" || input.Action == "addNow" {
		if len(input.SongIDs) < 1 {
			siteError(w, 400, "队列数量超出限制")
			return
		}
		if input.Action == "add" && input.SkipDuplicates {
			seen := make(map[string]bool, len(room.Queue))
			for _, entry := range room.Queue {
				seen[entry.SongID] = true
			}
			input.SongIDs = slices.DeleteFunc(input.SongIDs, func(songID string) bool {
				duplicate := seen[songID]
				seen[songID] = true
				return duplicate
			})
			if len(input.SongIDs) == 0 {
				roomSnapshot(w, u, input.Device)
				return
			}
		}
		if len(room.Queue)+len(input.SongIDs) > 1000 {
			siteError(w, 400, "队列数量超出限制")
			return
		}
		entries, ok := s.roomEntries(r.Context(), u, input.SongIDs)
		if !ok {
			siteError(w, 404, "曲目不可访问")
			return
		}
		insertion := len(room.Queue)
		if len(room.Queue) > 0 && (input.Action == "addNext" || input.Action == "addNow") {
			insertion = room.Index + 1
		} else if input.EntryID != "" {
			insertion = slices.IndexFunc(room.Queue, func(entry roomEntry) bool { return entry.ID == input.EntryID })
			if insertion < 0 || (input.Edge != "top" && input.Edge != "bottom") {
				siteError(w, 400, "插入位置无效")
				return
			}
			if input.Edge == "bottom" {
				insertion++
			}
		}
		if len(room.Queue) > 0 && insertion <= room.Index {
			room.Index += len(entries)
		}
		room.Queue = slices.Insert(room.Queue, insertion, entries...)
		if input.Action == "addNow" {
			selected := slices.IndexFunc(entries, func(entry roomEntry) bool { return entry.SongID == input.PlaySongID })
			room.Index = insertion + max(0, selected)
			room.Position = 0
			room.Playing = true
		}
		room.Version++
		roomSnapshot(w, u, input.Device)
		return
	}
	if len(room.Queue) == 0 && (input.Action == "previous" || input.Action == "next" || input.Action == "pause" || input.Action == "play") {
		roomSnapshot(w, u, input.Device)
		return
	}
	switch input.Action {
	case "restoreQueue":
		if len(room.Queue) > 0 && !input.Overwrite {
			siteError(w, 409, "请先确认覆盖共享队列")
			return
		}
		data, err := s.ds.Property(r.Context()).DefaultGet(sharedQueueProperty, "")
		var saved savedRoomQueue
		if err == nil && data == "" {
			siteError(w, 404, "服务器上没有已保存的共享队列")
			return
		}
		if err != nil || json.Unmarshal([]byte(data), &saved) != nil || saved.Index < 0 || saved.Index >= len(saved.SongIDs) {
			siteError(w, 500, "读取共享队列失败")
			return
		}
		entries, ok := s.roomEntries(r.Context(), u, saved.SongIDs)
		if !ok {
			siteError(w, 403, "已保存的队列包含不可访问的曲目")
			return
		}
		room.Queue = entries
		room.Index = saved.Index
		room.Position = min(saved.Position, entries[saved.Index].Duration)
		room.Playing = false
	case "clearQueue":
		room.Queue = []roomEntry{}
		room.Index = 0
		room.Position = 0
		room.Playing = false
	case "play":
		if len(room.Queue) > 0 {
			if room.Position >= room.Queue[room.Index].Duration {
				room.Position = 0
			}
			room.Playing = true
		}
	case "pause":
		room.Playing = false
	case "seek":
		if len(room.Queue) == 0 || !u.HasLibraryAccess(room.Queue[room.Index].LibraryID) || room.Queue[room.Index].ID != input.EntryID || math.IsNaN(input.Position) || math.IsInf(input.Position, 0) || input.Position < 0 || input.Position > room.Queue[room.Index].Duration {
			siteError(w, 400, "进度无效")
			return
		}
		room.Position = input.Position
	case "select":
		index := slices.IndexFunc(room.Queue, func(entry roomEntry) bool { return entry.ID == input.EntryID })
		if index < 0 || !u.HasLibraryAccess(room.Queue[index].LibraryID) {
			siteError(w, 404, "队列项不存在")
			return
		}
		room.Index = index
		room.Position = 0
		room.Playing = true
	case "previous":
		room.Index = max(0, room.Index-1)
		room.Position = 0
	case "next":
		if room.Index+1 < len(room.Queue) {
			room.Index++
			room.Position = 0
		} else {
			room.Playing = false
			room.Position = room.Queue[room.Index].Duration
		}
	case "remove":
		index := slices.IndexFunc(room.Queue, func(entry roomEntry) bool { return entry.ID == input.EntryID })
		if index < 0 {
			siteError(w, 404, "队列项不存在")
			return
		}
		room.Queue = slices.Delete(room.Queue, index, index+1)
		if index < room.Index {
			room.Index--
		} else if index == room.Index {
			room.Position = 0
		}
		if room.Index >= len(room.Queue) {
			room.Index = max(0, len(room.Queue)-1)
			room.Playing = false
		}
	case "reorder":
		if len(input.Order) != len(room.Queue) {
			siteError(w, 400, "队列顺序无效")
			return
		}
		var current string
		if len(room.Queue) > 0 {
			current = room.Queue[room.Index].ID
		}
		ordered := []roomEntry{}
		seen := map[string]bool{}
		for _, entryID := range input.Order {
			index := slices.IndexFunc(room.Queue, func(entry roomEntry) bool { return entry.ID == entryID })
			if index < 0 || seen[entryID] {
				siteError(w, 400, "队列顺序无效")
				return
			}
			seen[entryID] = true
			ordered = append(ordered, room.Queue[index])
		}
		room.Queue = ordered
		room.Index = max(0, slices.IndexFunc(ordered, func(entry roomEntry) bool { return entry.ID == current }))
	default:
		siteError(w, 400, "房间操作无效")
		return
	}
	room.UpdatedAt = now.UnixMilli()
	room.Version++
	roomSnapshot(w, u, input.Device)
}
