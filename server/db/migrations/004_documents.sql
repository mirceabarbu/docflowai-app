-- 004_documents: document_revisions (v4 relational document storage)
CREATE TABLE IF NOT EXISTS document_revisions (
  id               TEXT        PRIMARY KEY,
  flow_id          TEXT        NOT NULL REFERENCES flows(id),
  revision_no      INTEGER     NOT NULL DEFAULT 1,
  revision_type    TEXT        NOT NULL,
  storage_type     TEXT        NOT NULL DEFAULT 'inline',
  storage_path     TEXT,
  pdf_base64       TEXT,
  sha256           TEXT,
  size_bytes       BIGINT,
  created_by_id    INTEGER     REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_doc_rev_flow
  ON document_revisions(flow_id, revision_no DESC);
