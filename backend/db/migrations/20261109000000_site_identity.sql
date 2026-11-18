-- +goose Up
CREATE TABLE site_identity (
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id TEXT NOT NULL UNIQUE REFERENCES user(id) ON DELETE CASCADE,
    email TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (issuer, subject)
);
UPDATE user SET token_epoch=token_epoch+1 WHERE is_admin=0;

-- +goose Down
DROP TABLE site_identity;
