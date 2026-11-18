package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	. "github.com/Masterminds/squirrel"
	"github.com/go-chi/chi/v5"
	"github.com/navidrome/navidrome/core/artwork"
	"github.com/navidrome/navidrome/core/ffmpeg"
	"github.com/navidrome/navidrome/core/playlists"
	"github.com/navidrome/navidrome/db"
	"github.com/navidrome/navidrome/model"
	"github.com/navidrome/navidrome/model/id"
	"github.com/navidrome/navidrome/model/request"
	"github.com/navidrome/navidrome/persistence"
	"github.com/navidrome/navidrome/scanner"
)

var siteMetadataMu sync.Mutex

func (s *Server) metadataTracks(ctx context.Context, kind, itemID string) (model.MediaFiles, error) {
	if kind == "song" {
		song, err := s.ds.MediaFile(ctx).Get(itemID)
		if err != nil {
			return nil, err
		}
		return model.MediaFiles{*song}, nil
	}
	return s.ds.MediaFile(ctx).GetAll(model.QueryOptions{Filters: Eq{"album_id": itemID}})
}

func (s *Server) metadataObject(ctx context.Context, kind, id string) (any, error) {
	switch kind {
	case "song":
		return s.ds.MediaFile(ctx).Get(id)
	case "album":
		return s.ds.Album(ctx).Get(id)
	case "artist":
		return s.ds.Artist(ctx).Get(id)
	}
	return nil, model.ErrNotFound
}

func (s *Server) getMetadata(w http.ResponseWriter, r *http.Request) {
	kind, id := chi.URLParam(r, "kind"), chi.URLParam(r, "id")
	item, err := s.metadataObject(r.Context(), kind, id)
	if err != nil {
		siteError(w, 404, "对象不可访问")
		return
	}
	source, err := model.MetadataValues(kind, item)
	if err != nil {
		siteError(w, 500, "读取元数据失败")
		return
	}
	overrides := map[string]json.RawMessage{}
	var sourceText, overrideText, revision string
	err = db.Db().QueryRowContext(r.Context(), "SELECT source,overrides,CAST(updated_at AS TEXT) FROM site_metadata WHERE kind=? AND item_id=?", kind, id).Scan(&sourceText, &overrideText, &revision)
	if err == nil {
		_ = json.Unmarshal([]byte(sourceText), &source)
		_ = json.Unmarshal([]byte(overrideText), &overrides)
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		siteError(w, 500, "读取元数据失败")
		return
	}
	fields := model.MetadataFields(kind)
	result := map[string]any{"source": source, "overrides": overrides, "fields": fields, "revision": revision}
	u, _ := request.UserFrom(r.Context())
	if u.IsAdmin {
		result["fileFields"] = slices.Sorted(maps.Keys(model.FileTagFields(kind)))
		if kind != "artist" {
			tracks, err := s.metadataTracks(r.Context(), kind, id)
			if err != nil {
				siteError(w, 500, "读取受影响曲目失败")
				return
			}
			files := make([]string, 0, len(tracks))
			for _, song := range tracks {
				files = append(files, song.Path)
			}
			slices.Sort(files)
			result["files"] = files
		}
		var pinned bool
		if err := db.Db().QueryRowContext(r.Context(), "SELECT EXISTS(SELECT 1 FROM site_artwork WHERE kind=? AND item_id=?)", coverKind(kind).Prefix(), id).Scan(&pinned); err != nil {
			siteError(w, 500, "读取封面状态失败")
			return
		}
		result["coverOverride"] = pinned
	}
	_ = json.NewEncoder(w).Encode(result)
}

