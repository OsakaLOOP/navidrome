package server

import (
	"context"
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

func (s *Server) discussionObject(ctx context.Context, kind, id string) (any, error) {
	if kind == "thought" && id == "global" {
		return nil, nil
	}
	return s.metadataObject(ctx, kind, id)
}

func (s *Server) discussion(w http.ResponseWriter, r *http.Request) {
	kind, itemID := chi.URLParam(r, "kind"), chi.URLParam(r, "id")
	if _, err := s.discussionObject(r.Context(), kind, itemID); err != nil {
		siteError(w, 404, "对象不可访问")
		return
	}
	u, _ := request.UserFrom(r.Context())
	before, _ := strconv.Atoi(r.URL.Query().Get("before"))
	if before <= 0 {
		before = int(^uint(0) >> 1)
	}
	anchor, _ := strconv.Atoi(r.URL.Query().Get("comment"))
	thread, _ := strconv.Atoi(r.URL.Query().Get("thread"))
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	offset = max(0, offset)
	order := "c.id DESC"
	if r.URL.Query().Get("sort") == "hot" && thread == 0 {
		order = "likes DESC, c.id DESC"
	} else if thread != 0 {
		order = "branch.path ASC"
	}
	rows, err := db.Db().QueryContext(r.Context(), `WITH RECURSIVE branch(id,path,depth) AS (
        SELECT id,printf('%020d',id),0 FROM site_comment WHERE id=? AND kind=? AND item_id=?
        UNION ALL SELECT child.id,branch.path||'/'||printf('%020d',child.id),branch.depth+1
          FROM site_comment child JOIN branch ON child.parent_id=branch.id WHERE child.kind=? AND child.item_id=?
        ), timed(id,parent_id) AS (
          SELECT id,parent_id FROM site_comment WHERE ? AND kind=? AND item_id=? AND position IS NOT NULL AND deleted=0
          UNION SELECT p.id,p.parent_id FROM site_comment p JOIN timed t ON p.id=t.parent_id
        ) SELECT c.id,COALESCE(c.user_id,''),COALESCE(NULLIF(profile.nickname,''),u.name,''),c.body,c.parent_id,c.position,c.deleted,c.created_at,
        CASE WHEN c.deleted=0 THEN (SELECT COUNT(*) FROM site_comment_like l WHERE l.comment_id=c.id) ELSE 0 END AS likes,
        c.deleted=0 AND EXISTS(SELECT 1 FROM site_comment_like l WHERE l.comment_id=c.id AND l.user_id=?),
        COALESCE(NULLIF(pp.nickname,''),pu.name,''),CASE WHEN p.deleted=0 THEN substr(p.body,1,160) ELSE '' END,COALESCE(p.deleted,1),
        EXISTS(SELECT 1 FROM site_comment child WHERE child.parent_id=c.id AND (child.deleted=0 OR EXISTS(SELECT 1 FROM site_comment descendant WHERE descendant.parent_id=child.id))),
        (SELECT COUNT(*) FROM site_comment previous WHERE previous.kind=c.kind AND previous.item_id=c.item_id AND previous.id<=c.id),
        COALESCE(branch.depth,0),COALESCE(profile.avatar_version,0)
        FROM site_comment c LEFT JOIN user u ON u.id=c.user_id
        LEFT JOIN site_profile profile ON profile.user_id=c.user_id
        LEFT JOIN site_comment p ON p.id=c.parent_id AND p.kind=c.kind AND p.item_id=c.item_id
        LEFT JOIN user pu ON pu.id=p.user_id
        LEFT JOIN site_profile pp ON pp.user_id=pu.id
        LEFT JOIN branch ON branch.id=c.id
        WHERE c.kind=? AND c.item_id=? AND (c.id=? OR (?=0 AND c.id<? AND
            ((?=0 AND c.parent_id IS NULL AND (NOT ? OR c.id IN (SELECT id FROM timed))) OR branch.depth>0)))
          AND (c.deleted=0 OR EXISTS(SELECT 1 FROM site_comment child WHERE child.parent_id=c.id))
        ORDER BY `+order+` LIMIT 31 OFFSET ?`, thread, kind, itemID, kind, itemID, r.URL.Query().Has("timed"), kind, itemID,
		u.ID, kind, itemID, anchor, anchor, before, thread, r.URL.Query().Has("timed"), offset)
	if err != nil {
		siteError(w, 500, "读取评论失败")
		return
	}
	comments := []map[string]any{}
	for rows.Next() {
		var id, likes, floor, depth int
		var avatarVersion int64
		var author, name, body, created, parentName, parentBody string
		var parent sql.NullInt64
		var position sql.NullFloat64
		var deleted, liked, parentDeleted, replies bool
		if rows.Scan(&id, &author, &name, &body, &parent, &position, &deleted, &created, &likes, &liked, &parentName, &parentBody, &parentDeleted, &replies, &floor, &depth, &avatarVersion) != nil {
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
		comments = append(comments, map[string]any{"id": id, "userId": author, "name": name, "body": body, "parent": reply, "position": pos, "deleted": deleted, "createdAt": created, "likes": likes, "liked": liked, "canDelete": u.IsAdmin || author == u.ID, "hasReplies": replies, "floor": floor, "depth": depth, "avatarVersion": avatarVersion})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		siteError(w, 500, "读取评论失败")
		return
	}
	if anchor > 0 {
		var root int
		err := db.Db().QueryRowContext(r.Context(), `WITH RECURSIVE ancestors(id,parent_id) AS (
          SELECT id,parent_id FROM site_comment WHERE id=? AND kind=? AND item_id=?
          UNION ALL SELECT p.id,p.parent_id FROM site_comment p JOIN ancestors a ON a.parent_id=p.id WHERE p.kind=? AND p.item_id=?
        ) SELECT id FROM ancestors WHERE parent_id IS NULL`, anchor, kind, itemID, kind, itemID).Scan(&root)
		if err != nil || len(comments) == 0 {
			siteError(w, 404, "评论不存在")
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"comments": comments, "root": root})
		return
	}
	var next any
	if len(comments) == 31 {
		comments = comments[:30]
		if order == "c.id DESC" {
			next = comments[29]["id"]
		} else {
			next = offset + 30
		}
	}
	if thread != 0 || r.URL.Query().Has("before") || offset > 0 {
		_ = json.NewEncoder(w).Encode(map[string]any{"comments": comments, "next": next})
		return
	}
	if kind == "thought" {
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
	var public int
	err = db.Db().QueryRowContext(r.Context(), `SELECT COUNT(*) FROM annotation a JOIN site_privacy p ON p.user_id=a.user_id WHERE a.item_type=? AND a.item_id=? AND a.starred=1 AND p.favorites='public'`, itemType, itemID).Scan(&public)
	if err != nil {
		siteError(w, 500, "读取收藏失败")
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"comments": comments, "commentCount": commentCount, "favoriteCount": count, "publicCount": public, "next": next})
}

func (s *Server) discussionCount(w http.ResponseWriter, r *http.Request) {
	kind, itemID := chi.URLParam(r, "kind"), chi.URLParam(r, "id")
	if _, err := s.metadataObject(r.Context(), kind, itemID); err != nil {
		siteError(w, 404, "对象不可访问")
		return
	}
	var count int
	if db.Db().QueryRowContext(r.Context(), `SELECT COUNT(*) FROM site_comment WHERE kind=? AND item_id=? AND deleted=0`, kind, itemID).Scan(&count) != nil {
		siteError(w, 500, "读取评论失败")
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]int{"count": count})
}

