-- 012_outreach: outreach campaigns, recipients, primarii (Romanian municipalities)
-- Consolidates v3 migrations: 026_outreach, 029_outreach_primarii,
-- 030_outreach_unsubscribe, 040_outreach_click_tracking

CREATE TABLE IF NOT EXISTS outreach_campaigns (
  id         SERIAL      PRIMARY KEY,
  name       TEXT        NOT NULL,
  subject    TEXT        NOT NULL,
  html_body  TEXT        NOT NULL,
  created_by TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS outreach_recipients (
  id             SERIAL      PRIMARY KEY,
  campaign_id    INTEGER     NOT NULL REFERENCES outreach_campaigns(id) ON DELETE CASCADE,
  email          TEXT        NOT NULL,
  institutie     TEXT        NOT NULL DEFAULT '',
  status         TEXT        NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','sent','opened','error')),
  tracking_id    TEXT        NOT NULL DEFAULT md5(random()::text || clock_timestamp()::text),
  sent_at        TIMESTAMPTZ,
  opened_at      TIMESTAMPTZ,
  downloaded_at  TIMESTAMPTZ,
  download_count INTEGER     NOT NULL DEFAULT 0,
  clicked_at     TIMESTAMPTZ DEFAULT NULL,
  click_count    INTEGER     NOT NULL DEFAULT 0,
  error_msg      TEXT,
  UNIQUE(campaign_id, email)
);

CREATE INDEX IF NOT EXISTS idx_orecip_campaign ON outreach_recipients(campaign_id);
CREATE INDEX IF NOT EXISTS idx_orecip_status   ON outreach_recipients(status);
CREATE INDEX IF NOT EXISTS idx_orecip_tracking ON outreach_recipients(tracking_id);
CREATE INDEX IF NOT EXISTS idx_orecip_clicked
  ON outreach_recipients(clicked_at) WHERE clicked_at IS NOT NULL;

-- Romanian municipalities (primarii) seed table
CREATE TABLE IF NOT EXISTS outreach_primarii (
  id                SERIAL      PRIMARY KEY,
  institutie        TEXT        NOT NULL,
  email             TEXT        NOT NULL,
  judet             TEXT        NOT NULL DEFAULT '',
  localitate        TEXT        NOT NULL DEFAULT '',
  activ             BOOLEAN     NOT NULL DEFAULT TRUE,
  unsubscribed      BOOLEAN     NOT NULL DEFAULT FALSE,
  unsubscribe_token TEXT        UNIQUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(email)
);

CREATE INDEX IF NOT EXISTS idx_oprm_judet ON outreach_primarii(judet);
CREATE INDEX IF NOT EXISTS idx_oprm_activ ON outreach_primarii(activ);
CREATE INDEX IF NOT EXISTS idx_oprm_unsub_token
  ON outreach_primarii(unsubscribe_token) WHERE unsubscribe_token IS NOT NULL;

-- Additional v3 compat tables used by various routes
CREATE TABLE IF NOT EXISTS templates (
  id         SERIAL      PRIMARY KEY,
  user_email TEXT        NOT NULL,
  org_id     INTEGER,
  institutie TEXT        NOT NULL DEFAULT '',
  name       TEXT        NOT NULL,
  signers    JSONB       NOT NULL DEFAULT '[]',
  shared     BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tmpl_user ON templates(user_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tmpl_inst ON templates(institutie, shared) WHERE shared = TRUE;

CREATE TABLE IF NOT EXISTS delegations (
  id          SERIAL      PRIMARY KEY,
  from_email  TEXT        NOT NULL,
  to_email    TEXT        NOT NULL,
  org_id      INTEGER,
  institutie  TEXT        NOT NULL DEFAULT '',
  valid_from  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_delegations_from
  ON delegations(from_email, valid_until);

CREATE TABLE IF NOT EXISTS login_blocks (
  key          TEXT        PRIMARY KEY,
  count        INTEGER     NOT NULL DEFAULT 0,
  first_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  blocked_until TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS flow_attachments (
  id            TEXT        PRIMARY KEY,
  flow_id       TEXT        NOT NULL,
  uploaded_by   TEXT        NOT NULL,
  filename      TEXT        NOT NULL,
  mimetype      TEXT        NOT NULL DEFAULT 'application/octet-stream',
  size_bytes    INTEGER     NOT NULL DEFAULT 0,
  data          BYTEA       NOT NULL,
  drive_file_id   TEXT,
  drive_file_link TEXT,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_flow_att_flow ON flow_attachments(flow_id);
