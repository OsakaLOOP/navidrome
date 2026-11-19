package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/navidrome/navidrome/db"
	"github.com/navidrome/navidrome/model"
	"github.com/navidrome/navidrome/model/request"
	_ "golang.org/x/image/webp"
)

const siteAvatarLimit = 3 << 20
const siteFriendJoin = `LEFT JOIN site_friend f ON f.first_id=min(u.id,viewer.id) AND f.second_id=max(u.id,viewer.id)`
const siteName = `COALESCE(NULLIF(p.nickname,''),NULLIF(u.name,''),u.user_name)`
const sitePersonColumns = `u.id,` + siteName + `,COALESCE(p.bio,''),COALESCE(p.avatar_version,0),
    CASE WHEN u.id=viewer.id THEN 'self' WHEN f.accepted=1 THEN 'friend'
         WHEN f.requester=viewer.id THEN 'outgoing' WHEN f.requester=u.id THEN 'incoming' ELSE 'none' END,
    COALESCE(privacy.online_count,0)`

type sitePerson struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Bio           string `json:"bio"`
	AvatarVersion int64  `json:"avatarVersion"`
	Friendship    string `json:"friendship"`
	Status        string `json:"status"`
	Track         string `json:"track,omitempty"`
	Duration      int    `json:"duration,omitempty"`
	showPresence  bool
}

func (person *sitePerson) columns() []any {
	return []any{&person.ID, &person.Name, &person.Bio, &person.AvatarVersion, &person.Friendship, &person.showPresence}
}

const sitePeopleFrom = ` FROM user u CROSS JOIN viewer
    LEFT JOIN site_profile p ON p.user_id=u.id LEFT JOIN site_privacy privacy ON privacy.user_id=u.id ` + siteFriendJoin

func siteDisplayName(ctx context.Context, user model.User) (string, int64) {
	name := user.Name
	if name == "" {
		name = user.UserName
	}
	var avatar int64
	_ = db.Db().QueryRowContext(ctx, `SELECT COALESCE(NULLIF(nickname,''),?),avatar_version FROM site_profile WHERE user_id=?`, name, user.ID).Scan(&name, &avatar)
	return name, avatar
}

func (person *sitePerson) setPresence(viewer model.User, room *roomState, joined map[string]bool) {
	person.Status = "hidden"
	if !person.showPresence && person.ID != viewer.ID {
		return
	}
	person.Status = "offline"
	if joined[person.ID] {
		person.Status = "together"
		if room.Index >= 0 && room.Index < len(room.Queue) {
			track := room.Queue[room.Index]
			if viewer.HasLibraryAccess(track.LibraryID) {
				person.Track, person.Duration = track.Name, int(track.Duration)
			}
		}
	} else if !room.Online[person.ID].IsZero() || person.ID == viewer.ID {
		person.Status = "online"
	}
}

func sitePresence(viewer model.User, people []sitePerson) {
	room := &listeningRoom
	room.Lock()
	defer room.Unlock()
	room.advance()
	joined := make(map[string]bool)
	for _, device := range room.Devices {
		if time.Since(device.Seen) <= 15*time.Second {
			joined[device.UserID] = true
		}
	}
	for index := range people {
		people[index].setPresence(viewer, room, joined)
	}
}

func (s *Server) siteUsers(w http.ResponseWriter, r *http.Request) {
	viewer, _ := request.UserFrom(r.Context())
	term := strings.TrimSpace(r.URL.Query().Get("q"))
	if utf8.RuneCountInString(term) > 80 {
		siteError(w, 400, "搜索词过长")
		return
	}
	offset := siteOffset(r)
	people := []sitePerson{}
	group := r.URL.Query().Get("group")
	rows, err := db.Db().QueryContext(r.Context(), `WITH viewer(id) AS (VALUES (?)) SELECT `+sitePersonColumns+sitePeopleFrom+`
        WHERE instr(lower(`+siteName+`),lower(?))>0 AND (NOT ? OR f.accepted=1 OR f.requester=u.id)
        AND CASE ? WHEN 'requests' THEN f.accepted=0
                   WHEN 'friends' THEN f.accepted=1
                   WHEN 'others' THEN f.requester IS NULL
                   ELSE 1 END
        ORDER BY CASE WHEN f.requester=u.id AND NOT f.accepted THEN 0 ELSE 1 END, `+siteName+` COLLATE NOCASE,u.id LIMIT 31 OFFSET ?`,
		viewer.ID, term, r.URL.Query().Get("friends") == "1", group, offset)
	if err != nil {
		siteError(w, 500, "读取用户失败")
		return
	}
	for rows.Next() {
		var person sitePerson
		if err = rows.Scan(person.columns()...); err != nil {
			break
		}
		people = append(people, person)
	}
	rows.Close()
	if err != nil || rows.Err() != nil {
		siteError(w, 500, "读取用户失败")
		return
	}
	var next *int
	if len(people) == 31 {
		people, next = people[:30], new(offset+30)
	}
	sitePresence(viewer, people)
	_ = json.NewEncoder(w).Encode(map[string]any{"users": people, "next": next})
}

