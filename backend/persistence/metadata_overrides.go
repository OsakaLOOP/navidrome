package persistence

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	. "github.com/Masterminds/squirrel"
	"github.com/navidrome/navidrome/model"
	"github.com/pocketbase/dbx"
)

func SiteArtworkSource(ctx context.Context, store model.DataStore, kind, id string) (string, error) {
	var source string
	err := store.(*SQLStore).db.NewQuery(`SELECT source FROM site_artwork WHERE kind={:kind} AND item_id={:id}`).Bind(dbx.Params{"kind": kind, "id": id}).WithContext(ctx).Row(&source)
	return source, err
}

func SaveSiteArtwork(ctx context.Context, store model.DataStore, kind, id, hash, source string) error {
	_, err := store.(*SQLStore).db.NewQuery(`INSERT INTO site_artwork(kind,item_id,hash,source) VALUES({:kind},{:id},{:hash},{:source}) ON CONFLICT(kind,item_id) DO UPDATE SET hash=excluded.hash`).Bind(dbx.Params{"kind": kind, "id": id, "hash": hash, "source": source}).WithContext(ctx).Execute()
	return err
}

func ClearSiteArtwork(ctx context.Context, store model.DataStore, kind, id string) error {
	_, err := store.(*SQLStore).db.NewQuery(`DELETE FROM site_artwork WHERE kind={:kind} AND item_id={:id}`).Bind(dbx.Params{"kind": kind, "id": id}).WithContext(ctx).Execute()
	return err
}

func MoveSiteAlbum(ctx context.Context, store model.DataStore, from, to string) error {
	conn := store.(*SQLStore).db
	for _, statement := range []string{
		`UPDATE site_metadata SET item_id={:to} WHERE kind='album' AND item_id={:from}`,
		`UPDATE site_artwork SET item_id={:to} WHERE kind='al' AND item_id={:from}`,
		`UPDATE item_artwork SET item_id={:to} WHERE item_kind='al' AND item_id={:from} AND EXISTS(SELECT 1 FROM site_artwork WHERE kind='al' AND item_id={:to})`,
		`UPDATE site_comment SET item_id={:to} WHERE kind='album' AND item_id={:from}`,
	} {
		if _, err := conn.NewQuery(statement).Bind(dbx.Params{"from": from, "to": to}).WithContext(ctx).Execute(); err != nil {
			return err
		}
	}
	return nil
}

func MoveSiteAlbumIfNeeded(ctx context.Context, store model.DataStore, from, to string) (bool, error) {
	var exists bool
	err := store.(*SQLStore).db.NewQuery(`SELECT EXISTS(SELECT 1 FROM site_metadata WHERE kind='album' AND item_id={:from} UNION ALL SELECT 1 FROM site_artwork WHERE kind='al' AND item_id={:from} UNION ALL SELECT 1 FROM site_comment WHERE kind='album' AND item_id={:from})`).Bind(dbx.Params{"from": from}).WithContext(ctx).Row(&exists)
	if err != nil || !exists {
		return false, err
	}
	return true, MoveSiteAlbum(ctx, store, from, to)
}

// 与对象及搜索索引共用调用方事务。
func SaveMetadata(ctx context.Context, store model.DataStore, kind, id, source, overrides, user string, at time.Time) error {
	s := store.(*SQLStore)
	_, err := s.db.NewQuery(`INSERT INTO site_metadata(kind,item_id,source,overrides,updated_by,updated_at) VALUES({:kind},{:id},{:source},{:overrides},{:user},{:at}) ON CONFLICT(kind,item_id) DO UPDATE SET source=excluded.source,overrides=excluded.overrides,updated_by=excluded.updated_by,updated_at=excluded.updated_at`).Bind(dbx.Params{"kind": kind, "id": id, "source": source, "overrides": overrides, "user": user, "at": at}).WithContext(ctx).Execute()
	return err
}

