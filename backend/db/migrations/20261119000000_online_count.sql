-- +goose Up
ALTER TABLE site_privacy ADD COLUMN online_count BOOLEAN NOT NULL DEFAULT 0;

-- +goose Down
ALTER TABLE site_privacy DROP COLUMN online_count;
