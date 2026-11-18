-- +goose Up
CREATE TABLE site_artwork (
    kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    source TEXT NOT NULL,
    PRIMARY KEY(kind,item_id)
);
-- +goose Down
DROP TABLE site_artwork;
