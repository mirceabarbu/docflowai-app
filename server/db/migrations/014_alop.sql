-- Migration 014_alop (v2) — ALOP conform Ordinului 1140/2025
-- 4 faze: Angajare → Lichidare → Ordonanțare → Plată
-- Status machine: draft → angajare → lichidare → ordonantare → plata → completed

DROP TABLE IF EXISTS alop_instances CASCADE;
DROP TABLE IF EXISTS alop_sabloane CASCADE;

CREATE TABLE alop_instances (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         INTEGER NOT NULL REFERENCES organizations(id),
  created_by     INTEGER NOT NULL REFERENCES users(id),
  status         TEXT NOT NULL DEFAULT 'draft',
  -- draft / angajare / lichidare / ordonantare / plata / completed / cancelled

  titlu          TEXT,
  compartiment   TEXT,
  valoare_totala NUMERIC(15,2),
  notes          TEXT,

  -- Faza 1: Angajare — Document de Fundamentare + flux semnare
  df_id                UUID REFERENCES formulare_df(id),
  df_flow_id           TEXT REFERENCES flows(id),
  df_completed_at      TIMESTAMPTZ,

  -- Faza 2: Lichidare — confirmare servicii prestate / bunuri recepționate
  lichidare_confirmed_by  INTEGER REFERENCES users(id),
  lichidare_confirmed_at  TIMESTAMPTZ,
  lichidare_notes         TEXT,

  -- Faza 3: Ordonanțare — Ordonanțare de Plată + flux semnare
  ord_id               UUID REFERENCES formulare_ord(id),
  ord_flow_id          TEXT REFERENCES flows(id),
  ord_completed_at     TIMESTAMPTZ,

  -- Faza 4: Plată — confirmare plată efectuată
  plata_confirmed_by   INTEGER REFERENCES users(id),
  plata_confirmed_at   TIMESTAMPTZ,
  plata_notes          TEXT,

  meta           JSONB NOT NULL DEFAULT '{}',

  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at   TIMESTAMPTZ,
  cancelled_at   TIMESTAMPTZ
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

-- Șablon configurabil per organizație (maxim un șablon per org)
CREATE TABLE alop_sabloane (
  id         SERIAL PRIMARY KEY,
  org_id     INTEGER NOT NULL UNIQUE REFERENCES organizations(id),
  -- Semnatari impliciti per fază: [{id, email, nume, functie, compartiment}]
  signatari_angajare      JSONB NOT NULL DEFAULT '[]',
  signatari_lichidare     JSONB NOT NULL DEFAULT '[]',
  signatari_ordonantare   JSONB NOT NULL DEFAULT '[]',
  signatari_plata         JSONB NOT NULL DEFAULT '[]',
  meta        JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
