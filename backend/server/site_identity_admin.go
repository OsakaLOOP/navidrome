package server

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/navidrome/navidrome/conf"
	"github.com/navidrome/navidrome/db"
	"github.com/navidrome/navidrome/model/request"
)

func (s *Server) listIdentities(w http.ResponseWriter, r *http.Request) {
	u, _ := request.UserFrom(r.Context())
	if !u.IsAdmin {
		siteError(w, 403, "需要管理员权限")
		return
	}
	rows, err := db.Db().QueryContext(r.Context(), "SELECT i.subject,i.user_id,i.email,i.name,u.user_name FROM site_identity i JOIN user u ON u.id=i.user_id WHERE i.issuer=? ORDER BY i.name", strings.TrimRight(conf.Server.ServerManURL, "/"))
	if err != nil {
		siteError(w, 500, "读取绑定失败")
		return
	}
	identities := []map[string]string{}
	for rows.Next() {
		var subject, userID, email, name, username string
		if err = rows.Scan(&subject, &userID, &email, &name, &username); err != nil {
			rows.Close()
			siteError(w, 500, "读取绑定失败")
			return
		}
		identities = append(identities, map[string]string{"subject": subject, "userId": userID, "email": email, "name": name, "username": username})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		siteError(w, 500, "读取绑定失败")
		return
	}
	users, err := s.ds.User(r.Context()).GetAll()
	if err != nil {
		siteError(w, 500, "读取账号失败")
		return
	}
	choices := []map[string]string{}
	for _, user := range users {
		choices = append(choices, map[string]string{"id": user.ID, "username": user.UserName, "name": user.Name})
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"identities": identities, "users": choices})
}

func (s *Server) manageIdentity(w http.ResponseWriter, r *http.Request) {
	u, _ := request.UserFrom(r.Context())
	if !u.IsAdmin {
		siteError(w, 403, "需要管理员权限")
		return
	}
	var input struct {
		Subject string `json:"subject"`
		UserID  string `json:"userId"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, MaxLoginBodySize)
	if json.NewDecoder(r.Body).Decode(&input) != nil || input.Subject == "" || input.UserID == "" {
		siteError(w, 400, "绑定信息无效")
		return
	}
	if _, err := s.ds.User(r.Context()).Get(input.UserID); err != nil {
		siteError(w, 404, "音乐账号不存在")
		return
	}
	tx, err := db.Db().BeginTx(r.Context(), nil)
	if err != nil {
		siteError(w, 500, "更新绑定失败")
		return
	}
	defer tx.Rollback()
	issuer := strings.TrimRight(conf.Server.ServerManURL, "/")
	var previous string
	if err = tx.QueryRowContext(r.Context(), "SELECT user_id FROM site_identity WHERE issuer=? AND subject=?", issuer, input.Subject).Scan(&previous); err != nil {
		siteError(w, 404, "中心身份不存在")
		return
	}
	_, err = tx.ExecContext(r.Context(), "UPDATE site_identity SET user_id=?,updated_at=CURRENT_TIMESTAMP WHERE issuer=? AND subject=?", input.UserID, issuer, input.Subject)
	if err != nil {
		siteError(w, 409, "该音乐账号已有其他绑定")
		return
	}
	_, err = tx.ExecContext(r.Context(), "UPDATE user SET token_epoch=token_epoch+1 WHERE id IN (?,?)", previous, input.UserID)
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		siteError(w, 500, "更新账号会话失败")
		return
	}
	w.WriteHeader(204)
}
