package server

import (
	"crypto/md5"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/navidrome/navidrome/conf"
	"github.com/navidrome/navidrome/model"
	"github.com/navidrome/navidrome/model/request"
)

// EdgeOne D 类型采用十进制签发时间，签名覆盖完整媒体路径。
func SignMediaPath(path, timestamp string) string {
	sum := md5.Sum([]byte(conf.Server.MediaSigningKey + path + timestamp))
	return hex.EncodeToString(sum[:])
}

func VerifyMediaPath(path, token, timestamp string) bool {
	if conf.Server.MediaSigningKey == "" {
		return false
	}
	issued, err := strconv.ParseInt(timestamp, 10, 64)
	now := time.Now().Unix()
	if err != nil || issued > now+30 || now-issued > 900 {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(token), []byte(SignMediaPath(path, timestamp))) == 1
}

func (s *Server) mediaGrant(w http.ResponseWriter, r *http.Request) {
	resource, decodeErr := url.PathUnescape(chi.URLParam(r, "*"))
	if decodeErr != nil {
		siteError(w, 400, "媒体路径编码无效")
		return
	}
	parts := strings.Split(resource, "/")
	if len(parts) < 2 {
		siteError(w, 400, "媒体路径无效")
		return
	}
	var err error
	switch parts[0] {
	case "stream":
		if len(parts) != 6 {
			siteError(w, 400, "音频规格无效")
			return
		}
		_, err = s.ds.MediaFile(r.Context()).Get(parts[1])
	case "cover":
		if len(parts) != 4 {
			siteError(w, 400, "封面规格无效")
			return
		}
		var art model.ArtworkID
		art, err = model.ParseArtworkID(parts[1])
		if err == nil {
			switch art.Kind {
			case model.KindMediaFileArtwork:
				_, err = s.ds.MediaFile(r.Context()).Get(art.ID)
			case model.KindAlbumArtwork:
				_, err = s.ds.Album(r.Context()).Get(art.ID)
			case model.KindArtistArtwork:
				_, err = s.ds.Artist(r.Context()).Get(art.ID)
			case model.KindPlaylistArtwork:
				_, err = s.ds.Playlist(r.Context()).Get(art.ID)
			case model.KindDiscArtwork:
				var albumID string
				albumID, _, err = model.ParseDiscArtworkID(art.ID)
				if err == nil {
					_, err = s.ds.Album(r.Context()).Get(albumID)
				}
			default:
				err = model.ErrNotAuthorized
			}
		}
	default:
		siteError(w, 400, "媒体类型无效")
		return
	}
	if err != nil {
		siteError(w, 404, "媒体不可访问")
		return
	}
	user, _ := request.UserFrom(r.Context())
	mediaPath := conf.Server.BasePath + "/media/" + resource
	query := url.Values{"v": {"1.16.1"}, "c": {"ndFork"}}
	if conf.Server.MediaSigningKey != "" {
		timestamp := strconv.FormatInt(time.Now().Unix(), 10)
		query.Set("token", SignMediaPath(mediaPath, timestamp))
		query.Set("t", timestamp)
	} else {
		query.Set("u", user.UserName)
		query.Set("jwt", r.URL.Query().Get("jwt"))
		if query.Get("jwt") == "" {
			query.Set("jwt", strings.TrimPrefix(r.Header.Get("x-nd-authorization"), "Bearer "))
		}
	}
	target := strings.TrimRight(conf.Server.MediaPublicURL, "/") + (&url.URL{Path: mediaPath, RawQuery: query.Encode()}).String()
	if r.URL.Query().Get("resolve") == "1" {
		_ = json.NewEncoder(w).Encode(map[string]any{"url": target, "expires": time.Now().Add(14 * time.Minute).Unix()})
		return
	}
	http.Redirect(w, r, target, http.StatusTemporaryRedirect)
}
