-- 001_organizations: multi-tenant organizations table
CREATE TABLE IF NOT EXISTS organizations (
  id                        SERIAL      PRIMARY KEY,
  name                      TEXT        NOT NULL,
  slug                      TEXT        UNIQUE NOT NULL,
  cif                       TEXT,
  status                    TEXT        NOT NULL DEFAULT 'active',
  plan                      TEXT        NOT NULL DEFAULT 'starter',
  signing_providers_enabled TEXT[]      NOT NULL DEFAULT ARRAY['local-upload'],
  signing_providers_config  JSONB       NOT NULL DEFAULT '{}',
  settings                  JSONB       NOT NULL DEFAULT '{}',
  branding                  JSONB       NOT NULL DEFAULT '{}',
  compartimente             TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  -- webhook support (backward compat with v3)
  webhook_url               TEXT,
  webhook_secret            TEXT,
  webhook_events            TEXT[]      NOT NULL DEFAULT '{flow.completed}',
  webhook_enabled           BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_org_slug   ON organizations(slug);
CREATE INDEX IF NOT EXISTS idx_org_status ON organizations(status);
CREATE INDEX IF NOT EXISTS idx_org_signing_providers
  ON organizations USING GIN (signing_providers_enabled);
