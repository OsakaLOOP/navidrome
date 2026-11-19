-- +goose Up
CREATE TABLE site_profile (
    user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
    nickname TEXT NOT NULL DEFAULT '',
    bio TEXT NOT NULL DEFAULT '',
    avatar BLOB,
    avatar_type TEXT NOT NULL DEFAULT '',
    avatar_version INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE site_privacy ADD COLUMN history TEXT NOT NULL DEFAULT 'private' CHECK(history IN ('private','friends','public'));
ALTER TABLE site_privacy ADD COLUMN ratings TEXT NOT NULL DEFAULT 'private' CHECK(ratings IN ('private','friends','public'));
ALTER TABLE site_comment_like ADD COLUMN created_at DATETIME;

CREATE TABLE site_friend (
    first_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    second_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    requester TEXT NOT NULL,
    accepted BOOLEAN NOT NULL DEFAULT 0,
    PRIMARY KEY(first_id,second_id),
    CHECK(first_id < second_id AND requester IN (first_id,second_id))
);
CREATE INDEX site_friend_second ON site_friend(second_id,first_id);

CREATE TABLE site_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    item_type TEXT NOT NULL,
    item_id TEXT NOT NULL,
    value INTEGER NOT NULL DEFAULT 0,
    occurred_at INTEGER NOT NULL
);
CREATE INDEX site_activity_item ON site_activity(user_id,item_type,item_id,kind);
CREATE INDEX site_activity_time ON site_activity(occurred_at DESC,id DESC);

INSERT INTO site_activity(user_id,kind,item_type,item_id,value,occurred_at)
SELECT user_id,'favorite',item_type,item_id,0,unixepoch(starred_at)
FROM annotation WHERE starred=1 AND unixepoch(starred_at) IS NOT NULL
UNION ALL
SELECT user_id,'rating',item_type,item_id,rating,unixepoch(rated_at)
FROM annotation WHERE rating>0 AND unixepoch(rated_at) IS NOT NULL;

WITH plays AS (
    SELECT user_id, media_file_id, submission_time,
           ROW_NUMBER() OVER (PARTITION BY user_id, media_file_id ORDER BY id) AS play_number,
           COUNT(*) OVER (PARTITION BY user_id, media_file_id) AS recorded_count
    FROM scrobbles
)
INSERT INTO site_activity(user_id,kind,item_type,item_id,value,occurred_at)
SELECT plays.user_id,'milestone','media_file',plays.media_file_id,plays.play_number,plays.submission_time
FROM plays JOIN annotation a ON a.user_id=plays.user_id AND a.item_type='media_file' AND a.item_id=plays.media_file_id
WHERE a.play_count=plays.recorded_count AND (plays.play_number IN (1,10,50,100,500) OR plays.play_number%1000=0);

-- +goose StatementBegin
CREATE TRIGGER site_activity_annotation_insert AFTER INSERT ON annotation BEGIN
    INSERT INTO site_activity(user_id,kind,item_type,item_id,value,occurred_at)
    SELECT NEW.user_id,'favorite',NEW.item_type,NEW.item_id,0,unixepoch() WHERE NEW.starred=1
    UNION ALL SELECT NEW.user_id,'rating',NEW.item_type,NEW.item_id,NEW.rating,unixepoch() WHERE NEW.rating>0
    UNION ALL SELECT NEW.user_id,'milestone',NEW.item_type,NEW.item_id,1,unixepoch()
    WHERE NEW.item_type='media_file' AND NEW.play_count=1;
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER site_activity_annotation_update AFTER UPDATE OF starred,rating,play_count ON annotation BEGIN
    DELETE FROM site_activity WHERE user_id=NEW.user_id AND item_type=NEW.item_type AND item_id=NEW.item_id
        AND ((kind='favorite' AND OLD.starred=1 AND NEW.starred=0) OR (kind='rating' AND OLD.rating>0 AND NEW.rating=0));
    INSERT INTO site_activity(user_id,kind,item_type,item_id,value,occurred_at)
    SELECT NEW.user_id,'favorite',NEW.item_type,NEW.item_id,0,unixepoch() WHERE NEW.starred=1 AND OLD.starred IS NOT 1
    UNION ALL SELECT NEW.user_id,'rating',NEW.item_type,NEW.item_id,NEW.rating,unixepoch() WHERE NEW.rating>0 AND NEW.rating IS NOT OLD.rating
    UNION ALL SELECT NEW.user_id,'milestone',NEW.item_type,NEW.item_id,NEW.play_count,unixepoch()
    WHERE NEW.item_type='media_file' AND NEW.play_count>COALESCE(OLD.play_count,0)
      AND (NEW.play_count IN (1,10,50,100,500) OR NEW.play_count%1000=0);
END;
-- +goose StatementEnd

-- +goose Down
DROP TRIGGER site_activity_annotation_update;
DROP TRIGGER site_activity_annotation_insert;
DROP TABLE site_activity;
DROP TABLE site_friend;
ALTER TABLE site_comment_like DROP COLUMN created_at;
ALTER TABLE site_privacy DROP COLUMN ratings;
ALTER TABLE site_privacy DROP COLUMN history;
DROP TABLE site_profile;