func (s *Server) favoritePeople(w http.ResponseWriter, r *http.Request) {
	kind, itemID := chi.URLParam(r, "kind"), chi.URLParam(r, "id")
	if _, err := s.metadataObject(r.Context(), kind, itemID); err != nil {
		siteError(w, 404, "对象不可访问")
		return
	}
	if kind == "song" {
		kind = "media_file"
	}
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	offset = max(0, offset)
	people := []map[string]string{}
	rows, err := db.Db().QueryContext(r.Context(), `SELECT u.id,COALESCE(NULLIF(profile.nickname,''),u.name) AS name FROM annotation a JOIN user u ON u.id=a.user_id JOIN site_privacy p ON p.user_id=u.id LEFT JOIN site_profile profile ON profile.user_id=u.id WHERE a.item_type=? AND a.item_id=? AND a.starred=1 AND p.favorites='public' ORDER BY name,u.id LIMIT 31 OFFSET ?`, kind, itemID, offset)
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
	var next any
	if len(people) == 31 {
		people = people[:30]
		next = offset + 30
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"people": people, "next": next})
}

func (s *Server) addComment(w http.ResponseWriter, r *http.Request) {
	kind, itemID := chi.URLParam(r, "kind"), chi.URLParam(r, "id")
	item, err := s.discussionObject(r.Context(), kind, itemID)
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
	commentID, err := result.LastInsertId()
	if err != nil {
		siteError(w, 500, "读取评论失败")
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"id": commentID})
}

