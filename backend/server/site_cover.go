package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"time"

	. "github.com/Masterminds/squirrel"
	"github.com/go-chi/chi/v5"
	"github.com/navidrome/navidrome/core/artwork"
	"github.com/navidrome/navidrome/model"
	"github.com/navidrome/navidrome/model/request"
	"github.com/navidrome/navidrome/persistence"
	"github.com/zeebo/xxh3"
	_ "golang.org/x/image/webp"
)

func coverKind(kind string) model.Kind {
	switch kind {
	case "song":
		return model.KindMediaFileArtwork
	case "album":
		return model.KindAlbumArtwork
	default:
		return model.KindArtistArtwork
	}
}

func (s *Server) saveCover(w http.ResponseWriter, r *http.Request) {
	u, _ := request.UserFrom(r.Context())
	if !u.IsAdmin {
		siteError(w, 403, "需要管理员权限")
		return
	}
	kind, itemID := chi.URLParam(r, "kind"), chi.URLParam(r, "id")
	if _, err := s.metadataObject(r.Context(), kind, itemID); err != nil {
		siteError(w, 404, "对象不存在")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, artwork.MaxImageUploadSize())
	data, err := io.ReadAll(r.Body)
	if err != nil {
		siteError(w, 400, "图片超过大小限制")
		return
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width <= 0 || config.Height <= 0 || config.Width > 12000 || config.Height > 12000 || int64(config.Width)*int64(config.Height) > 40_000_000 {
		siteError(w, 400, "图片格式或尺寸无效")
		return
	}
	if _, _, err := image.Decode(bytes.NewReader(data)); err != nil {
		siteError(w, 400, "图片内容无效")
		return
	}
	siteMetadataMu.Lock()
	defer siteMetadataMu.Unlock()
	hash := fmt.Sprintf("%016x", xxh3.Hash(data))
	mime := "image/" + format
	if err = artwork.GetImageStore().Write(hash, mime, bytes.NewReader(data)); err != nil {
		siteError(w, 500, "保存图片失败")
		return
	}
	artKind := coverKind(kind)
	ctx := r.Context()
	err = s.ds.WithTx(func(tx model.DataStore) error {
		repo := tx.Artwork(ctx)
		original, err := repo.GetItemArtwork(artKind, itemID, model.ImageTypePrimary)
		if err != nil && !errors.Is(err, model.ErrNotFound) {
			return err
		}
		if original == nil {
			original = &model.ItemArtwork{ItemKind: artKind.Prefix(), ItemID: itemID, ImageType: model.ImageTypePrimary}
		}
		source, err := json.Marshal(original)
		if err != nil {
			return err
		}
		if err = repo.PutImage(&model.Artwork{Hash: hash, Mime: mime, Width: config.Width, Height: config.Height, SizeBytes: int64(len(data)), CreatedAt: time.Now()}); err != nil {
			return err
		}
		if err = persistence.SaveSiteArtwork(ctx, tx, artKind.Prefix(), itemID, hash, string(source)); err != nil {
			return err
		}
		original.Source = "site"
		if err = repo.PutItemArtwork(original); err != nil {
			return err
		}
		return touchArtworkMetadata(ctx, tx, kind, itemID, u.ID)
	})
	if err != nil {
		siteError(w, 500, "更新封面失败")
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]string{"hash": hash})
}

func (s *Server) restoreCover(w http.ResponseWriter, r *http.Request) {
	u, _ := request.UserFrom(r.Context())
	if !u.IsAdmin {
		siteError(w, 403, "需要管理员权限")
		return
	}
	kind, itemID := chi.URLParam(r, "kind"), chi.URLParam(r, "id")
	if _, err := s.metadataObject(r.Context(), kind, itemID); err != nil {
		siteError(w, 404, "对象不存在")
		return
	}
	artKind := coverKind(kind)
	siteMetadataMu.Lock()
	defer siteMetadataMu.Unlock()
	ctx := r.Context()
	err := s.ds.WithTx(func(tx model.DataStore) error {
		source, err := persistence.SiteArtworkSource(ctx, tx, artKind.Prefix(), itemID)
		if err != nil {
			return err
		}
		var original model.ItemArtwork
		if err = json.Unmarshal([]byte(source), &original); err != nil {
			return err
		}
		original.ItemID = itemID
		if err = persistence.ClearSiteArtwork(ctx, tx, artKind.Prefix(), itemID); err != nil {
			return err
		}
		if original.Hash == "" {
			err = tx.Artwork(ctx).DeleteForItems(artKind, []string{itemID})
		} else {
			err = tx.Artwork(ctx).PutItemArtwork(&original)
		}
		if err != nil {
			return err
		}
		return touchArtworkMetadata(ctx, tx, kind, itemID, u.ID)
	})
	if errors.Is(err, sql.ErrNoRows) {
		siteError(w, 404, "尚未设置封面覆写")
		return
	}
	if err != nil {
		siteError(w, 500, "恢复封面失败")
		return
	}
	w.WriteHeader(204)
}

func touchArtworkMetadata(ctx context.Context, tx model.DataStore, kind, itemID, userID string) error {
	at := time.Now().UTC()
	touch := func(kind, id string, item any) error {
		if err := persistence.RestoreMetadataSource(ctx, tx, kind, id, item); err != nil {
			return err
		}
		fields, err := model.MetadataValues(kind, item)
		if err != nil {
			return err
		}
		source, _ := json.Marshal(fields)
		// 更新时保留已有覆写规则。
		if err := persistence.TouchMetadata(ctx, tx, kind, id, string(source), userID, at); err != nil {
			return err
		}
		switch value := item.(type) {
		case *model.MediaFile:
			value.UpdatedAt = at
			return tx.MediaFile(ctx).Put(value)
		case *model.Album:
			value.UpdatedAt = at
			return tx.Album(ctx).Put(value)
		case *model.Artist:
			value.UpdatedAt = &at
			return tx.Artist(ctx).Put(value)
		}
		return nil
	}
	switch kind {
	case "song":
		item, e := tx.MediaFile(ctx).Get(itemID)
		if e != nil {
			return e
		}
		return touch(kind, itemID, item)
	case "artist":
		item, e := tx.Artist(ctx).Get(itemID)
		if e != nil {
			return e
		}
		return touch(kind, itemID, item)
	case "album":
		item, e := tx.Album(ctx).Get(itemID)
		if e != nil {
			return e
		}
		if e = touch(kind, itemID, item); e != nil {
			return e
		}
		tracks, e := tx.MediaFile(ctx).GetAll(model.QueryOptions{Filters: Eq{"album_id": itemID}})
		if e != nil {
			return e
		}
		for i := range tracks {
			if e = touch("song", tracks[i].ID, &tracks[i]); e != nil {
				return e
			}
		}
	}
	return nil
}
