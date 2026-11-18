package subsonic

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/navidrome/navidrome/conf"
	"github.com/navidrome/navidrome/core/stream"
	"github.com/navidrome/navidrome/model"
	"github.com/navidrome/navidrome/model/request"
	"github.com/navidrome/navidrome/server"
	"github.com/navidrome/navidrome/server/imghttp"
)

// MediaRouter 将媒体身份与输出规格集中到路径，沿用本站认证和音乐库权限。
func (api *Router) MediaRouter() http.Handler {
	r := chi.NewRouter()
	r.Use(server.NoStore)
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if token := r.URL.Query().Get("token"); token != "" {
				if !server.VerifyMediaPath(r.URL.Path, token, r.URL.Query().Get("t")) {
					http.Error(w, "媒体授权已失效", http.StatusUnauthorized)
					return
				}
				admin, err := api.ds.User(r.Context()).FindFirstAdmin()
				if err != nil {
					http.Error(w, "媒体服务不可用", http.StatusServiceUnavailable)
					return
				}
				r = r.WithContext(request.WithInternalAuth(r.Context(), admin.UserName))
			}
			next.ServeHTTP(w, r)
		})
	})
	r.Use(checkRequiredParameters)
	r.Use(authenticate(api.ds))
	r.Group(func(r chi.Router) {
		r.Use(server.ThrottleBacklog(conf.Server.DevArtworkMaxRequests,
			conf.Server.DevArtworkThrottleBacklogLimit, conf.Server.DevArtworkThrottleBacklogTimeout))
		r.Get("/cover/{id}/{size}/{shape}", api.mediaCover)
		r.Head("/cover/{id}/{size}/{shape}", api.mediaCover)
	})
	r.Group(func(r chi.Router) {
		r.Use(getPlayer(api.players))
		r.Get("/stream/{id}/{version}/{format}/{bitrate}/{offset}", api.mediaStream)
		r.Head("/stream/{id}/{version}/{format}/{bitrate}/{offset}", api.mediaStream)
	})
	return r
}

func (api *Router) mediaCover(w http.ResponseWriter, r *http.Request) {
	size, err := strconv.Atoi(chi.URLParam(r, "size"))
	shape := chi.URLParam(r, "shape")
	if err != nil || size < 0 || size > 2048 || (shape != "square" && shape != "fit") {
		http.Error(w, "封面规格无效", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	id, err := url.PathUnescape(chi.URLParam(r, "id"))
	if err != nil {
		http.Error(w, "封面标识无效", http.StatusBadRequest)
		return
	}
	artID, err := model.ParseArtworkID(id)
	if err != nil {
		http.Error(w, "封面标识无效", http.StatusBadRequest)
		return
	}
	img, err := api.artwork.GetOrPlaceholder(ctx, id, size, shape == "square")
	if err != nil {
		mediaError(w, err)
		return
	}
	defer img.Close()
	if artID.Hash != "" && artID.Hash != img.Hash {
		http.Error(w, "封面版本已更新", http.StatusGone)
		return
	}
	if artID.Kind == model.KindMediaFileArtwork && img.Hash != "" {
		mf, err := api.ds.MediaFile(ctx).Get(artID.ID)
		if err != nil {
			mediaError(w, err)
			return
		}
		if mf.AlbumImage.ImageHash == img.Hash {
			canonical := url.URL{
				Path: path.Join(conf.Server.BasePath, "/media/cover", mf.AlbumCoverArtID().String(),
					strconv.Itoa(size), shape),
				RawQuery: r.URL.RawQuery,
			}
			if r.URL.Query().Get("token") != "" {
				query := canonical.Query()
				query.Set("token", server.SignMediaPath(canonical.Path, query.Get("t")))
				canonical.RawQuery = query.Encode()
			}
			http.Redirect(w, r, canonical.String(), http.StatusTemporaryRedirect)
			return
		}
	}
	if imghttp.WritePrivateImageHeaders(w, r, img, artID.Hash) || r.Method == http.MethodHead {
		return
	}
	_, _ = io.Copy(w, img)
}

func (api *Router) mediaStream(w http.ResponseWriter, r *http.Request) {
	mf, err := api.ds.MediaFile(r.Context()).Get(chi.URLParam(r, "id"))
	if err != nil {
		mediaError(w, err)
		return
	}
	versionText, err := url.PathUnescape(chi.URLParam(r, "version"))
	if err != nil {
		http.Error(w, "音频版本无效", http.StatusBadRequest)
		return
	}
	version, err := time.Parse(time.RFC3339Nano, versionText)
	if err != nil || !version.Equal(mf.UpdatedAt) {
		http.Error(w, "音频版本已更新", http.StatusGone)
		return
	}
	format := chi.URLParam(r, "format")
	bitrate, bitrateErr := strconv.Atoi(chi.URLParam(r, "bitrate"))
	offset, offsetErr := strconv.Atoi(chi.URLParam(r, "offset"))
	if bitrateErr != nil || offsetErr != nil || bitrate < 0 || offset < 0 ||
		(format != "raw" && format != "mp3" && format != "opus" && format != "aac" && format != "auto") ||
		(format == "raw" && (bitrate != 0 || offset != 0)) {
		http.Error(w, "音频规格无效", http.StatusBadRequest)
		return
	}
	if format == "auto" {
		format = ""
	}
	streamReq := api.transcodeDecision.ResolveRequest(r.Context(), mf, format, bitrate, offset)
	media, err := api.streamer.NewStream(r.Context(), mf, streamReq)
	if err != nil {
		mediaError(w, err)
		return
	}
	defer media.Close()
	if format == "raw" {
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
		w.Header().Set("ETag",`"`+mf.ID+"."+strconv.FormatInt(mf.UpdatedAt.UnixNano(),10)+`"`)
		if r.URL.Query().Get("token") != "" {
			w.Header().Set("CDN-Cache-Control", "public, max-age=31536000, immutable")
		}
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Content-Duration", strconv.FormatFloat(float64(media.Duration()), 'G', -1, 32))
	_, err = media.Serve(r.Context(), w, r)
	if err != nil {
		w.Header().Set("Cache-Control", "no-store")
		mediaError(w, err)
	}
}

func mediaError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, model.ErrNotFound):
		http.Error(w, "媒体不存在", http.StatusNotFound)
	case errors.Is(err, model.ErrNotAuthorized):
		http.Error(w, "无权访问媒体", http.StatusForbidden)
	case errors.Is(err, stream.ErrTooManyTranscodes):
		w.Header().Set("Retry-After", strconv.Itoa(stream.RetryAfterSeconds))
		http.Error(w, "转码繁忙，请稍后重试", http.StatusTooManyRequests)
	default:
		http.Error(w, "读取媒体失败", http.StatusInternalServerError)
	}
}