func (s *Server) saveMetadata(w http.ResponseWriter, r *http.Request) {
	u, _ := request.UserFrom(r.Context())
	if !u.IsAdmin {
		siteError(w, 403, "需要管理员权限")
		return
	}
	siteMetadataMu.Lock()
	defer siteMetadataMu.Unlock()
	releaseScan, ok := scanner.LockForMaintenance()
	if !ok {
		siteError(w, 409, "请等待音乐库扫描完成")
		return
	}
	defer func() { releaseScan() }()
	kind, itemID := chi.URLParam(r, "kind"), chi.URLParam(r, "id")
	item, err := s.metadataObject(r.Context(), kind, itemID)
	if err != nil {
		siteError(w, 404, "对象不存在")
		return
	}
	var input struct {
		Mode     string                     `json:"mode"`
		Fields   map[string]json.RawMessage `json:"fields"`
		Restore  []string                   `json:"restore"`
		Revision string                     `json:"revision"`
		Artists  map[string][]string        `json:"artists"`
		Files    []string                   `json:"files"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
	if json.NewDecoder(r.Body).Decode(&input) != nil || (input.Mode != "override" && input.Mode != "edit") {
		siteError(w, 400, "编辑内容无效")
		return
	}
	for field, value := range input.Fields {
		_, fileField := model.FileTagFields(kind)[field]
		if (input.Mode == "edit" && !fileField) || (input.Mode == "override" && (!slices.Contains(model.MetadataFields(kind), field) || slices.Contains([]string{"artistId", "albumArtistId", "participants"}, field))) || string(value) == "null" {
			siteError(w, 400, "字段无效："+field)
			return
		}
		if slices.Contains([]string{"year", "minYear", "maxYear", "fileYear", "trackNumber", "discNumber"}, field) {
			var number int
			if json.Unmarshal(value, &number) != nil || number < 0 || number > 9999 {
				siteError(w, 400, "编号或年份超出范围："+field)
				return
			}
		} else {
			var text string
			if json.Unmarshal(value, &text) != nil || strings.ContainsRune(text, 0) || ((field == "title" || field == "name") && strings.TrimSpace(text) == "") {
				siteError(w, 400, "字段内容无效："+field)
				return
			}
		}
	}
	for _, field := range input.Restore {
		if input.Mode != "override" || !slices.Contains(model.MetadataFields(kind), field) || slices.Contains([]string{"artistId", "albumArtistId", "participants"}, field) {
			siteError(w, 400, "恢复字段无效："+field)
			return
		}
	}
	for field := range input.Artists {
		if input.Mode != "override" || (field != "artist" && field != "albumArtist") || !slices.Contains(model.MetadataFields(kind), field) || input.Fields[field] == nil {
			siteError(w, 400, "歌手选择无效")
			return
		}
	}
	inputData, _ := json.Marshal(input.Fields)
	if err = json.Unmarshal(inputData, item); err != nil {
		siteError(w, 400, "字段类型无效")
		return
	}
	item, err = s.metadataObject(r.Context(), kind, itemID)
	if err != nil {
		siteError(w, 404, "对象不存在")
		return
	}
	source, err := model.MetadataValues(kind, item)
	if err != nil {
		siteError(w, 500, "读取元数据失败")
		return
	}
	var sourceText, overrideText, revision string
	overrides := map[string]json.RawMessage{}
	err = db.Db().QueryRowContext(r.Context(), "SELECT source,overrides,CAST(updated_at AS TEXT) FROM site_metadata WHERE kind=? AND item_id=?", kind, itemID).Scan(&sourceText, &overrideText, &revision)
	if err == nil {
		_ = json.Unmarshal([]byte(sourceText), &source)
		_ = json.Unmarshal([]byte(overrideText), &overrides)
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		siteError(w, 500, "读取元数据失败")
		return
	}
	if input.Revision != revision {
		siteError(w, 409, "元数据已更新，请重新读取后再保存")
		return
	}
	if input.Mode == "override" {
		for key, value := range input.Fields {
			overrides[key] = value
		}
	}
	for _, key := range input.Restore {
		delete(overrides, key)
		if key == "artist" {
			delete(overrides, "artistId")
		}
		if key == "albumArtist" {
			delete(overrides, "albumArtistId")
		}
	}
	for _, fields := range []map[string]json.RawMessage{source, overrides} {
		if raw, ok := fields["lyrics"]; ok {
			var text string
			var parsedLyrics model.LyricList
			if json.Unmarshal(raw, &text) == nil && json.Unmarshal([]byte(text), &parsedLyrics) != nil {
				lyrics, e := model.ParseLyrics(r.Context(), ".lrc", "und", []byte(text))
				if e != nil {
					siteError(w, 400, "歌词格式无效")
					return
				}
				parsed, _ := json.Marshal(lyrics)
				fields["lyrics"], _ = json.Marshal(string(parsed))
			}
		}
	}
	sourceData, _ := json.Marshal(source)
	overrideData, _ := json.Marshal(overrides)
	if err = json.Unmarshal(sourceData, item); err != nil {
		siteError(w, 400, "字段类型无效")
		return
	}
	// 先验证合成数据，确保类型错误不会修改已保存的规则。
	merged := map[string]json.RawMessage{}
	for k, v := range source {
		merged[k] = v
	}
	for k, v := range overrides {
		merged[k] = v
	}
	mergedData, _ := json.Marshal(merged)
	if err = json.Unmarshal(mergedData, item); err != nil {
		siteError(w, 400, "字段类型无效")
		return
	}
	_ = json.Unmarshal(sourceData, item)
	if input.Mode == "edit" {
		if len(input.Fields) == 0 {
			siteError(w, 400, "请选择要写入的标签")
			return
		}
		var fromAlbum string
		var originalSongs model.MediaFiles
		if kind == "album" {
			fromAlbum = itemID
			originalSongs, err = s.metadataTracks(r.Context(), kind, itemID)
		} else if input.Fields["album"] != nil || input.Fields["albumArtist"] != nil {
			fromAlbum = item.(*model.MediaFile).AlbumID
			originalSongs, err = s.metadataTracks(r.Context(), "album", fromAlbum)
			if len(originalSongs) != 1 {
				originalSongs = nil
			}
		}
		if err != nil {
			siteError(w, 500, "读取专辑曲目失败")
			return
		}
		targets, err := s.editFileTags(r.Context(), kind, itemID, input.Fields, input.Files)
		if err != nil {
			siteError(w, 422, err.Error())
			return
		}
		releaseScan()
		releaseScan = func() {}
		response := map[string]any{"filesSaved": true}
		progress, err := scanner.CallScan(context.WithoutCancel(r.Context()), s.ds, playlists.NewPlaylists(s.ds, artwork.NewUploader(s.ds)), false, targets)
		if err != nil {
			response["scanWarning"] = "文件已写入，请在当前扫描结束后重新扫描受影响的文件夹。"
		} else {
			for result := range progress {
				if result.Error != "" {
					response["scanWarning"] = "文件已写入，音乐库扫描失败：" + result.Error
				}
			}
		}
		if response["scanWarning"] == nil && len(originalSongs) > 0 {
			if err := s.reconcileEditedAlbum(context.WithoutCancel(r.Context()), fromAlbum, originalSongs); err != nil {
				response["scanWarning"] = "文件已写入，专辑资料迁移失败：" + err.Error()
			}
		}
		_ = json.NewEncoder(w).Encode(response)
		return
	}
	modified := time.Now().UTC()
	err = s.ds.WithTx(func(tx model.DataStore) error {
		if e := resolveMetadataArtists(r.Context(), tx, kind, source, overrides, input.Fields, input.Artists); e != nil {
			return e
		}
		overrideData, _ = json.Marshal(overrides)
		if e := persistence.SaveMetadata(r.Context(), tx, kind, itemID, string(sourceData), string(overrideData), u.ID, modified); e != nil {
			return e
		}
		switch v := item.(type) {
		case *model.MediaFile:
			v.UpdatedAt = modified
			if e := tx.MediaFile(r.Context()).Put(v); e != nil {
				return e
			}
			for _, artistID := range v.Participants.AllIDs() {
				if e := tx.Library(r.Context()).AddArtist(v.LibraryID, artistID); e != nil {
					return e
				}
			}
			return nil
		case *model.Album:
			v.UpdatedAt = modified
			if e := tx.Album(r.Context()).Put(v); e != nil {
				return e
			}
			tracks, e := tx.MediaFile(r.Context()).GetAll(model.QueryOptions{Filters: Eq{"album_id": itemID}})
			if e != nil {
				return e
			}
			for _, song := range tracks {
				if e = persistence.RestoreMetadataSource(r.Context(), tx, "song", song.ID, &song); e != nil {
					return e
				}
				song.UpdatedAt = modified
				if e = tx.MediaFile(r.Context()).Put(&song); e != nil {
					return e
				}
				for _, artistID := range song.Participants.AllIDs() {
					if e = tx.Library(r.Context()).AddArtist(song.LibraryID, artistID); e != nil {
						return e
					}
				}
			}
		case *model.Artist:
			v.UpdatedAt = &modified
			if e := tx.Artist(r.Context()).Put(v); e != nil {
				return e
			}
			tracks, e := tx.MediaFile(r.Context()).GetAll(model.QueryOptions{Filters: persistence.ParticipantIDFilter("media_file", itemID)})
			if e != nil {
				return e
			}
			for _, song := range tracks {
				if e = persistence.RestoreMetadataSource(r.Context(), tx, "song", song.ID, &song); e != nil {
					return e
				}
				for role, list := range song.Participants {
					for i := range list {
						if list[i].ID == itemID {
							list[i].Name = v.Name
						}
					}
					song.Participants[role] = list
				}
				song.UpdatedAt = modified
				if e = tx.MediaFile(r.Context()).Put(&song); e != nil {
					return e
				}
			}
			albums, e := tx.Album(r.Context()).GetAll(model.QueryOptions{Filters: persistence.ParticipantIDFilter("album", itemID)})
			if e != nil {
				return e
			}
			for _, album := range albums {
				if e = persistence.RestoreMetadataSource(r.Context(), tx, "album", album.ID, &album); e != nil {
					return e
				}
				for role, list := range album.Participants {
					for i := range list {
						if list[i].ID == itemID {
							list[i].Name = v.Name
						}
					}
					album.Participants[role] = list
				}
				album.UpdatedAt = modified
				if e = tx.Album(r.Context()).Put(&album); e != nil {
					return e
				}
			}
		}
		return nil
	})
	if err != nil {
		siteError(w, 422, err.Error())
		return
	}
	s.getMetadata(w, r)
}

func (s *Server) reconcileEditedAlbum(ctx context.Context, from string, original model.MediaFiles) error {
	return s.ds.WithTx(func(tx model.DataStore) error {
		track, err := tx.MediaFile(ctx).Get(original[0].ID)
		if err != nil || track.AlbumID == from {
			return err
		}
		to := track.AlbumID
		tracks, err := tx.MediaFile(ctx).GetAll(model.QueryOptions{Filters: Eq{"album_id": to}})
		if err != nil || len(tracks) != len(original) {
			return err
		}
		ids := make(map[string]bool, len(original))
		for _, song := range original {
			ids[song.ID] = true
		}
		if slices.ContainsFunc(tracks, func(song model.MediaFile) bool { return !ids[song.ID] }) {
			return nil
		}
		moved, err := persistence.MoveSiteAlbumIfNeeded(ctx, tx, from, to)
		if err != nil || !moved {
			return err
		}
		album, err := tx.Album(ctx).Get(to)
		if err != nil {
			return err
		}
		if err = tx.Album(ctx).Put(album); err != nil {
			return err
		}
		for _, song := range tracks {
			if err = persistence.RestoreMetadataSource(ctx, tx, "song", song.ID, &song); err != nil {
				return err
			}
			if err = tx.MediaFile(ctx).Put(&song); err != nil {
				return err
			}
		}
		return nil
	})
}

func resolveMetadataArtists(ctx context.Context, tx model.DataStore, kind string, source, overrides, changed map[string]json.RawMessage, selected map[string][]string) error {
	if kind == "artist" {
		return nil
	}
	var base, previous model.Participants
	_ = json.Unmarshal(source["participants"], &base)
	_ = json.Unmarshal(overrides["participants"], &previous)
	if base == nil {
		base = model.Participants{}
	}
	active := false
	for _, entry := range []struct {
		Field, ID string
		Role      model.Role
	}{{"artist", "artistId", model.RoleArtist}, {"albumArtist", "albumArtistId", model.RoleAlbumArtist}} {
		if overrides[entry.Field] == nil {
			continue
		}
		active = true
		if changed[entry.Field] == nil {
			base[entry.Role] = previous[entry.Role]
			continue
		}
		delete(base, entry.Role)
		var names string
		_ = json.Unmarshal(changed[entry.Field], &names)
		if artistIDs, ok := selected[entry.Field]; ok {
			for _, artistID := range artistIDs {
				if name, newArtist := strings.CutPrefix(artistID, "new:"); newArtist {
					name = strings.TrimSpace(name)
					if name == "" || len(name) > 400 || strings.ContainsAny(name, "\x00;\r\n") {
						return fmt.Errorf("新歌手名称无效")
					}
					existing, err := tx.Artist(ctx).GetAll(model.QueryOptions{Filters: Eq{"name": name}, Max: 1})
					if err != nil {
						return err
					}
					if len(existing) != 0 {
						return fmt.Errorf("同名歌手已存在，请重新搜索并选择：%s", name)
					}
					artist := model.Artist{ID: id.NewRandom(), Name: name, OrderArtistName: strings.ToLower(name)}
					if err := tx.Artist(ctx).Put(&artist); err != nil {
						return err
					}
					base.Add(entry.Role, artist)
					continue
				}
				artist, err := tx.Artist(ctx).Get(artistID)
				if err != nil {
					return fmt.Errorf("选中的歌手不存在：%s", artistID)
				}
				base.Add(entry.Role, *artist)
			}
		} else {
			for _, name := range strings.Split(names, ";") {
				name = strings.TrimSpace(name)
				if name == "" {
					continue
				}
				artists, err := tx.Artist(ctx).GetAll(model.QueryOptions{Filters: Eq{"name": name}, Max: 2})
				if err != nil {
					return err
				}
				if len(artists) != 1 {
					return fmt.Errorf("请选择已有歌手：%s", name)
				}
				base.Add(entry.Role, artists[0])
			}
		}
		values := []string{}
		for _, artist := range base[entry.Role] {
			values = append(values, artist.Name)
		}
		overrides[entry.Field], _ = json.Marshal(strings.Join(values, "; "))
		overrides[entry.ID], _ = json.Marshal(base.First(entry.Role).ID)
	}
	if active {
		overrides["participants"], _ = json.Marshal(base)
	} else {
		delete(overrides, "participants")
	}
	return nil
}

type tagReplacement struct {
	path, output, backup string
	info                 os.FileInfo
}

func (s *Server) editFileTags(ctx context.Context, kind, itemID string, fields map[string]json.RawMessage, confirmedPaths []string) ([]model.ScanTarget, error) {
	command, err := ffmpeg.New().CmdPath()
	if err != nil {
		return nil, fmt.Errorf("无法读取 FFmpeg：%w", err)
	}
	songs, err := s.metadataTracks(ctx, kind, itemID)
	if err != nil || len(songs) == 0 {
		return nil, fmt.Errorf("没有可编辑的曲目文件")
	}
	pathsToWrite := make([]string, 0, len(songs))
	for _, song := range songs {
		pathsToWrite = append(pathsToWrite, song.Path)
	}
	slices.Sort(pathsToWrite)
	if !slices.Equal(pathsToWrite, confirmedPaths) {
		return nil, fmt.Errorf("受影响文件已变化，请重新读取并确认")
	}
	replacements := make([]tagReplacement, 0, len(songs))
	paths := map[string]bool{}
	targets := map[model.ScanTarget]bool{}
	defer func() {
		for _, file := range replacements {
			_ = os.Remove(file.output)
		}
	}()
	for _, song := range songs {
		path, err := filepath.EvalSymlinks(song.AbsolutePath())
		if err != nil {
			return nil, err
		}
		root, err := filepath.EvalSymlinks(song.LibraryPath)
		if err != nil {
			return nil, err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || paths[path] {
			return nil, fmt.Errorf("曲目路径超出音乐库或指向同一文件：%s", song.Path)
		}
		paths[path] = true
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() {
			return nil, fmt.Errorf("曲目文件不可写入：%s", song.Path)
		}
		if !slices.Contains([]string{".mp3", ".flac", ".m4a", ".ogg", ".opus"}, strings.ToLower(filepath.Ext(path))) {
			return nil, fmt.Errorf("该文件格式使用本站覆写：%s", song.Path)
		}
		file, err := os.CreateTemp(filepath.Dir(path), ".ndfork-edit-*"+filepath.Ext(path))
		if err != nil {
			return nil, err
		}
		temp := file.Name()
		_ = file.Close()
		replacements = append(replacements, tagReplacement{path: path, output: temp, backup: temp + ".original", info: info})
		args := []string{"-nostdin", "-v", "error", "-y", "-i", path, "-map", "0", "-c", "copy", "-map_metadata", "0"}
		for _, field := range slices.Sorted(maps.Keys(fields)) {
			var text string
			if json.Unmarshal(fields[field], &text) != nil {
				text = string(fields[field])
				if text == "0" {
					text = ""
				}
			}
			args = append(args, "-metadata", model.FileTagFields(kind)[field]+"="+text)
		}
		args = append(args, temp)
		commandCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		output, commandErr := exec.CommandContext(commandCtx, command, args...).CombinedOutput()
		cancel()
		if commandErr != nil {
			return nil, fmt.Errorf("准备文件失败（%s）：%w %s", song.Path, commandErr, strings.TrimSpace(string(output)))
		}
		if err := os.Chmod(temp, info.Mode().Perm()); err != nil {
			return nil, err
		}
		targets[model.ScanTarget{LibraryID: song.LibraryID, FolderPath: filepath.Dir(song.Path)}] = true
	}
	for _, file := range replacements {
		info, err := os.Stat(file.path)
		if err != nil || !os.SameFile(info, file.info) || info.Size() != file.info.Size() || !info.ModTime().Equal(file.info.ModTime()) {
			return nil, fmt.Errorf("准备期间文件已更改：%s", file.path)
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	rollback := func(last int, cause error) error {
		for index := last; index >= 0; index-- {
			file := replacements[index]
			if err := os.Rename(file.backup, file.path); err != nil {
				cause = errors.Join(cause, fmt.Errorf("无法恢复 %s，原文件保留在 %s：%w", file.path, file.backup, err))
			}
		}
		return cause
	}
	for index, file := range replacements {
		if err := os.Rename(file.path, file.backup); err != nil {
			return nil, rollback(index-1, err)
		}
		if err := os.Rename(file.output, file.path); err != nil {
			return nil, rollback(index, err)
		}
	}
	for _, file := range replacements {
		_ = os.Remove(file.backup)
	}
	return slices.Collect(maps.Keys(targets)), nil
}
