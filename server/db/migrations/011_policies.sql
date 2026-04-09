-- 011_policies: policy rules engine (org-level and global)
CREATE TABLE IF NOT EXISTS policy_rules (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      INTEGER     REFERENCES organizations(id),
  scope       TEXT        NOT NULL,
  code        TEXT        NOT NULL,
  name        TEXT        NOT NULL,
  description TEXT,
  rule_json   JSONB       NOT NULL,
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  priority    INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_policy_rules_org
  ON policy_rules(org_id, is_active, priority DESC);
CREATE INDEX IF NOT EXISTS idx_policy_rules_scope
  ON policy_rules(scope, is_active);
