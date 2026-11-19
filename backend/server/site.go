package server

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/navidrome/navidrome/conf"
	"github.com/navidrome/navidrome/db"
	"github.com/navidrome/navidrome/model/request"
)

func (s *Server) mountSiteRoutes() {
	s.router.Route(path.Join(conf.Server.BasePath, "/site"), func(r chi.Router) {
		r.Use(NoStore, sameSiteWrite, Authenticator(s.ds))
		r.Get("/identity", s.siteIdentity)
		r.Get("/identities", s.listIdentities)
		r.Put("/identities", s.manageIdentity)
		r.With(ClientIPRateLimiter(10, time.Minute)).Post("/identity/bind", s.bindIdentity)
		r.Get("/media/*", s.mediaGrant)
		r.Get("/metadata/{kind}/{id}", s.getMetadata)
		r.Get("/metadata-artists", s.metadataArtists)
		r.Put("/metadata/{kind}/{id}", s.saveMetadata)
		r.Post("/cover/{kind}/{id}", s.saveCover)
		r.Delete("/cover/{kind}/{id}", s.restoreCover)
		r.Get("/discussion/{kind}/{id}", s.discussion)
		r.Get("/discussion/{kind}/{id}/people", s.favoritePeople)
		r.Get("/discussion/{kind}/{id}/count", s.discussionCount)
		r.Post("/discussion/{kind}/{id}", s.addComment)
		r.Put("/comment/{commentId}", s.editComment)
		r.Delete("/comment/{commentId}", s.deleteComment)
		r.Put("/comment/{commentId}/like", s.likeComment)
		r.Post("/comment/{commentId}/report", s.reportComment)
		r.Get("/comment-reports", s.commentReports)
		r.Put("/comment-reports/{commentId}", s.reviewCommentReport)
		r.Get("/privacy", s.getPrivacy)
		r.Put("/privacy", s.savePrivacy)
		r.Get("/profile/{userId}", s.siteProfile)
		r.Get("/profile/{userId}/history", s.siteHistory)
		r.Get("/profile/{userId}/avatar", s.siteAvatar)
		r.Put("/profile", s.saveSiteProfile)
		r.Put("/profile/avatar", s.saveSiteAvatar)
		r.Delete("/profile/avatar", s.deleteSiteAvatar)
		r.Get("/users", s.siteUsers)
		r.Put("/friends/{userId}", s.addSiteFriend)
		r.Delete("/friends/{userId}", s.removeSiteFriend)
		r.Get("/timeline", s.siteTimeline)
		r.Get("/room", s.getRoom)
		r.Post("/room", s.changeRoom)
	})
}

func (s *Server) siteIdentity(w http.ResponseWriter, r *http.Request) {
	u, _ := request.UserFrom(r.Context())
	var subject, email, name, nickname, bio string
	var avatarVersion int64
	err := db.Db().QueryRowContext(r.Context(), "SELECT subject,email,name FROM site_identity WHERE user_id=?", u.ID).Scan(&subject, &email, &name)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		siteError(w, 500, "读取绑定失败")
		return
	}
	if subject == "" {
		name, email = u.Name, u.Email
	}
	err = db.Db().QueryRowContext(r.Context(), "SELECT nickname,bio,avatar_version FROM site_profile WHERE user_id=?", u.ID).Scan(&nickname, &bio, &avatarVersion)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		siteError(w, 500, "读取个人资料失败")
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"subject": subject, "email": email, "name": name, "userId": u.ID, "isAdmin": u.IsAdmin, "nickname": nickname, "bio": bio, "avatarVersion": avatarVersion})
}

// 旧账号归属通过密码核验；中心身份来自服务端验证的会话。
func (s *Server) bindIdentity(w http.ResponseWriter, r *http.Request) {
	central, err := centralUserFrom(r)
	if err != nil {
		siteError(w, 401, "请先登录 ServerMan")
		return
	}
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, MaxLoginBodySize)
	if json.NewDecoder(r.Body).Decode(&input) != nil {
		siteError(w, 400, "绑定信息无效")
		return
	}
	old, err := validateLogin(s.ds.User(r.Context()), input.Username, input.Password)
	if err != nil || old == nil {
		siteError(w, 401, "旧账号或密码无效")
		return
	}
	issuer := strings.TrimRight(conf.Server.ServerManURL, "/")
	tx, err := db.Db().BeginTx(r.Context(), nil)
	if err != nil {
		siteError(w, 500, "更新绑定失败")
		return
	}
	defer tx.Rollback()
	var current string
	err = tx.QueryRowContext(r.Context(), "SELECT user_id FROM site_identity WHERE issuer=? AND subject=?", issuer, central.ID).Scan(&current)
	if err != nil {
		siteError(w, 409, "中心账号尚未建立本站身份")
		return
	}
	var existing string
	err = tx.QueryRowContext(r.Context(), "SELECT subject FROM site_identity WHERE user_id=?", old.ID).Scan(&existing)
	if err == nil && existing != central.ID {
		siteError(w, 409, "该账号已绑定其他中心身份")
		return
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		siteError(w, 500, "读取绑定失败")
		return
	}
	_, err = tx.ExecContext(r.Context(), "UPDATE site_identity SET user_id=?,email=?,name=?,updated_at=CURRENT_TIMESTAMP WHERE issuer=? AND subject=?", old.ID, central.Email, central.Name, issuer, central.ID)
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		siteError(w, 409, "更新绑定失败")
		return
	}
	_, err = db.Db().ExecContext(r.Context(), "UPDATE user SET token_epoch=token_epoch+1 WHERE id IN (?,?)", current, old.ID)
	if err != nil {
		siteError(w, 500, "更新账号会话失败")
		return
	}
	old, err = s.ds.User(r.Context()).FindByUsernameWithPassword(old.UserName)
	if err != nil {
		siteError(w, 500, "读取账号失败")
		return
	}
	s.siteAuthResponse(w, r, old)
}
