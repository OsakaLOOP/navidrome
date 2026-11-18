-- +goose Up
CREATE TABLE site_metadata (
    kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '{}',
    overrides TEXT NOT NULL DEFAULT '{}',
    updated_by TEXT NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(kind,item_id)
);

-- +goose Down
DROP TABLE site_metadata;
