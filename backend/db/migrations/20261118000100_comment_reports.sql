-- +goose Up
CREATE INDEX site_comment_parent ON site_comment(parent_id);
CREATE TABLE site_comment_report (
    comment_id INTEGER NOT NULL REFERENCES site_comment(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    reviewed BOOLEAN NOT NULL DEFAULT 0,
    PRIMARY KEY(comment_id,user_id)
);

-- +goose Down
DROP TABLE site_comment_report;
DROP INDEX site_comment_parent;
