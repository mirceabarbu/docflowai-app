-- 010_archive: archive_jobs for Google Drive archiving
CREATE TABLE IF NOT EXISTS archive_jobs (
  id            TEXT        PRIMARY KEY,
  org_id        INTEGER     NOT NULL REFERENCES organizations(id),
  flow_id       TEXT        NOT NULL REFERENCES flows(id),
  status        TEXT        NOT NULL DEFAULT 'pending',
  storage_type  TEXT        NOT NULL DEFAULT 'drive',
  archive_path  TEXT,
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  error_message TEXT,
  meta          JSONB       NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_archive_jobs_org
  ON archive_jobs(org_id, status);
CREATE INDEX IF NOT EXISTS idx_archive_jobs_flow
  ON archive_jobs(flow_id);
