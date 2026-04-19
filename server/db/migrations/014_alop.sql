-- 014_alop: ALOP instances și șabloane

CREATE TABLE IF NOT EXISTS alop_instances (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            INTEGER NOT NULL REFERENCES organizations(id),
  created_by        INTEGER NOT NULL REFERENCES users(id),
  titlu             TEXT NOT NULL DEFAULT '',
  compartiment      TEXT,
  valoare_totala    NUMERIC(15,2),
  notes             TEXT,
  status            TEXT NOT NULL DEFAULT 'draft',
  df_id             UUID,
  df_flow_id        TEXT,
  df_semnatari      JSONB NOT NULL DEFAULT '[]',
  ord_id            UUID,
  ord_flow_id       TEXT,
  ord_semnatari     JSONB NOT NULL DEFAULT '[]',
  lichidare_user_id INTEGER,
  lichidare_confirmat BOOLEAN DEFAULT FALSE,
  lichidare_docs    JSONB NOT NULL DEFAULT '[]',
  plata_user_id     INTEGER,
  plata_nr_ordin    TEXT,
  plata_data        DATE,
  plata_suma        NUMERIC(15,2),
  meta              JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  cancelled_at      TIMESTAMPTZ,
  cancelled_reason  TEXT
);

ALTER TABLE alop_instances ADD COLUMN IF NOT EXISTS
  df_completed_at TIMESTAMPTZ;
ALTER TABLE alop_instances ADD COLUMN IF NOT EXISTS
  lichidare_at TIMESTAMPTZ;
ALTER TABLE alop_instances ADD COLUMN IF NOT EXISTS
  lichidare_confirmed_by INTEGER;
ALTER TABLE alop_instances ADD COLUMN IF NOT EXISTS
  lichidare_confirmed_at TIMESTAMPTZ;
ALTER TABLE alop_instances ADD COLUMN IF NOT EXISTS
  lichidare_notes TEXT;
ALTER TABLE alop_instances ADD COLUMN IF NOT EXISTS
  ord_completed_at TIMESTAMPTZ;
ALTER TABLE alop_instances ADD COLUMN IF NOT EXISTS
  plata_confirmed_by INTEGER;
ALTER TABLE alop_instances ADD COLUMN IF NOT EXISTS
  plata_confirmed_at TIMESTAMPTZ;
ALTER TABLE alop_instances ADD COLUMN IF NOT EXISTS
  plata_notes TEXT;

CREATE TABLE IF NOT EXISTS alop_sabloane (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      INTEGER NOT NULL REFERENCES organizations(id),
  df_semnatari_sablon  JSONB NOT NULL DEFAULT '[]',
  ord_semnatari_sablon JSONB NOT NULL DEFAULT '[]',
  lichidare_sablon     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE alop_sabloane
    ADD CONSTRAINT alop_sabloane_org_id_key UNIQUE (org_id);
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_alop_org
  ON alop_instances(org_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_alop_status
  ON alop_instances(org_id, status) WHERE cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_alop_created_by
  ON alop_instances(created_by);
CREATE INDEX IF NOT EXISTS idx_alop_df
  ON alop_instances(df_id) WHERE df_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_alop_ord
  ON alop_instances(ord_id) WHERE ord_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_alop_sablon_org
  ON alop_sabloane(org_id);
