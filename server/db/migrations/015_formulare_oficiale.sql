-- 015_formulare_oficiale.sql
-- Formulare oficiale standalone (Referat necesitate, NF investiții, viitoare)
-- Separate de DF/ORD/ALOP — nu interferează cu fluxul existent

CREATE TABLE IF NOT EXISTS formulare_oficiale (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by       UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
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
