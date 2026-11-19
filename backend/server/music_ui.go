package server

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"path"
	"regexp"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/navidrome/navidrome/conf"
	"github.com/navidrome/navidrome/resources"
)

var versionedAssetName = regexp.MustCompile(`-[A-Za-z0-9_-]{8,}\.`)

// NoStore 用于登录、用户数据及实时接口。
func NoStore(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

// requireTrailingSlash 保证使用相对资源路径的入口在缺少尾斜杠时跳转至带尾斜杠地址。
func requireTrailingSlash(root string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == root {
				target := root + "/"
				if r.URL.RawQuery != "" {
					target += "?" + r.URL.RawQuery
				}
				w.Header().Set("Cache-Control", "no-store")
				http.Redirect(w, r, target, http.StatusFound)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func (s *Server) musicAssetsHandler() http.Handler {
	assets, _ := fs.Sub(resources.FS(), "music")
	root := path.Join(conf.Server.BasePath, "/music")
	files := http.StripPrefix(root, http.FileServer(http.FS(assets)))
	r := chi.NewRouter()
	r.Use(NoStore, requireTrailingSlash(root))
	r.Get("/settings.js", func(w http.ResponseWriter, r *http.Request) {
		settings, _ := json.Marshal(map[string]any{
			"SERVER_NAME": "ndFork", "SERVER_TYPE": "navidrome",
			"SERVER_LOCK": true, "ANALYTICS_DISABLED": true,
			"SERVERMAN_URL":        conf.Server.ServerManURL,
			"REGISTRATION_ENABLED": conf.Server.ServerManURL == "" && conf.Server.EnableRegistration,
		})
		basePath, _ := json.Marshal(conf.Server.BasePath)
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		_, _ = fmt.Fprintf(w, "Object.assign(window, %s); window.SERVER_URL = location.origin + %s;", settings, basePath)
	})
	r.Handle("/*", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if rel, ok := strings.CutPrefix(r.URL.Path, root+"/"); ok && versionedAssetName.MatchString(path.Base(r.URL.Path)) {
			if _, err := fs.Stat(assets, rel); err == nil {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
		}
		if path.Base(r.URL.Path) == "sw.js" {
			w.Header().Set("Service-Worker-Allowed", root+"/")
		}
		files.ServeHTTP(w, r)
	}))
	return r
}