func siteOffset(r *http.Request) int {
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	return max(0, offset)
}

func (s *Server) saveSiteProfile(w http.ResponseWriter, r *http.Request) {
	viewer, _ := request.UserFrom(r.Context())
	var input struct{ Nickname, Bio string }
	r.Body = http.MaxBytesReader(w, r.Body, 12<<10)
	if json.NewDecoder(r.Body).Decode(&input) != nil {
		siteError(w, 400, "个人资料无效")
		return
	}
	nickname, bio := strings.TrimSpace(input.Nickname), strings.TrimSpace(input.Bio)
	if utf8.RuneCountInString(nickname) > 40 || utf8.RuneCountInString(bio) > 500 || strings.ContainsAny(nickname, "\r\n\t") {
		siteError(w, 400, "昵称最多 40 字，简介最多 500 字")
		return
	}
	if _, err := db.Db().ExecContext(r.Context(), `INSERT INTO site_profile(user_id,nickname,bio) VALUES(?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET nickname=excluded.nickname,bio=excluded.bio`, viewer.ID, nickname, bio); err != nil {
		siteError(w, 500, "保存个人资料失败")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) saveSiteAvatar(w http.ResponseWriter, r *http.Request) {
	viewer, _ := request.UserFrom(r.Context())
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, siteAvatarLimit))
	if err != nil {
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			siteError(w, 413, "头像最大为 3 MiB")
			return
		}
		siteError(w, 400, "无法读取头像")
		return
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width <= 0 || config.Height <= 0 || config.Width > 4096 || config.Height > 4096 {
		siteError(w, 400, "请使用尺寸不超过 4096 × 4096 的 JPEG、PNG、GIF 或 WebP 图片")
		return
	}
	if _, err = db.Db().ExecContext(r.Context(), `INSERT INTO site_profile(user_id,avatar,avatar_type,avatar_version) VALUES(?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET avatar=excluded.avatar,avatar_type=excluded.avatar_type,avatar_version=excluded.avatar_version`,
		viewer.ID, data, "image/"+format, time.Now().UnixMilli()); err != nil {
		siteError(w, 500, "保存头像失败")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) deleteSiteAvatar(w http.ResponseWriter, r *http.Request) {
	viewer, _ := request.UserFrom(r.Context())
	if _, err := db.Db().ExecContext(r.Context(), `UPDATE site_profile SET avatar=NULL,avatar_type='',avatar_version=0 WHERE user_id=?`, viewer.ID); err != nil {
		siteError(w, 500, "删除头像失败")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) siteAvatar(w http.ResponseWriter, r *http.Request) {
	var data []byte
	var mediaType string
	if err := db.Db().QueryRowContext(r.Context(), `SELECT avatar,avatar_type FROM site_profile WHERE user_id=? AND avatar IS NOT NULL`, chi.URLParam(r, "userId")).Scan(&data, &mediaType); err != nil {
		siteError(w, 404, "头像不存在")
		return
	}
	w.Header().Set("Content-Type", mediaType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(data)
}

func (s *Server) addSiteFriend(w http.ResponseWriter, r *http.Request) {
	viewer, _ := request.UserFrom(r.Context())
	target := chi.URLParam(r, "userId")
	if target == viewer.ID {
		siteError(w, 400, "请选择其他用户")
		return
	}
	result, err := db.Db().ExecContext(r.Context(), `INSERT INTO site_friend(first_id,second_id,requester)
        SELECT min(?,id),max(?,id),? FROM user WHERE id=?
        ON CONFLICT(first_id,second_id) DO UPDATE SET accepted=site_friend.accepted OR site_friend.requester<>excluded.requester`,
		viewer.ID, viewer.ID, viewer.ID, target)
	if err != nil {
		siteError(w, 500, "更新好友关系失败")
		return
	}
	if count, _ := result.RowsAffected(); count == 0 {
		siteError(w, 404, "用户不存在")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) removeSiteFriend(w http.ResponseWriter, r *http.Request) {
	viewer, _ := request.UserFrom(r.Context())
	target := chi.URLParam(r, "userId")
	if _, err := db.Db().ExecContext(r.Context(), `DELETE FROM site_friend WHERE first_id=? AND second_id=?`, min(viewer.ID, target), max(viewer.ID, target)); err != nil {
		siteError(w, 500, "更新好友关系失败")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

const siteMediaJoins = ` LEFT JOIN media_file m ON m.id=e.item_id AND e.item_type IN ('media_file','song')
    LEFT JOIN album b ON b.id=e.item_id AND e.item_type='album'
    LEFT JOIN artist t ON t.id=e.item_id AND e.item_type='artist' `
const siteMediaVisible = `(COALESCE(m.title,b.name,t.name) IS NOT NULL AND (viewer.admin OR EXISTS(
    SELECT 1 FROM user_library access WHERE access.user_id=viewer.id AND
      (access.library_id=m.library_id OR access.library_id=b.library_id OR EXISTS(
        SELECT 1 FROM library_artist lt WHERE lt.artist_id=t.id AND lt.library_id=access.library_id)))))`

func siteDate(seconds int64) time.Time { return time.Unix(seconds, 0).UTC() }

func (s *Server) siteHistory(w http.ResponseWriter, r *http.Request) {
	viewer, _ := request.UserFrom(r.Context())
	target := chi.URLParam(r, "userId")
	var visible bool
	err := db.Db().QueryRowContext(r.Context(), `WITH viewer(id) AS (VALUES (?))
        SELECT u.id=viewer.id OR COALESCE(privacy.history='public' OR (privacy.history='friends' AND f.accepted=1),0)`+sitePeopleFrom+` WHERE u.id=?`, viewer.ID, target).Scan(&visible)
	if errors.Is(err, sql.ErrNoRows) {
		siteError(w, 404, "用户不存在")
		return
	}
	if err != nil {
		siteError(w, 500, "读取播放记录失败")
		return
	}
	entries := []map[string]any{}
	var next *int
	if visible {
		offset := siteOffset(r)
		rows, err := db.Db().QueryContext(r.Context(), `WITH viewer(id,admin) AS (VALUES (?,?))
            SELECT e.id,m.id,m.title,m.artist,e.submission_time FROM
            (SELECT id,media_file_id AS item_id,'song' AS item_type,submission_time,user_id FROM scrobbles WHERE user_id=?) e
            CROSS JOIN viewer JOIN user u ON u.id=e.user_id `+siteFriendJoin+`
            LEFT JOIN site_privacy privacy ON privacy.user_id=u.id `+siteMediaJoins+` WHERE `+siteMediaVisible+`
            AND (u.id=viewer.id OR privacy.history='public' OR (privacy.history='friends' AND f.accepted=1))
            ORDER BY e.submission_time DESC,e.id DESC LIMIT 31 OFFSET ?`, viewer.ID, viewer.IsAdmin, target, offset)
		if err != nil {
			siteError(w, 500, "读取播放记录失败")
			return
		}
		defer rows.Close()
		for rows.Next() {
			var id, timestamp int64
			var songID, title, artist string
			if rows.Scan(&id, &songID, &title, &artist, &timestamp) != nil {
				siteError(w, 500, "读取播放记录失败")
				return
			}
			entries = append(entries, map[string]any{"id": id, "songId": songID, "title": title, "artist": artist, "at": siteDate(timestamp)})
		}
		if rows.Err() != nil {
			siteError(w, 500, "读取播放记录失败")
			return
		}
		if len(entries) == 31 {
			entries, next = entries[:30], new(offset+30)
		}
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"canView": visible, "entries": entries, "next": next})
}

func siteTimelineQuery(ctx context.Context, viewer model.User, filter, userID string, friends bool, before int64, key string) (*sql.Rows, error) {
	return db.Db().QueryContext(ctx, `WITH viewer(id,admin) AS (VALUES (?,?)),
        events(key,kind,user_id,item_type,item_id,comment_id,body,value,at) AS (
            SELECT printf('c%020d',c.id),CASE WHEN c.parent_id IS NOT NULL THEN 'reply' WHEN c.kind='thought' THEN 'thought' ELSE 'comment' END,
                c.user_id,c.kind,c.item_id,c.id,c.body,0,unixepoch(c.created_at)
            FROM site_comment c WHERE c.deleted=0
            UNION ALL SELECT printf('l%020d',l.rowid),'like',l.user_id,c.kind,c.item_id,c.id,c.body,0,unixepoch(l.created_at)
            FROM site_comment_like l JOIN site_comment c ON c.id=l.comment_id WHERE c.deleted=0 AND l.created_at IS NOT NULL
            UNION ALL SELECT printf('a%020d',a.id),a.kind,a.user_id,a.item_type,a.item_id,NULL,'',a.value,a.occurred_at FROM site_activity a
        ) SELECT e.key,e.kind,u.id,`+siteName+`,COALESCE(p.avatar_version,0),
            CASE WHEN e.item_type='media_file' THEN 'song' ELSE e.item_type END,e.item_id,COALESCE(m.title,b.name,t.name,''),
            COALESCE(m.artist,''),CASE WHEN m.id IS NOT NULL THEN 'mf-'||m.id WHEN b.id IS NOT NULL THEN 'al-'||b.id WHEN t.id IS NOT NULL THEN 'ar-'||t.id ELSE '' END,
            e.comment_id,substr(e.body,1,400),e.value,e.at
        FROM events e CROSS JOIN viewer JOIN user u ON u.id=e.user_id
        LEFT JOIN site_profile p ON p.user_id=u.id LEFT JOIN site_privacy privacy ON privacy.user_id=u.id `+siteFriendJoin+siteMediaJoins+`
        WHERE (e.item_type='thought' OR `+siteMediaVisible+`)
          AND (?='' OR u.id=?) AND (NOT ? OR f.accepted=1)
          AND (?='' OR e.kind=? OR (?='interaction' AND e.kind IN ('reply','like')))
          AND (u.id=viewer.id OR CASE e.kind
              WHEN 'favorite' THEN privacy.favorites='public'
              WHEN 'rating' THEN privacy.ratings='public' OR (privacy.ratings='friends' AND f.accepted=1)
              WHEN 'milestone' THEN privacy.history='public' OR (privacy.history='friends' AND f.accepted=1)
              ELSE 1 END)
          AND (?=0 OR (e.at,e.key)<(?,?))
        ORDER BY e.at DESC,e.key DESC LIMIT 31`, viewer.ID, viewer.IsAdmin, userID, userID, friends, filter, filter, filter, before, before, key)
}

func (s *Server) siteTimeline(w http.ResponseWriter, r *http.Request) {
	viewer, _ := request.UserFrom(r.Context())
	params := r.URL.Query()
	before, _ := strconv.ParseInt(params.Get("before"), 10, 64)
	rows, err := siteTimelineQuery(r.Context(), viewer, params.Get("kind"), params.Get("user"), params.Get("friends") == "1", before, params.Get("key"))
	if err != nil {
		siteError(w, 500, "读取时间线失败")
		return
	}
	defer rows.Close()
	events := []map[string]any{}
	var next, last map[string]any
	for rows.Next() {
		var key, kind, userID, name, itemType, itemID, title, artist, coverID, body string
		var avatar, at int64
		var comment *int64
		var value int
		if rows.Scan(&key, &kind, &userID, &name, &avatar, &itemType, &itemID, &title, &artist, &coverID, &comment, &body, &value, &at) != nil {
			siteError(w, 500, "读取时间线失败")
			return
		}
		if len(events) == 30 {
			next = last
			break
		}
		events = append(events, map[string]any{"key": key, "kind": kind, "userId": userID, "name": name, "avatarVersion": avatar,
			"itemType": itemType, "itemId": itemID, "title": title, "artist": artist, "coverId": coverID, "commentId": comment, "body": body, "value": value, "at": siteDate(at)})
		last = map[string]any{"before": at, "key": key}
	}
	if rows.Err() != nil {
		siteError(w, 500, "读取时间线失败")
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"events": events, "next": next})
}
