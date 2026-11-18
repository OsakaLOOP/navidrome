package model

import "encoding/json"

func FileTagFields(kind string) map[string]string {
	switch kind {
	case "song":
		return map[string]string{"title": "title", "artist": "artist", "albumArtist": "album_artist", "album": "album", "year": "date", "trackNumber": "track", "discNumber": "disc", "comment": "comment"}
	case "album":
		return map[string]string{"name": "album", "albumArtist": "album_artist", "fileYear": "date", "comment": "comment"}
	}
	return nil
}

func MetadataValues(kind string, value any) (map[string]json.RawMessage, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var item map[string]json.RawMessage
	if err = json.Unmarshal(data, &item); err != nil {
		return nil, err
	}
	fields := map[string]json.RawMessage{}
	for _, field := range MetadataFields(kind) {
		if raw, ok := item[field]; ok {
			fields[field] = raw
		} else if field == "participants" {
			fields[field] = json.RawMessage(`{}`)
		} else {
			fields[field] = json.RawMessage(`""`)
		}
	}
	return fields, nil
}

func MetadataFields(kind string) []string {
	switch kind {
	case "song":
		return []string{"title", "artist", "artistId", "albumArtist", "albumArtistId", "album", "year", "trackNumber", "discNumber", "comment", "lyrics", "participants", "sortTitle", "sortArtistName", "sortAlbumArtistName"}
	case "album":
		return []string{"name", "albumArtist", "albumArtistId", "minYear", "maxYear", "comment", "description", "participants", "sortAlbumName", "sortAlbumArtistName"}
	case "artist":
		return []string{"name", "biography", "sortArtistName", "mbzArtistId"}
	}
	return nil
}
