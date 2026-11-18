package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/deluan/rest"
	"github.com/go-chi/jwtauth/v5"
	"github.com/lestrrat-go/jwx/v3/jwk"
	"github.com/lestrrat-go/jwx/v3/jwt"
	"github.com/navidrome/navidrome/conf"
	"github.com/navidrome/navidrome/core/auth"
	"github.com/navidrome/navidrome/db"
	"github.com/navidrome/navidrome/model"
	"github.com/navidrome/navidrome/model/id"
	"github.com/navidrome/navidrome/persistence"
)

type centralUser struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
}

func setSiteCookie(w http.ResponseWriter, r *http.Request, name, value string, age int) {
	http.SetCookie(w, &http.Cookie{Name: name, Value: value, Path: conf.Server.BasePath + "/", HttpOnly: true,
		Secure: r.TLS != nil || conf.Server.BaseScheme == "https", SameSite: http.SameSiteLaxMode, MaxAge: age})
}

// 中心 Cookie 限定在本站后端使用，浏览器只接触 HttpOnly 会话。
func centralCookies(r *http.Request) string {
	if c, err := r.Cookie("nd_serverman"); err == nil {
		data, err := base64.RawURLEncoding.DecodeString(c.Value)
		if err == nil {
			return string(data)
		}
	}
	var values []string
	for _, c := range r.Cookies() {
		if strings.Contains(c.Name, "better-auth.") {
			values = append(values, c.Name+"="+c.Value)
		}
	}
	return strings.Join(values, "; ")
}

func centralRequest(ctx context.Context, method, endpoint, cookie string, body any) (*http.Response, error) {
	if conf.Server.ServerManURL == "" {
		return nil, errors.New("尚未配置 ServerManURL")
	}
	var data []byte
	if body != nil {
		data, _ = json.Marshal(body)
	}
	origin := strings.TrimRight(conf.Server.ServerManURL, "/")
	r, err := http.NewRequestWithContext(ctx, method, origin+"/api/auth/"+endpoint, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", origin)
	r.Header.Set("Cookie", cookie)
	client := &http.Client{Timeout: 12 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return client.Do(r)
}

func centralIdentity(ctx context.Context, cookie string) (*centralUser, error) {
	res, err := centralRequest(ctx, "GET", "get-session", cookie, nil)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var data struct {
		User centralUser `json:"user"`
	}
	if res.StatusCode != 200 || json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&data) != nil || data.User.ID == "" {
		return nil, ErrUnauthenticated
	}
	return &data.User, nil
}

func (s *Server) servermanLogin(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Email    string `json:"email"`
		Password string `json:"password"`
		Code     string `json:"code"`
		Recovery bool   `json:"recovery"`
	}
	if json.NewDecoder(r.Body).Decode(&input) != nil {
		siteError(w, 400, "登录信息无效")
		return
	}
	endpoint := "sign-in/email"
	body := map[string]any{"email": input.Email, "password": input.Password, "rememberMe": true}
	if input.Code != "" {
		endpoint = "two-factor/verify-totp"
		if input.Recovery {
			endpoint = "two-factor/verify-backup-code"
		}
		body = map[string]any{"code": input.Code, "trustDevice": true}
	}
	cookie := centralCookies(r)
	res, err := centralRequest(r.Context(), "POST", endpoint, cookie, body)
	if err != nil {
		siteError(w, 503, "ServerMan 暂时无法连接")
		return
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		siteError(w, res.StatusCode, "请检查账号、密码或验证码")
		return
	}
	jar := map[string]string{}
	for _, part := range strings.Split(cookie, "; ") {
		if k, v, ok := strings.Cut(part, "="); ok {
			jar[k] = v
		}
	}
	for _, c := range res.Cookies() {
		if c.MaxAge < 0 {
			delete(jar, c.Name)
		} else {
			jar[c.Name] = c.Value
		}
	}
	parts := []string{}
	for k, v := range jar {
		parts = append(parts, k+"="+v)
	}
	cookie = strings.Join(parts, "; ")
	setSiteCookie(w, r, "nd_serverman", base64.RawURLEncoding.EncodeToString([]byte(cookie)), 7*86400)
	var result struct {
		TwoFactorRedirect bool `json:"twoFactorRedirect"`
	}
	_ = json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&result)
	if result.TwoFactorRedirect {
		_ = rest.RespondWithJSON(w, 200, map[string]bool{"twoFactorRequired": true})
		return
	}
	central, err := centralIdentity(r.Context(), cookie)
	if err != nil {
		siteError(w, 401, "中心会话无效")
		return
	}
	s.finishCentralLogin(w, r, central)
}