func (s *Server) editComment(w http.ResponseWriter, r *http.Request) {
	id, author, ok := s.commentAccess(w, r)
	if !ok {
		return
	}
	user, _ := request.UserFrom(r.Context())
	if user.ID != author {
		siteError(w, 403, "无权编辑评论")
		return
	}
	var input struct {
		Body string `json:"body"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 32<<10)
	if json.NewDecoder(r.Body).Decode(&input) != nil || strings.TrimSpace(input.Body) == "" || utf8.RuneCountInString(input.Body) > 4000 {
		siteError(w, 400, "评论内容无效")
		return
	}
	result, err := db.Db().ExecContext(r.Context(), `UPDATE site_comment SET body=? WHERE id=? AND deleted=0`, strings.TrimSpace(input.Body), id)
	if err != nil {
		siteError(w, 500, "编辑失败")
		return
	}
	if count, _ := result.RowsAffected(); count == 0 {
		siteError(w, 409, "评论已删除")
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
	if _, err := s.discussionObject(r.Context(), kind, itemID); err != nil {
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
		result, err = db.Db().ExecContext(r.Context(), `INSERT INTO site_comment_like(comment_id,user_id,created_at) SELECT id,?,CURRENT_TIMESTAMP FROM site_comment WHERE id=? AND deleted=0 ON CONFLICT DO NOTHING`, u.ID, id)
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
	var likes int
	var liked bool
	if err := db.Db().QueryRowContext(r.Context(), `SELECT COUNT(*),COALESCE(MAX(user_id=?),0) FROM site_comment_like WHERE comment_id=?`, u.ID, id).Scan(&likes, &liked); err != nil {
		siteError(w, 500, "读取点赞失败")
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"likes": likes, "liked": liked})
}

func (s *Server) getPrivacy(w http.ResponseWriter, r *http.Request) {
	u, _ := request.UserFrom(r.Context())
	visibility := "private"
	var onlineCount bool
	history, ratings := "private", "private"
	_ = db.Db().QueryRowContext(r.Context(), "SELECT favorites,online_count,history,ratings FROM site_privacy WHERE user_id=?", u.ID).Scan(&visibility, &onlineCount, &history, &ratings)
	_ = json.NewEncoder(w).Encode(map[string]any{"favorites": visibility, "onlineCount": onlineCount, "history": history, "ratings": ratings})
}

func (s *Server) savePrivacy(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Favorites   string `json:"favorites"`
		OnlineCount *bool  `json:"onlineCount"`
		History     string `json:"history"`
		Ratings     string `json:"ratings"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	if json.NewDecoder(r.Body).Decode(&input) != nil ||
		(input.Favorites == "" && input.OnlineCount == nil && input.History == "" && input.Ratings == "") ||
		(input.Favorites != "" && input.Favorites != "private" && input.Favorites != "count" && input.Favorites != "public") {
		siteError(w, 400, "可见性无效")
		return
	}
	for _, value := range []string{input.History, input.Ratings} {
		if value != "" && value != "private" && value != "friends" && value != "public" {
			siteError(w, 400, "可见性无效")
			return
		}
	}
	u, _ := request.UserFrom(r.Context())
	listeningRoom.Lock()
	_, err := db.Db().ExecContext(r.Context(), `
		INSERT INTO site_privacy(user_id,favorites,online_count,history,ratings)
		VALUES(?,COALESCE(NULLIF(?,''),'private'),COALESCE(?,0),COALESCE(NULLIF(?,''),'private'),COALESCE(NULLIF(?,''),'private'))
		ON CONFLICT(user_id) DO UPDATE SET
		favorites=COALESCE(NULLIF(?,''),favorites), online_count=COALESCE(?,online_count),
		history=COALESCE(NULLIF(?,''),history), ratings=COALESCE(NULLIF(?,''),ratings)`,
		u.ID, input.Favorites, input.OnlineCount, input.History, input.Ratings, input.Favorites, input.OnlineCount, input.History, input.Ratings)
	if err == nil && input.OnlineCount != nil && !*input.OnlineCount {
		delete(listeningRoom.Online, u.ID)
	}
	listeningRoom.Unlock()
	if err != nil {
		siteError(w, 500, "保存设置失败")
		return
	}
	s.getPrivacy(w, r)
}

func (s *Server) siteProfile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "userId")
	viewer, _ := request.UserFrom(r.Context())
	visibility := "private"
	people := make([]sitePerson, 1)
	err := db.Db().QueryRowContext(r.Context(), `WITH viewer(id) AS (VALUES (?)) SELECT `+sitePersonColumns+`,COALESCE(privacy.favorites,'private')`+sitePeopleFrom+` WHERE u.id=?`, viewer.ID, id).Scan(append(people[0].columns(), &visibility)...)
	if err == sql.ErrNoRows {
		siteError(w, 404, "用户不存在")
		return
	}
	if err != nil {
		siteError(w, 500, "读取个人资料失败")
		return
	}
	sitePresence(viewer, people)
	favorites := []map[string]any{}
	var next any
	if visibility == "public" || viewer.ID == id {
		kind := r.URL.Query().Get("kind")
		if kind == "song" {
			kind = "media_file"
		}
		offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
		offset = max(0, offset)
		rows, e := db.Db().QueryContext(r.Context(), `SELECT a.item_type,a.item_id,COALESCE(m.title,b.name,t.name)
            FROM annotation a
            LEFT JOIN media_file m ON a.item_type='media_file' AND m.id=a.item_id
            LEFT JOIN album b ON a.item_type='album' AND b.id=a.item_id
            LEFT JOIN artist t ON a.item_type='artist' AND t.id=a.item_id
            WHERE a.user_id=? AND a.starred=1 AND (?='' OR a.item_type=?) AND COALESCE(m.title,b.name,t.name) IS NOT NULL
            AND (a.user_id=? OR EXISTS(SELECT 1 FROM site_privacy WHERE user_id=a.user_id AND favorites='public'))
            AND (? OR EXISTS(SELECT 1 FROM user_library access WHERE access.user_id=? AND (
                access.library_id=m.library_id OR
                access.library_id=b.library_id OR
                EXISTS(SELECT 1 FROM library_artist lt WHERE lt.artist_id=t.id AND lt.library_id=access.library_id))))
            ORDER BY a.starred_at DESC,a.item_type,a.item_id LIMIT 31 OFFSET ?`, id, kind, kind, viewer.ID, viewer.IsAdmin, viewer.ID, offset)
		if e != nil {
			siteError(w, 500, "读取收藏失败")
			return
		}
		for rows.Next() {
			var itemKind, itemID, title string
			if rows.Scan(&itemKind, &itemID, &title) != nil {
				rows.Close()
				siteError(w, 500, "读取收藏失败")
				return
			}
			if itemKind == "media_file" {
				itemKind = "song"
			}
			favorites = append(favorites, map[string]any{"kind": itemKind, "id": itemID, "title": title})
		}
		err := rows.Err()
		rows.Close()
		if err != nil {
			siteError(w, 500, "读取收藏失败")
			return
		}
		if len(favorites) == 31 {
			favorites = favorites[:30]
			next = offset + 30
		}
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"person": people[0], "favorites": favorites, "canView": visibility == "public" || viewer.ID == id, "next": next})
}

