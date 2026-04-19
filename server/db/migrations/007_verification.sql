-- 007_verification: trust reports and certificate records
-- Note: trust_reports UNIQUE on flow_id for backward compat with NO-TOUCH DELETE queries
CREATE TABLE IF NOT EXISTS trust_reports (
  id                   TEXT        PRIMARY KEY,
  org_id               INTEGER     NOT NULL REFERENCES organizations(id),
  flow_id              TEXT        NOT NULL REFERENCES flows(id) UNIQUE,
  document_revision_id TEXT        REFERENCES document_revisions(id),
  status               TEXT        NOT NULL DEFAULT 'pending',
  conclusion           TEXT,
  summary_json         JSONB,
  report_json          JSONB,
  report_pdf           BYTEA,
  report_revision_id   TEXT        REFERENCES document_revisions(id),
  generated_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trust_reports_flow_id
  ON trust_reports(flow_id);

CREATE TABLE IF NOT EXISTS certificate_records (
  id                   TEXT        PRIMARY KEY,
  trust_report_id      TEXT        NOT NULL REFERENCES trust_reports(id),
  signature_session_id TEXT        REFERENCES signature_sessions(id),
  signer_name          TEXT,
  subject_dn           TEXT,
  issuer_dn            TEXT,
  serial_number        TEXT,
  qualified_status     TEXT,
  valid_from           TIMESTAMPTZ,
  valid_to             TIMESTAMPTZ,
  ocsp_status          TEXT,
  crl_status           TEXT,
  trusted_list_source  TEXT,
  raw_json             JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Legacy signature tables used by existing routes (v3 compat)
CREATE TABLE IF NOT EXISTS flow_signatures (
  id               TEXT        PRIMARY KEY,
  flow_id          TEXT        NOT NULL,
  signer_id        TEXT,
  signer_name      TEXT        NOT NULL,
  signer_email     TEXT,
  signer_role      TEXT,
  signing_order    INTEGER,
  status           TEXT        NOT NULL DEFAULT 'pending',
  signed_at        TIMESTAMPTZ,
  signature_method TEXT,
  source_file_name TEXT,
  signed_file_hash TEXT,
  signature_hash   TEXT,
  certificate_id   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_flow_signatures_flow_id
  ON flow_signatures(flow_id);

CREATE TABLE IF NOT EXISTS signature_certificates (
  id                   TEXT        PRIMARY KEY,
  flow_id              TEXT        NOT NULL,
  signer_email         TEXT,
  signer_name          TEXT,
  certificate_type     TEXT        DEFAULT 'unknown',
  issuer_name          TEXT,
  issuer_cn            TEXT,
  subject_cn           TEXT,
  subject_serial       TEXT,
  subject_identifier   TEXT,
  serial_number        TEXT,
  valid_from           TIMESTAMPTZ,
  valid_to             TIMESTAMPTZ,
  was_valid_at_signing BOOLEAN     DEFAULT FALSE,
  revocation_status    TEXT        DEFAULT 'unknown',
  chain_status         TEXT        DEFAULT 'unknown',
  trust_status         TEXT        DEFAULT 'unknown',
  qc_statement_present BOOLEAN     DEFAULT FALSE,
  key_usage            TEXT,
  signature_algorithm  TEXT,
  digest_algorithm     TEXT,
  timestamp_present    BOOLEAN     DEFAULT FALSE,
  timestamp_time       TIMESTAMPTZ,
  ocsp_url             TEXT,
  raw_json             JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_signature_certificates_flow_id
  ON signature_certificates(flow_id);