func (s *Server) finishCentralLogin(w http.ResponseWriter, r *http.Request, central *centralUser) {
	issuer := strings.TrimRight(conf.Server.ServerManURL, "/")
	var userID string
	err := db.Db().QueryRowContext(r.Context(), "SELECT user_id FROM site_identity WHERE issuer=? AND subject=?", issuer, central.ID).Scan(&userID)
	if errors.Is(err, sql.ErrNoRows) {
		secret := make([]byte, 32)
		if _, err = rand.Read(secret); err != nil {
			siteError(w, 500, "创建账号失败")
			return
		}
		u := &model.User{ID: id.NewRandom(), UserName: "sm-" + central.ID, Name: central.Name, Email: central.Email, NewPassword: hex.EncodeToString(secret)}
		err = s.ds.WithTx(func(tx model.DataStore) error {
			if e := tx.User(r.Context()).Put(u); e != nil {
				return e
			}
			libs, e := tx.Library(r.Context()).GetAll()
			if e != nil {
				return e
			}
			ids := []int{}
			for _, lib := range libs {
				if lib.DefaultNewUsers {
					ids = append(ids, lib.ID)
				}
			}
			if e = tx.User(r.Context()).SetUserLibraries(u.ID, ids); e != nil {
				return e
			}
			return persistence.CreateSiteIdentity(r.Context(), tx, issuer, central.ID, u.ID, central.Email, central.Name)
		})
		userID = u.ID
		if err != nil {
			err = db.Db().QueryRowContext(r.Context(), "SELECT user_id FROM site_identity WHERE issuer=? AND subject=?", issuer, central.ID).Scan(&userID)
		}
	}
	if err != nil {
		siteError(w, 500, "读取账号绑定失败")
		return
	}
	u, err := s.ds.User(r.Context()).Get(userID)
	if err != nil {
		siteError(w, 401, "本站账号已停用")
		return
	}
	u.Name = central.Name
	u.Email = central.Email
	if err = s.ds.User(r.Context()).Put(u); err != nil {
		siteError(w, 500, "更新账号失败")
		return
	}
	_, err = db.Db().ExecContext(r.Context(), "UPDATE site_identity SET email=?,name=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?", central.Email, central.Name, u.ID)
	if err != nil {
		siteError(w, 500, "更新绑定失败")
		return
	}
	u, err = s.ds.User(r.Context()).FindByUsernameWithPassword(u.UserName)
	if err != nil {
		siteError(w, 500, "读取账号失败")
		return
	}
	_ = s.ds.User(r.Context()).UpdateLastLoginAt(u.ID)
	s.siteAuthResponse(w, r, u)
}

func (s *Server) siteAuthResponse(w http.ResponseWriter, r *http.Request, u *model.User) {
	token, err := auth.CreateToken(u)
	if err != nil {
		siteError(w, 500, "创建会话失败")
		return
	}
	if !u.IsAdmin && conf.Server.ServerManURL != "" {
		claims, e := auth.Validate(token)
		if e != nil {
			siteError(w, 500, "创建会话失败")
			return
		}
		claims.CentralExpiresAt = time.Now().Add(15 * time.Minute)
		token, err = auth.TouchClaims(claims)
		if err != nil {
			siteError(w, 500, "创建会话失败")
			return
		}
	}
	setSiteCookie(w, r, "jwt", token, int(conf.Server.SessionTimeout.Seconds()))
	payload := buildAuthPayload(u)
	payload["token"] = token
	_ = rest.RespondWithJSON(w, 200, payload)
}

