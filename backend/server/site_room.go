package server

import (
	"encoding/json"
	"math"
	"net/http"
	"slices"
	"sync"
	"time"

	"github.com/navidrome/navidrome/model/id"
	"github.com/navidrome/navidrome/model/request"
)

type roomEntry struct {
	ID        string  `json:"id"`
	SongID    string  `json:"songId"`
	Name      string  `json:"name"`
	Artist    string  `json:"artist"`
	ArtistID  string  `json:"artistId"`
	AlbumID   string  `json:"albumId"`
	AddedBy   string  `json:"addedBy"`
	Duration  float64 `json:"duration"`
	LibraryID int     `json:"-"`
}
type roomDevice struct {
	UserID string
	Name   string
	Seen   time.Time
}
type roomState struct {
	sync.Mutex
	Queue     []roomEntry           `json:"queue"`
	Index     int                   `json:"index"`
	Playing   bool                  `json:"playing"`
	Position  float64               `json:"position"`
	UpdatedAt int64                 `json:"updatedAt"`
	Version   int64                 `json:"version"`
	Session   string                `json:"session"`
	Devices   map[string]roomDevice `json:"-"`
}

var listeningRoom = roomState{Queue: []roomEntry{}, Devices: map[string]roomDevice{}, UpdatedAt: time.Now().UnixMilli(), Session: id.NewRandom()}

func (room *roomState) advance() {
	now := time.Now()
	for device, member := range room.Devices {
		if now.Sub(member.Seen) > 30*time.Second {
			delete(room.Devices, device)
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
	if len(room.Devices) == 0 && room.Playing {
		room.Playing = false
		room.Version++
	}
	room.UpdatedAt = now.UnixMilli()
}

func (s *Server) canHearRoom(r *http.Request) bool {
	user, _ := request.UserFrom(r.Context())
	for _, entry := range listeningRoom.Queue {
		if !user.HasLibraryAccess(entry.LibraryID) {
			return false
		}
	}
	return true
}

func roomSnapshot(w http.ResponseWriter, userID, device string) {
	room := &listeningRoom
	members := map[string]map[string]any{}
	for _, member := range room.Devices {
		if existing, ok := members[member.UserID]; ok {
			existing["devices"] = existing["devices"].(int) + 1
		} else {
			members[member.UserID] = map[string]any{"id": member.UserID, "name": member.Name, "devices": 1}
		}
	}
	member, joined := room.Devices[device]
	_ = json.NewEncoder(w).Encode(map[string]any{"queue": room.Queue, "index": room.Index, "playing": room.Playing, "position": room.Position, "updatedAt": room.UpdatedAt, "serverTime": time.Now().UnixMilli(), "version": room.Version, "session": room.Session, "joined": joined && member.UserID == userID, "members": members})
}

func (s *Server) getRoom(w http.ResponseWriter, r *http.Request) {
	room := &listeningRoom
	room.Lock()
	defer room.Unlock()
	room.advance()
	if !s.canHearRoom(r) {
		siteError(w, 403, "房间包含无权访问的曲目")
		return
	}
	u, _ := request.UserFrom(r.Context())
	device := r.URL.Query().Get("device")
	if member, ok := room.Devices[device]; ok && member.UserID == u.ID {
		member.Seen = time.Now()
		room.Devices[device] = member
	}
	roomSnapshot(w, u.ID, device)
}

func (s *Server) changeRoom(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Action   string   `json:"action"`
		Device   string   `json:"device"`
		Session  string   `json:"session"`
		SongIDs  []string `json:"songIds"`
		EntryID  string   `json:"entryId"`
		Order    []string `json:"order"`
		Position float64  `json:"position"`
		Version  *int64   `json:"version"`
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
		if !s.canHearRoom(r) {
			siteError(w, 403, "房间包含无权访问的曲目")
			return
		}
		if !joined {
			member = roomDevice{UserID: u.ID, Name: u.Name}
		}
		member.Seen = now
		room.Devices[input.Device] = member
		roomSnapshot(w, u.ID, input.Device)
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
	if !s.canHearRoom(r) {
		siteError(w, 403, "房间包含无权访问的曲目")
		return
	}
	if input.Session != room.Session || (input.Action == "reorder" && input.Version == nil) || (input.Version != nil && *input.Version != room.Version) {
		w.WriteHeader(http.StatusConflict)
		roomSnapshot(w, u.ID, input.Device)
		return
	}
	if input.Action == "add" || input.Action == "addNext" {
		if len(input.SongIDs) < 1 || len(input.SongIDs) > 100 || len(room.Queue)+len(input.SongIDs) > 1000 {
			siteError(w, 400, "队列数量超出限制")
			return
		}
		entries := []roomEntry{}
		for _, songID := range input.SongIDs {
			song, err := s.ds.MediaFile(r.Context()).Get(songID)
			if err != nil || song.Duration <= 0 || !u.HasLibraryAccess(song.LibraryID) {
				siteError(w, 404, "曲目不可访问")
				return
			}
			for _, peer := range room.Devices {
				user, e := s.ds.User(r.Context()).Get(peer.UserID)
				if e != nil || !user.HasLibraryAccess(song.LibraryID) {
					siteError(w, 403, "房间成员无法访问该曲目")
					return
				}
			}
			entries = append(entries, roomEntry{ID: id.NewRandom(), SongID: songID, Name: song.Title, Artist: song.Artist, ArtistID: song.ArtistID, AlbumID: song.AlbumID, AddedBy: u.Name, Duration: float64(song.Duration), LibraryID: song.LibraryID})
		}
		if input.Action == "addNext" && len(room.Queue) > 0 {
			room.Queue = slices.Insert(room.Queue, room.Index+1, entries...)
		} else {
			room.Queue = append(room.Queue, entries...)
		}
		room.Version++
		roomSnapshot(w, u.ID, input.Device)
		return
	}
	switch input.Action {
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
		if len(room.Queue) == 0 || room.Queue[room.Index].ID != input.EntryID || math.IsNaN(input.Position) || math.IsInf(input.Position, 0) || input.Position < 0 || input.Position > room.Queue[room.Index].Duration {
			siteError(w, 400, "进度无效")
			return
		}
		room.Position = input.Position
	case "select":
		index := slices.IndexFunc(room.Queue, func(entry roomEntry) bool { return entry.ID == input.EntryID })
		if index < 0 {
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
	roomSnapshot(w, u.ID, input.Device)
}
