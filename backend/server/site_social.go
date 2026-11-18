package server

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/navidrome/navidrome/db"
	"github.com/navidrome/navidrome/model"
	"github.com/navidrome/navidrome/model/request"
)

func (s *Server) discussion(w http.ResponseWriter, r *http.Request) {
	kind, itemID := chi.URLParam(r, "kind"), chi.URLParam(r, "id")
	if _, err := s.metadataObject(r.Context(), kind, itemID); err != nil {
		siteError(w, 404, "对象不可访问")
		return
	}
	u, _ := request.UserFrom(r.Context())
	before, _ := strconv.Atoi(r.URL.Query().Get("before"))
	if before <= 0 {
		before = int(^uint(0) >> 1)
	}
	anchor, _ := strconv.Atoi(r.URL.Query().Get("comment"))
	rows, err := db.Db().QueryContext(r.Context(), `SELECT c.id,COALESCE(c.user_id,''),COALESCE(u.name,''),c.body,c.parent_id,c.position,c.deleted,c.created_at,
        CASE WHEN c.deleted=0 THEN (SELECT COUNT(*) FROM site_comment_like l WHERE l.comment_id=c.id) ELSE 0 END,
        c.deleted=0 AND EXISTS(SELECT 1 FROM site_comment_like l WHERE l.comment_id=c.id AND l.user_id=?),
        COALESCE(pu.name,''),CASE WHEN p.deleted=0 THEN substr(p.body,1,160) ELSE '' END,COALESCE(p.deleted,1)
        FROM site_comment c LEFT JOIN user u ON u.id=c.user_id
        LEFT JOIN site_comment p ON p.id=c.parent_id AND p.kind=c.kind AND p.item_id=c.item_id
        LEFT JOIN user pu ON pu.id=p.user_id
        WHERE c.kind=? AND c.item_id=? AND ((?=0 AND c.id<?) OR c.id=?) AND (c.deleted=0 OR EXISTS(SELECT 1 FROM site_comment child WHERE child.parent_id=c.id))
        ORDER BY c.id DESC LIMIT 31`, u.ID, kind, itemID, anchor, before, anchor)
	if err != nil {
		siteError(w, 500, "读取评论失败")
		return
	}
	comments := []map[string]any{}
	for rows.Next() {
		var id, likes int
		var author, name, body, created, parentName, parentBody string
		var parent sql.NullInt64
		var position sql.NullFloat64
		var deleted, liked, parentDeleted bool
		if rows.Scan(&id, &author, &name, &body, &parent, &position, &deleted, &created, &likes, &liked, &parentName, &parentBody, &parentDeleted) != nil {
			rows.Close()
			siteError(w, 500, "读取评论失败")
			return
		}
		var pos any
		if position.Valid && !deleted {
			pos = position.Float64
		}
		var reply any
		if parent.Valid {
			reply = map[string]any{"id": parent.Int64, "name": parentName, "body": parentBody, "deleted": parentDeleted}
		}
		if deleted {
			body = ""
		}
		if parsed, err := time.Parse(time.DateTime, created); err == nil {
			created = parsed.Format(time.RFC3339)
		}
		comments = append(comments, map[string]any{"id": id, "userId": author, "name": name, "body": body, "parent": reply, "position": pos, "deleted": deleted, "createdAt": created, "likes": likes, "liked": liked, "canDelete": u.IsAdmin || author == u.ID})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		siteError(w, 500, "读取评论失败")
		return
	}
	if anchor > 0 {
		_ = json.NewEncoder(w).Encode(map[string]any{"comments": comments})
		return
	}
	var next any
	if len(comments) == 31 {
		comments = comments[:30]
		next = comments[29]["id"]
	}
	if r.URL.Query().Has("before") {
		_ = json.NewEncoder(w).Encode(map[string]any{"comments": comments, "next": next})
		return
	}
	var commentCount int
	if err := db.Db().QueryRowContext(r.Context(), `SELECT COUNT(*) FROM site_comment WHERE kind=? AND item_id=? AND deleted=0`, kind, itemID).Scan(&commentCount); err != nil {
		siteError(w, 500, "读取评论失败")
		return
	}
	itemType := kind
	if kind == "song" {
		itemType = "media_file"
	}
	var count int
	err = db.Db().QueryRowContext(r.Context(), `SELECT COUNT(*) FROM annotation a JOIN site_privacy p ON p.user_id=a.user_id WHERE a.item_type=? AND a.item_id=? AND a.starred=1 AND p.favorites IN ('count','public')`, itemType, itemID).Scan(&count)
	if err != nil {
		siteError(w, 500, "读取收藏失败")
		return
	}
	people := []map[string]string{}
	rows, err = db.Db().QueryContext(r.Context(), `SELECT u.id,u.name FROM annotation a JOIN user u ON u.id=a.user_id JOIN site_privacy p ON p.user_id=u.id WHERE a.item_type=? AND a.item_id=? AND a.starred=1 AND p.favorites='public' ORDER BY u.name LIMIT 100`, itemType, itemID)
	if err != nil {
		siteError(w, 500, "读取收藏失败")
		return
	}
	for rows.Next() {
		var id, name string
		if rows.Scan(&id, &name) == nil {
			people = append(people, map[string]string{"id": id, "name": name})
		}
	}
	rows.Close()
	_ = json.NewEncoder(w).Encode(map[string]any{"comments": comments, "commentCount": commentCount, "favoriteCount": count, "people": people, "next": next})
}