func (s *Server) reportComment(w http.ResponseWriter, r *http.Request) {
	id, author, ok := s.commentAccess(w, r)
	if !ok {
		return
	}
	user, _ := request.UserFrom(r.Context())
	if user.ID == author {
		siteError(w, 400, "请选择其他用户的评论")
		return
	}
	var input struct {
		Reason string `json:"reason"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if json.NewDecoder(r.Body).Decode(&input) != nil || strings.TrimSpace(input.Reason) == "" || utf8.RuneCountInString(input.Reason) > 500 {
		siteError(w, 400, "举报理由无效")
		return
	}
	_, err := db.Db().ExecContext(r.Context(), `INSERT INTO site_comment_report(comment_id,user_id,reason) SELECT id,?,? FROM site_comment WHERE id=? AND deleted=0 ON CONFLICT DO NOTHING`, user.ID, strings.TrimSpace(input.Reason), id)
	if err != nil {
		siteError(w, 500, "举报失败")
		return
	}
	w.WriteHeader(204)
}

func (s *Server) commentReports(w http.ResponseWriter, r *http.Request) {
	user, _ := request.UserFrom(r.Context())
	if !user.IsAdmin {
		siteError(w, 403, "仅管理员可审核举报")
		return
	}
	rows, err := db.Db().QueryContext(r.Context(), `SELECT c.id,c.body,COALESCE(u.name,''),GROUP_CONCAT(r.reason,char(10)),COUNT(*) FROM site_comment_report r JOIN site_comment c ON c.id=r.comment_id LEFT JOIN user u ON u.id=c.user_id WHERE r.reviewed=0 AND c.deleted=0 GROUP BY c.id ORDER BY MIN(r.rowid) LIMIT 30`)
	if err != nil {
		siteError(w, 500, "读取举报失败")
		return
	}
	defer rows.Close()
	reports := []map[string]any{}
	for rows.Next() {
		var id, count int
		var body, name, reason string
		if rows.Scan(&id, &body, &name, &reason, &count) != nil {
			siteError(w, 500, "读取举报失败")
			return
		}
		reports = append(reports, map[string]any{"id": id, "body": body, "name": name, "reason": reason, "count": count})
	}
	if rows.Err() != nil {
		siteError(w, 500, "读取举报失败")
		return
	}
	_ = json.NewEncoder(w).Encode(reports)
}

func (s *Server) reviewCommentReport(w http.ResponseWriter, r *http.Request) {
	user, _ := request.UserFrom(r.Context())
	if !user.IsAdmin {
		siteError(w, 403, "仅管理员可审核举报")
		return
	}
	id, _ := strconv.Atoi(chi.URLParam(r, "commentId"))
	if id <= 0 {
		siteError(w, 400, "评论无效")
		return
	}
	var input struct {
		Remove *bool `json:"remove"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	if json.NewDecoder(r.Body).Decode(&input) != nil || input.Remove == nil {
		siteError(w, 400, "审核操作无效")
		return
	}
	tx, err := db.Db().BeginTx(r.Context(), nil)
	if err == nil {
		defer tx.Rollback()
		var result sql.Result
		result, err = tx.ExecContext(r.Context(), `UPDATE site_comment_report SET reviewed=1 WHERE comment_id=? AND reviewed=0`, id)
		if err == nil {
			if count, _ := result.RowsAffected(); count == 0 {
				siteError(w, 404, "待审核举报不存在")
				return
			}
			if *input.Remove {
				_, err = tx.ExecContext(r.Context(), `UPDATE site_comment SET body='',deleted=1 WHERE id=?`, id)
			}
		}
		if err == nil {
			err = tx.Commit()
		}
	}
	if err != nil {
		siteError(w, 500, "审核失败")
		return
	}
	w.WriteHeader(204)
}
