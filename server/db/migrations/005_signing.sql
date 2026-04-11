-- 005_signing: signature_sessions (v4) + bulk_signing_sessions (v3 compat for NO-TOUCH)
CREATE TABLE IF NOT EXISTS signature_sessions (
  id                    TEXT        PRIMARY KEY,
  flow_id               TEXT        NOT NULL REFERENCES flows(id),
  signer_id             TEXT        NOT NULL REFERENCES flow_signers(id),
  document_revision_id  TEXT        REFERENCES document_revisions(id),
  provider_code         TEXT        NOT NULL,
  provider_session_id   TEXT,
  status                TEXT        NOT NULL DEFAULT 'pending',
  started_at            TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  failure_reason        TEXT,
  certificate_thumbprint TEXT,
  certificate_subject   TEXT,
  certificate_issuer    TEXT,
  provider_payload      JSONB       NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sig_sess_flow
  ON signature_sessions(flow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sig_sess_provider
  ON signature_sessions(provider_code, status);

-- bulk_signing_sessions: used directly by bulk-signing.mjs (NO-TOUCH zone)
-- Kept exactly as in v3 schema for backward compat
CREATE TABLE IF NOT EXISTS bulk_signing_sessions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            INTEGER     REFERENCES organizations(id) ON DELETE SET NULL,
  signer_email      TEXT        NOT NULL,
  provider_id       TEXT        NOT NULL DEFAULT 'sts-cloud',
  status            TEXT        NOT NULL DEFAULT 'initiated'
                    CHECK (status IN ('initiated','oauth_pending','signing_pending','completed','error')),
  items             JSONB       NOT NULL DEFAULT '[]',
  sts_provider_data JSONB,
  sts_op_id         TEXT,
  sts_token         TEXT,
  sts_sign_url      TEXT,
  sts_cert_pem      TEXT,
  error_message     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '2 hours',
  completed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bulk_sessions_signer
  ON bulk_signing_sessions(signer_email, status);
CREATE INDEX IF NOT EXISTS idx_bulk_sessions_expires
  ON bulk_signing_sessions(expires_at)
  WHERE status NOT IN ('completed','error');
