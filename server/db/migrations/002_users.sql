-- 002_users: users table with full v4 columns
CREATE TABLE IF NOT EXISTS users (
  id                       SERIAL      PRIMARY KEY,
  org_id                   INTEGER     NOT NULL REFERENCES organizations(id),
  email                    TEXT        UNIQUE NOT NULL,
  password_hash            TEXT        NOT NULL,
  -- v4 canonical names
  name                     TEXT        NOT NULL DEFAULT '',
  phone                    TEXT        NOT NULL DEFAULT '',
  position                 TEXT        NOT NULL DEFAULT '',
  department               TEXT        NOT NULL DEFAULT '',
  -- v3 legacy aliases (kept for backward compat with existing queries)
  nume                     TEXT        NOT NULL DEFAULT '',
  functie                  TEXT        NOT NULL DEFAULT '',
  institutie               TEXT        NOT NULL DEFAULT '',
  compartiment             TEXT        NOT NULL DEFAULT '',
  role                     TEXT        NOT NULL DEFAULT 'user',
  status                   TEXT        NOT NULL DEFAULT 'active',
  preferred_signing_provider TEXT      DEFAULT NULL,
  mfa_enabled              BOOLEAN     NOT NULL DEFAULT FALSE,
  mfa_secret               TEXT,
  -- TOTP 2FA fields
  totp_secret              TEXT        DEFAULT NULL,
  totp_enabled             BOOLEAN     NOT NULL DEFAULT FALSE,
  totp_backup_codes        TEXT[]      DEFAULT NULL,
  token_version            INTEGER     NOT NULL DEFAULT 1,
  login_blocked_until      TIMESTAMPTZ,
  login_attempts           INTEGER     NOT NULL DEFAULT 0,
  force_password_change    BOOLEAN     NOT NULL DEFAULT FALSE,
  push_subscriptions       JSONB       NOT NULL DEFAULT '[]',
  notif_inapp              BOOLEAN     NOT NULL DEFAULT TRUE,
  notif_email              BOOLEAN     NOT NULL DEFAULT FALSE,
  notif_whatsapp           BOOLEAN     NOT NULL DEFAULT FALSE,
  -- hash algorithm tracking (v3 SEC-03)
  hash_algo                TEXT        NOT NULL DEFAULT 'pbkdf2_v2',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_org   ON users(org_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role  ON users(role);