func (s *Server) siteSession(w http.ResponseWriter, r *http.Request) {
	if u, err := centralUserFrom(r); err == nil {
		s.finishCentralLogin(w, r, u)
		return
	}
	if username := UsernameFromToken(r); username != "" {
		u, err := s.ds.User(r.Context()).FindByUsernameWithPassword(username)
		if err == nil && (u.IsAdmin || conf.Server.ServerManURL == "") {
			if token, _, e := jwtauth.FromContext(r.Context()); e == nil && token != nil {
				if auth.CheckClaims(auth.ClaimsFromToken(token), *u, auth.AudienceNative) == nil {
					s.siteAuthResponse(w, r, u)
					return
				}
			}
		}
	}
	siteError(w, 401, "请登录")
}

func (s *Server) siteLogout(w http.ResponseWriter, r *http.Request) {
	for _, name := range []string{"jwt", "nd_serverman", "nd_central"} {
		setSiteCookie(w, r, name, "", -1)
	}
	w.WriteHeader(204)
}

func siteError(w http.ResponseWriter, status int, message string) {
	_ = rest.RespondWithJSON(w, status, map[string]string{"message": message})
}

func SiteUserAllowed(ctx context.Context, user model.User) bool {
	if user.IsAdmin || conf.Server.ServerManURL == "" {
		return true
	}
	var found int
	return db.Db().QueryRowContext(ctx, "SELECT 1 FROM site_identity WHERE user_id=? AND issuer=?", user.ID, strings.TrimRight(conf.Server.ServerManURL, "/")).Scan(&found) == nil
}

func verifyCentralToken(ctx context.Context, raw string) (*centralUser, error) {
	if conf.Server.ServerManURL == "" {
		return nil, ErrUnauthenticated
	}
	origin := strings.TrimRight(conf.Server.ServerManURL, "/")
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	keys, err := jwk.Fetch(ctx, origin+"/api/auth/jwks")
	if err != nil {
		return nil, err
	}
	token, err := jwt.Parse([]byte(raw), jwt.WithKeySet(keys))
	if err != nil {
		return nil, err
	}
	issuer, _ := token.Issuer()
	audience, _ := token.Audience()
	expires, hasExpiry := token.Expiration()
	if (issuer != origin && issuer != origin+"/api/auth") || !slices.Contains(audience, issuer) || !hasExpiry || !expires.After(time.Now()) {
		return nil, ErrUnauthenticated
	}
	user := &centralUser{}
	user.ID, _ = token.Subject()
	_ = token.Get("email", &user.Email)
	_ = token.Get("name", &user.Name)
	if user.ID == "" {
		return nil, ErrUnauthenticated
	}
	return user, nil
}

func (s *Server) exchangeCentralToken(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Token string `json:"token"`
	}
	if json.NewDecoder(r.Body).Decode(&input) != nil {
		siteError(w, 400, "身份信息无效")
		return
	}
	central, err := verifyCentralToken(r.Context(), input.Token)
	if err != nil {
		siteError(w, 401, "中心身份验证失败")
		return
	}
	setSiteCookie(w, r, "nd_central", input.Token, 900)
	s.finishCentralLogin(w, r, central)
}

func centralUserFrom(r *http.Request) (*centralUser, error) {
	if cookie := centralCookies(r); cookie != "" {
		if u, err := centralIdentity(r.Context(), cookie); err == nil {
			return u, nil
		}
	}
	if cookie, err := r.Cookie("nd_central"); err == nil {
		return verifyCentralToken(r.Context(), cookie.Value)
	}
	return nil, ErrUnauthenticated
}

func sameSiteWrite(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && r.Method != "HEAD" {
			if origin := r.Header.Get("Origin"); origin != "" {
				u, err := url.Parse(origin)
				if err != nil || u.Host != r.Host {
					siteError(w, 403, "请求来源无效")
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}