func TouchMetadata(ctx context.Context, store model.DataStore, kind, id, source, user string, at time.Time) error {
	s := store.(*SQLStore)
	_, err := s.db.NewQuery(`INSERT INTO site_metadata(kind,item_id,source,overrides,updated_by,updated_at) VALUES({:kind},{:id},{:source},'{}',{:user},{:at}) ON CONFLICT(kind,item_id) DO UPDATE SET updated_by=excluded.updated_by,updated_at=excluded.updated_at`).Bind(dbx.Params{"kind": kind, "id": id, "source": source, "user": user, "at": at}).WithContext(ctx).Execute()
	return err
}

func RestoreMetadataSource(ctx context.Context, store model.DataStore, kind, id string, value any) error {
	s := store.(*SQLStore)
	var row struct {
		Source string `db:"source"`
	}
	err := s.db.NewQuery("SELECT source FROM site_metadata WHERE kind={:kind} AND item_id={:id}").Bind(dbx.Params{"kind": kind, "id": id}).WithContext(ctx).One(&row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return json.Unmarshal([]byte(row.Source), value)
}

// 扫描写入先保存基础值，再合并持久化覆写；所有查询与搜索读取合并后的索引。
func (r sqlRepository) applyMetadata(kind, id string, value any) error {
	var row struct {
		Source    string    `db:"source"`
		Overrides string    `db:"overrides"`
		UpdatedAt time.Time `db:"updated_at"`
	}
	err := r.db.NewQuery("SELECT source,overrides,updated_at FROM site_metadata WHERE kind={:kind} AND item_id={:id}").Bind(dbx.Params{"kind": kind, "id": id}).One(&row)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if errors.Is(err, sql.ErrNoRows) {
		return r.inheritMetadata(value)
	}
	source, err := model.MetadataValues(kind, value)
	if err != nil {
		return err
	}
	// 扫描器对歌手采用部分字段写入，保留其资料基础值。
	if kind == "artist" {
		var previous map[string]json.RawMessage
		_ = json.Unmarshal([]byte(row.Source), &previous)
		for _, field := range []string{"biography"} {
			if v, ok := previous[field]; ok && string(source[field]) == "\"\"" {
				source[field] = v
			}
		}
	}
	data, err := json.Marshal(source)
	if err != nil {
		return err
	}
	if _, err = r.executeSQL(Update("site_metadata").Set("source", string(data)).Where(Eq{"kind": kind, "item_id": id})); err != nil {
		return err
	}
	if err = json.Unmarshal([]byte(row.Overrides), &source); err != nil {
		return err
	}
	data, err = json.Marshal(source)
	if err != nil {
		return err
	}
	if err = json.Unmarshal(data, value); err != nil {
		return err
	}
	switch v := value.(type) {
	case *model.MediaFile:
		if row.UpdatedAt.After(v.UpdatedAt) {
			v.UpdatedAt = row.UpdatedAt
		}
		v.OrderTitle = metadataOrder(v.SortTitle, v.Title)
		v.OrderArtistName = metadataOrder(v.SortArtistName, v.Artist)
		v.OrderAlbumArtistName = metadataOrder(v.SortAlbumArtistName, v.AlbumArtist)
	case *model.Album:
		if row.UpdatedAt.After(v.UpdatedAt) {
			v.UpdatedAt = row.UpdatedAt
		}
		v.OrderAlbumName = metadataOrder(v.SortAlbumName, v.Name)
		v.OrderAlbumArtistName = metadataOrder(v.SortAlbumArtistName, v.AlbumArtist)
	case *model.Artist:
		if v.UpdatedAt == nil || row.UpdatedAt.After(*v.UpdatedAt) {
			v.UpdatedAt = &row.UpdatedAt
		}
		v.OrderArtistName = metadataOrder(v.SortArtistName, v.Name)
	}
	return r.inheritMetadata(value)
}

func metadataOrder(sortName, name string) string {
	if sortName != "" {
		return strings.ToLower(sortName)
	}
	return strings.ToLower(name)
}

func (r sqlRepository) inheritMetadata(value any) error {
	var participants model.Participants
	var modified time.Time
	switch v := value.(type) {
	case *model.MediaFile:
		participants = v.Participants
		var album struct {
			Overrides string    `db:"overrides"`
			UpdatedAt time.Time `db:"updated_at"`
		}
		err := r.db.NewQuery("SELECT overrides,updated_at FROM site_metadata WHERE kind='album' AND item_id={:id}").Bind(dbx.Params{"id": v.AlbumID}).One(&album)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if err == nil {
			var fields map[string]json.RawMessage
			if err = json.Unmarshal([]byte(album.Overrides), &fields); err != nil {
				return err
			}
			var own struct {
				Overrides string `db:"overrides"`
			}
			ownFields := map[string]json.RawMessage{}
			if r.db.NewQuery("SELECT overrides FROM site_metadata WHERE kind='song' AND item_id={:id}").Bind(dbx.Params{"id": v.ID}).One(&own) == nil {
				_ = json.Unmarshal([]byte(own.Overrides), &ownFields)
			}
			if name, ok := fields["name"]; ok && ownFields["album"] == nil {
				_ = json.Unmarshal(name, &v.Album)
			}
			if raw, ok := fields["albumArtist"]; ok && ownFields["albumArtist"] == nil {
				_ = json.Unmarshal(raw, &v.AlbumArtist)
				_ = json.Unmarshal(fields["albumArtistId"], &v.AlbumArtistID)
				var albumParticipants model.Participants
				_ = json.Unmarshal(fields["participants"], &albumParticipants)
				if participants == nil {
					participants = model.Participants{}
				}
				participants[model.RoleAlbumArtist] = albumParticipants[model.RoleAlbumArtist]
			}
			modified = album.UpdatedAt
		}
	case *model.Album:
		participants = v.Participants
	default:
		return nil
	}
	// 歌手覆写通过同一 ID 更新所有参与者名称。
	for role, list := range participants {
		for i := range list {
			var artist struct {
				Overrides string    `db:"overrides"`
				UpdatedAt time.Time `db:"updated_at"`
			}
			err := r.db.NewQuery("SELECT overrides,updated_at FROM site_metadata WHERE kind='artist' AND item_id={:id}").Bind(dbx.Params{"id": list[i].ID}).One(&artist)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			if err == nil {
				var fields map[string]json.RawMessage
				if json.Unmarshal([]byte(artist.Overrides), &fields) != nil {
					continue
				}
				if name, ok := fields["name"]; ok {
					_ = json.Unmarshal(name, &list[i].Name)
				}
				if artist.UpdatedAt.After(modified) {
					modified = artist.UpdatedAt
				}
			}
		}
		participants[role] = list
	}
	switch v := value.(type) {
	case *model.MediaFile:
		v.Participants = participants
		if len(participants[model.RoleArtist]) > 0 {
			v.Artist = participants[model.RoleArtist].Join(" / ")
			v.ArtistID = participants.First(model.RoleArtist).ID
		}
		if len(participants[model.RoleAlbumArtist]) > 0 {
			v.AlbumArtist = participants[model.RoleAlbumArtist].Join(" / ")
			v.AlbumArtistID = participants.First(model.RoleAlbumArtist).ID
		}
		if modified.After(v.UpdatedAt) {
			v.UpdatedAt = modified
		}
	case *model.Album:
		v.Participants = participants
		if len(participants[model.RoleAlbumArtist]) > 0 {
			v.AlbumArtist = participants[model.RoleAlbumArtist].Join(" / ")
			v.AlbumArtistID = participants.First(model.RoleAlbumArtist).ID
		}
		if modified.After(v.UpdatedAt) {
			v.UpdatedAt = modified
		}
	}
	return nil
}