func (s *Server) addComment(w http.ResponseWriter, r *http.Request) {
	kind, itemID := chi.URLParam(r, "kind"), chi.URLParam(r, "id")
	item, err := s.metadataObject(r.Context(), kind, itemID)
	if err != nil {
		siteError(w, 404, "对象不可访问")
		return
	}
	var input struct {
		Body     string   `json:"body"`
		ParentID *int64   `json:"parentId"`
		Position *float64 `json:"position"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 24<<10)
	if json.NewDecoder(r.Body).Decode(&input) != nil || utf8.RuneCountInString(strings.TrimSpace(input.Body)) < 1 || utf8.RuneCountInString(input.Body) > 4000 {
		siteError(w, 400, "评论须为 1 至 4000 字")
		return
	}
	if input.Position != nil {
		song, ok := item.(*model.MediaFile)
		if !ok || *input.Position < 0 || *input.Position > float64(song.Duration) {
			siteError(w, 400, "播放时间无效")
			return
		}
	}
	u, _ := request.UserFrom(r.Context())
	result, err := db.Db().ExecContext(r.Context(), `INSERT INTO site_comment(kind,item_id,user_id,body,parent_id,position) SELECT ?,?,?,?,?,? WHERE ? IS NULL OR EXISTS(SELECT 1 FROM site_comment WHERE id=? AND kind=? AND item_id=? AND deleted=0)`, kind, itemID, u.ID, strings.TrimSpace(input.Body), input.ParentID, input.Position, input.ParentID, input.ParentID, kind, itemID)
	if err != nil {
		siteError(w, 500, "发表失败")
		return
	}
	if count, _ := result.RowsAffected(); count == 0 {
		siteError(w, 409, "回复的评论已删除或不可访问")
		return
	}
	w.WriteHeader(204)
}

func (s *Server) commentAccess(w http.ResponseWriter, r *http.Request) (int, string, bool) {
	id, _ := strconv.Atoi(chi.URLParam(r, "commentId"))
	var kind, itemID, author string
	if db.Db().QueryRowContext(r.Context(), "SELECT kind,item_id,COALESCE(user_id,'') FROM site_comment WHERE id=?", id).Scan(&kind, &itemID, &author) != nil {
		siteError(w, 404, "评论不存在")
		return 0, "", false
	}
	if _, err := s.metadataObject(r.Context(), kind, itemID); err != nil {
		siteError(w, 404, "评论不可访问")
		return 0, "", false
	}
	return id, author, true
}

func (s *Server) deleteComment(w http.ResponseWriter, r *http.Request) {
	id, author, ok := s.commentAccess(w, r)
	if !ok {
		return
	}
	u, _ := request.UserFrom(r.Context())
	if !u.IsAdmin && u.ID != author {
		siteError(w, 403, "无权删除评论")
		return
	}
	if _, err := db.Db().ExecContext(r.Context(), "UPDATE site_comment SET body='',deleted=1 WHERE id=?", id); err != nil {
		siteError(w, 500, "删除失败")
		return
	}
	w.WriteHeader(204)
}

func (s *Server) likeComment(w http.ResponseWriter, r *http.Request) {
	id, _, ok := s.commentAccess(w, r)
	if !ok {
		return
	}
	var input struct {
		Liked bool `json:"liked"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	if json.NewDecoder(r.Body).Decode(&input) != nil {
		siteError(w, 400, "操作无效")
		return
	}
	u, _ := request.UserFrom(r.Context())
	var err error
	if input.Liked {
		var result sql.Result
		result, err = db.Db().ExecContext(r.Context(), `INSERT INTO site_comment_like(comment_id,user_id) SELECT id,? FROM site_comment WHERE id=? AND deleted=0 ON CONFLICT DO NOTHING`, u.ID, id)
		if err == nil {
			if count, _ := result.RowsAffected(); count == 0 {
				var deleted bool
				if db.Db().QueryRowContext(r.Context(), "SELECT deleted FROM site_comment WHERE id=?", id).Scan(&deleted) != nil || deleted {
					siteError(w, 409, "评论已删除")
					return
				}
			}
		}
	} else {
		_, err = db.Db().ExecContext(r.Context(), "DELETE FROM site_comment_like WHERE comment_id=? AND user_id=?", id, u.ID)
	}
	if err != nil {
		siteError(w, 500, "点赞失败")
		return
	}
	w.WriteHeader(204)
}

func (s *Server) getPrivacy(w http.ResponseWriter, r *http.Request) {
	u, _ := request.UserFrom(r.Context())
	visibility := "private"
	_ = db.Db().QueryRowContext(r.Context(), "SELECT favorites FROM site_privacy WHERE user_id=?", u.ID).Scan(&visibility)
	_ = json.NewEncoder(w).Encode(map[string]string{"favorites": visibility})
}

func (s *Server) savePrivacy(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Favorites string `json:"favorites"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	if json.NewDecoder(r.Body).Decode(&input) != nil || (input.Favorites != "private" && input.Favorites != "count" && input.Favorites != "public") {
		siteError(w, 400, "可见性无效")
		return
	}
	u, _ := request.UserFrom(r.Context())
	_, err := db.Db().ExecContext(r.Context(), "INSERT INTO site_privacy(user_id,favorites) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET favorites=excluded.favorites", u.ID, input.Favorites)
	if err != nil {
		siteError(w, 500, "保存设置失败")
		return
	}
	s.getPrivacy(w, r)
}

func (s *Server) siteProfile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "userId")
	user, err := s.ds.User(r.Context()).Get(id)
	if err != nil {
		siteError(w, 404, "用户不存在")
		return
	}
	visibility := "private"
	_ = db.Db().QueryRowContext(r.Context(), "SELECT favorites FROM site_privacy WHERE user_id=?", id).Scan(&visibility)
	viewer, _ := request.UserFrom(r.Context())
	favorites := []map[string]any{}
	if visibility == "public" || viewer.ID == id {
		rows, e := db.Db().QueryContext(r.Context(), "SELECT item_type,item_id FROM annotation WHERE user_id=? AND starred=1 ORDER BY starred_at DESC LIMIT 100", id)
		if e != nil {
			siteError(w, 500, "读取收藏失败")
			return
		}
		type ref struct{ kind, id string }
		refs := []ref{}
		for rows.Next() {
			var value ref
			if rows.Scan(&value.kind, &value.id) == nil {
				refs = append(refs, value)
			}
		}
		rows.Close()
		for _, value := range refs {
			if value.kind == "media_file" {
				value.kind = "song"
			}
			item, e := s.metadataObject(r.Context(), value.kind, value.id)
			if e == nil {
				favorites = append(favorites, map[string]any{"kind": value.kind, "id": value.id, "item": item})
			}
		}
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"id": id, "name": user.Name, "favorites": favorites, "visibility": visibility})
}
