-- 006_forms: form templates, versions, instances (v4 generic forms engine)
CREATE TABLE IF NOT EXISTS form_templates (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       INTEGER     REFERENCES organizations(id),
  code         TEXT        NOT NULL,
  name         TEXT        NOT NULL,
  category     TEXT        NOT NULL DEFAULT 'general',
  description  TEXT,
  is_standard  BOOLEAN     NOT NULL DEFAULT FALSE,
  is_mandatory BOOLEAN     NOT NULL DEFAULT FALSE,
  is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS form_versions (
  id                   UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id          UUID    NOT NULL REFERENCES form_templates(id),
  version_no           INTEGER NOT NULL DEFAULT 1,
  schema_json          JSONB   NOT NULL DEFAULT '{}',
  pdf_mapping_json     JSONB   NOT NULL DEFAULT '{}',
  rules_json           JSONB   NOT NULL DEFAULT '[]',
  required_attachments JSONB   NOT NULL DEFAULT '[]',
  required_signers     JSONB   NOT NULL DEFAULT '[]',
  status               TEXT    NOT NULL DEFAULT 'draft',
  published_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(template_id, version_no)
);

CREATE TABLE IF NOT EXISTS form_instances (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                INTEGER     NOT NULL REFERENCES organizations(id),
  template_id           UUID        NOT NULL REFERENCES form_templates(id),
  version_id            UUID        NOT NULL REFERENCES form_versions(id),
  flow_id               TEXT        REFERENCES flows(id),
  created_by_id         INTEGER     NOT NULL REFERENCES users(id),
  status                TEXT        NOT NULL DEFAULT 'draft',
  data_json             JSONB       NOT NULL DEFAULT '{}',
  validation_errors     JSONB,
  generated_revision_id TEXT        REFERENCES document_revisions(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_form_inst_flow
  ON form_instances(flow_id) WHERE flow_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_form_inst_org
  ON form_instances(org_id, updated_at DESC);
