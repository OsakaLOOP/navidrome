-- +goose Up
ALTER TABLE media_file ADD COLUMN source_updated_at DATETIME;
UPDATE media_file SET source_updated_at=updated_at;
-- +goose Down
ALTER TABLE media_file DROP COLUMN source_updated_at;
