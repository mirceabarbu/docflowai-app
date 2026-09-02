-- ═══════════════════════════════════════════════════════════════════════════
-- PASUL 2 (CORECTAT) — context complet pentru fiecare DF implicat în coliziune
--
-- Corecție: `aprobat` NU e coloană în formulare_df — e calculat în cod din
-- starea fluxului (`df.mjs:501`: flow_id IS NOT NULL AND flux completed).
-- Aici îl derivăm identic, plus arătăm câte semnături are efectiv fluxul.
--
-- ⚠️ Rulează ACEASTĂ interogare SINGURĂ (șterge restul din editor).
-- ═══════════════════════════════════════════════════════════════════════════
WITH coliziuni AS (
  SELECT fd.org_id, fd.nr_unic_inreg, fd.revizie_nr
  FROM formulare_df fd
  WHERE fd.deleted_at IS NULL
    AND fd.nr_unic_inreg IS NOT NULL
    AND TRIM(fd.nr_unic_inreg) <> ''
  GROUP BY fd.org_id, fd.nr_unic_inreg, fd.revizie_nr
  HAVING COUNT(*) > 1
)
SELECT
  d.nr_unic_inreg,
  d.revizie_nr                                   AS rev,
  d.id                                           AS df_id,
  d.subtitlu_df                                  AS titlu,
  d.status,
  d.created_at,
  -- „aprobat" derivat exact ca în aplicație
  (d.flow_id IS NOT NULL
     AND (f.data->>'status' = 'completed'
          OR (f.data->>'completed')::boolean = true)) AS aprobat,
  -- dovada REALĂ de semnare: câți semnatari au semnat efectiv
  (SELECT COUNT(*)
     FROM jsonb_array_elements(COALESCE(f.data->'signers','[]'::jsonb)) s
    WHERE s->>'status' = 'signed')                AS semnaturi_aplicate,
  jsonb_array_length(COALESCE(f.data->'signers','[]'::jsonb)) AS semnatari_total,
  f.data->>'status'                              AS flux_status,
  d.flow_id,
  d.source_alop_id,
  a.titlu                                        AS alop_titlu,
  a.status                                       AS alop_status
FROM formulare_df d
JOIN coliziuni c
  ON  c.org_id        = d.org_id
  AND c.nr_unic_inreg = d.nr_unic_inreg
  AND c.revizie_nr    = d.revizie_nr
LEFT JOIN alop_instances a ON a.id = d.source_alop_id
LEFT JOIN flows f          ON f.id = d.flow_id AND f.deleted_at IS NULL
WHERE d.deleted_at IS NULL
ORDER BY d.nr_unic_inreg, d.created_at;

-- ───────────────────────────────────────────────────────────────────────────
-- CUM DECIZI care păstrează numărul, în ordinea priorității:
--   1. `semnaturi_aplicate > 0`  → INTANGIBIL. Documentul a ieșit din aplicație
--      (PDF semnat, poate deja la trezorerie). Păstrează numărul aici.
--      ⛔ NU modifica numărul unui document cu semnături aplicate.
--   2. dacă niciunul nu are semnături → păstrează la cel mai VECHI (created_at),
--      fiindcă e cel pe care l-au folosit oamenii mai mult timp.
--   3. celelalte primesc alt număr, din interfață, prin editarea DF-ului
--      (posibil doar în draft / returnat / de_revizuit).
--
-- ⛔ NU șterge niciun DF. ⛔ Nu rezolva nimic din SQL — numărul se schimbă din
--    aplicație, ca să treacă prin audit și prin gărzile de status.
--
-- ⚠️ `alop_status` diferit pe aceeași linie de coliziune = două dosare ALOP
--    independente care s-au calcat pe număr (cazul clasic). Dacă `source_alop_id`
--    e IDENTIC la două rânduri cu aceeași revizie, e altceva — spune-mi,
--    ar însemna că dedup-ul de la 095 n-a prins un caz.
-- ───────────────────────────────────────────────────────────────────────────
