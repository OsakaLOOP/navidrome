-- +goose Up
CREATE TABLE site_comment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    user_id TEXT REFERENCES user(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    parent_id INTEGER REFERENCES site_comment(id),
    position REAL,
    deleted BOOLEAN NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX site_comment_item ON site_comment(kind,item_id,id);
CREATE TABLE site_comment_like (
    comment_id INTEGER NOT NULL REFERENCES site_comment(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    PRIMARY KEY(comment_id,user_id)
);
CREATE TABLE site_privacy (
    user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
    favorites TEXT NOT NULL DEFAULT 'private' CHECK(favorites IN ('private','count','public'))
);
-- +goose Down
DROP TABLE site_privacy;
DROP TABLE site_comment_like;
DROP TABLE site_comment;
