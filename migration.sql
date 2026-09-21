CREATE TABLE IF NOT EXISTS signal_github_handoff (
 kind TEXT NOT NULL CHECK(kind IN ('research','results')),
 season INTEGER NOT NULL, week INTEGER NOT NULL,
 content_hash TEXT NOT NULL, model_version TEXT NOT NULL,
 generated_at TEXT NOT NULL, imported_at TEXT NOT NULL,
 frozen INTEGER NOT NULL DEFAULT 0, rows_written INTEGER NOT NULL,
 commit_sha TEXT NOT NULL, payload_json TEXT NOT NULL,
 PRIMARY KEY(kind,season,week)
);
CREATE TRIGGER IF NOT EXISTS signal_github_frozen_update
BEFORE UPDATE ON weekly_research
WHEN EXISTS(SELECT 1 FROM signal_github_handoff WHERE kind='research' AND frozen=1 AND printf('%d-W%02d',season,week)=OLD.week_key)
BEGIN SELECT RAISE(ABORT,'Frozen GitHub research cannot be overwritten'); END;
CREATE TRIGGER IF NOT EXISTS signal_github_frozen_delete
BEFORE DELETE ON weekly_research
WHEN EXISTS(SELECT 1 FROM signal_github_handoff WHERE kind='research' AND frozen=1 AND printf('%d-W%02d',season,week)=OLD.week_key)
BEGIN SELECT RAISE(ABORT,'Frozen GitHub research cannot be deleted'); END;
