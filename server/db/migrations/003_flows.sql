-- 003_flows: flows, flow_signers, flows_pdfs (backward compat), notifications

-- Main flows table: proper relational columns + data JSONB for backward compat
-- IMPORTANT: data JSONB is kept because NO-TOUCH files (cloud-signing, bulk-signing)
--            use queries like: WHERE data->'signers' @> $1::jsonb
CREATE TABLE IF NOT EXISTS flows (
  id                TEXT        PRIMARY KEY,
  org_id            INTEGER     NOT NULL REFERENCES organizations(id),
  initiator_id      INTEGER     REFERENCES users(id),
  initiator_email   TEXT        NOT NULL DEFAULT '',
  initiator_name    TEXT        NOT NULL DEFAULT '',
  title             TEXT        NOT NULL DEFAULT '',
  doc_name          TEXT        NOT NULL DEFAULT '',
  doc_type          TEXT        NOT NULL DEFAULT 'tabel',
  status            TEXT        NOT NULL DEFAULT 'draft',
  current_step      INTEGER     NOT NULL DEFAULT 0,
  form_type         TEXT        DEFAULT 'none',
  form_instance_id  UUID,
  metadata          JSONB       NOT NULL DEFAULT '{}',
  -- Backward compat: full JSONB blob (signers, etc.) for NO-TOUCH zone queries
  data              JSONB       NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  deleted_at        TIMESTAMPTZ,
  deleted_by        TEXT
);

CREATE INDEX IF NOT EXISTS idx_flows_org_status
  ON flows(org_id, status, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_flows_initiator
  ON flows(initiator_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_flows_deleted_at
  ON flows(deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_flows_updated_at
  ON flows(updated_at DESC);
-- GIN indexes for NO-TOUCH backward compat JSONB queries
CREATE INDEX IF NOT EXISTS idx_flows_signers_gin
  ON flows USING GIN ((data->'signers'));
CREATE INDEX IF NOT EXISTS idx_flows_status_jsonb
  ON flows ((data->>'status'));
CREATE INDEX IF NOT EXISTS idx_flows_org_id_jsonb
  ON flows ((data->>'orgId'));
CREATE INDEX IF NOT EXISTS idx_flows_init_org
  ON flows ((data->>'initEmail'), (data->>'orgId'));

-- flow_signers: relational signers (populated by saveFlow from data.signers)
CREATE TABLE IF NOT EXISTS flow_signers (
  id              TEXT        PRIMARY KEY,
  flow_id         TEXT        NOT NULL REFERENCES flows(id),
  step_order      INTEGER     NOT NULL,
  user_id         INTEGER     REFERENCES users(id),
  email           TEXT        NOT NULL,
  name            TEXT        NOT NULL DEFAULT '',
  role            TEXT,
  function        TEXT,
  status          TEXT        NOT NULL DEFAULT 'pending',
  token           TEXT        UNIQUE,
  token_expires   TIMESTAMPTZ,
  signing_method  TEXT,
  signed_at       TIMESTAMPTZ,
  decision        TEXT,
  notes           TEXT,
  delegated_from  INTEGER     REFERENCES users(id),
  meta            JSONB       NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_flow_signers_flow
  ON flow_signers(flow_id, step_order);
CREATE INDEX IF NOT EXISTS idx_flow_signers_email
  ON flow_signers(email) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_flow_signers_token
  ON flow_signers(token) WHERE token IS NOT NULL;

-- flows_pdfs: key-value PDF byte store (used directly by cloud-signing & bulk-signing NO-TOUCH files)
CREATE TABLE IF NOT EXISTS flows_pdfs (
  flow_id    TEXT        NOT NULL,
  key        TEXT        NOT NULL,
  data       TEXT        NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (flow_id, key)
);
CREATE INDEX IF NOT EXISTS idx_flows_pdfs_flow ON flows_pdfs(flow_id);

-- notifications: in-app notification store (NO-TOUCH files delete from this)
CREATE TABLE IF NOT EXISTS notifications (
  id         SERIAL      PRIMARY KEY,
  user_email TEXT        NOT NULL,
  flow_id    TEXT,
  type       TEXT        NOT NULL,
  title      TEXT        NOT NULL,
  message    TEXT        NOT NULL,
  read       BOOLEAN     NOT NULL DEFAULT FALSE,
  data       JSONB       DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notif_email   ON notifications(user_email, read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_flow_id ON notifications(flow_id);
