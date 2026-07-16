-- 015_formulare_oficiale.sql
-- Formulare oficiale standalone (Referat necesitate, NF investiții, viitoare)
-- Separate de DF/ORD/ALOP — nu interferează cu fluxul existent
-- HOTFIX v3.9.327: org_id și created_by sunt INTEGER (SERIAL) pentru a respecta
-- schema existentă (organizations.id și users.id sunt SERIAL, nu UUID).

CREATE TABLE IF NOT EXISTS formulare_oficiale (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           INTEGER     NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by       INTEGER     NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  form_type        TEXT        NOT NULL CHECK (form_type IN ('REFNEC', 'NOTAFD_INVEST')),
  ref_number       TEXT,
  title            TEXT        NOT NULL DEFAULT '',
  form_data        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status           TEXT        NOT NULL DEFAULT 'draft'
                               CHECK (status IN ('draft', 'completed', 'archived')),
  pdf_path         TEXT,
  pdf_generated_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_formulare_oficiale_org
  ON formulare_oficiale (org_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_formulare_oficiale_type
  ON formulare_oficiale (org_id, form_type, deleted_at);
CREATE INDEX IF NOT EXISTS idx_formulare_oficiale_status
  ON formulare_oficiale (org_id, status, deleted_at);
CREATE INDEX IF NOT EXISTS idx_formulare_oficiale_created_by
  ON formulare_oficiale (created_by);

-- formular_attachments (mutat aici din inline 068_formular_attachments): FK direct pe
-- formulare_oficiale(id) — pe fresh prod inline rulează ÎNAINTEA acestui fișier V4, deci
-- garda inline (IF NOT EXISTS formulare_oficiale) sare; tabela trebuie creată aici, garantat
-- DUPĂ CREATE TABLE formulare_oficiale de mai sus.
CREATE TABLE IF NOT EXISTS formular_attachments (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  formular_id   UUID        NOT NULL REFERENCES formulare_oficiale(id) ON DELETE CASCADE,
  category      TEXT        NOT NULL CHECK (category IN ('caiet_sarcini','estimare_valoare','altele')),
  uploaded_by   INTEGER     NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  filename      TEXT        NOT NULL,
  mime_type     TEXT        NOT NULL DEFAULT 'application/octet-stream',
  size_bytes    INTEGER     NOT NULL DEFAULT 0,
  data          BYTEA       NOT NULL,
  notes         TEXT,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_formular_att_formular
  ON formular_attachments(formular_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_formular_att_category
  ON formular_attachments(formular_id, category, deleted_at);

-- Trigger updated_at (condiționat — funcția poate lipsi pe DB-uri fresh)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column') THEN
    DROP TRIGGER IF EXISTS trg_formulare_oficiale_updated_at ON formulare_oficiale;
    CREATE TRIGGER trg_formulare_oficiale_updated_at
      BEFORE UPDATE ON formulare_oficiale
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
