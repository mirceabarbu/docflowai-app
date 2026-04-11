-- Migration 014_alop
-- Tabelă orchestrator ALOP (Angajament Legal / Ordonanțare de Plată)
-- Leagă un Document de Fundamentare (DF) cu o Ordonanțare de Plată (ORD)
-- și fluxurile lor de semnare corespunzătoare.

CREATE TABLE IF NOT EXISTS alop_instances (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          INTEGER NOT NULL REFERENCES organizations(id),
  created_by      INTEGER NOT NULL REFERENCES users(id),
  status          TEXT NOT NULL DEFAULT 'draft',
  -- status: draft / df_in_progress / df_signed /
  --         ord_in_progress / ord_signed / completed / cancelled

  df_id           UUID REFERENCES formulare_df(id),
  ord_id          UUID REFERENCES formulare_ord(id),
  df_flow_id      TEXT REFERENCES flows(id),
  ord_flow_id     TEXT REFERENCES flows(id),

  titlu           TEXT,
  compartiment    TEXT,
  valoare_totala  NUMERIC(15,2),

  notes           TEXT,
  meta            JSONB NOT NULL DEFAULT '{}',

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_alop_org
  ON alop_instances(org_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_alop_created_by
  ON alop_instances(created_by);
CREATE INDEX IF NOT EXISTS idx_alop_status
  ON alop_instances(status) WHERE cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_alop_df
  ON alop_instances(df_id) WHERE df_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_alop_ord
  ON alop_instances(ord_id) WHERE ord_id IS NOT NULL;
