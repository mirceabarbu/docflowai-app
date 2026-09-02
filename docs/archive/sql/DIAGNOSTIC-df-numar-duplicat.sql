-- ═══════════════════════════════════════════════════════════════════════════
-- DIAGNOSTIC — DF-uri cu ACELAȘI nr_unic_inreg care NU sunt revizii
--
-- Reviziile împart legitim numărul (R0 → R1 → R2), conform OMF 1140/2025.
-- Problema e când DOUĂ documente au același număr ȘI aceeași revizie_nr —
-- adică două dosare independente care se calcă pe număr.
--
-- Consecințe (verificate pe cod):
--   • /revizuieste ia MAX(revizie_nr) pe TOT numărul ⇒ după ce unul devine R1,
--     celălalt nu mai poate fi revizuit NICIODATĂ (400 „nu mai este cea curentă")
--   • lista face DISTINCT ON (nr_unic_inreg) ⇒ unul dispare din vedere
--   • trasabilitatea le arată ca revizii ale aceluiași document
--
-- ⚠️ CONSOLA RAILWAY adaugă automat „LIMIT n" — de aceea totul se termină în SELECT.
--    Rulează fiecare pas SINGUR (șterge restul din editor).
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- PASUL 1 — coliziuni reale: același (org, număr, revizie) pe documente diferite
-- ───────────────────────────────────────────────────────────────────────────
SELECT
  fd.org_id,
  fd.nr_unic_inreg,
  fd.revizie_nr,
  COUNT(*)                                   AS cate_documente,
  array_agg(fd.id ORDER BY fd.created_at)    AS df_ids,
  array_agg(fd.subtitlu_df ORDER BY fd.created_at) AS titluri,
  array_agg(fd.status ORDER BY fd.created_at)      AS statusuri,
  array_agg(fd.source_alop_id ORDER BY fd.created_at) AS alop_ids,
  array_agg(fd.created_at ORDER BY fd.created_at)  AS create_la
FROM formulare_df fd
WHERE fd.deleted_at IS NULL
  AND fd.nr_unic_inreg IS NOT NULL
  AND TRIM(fd.nr_unic_inreg) <> ''
GROUP BY fd.org_id, fd.nr_unic_inreg, fd.revizie_nr
HAVING COUNT(*) > 1
ORDER BY fd.org_id, fd.nr_unic_inreg;

-- Interpretare:
--   • 0 rânduri  ⇒ singurul caz e cel deja știut sau nu mai există; indexul unic
--                  se poate crea direct
--   • ≥1 rânduri ⇒ TREBUIE curățate ÎNAINTE de a crea indexul unic, altfel
--                  migrarea eșuează (tăcut, ca la 095_df_dedup)
--   • `alop_ids` diferite = două dosare ALOP independente (cazul 40339)
--   • `alop_ids` identice = altceva; NU curăța automat, analizează separat


-- ───────────────────────────────────────────────────────────────────────────
-- PASUL 2 — context complet pentru fiecare document implicat
-- Îți arată ce ALOP îl deține, ce flux are, dacă e semnat — ca să decizi
-- CARE păstrează numărul și care primește altul.
-- ───────────────────────────────────────────────────────────────────────────
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
  d.id                AS df_id,
  d.nr_unic_inreg,
  d.revizie_nr,
  d.subtitlu_df       AS titlu,
  d.status,
  d.aprobat,
  d.created_at,
  d.source_alop_id,
  a.titlu             AS alop_titlu,
  a.status            AS alop_status,
  d.flow_id,
  (f.data->>'status') AS flux_status
FROM formulare_df d
JOIN coliziuni c
  ON c.org_id = d.org_id
 AND c.nr_unic_inreg = d.nr_unic_inreg
 AND c.revizie_nr = d.revizie_nr
LEFT JOIN alop_instances a ON a.id = d.source_alop_id
LEFT JOIN flows f ON f.id = d.flow_id AND f.deleted_at IS NULL
WHERE d.deleted_at IS NULL
ORDER BY d.nr_unic_inreg, d.created_at;

-- Regula de decizie recomandată:
--   • păstrează numărul la documentul MAI VECHI și/sau deja APROBAT/semnat
--     (are urmă în afara aplicației: flux semnat, PDF, poate deja la trezorerie)
--   • documentul mai nou primește alt număr — se poate schimba din interfață,
--     prin editarea DF-ului, cât timp e în draft/returnat/de_revizuit
--   ⛔ NU șterge niciun DF. ⛔ NU modifica numărul unui document deja semnat.


-- ───────────────────────────────────────────────────────────────────────────
-- PASUL 3 — după curățare: confirmă că se poate crea indexul unic
-- Re-rulează PASUL 1. Trebuie să întoarcă 0 rânduri.
-- Abia atunci migrarea din promptul #126 (Etapa A3) va reuși.
-- ───────────────────────────────────────────────────────────────────────────
