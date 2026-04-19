-- 008_audit: audit_events (v4) + audit_log (v3 compat name used by writeAuditEvent)
CREATE TABLE IF NOT EXISTS audit_events (
  id               BIGSERIAL   PRIMARY KEY,
  org_id           INTEGER     REFERENCES organizations(id),
  flow_id          TEXT        REFERENCES flows(id),
  form_instance_id UUID        REFERENCES form_instances(id),
  actor_id         INTEGER     REFERENCES users(id),
  actor_email      TEXT,
  actor_type       TEXT        NOT NULL DEFAULT 'user',
  event_type       TEXT        NOT NULL,
  channel          TEXT        DEFAULT 'api',
  ok               BOOLEAN     NOT NULL DEFAULT TRUE,
  message          TEXT,
  meta             JSONB       NOT NULL DEFAULT '{}',
  ip_address       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_org  ON audit_events(org_id,   created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_flow ON audit_events(flow_id,  created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_events(event_type, created_at DESC);

-- audit_log: v3 alias view for backward compat (writeAuditEvent writes here)
-- Implemented as a table so existing INSERT queries keep working
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL   PRIMARY KEY,
  flow_id    TEXT,
  org_id     INTEGER,
  event_type TEXT        NOT NULL,
  actor_email TEXT,
  actor_ip   TEXT,
  payload    JSONB       NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_flow ON audit_log(flow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_org  ON audit_log(org_id,  created_at DESC);
