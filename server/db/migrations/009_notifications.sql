-- 009_notifications: notification_events (v4 outbound log) + inapp_notifications
CREATE TABLE IF NOT EXISTS notification_events (
  id                 BIGSERIAL   PRIMARY KEY,
  org_id             INTEGER     REFERENCES organizations(id),
  flow_id            TEXT        REFERENCES flows(id),
  recipient_id       INTEGER     REFERENCES users(id),
  recipient_email    TEXT        NOT NULL,
  channel            TEXT        NOT NULL,
  template_code      TEXT        NOT NULL,
  status             TEXT        NOT NULL DEFAULT 'pending',
  provider_message_id TEXT,
  payload            JSONB       NOT NULL DEFAULT '{}',
  sent_at            TIMESTAMPTZ,
  failed_at          TIMESTAMPTZ,
  error_message      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inapp_notifications (
  id         BIGSERIAL   PRIMARY KEY,
  user_id    INTEGER     NOT NULL REFERENCES users(id),
  flow_id    TEXT        REFERENCES flows(id),
  type       TEXT        NOT NULL,
  title      TEXT        NOT NULL,
  message    TEXT        NOT NULL,
  read       BOOLEAN     NOT NULL DEFAULT FALSE,
  data       JSONB       NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notif_user
  ON inapp_notifications(user_id, read, created_at DESC);

-- push_subscriptions: VAPID push (v3 table, kept for backward compat)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         SERIAL      PRIMARY KEY,
  user_email TEXT        NOT NULL,
  endpoint   TEXT        NOT NULL,
  p256dh     TEXT        NOT NULL,
  auth       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_email, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_push_sub_email ON push_subscriptions(user_email);
