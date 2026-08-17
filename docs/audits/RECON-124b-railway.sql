-- ============================================================================
-- RECON #124b — duplicate în PRODUCȚIE  ·  VARIANTĂ PENTRU CONSOLA RAILWAY
-- ============================================================================
-- Sursa: docs/audits/recon-124-duplicate-check.sql (varianta psql, #124a)
-- Diferențe față de original — TOATE impuse de consola Railway:
--   1. FĂRĂ `LIMIT` la finalul interogărilor (consola adaugă automat un LIMIT;
--      peste unul existent ar da `syntax error at or near "LIMIT"`).
--   2. O SINGURĂ interogare per execuție — golește editorul între blocuri.
--   3. Ordinea e schimbată: întâi cele 5 care DECID, apoi detaliile.
--
-- ⛔ STRICT READ-ONLY. Doar SELECT. Se poate rula oricând pe producție.
--
-- ORDINEA DE RULARE
--   Pasul 1 → blocul 0   (schema — dacă ceva lipsește, sari blocul dependent)
--   Pasul 2 → blocul 1   (indexul DF există? cel mai prost rezultat posibil)
--   Pasul 3 → blocul 2   (ORD duplicate — întrebarea principală pentru #124e)
--   Pasul 4 → blocul 4b  (fluxuri paralele — măsoară direct problema raportată)
--   Pasul 5 → blocul 5   (reinițieri duble — justifică #124f)
--   Pasul 6 → blocul 6   (numere de registru consumate degeaba — #124g)
--   Apoi, DOAR dacă e cazul: 1b (dacă 1 e gol), 2b + 2c (dacă 2 > 0),
--   3 / 3b (ALOP), 4 (detaliu fluxuri), 7 (atașamente).
-- ============================================================================


-- ############################################################################
-- PASUL 1 · BLOCUL 0 — verificare de schemă
-- Așteptat: toate `exista = true`, MAI PUȚIN formulare_ord.revizie_nr = FALSE
--           (ORD nu are revizii — nu e o problemă, e confirmarea asimetriei).
-- ############################################################################
SELECT
  t.tabel,
  t.coloana,
  EXISTS (
    SELECT 1 FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.table_name   = t.tabel
       AND c.column_name  = t.coloana
  ) AS exista
FROM (VALUES
  ('formulare_df',  'source_alop_id'),
  ('formulare_df',  'revizie_nr'),
  ('formulare_df',  'nr_unic_inreg'),
  ('formulare_df',  'deleted_at'),
  ('formulare_ord', 'source_alop_id'),
  ('formulare_ord', 'deleted_at'),
  ('formulare_ord', 'nr_ordonant_pl'),
  ('formulare_ord', 'revizie_nr'),
  ('alop_instances','cancelled_at'),
  ('alop_instances','titlu'),
  ('flows',         'deleted_at'),
  ('flows',         'org_id')
) AS t(tabel, coloana)
ORDER BY t.tabel, t.coloana;


-- ############################################################################
-- PASUL 2 · BLOCUL 1 — indexul unic al DF există în producție?
-- 1 rând     ⇒ migrarea 095 a reușit, DF e protejat la creare.
-- 0 rânduri  ⇒ ⚠️ CEL MAI PROST REZULTAT: migrarea a eșuat TĂCUT (RAISE WARNING)
--              din cauza unor duplicate rămase. Atunci rulează blocul 1b.
-- ############################################################################
SELECT indexname, indexdef
  FROM pg_indexes
 WHERE schemaname = 'public'
   AND tablename  = 'formulare_df'
   AND indexname  = 'df_source_alop_revizie_uniq';


-- ############################################################################
-- PASUL 3 · BLOCUL 2 — ORD duplicate pe source_alop_id  ⭐ ÎNTREBAREA PRINCIPALĂ
-- grupuri_cu_duplicate = 0  ⇒ ✅ indexul unic pe ORD (#124e) se poate crea direct.
-- grupuri_cu_duplicate > 0  ⇒ ⛔ nu se poate crea fără curățare; rulează 2b + 2c.
-- ############################################################################
SELECT
  COUNT(*)                     AS grupuri_cu_duplicate,
  COALESCE(SUM(nr_ord), 0)     AS ord_uri_implicate,
  COALESCE(SUM(nr_ord - 1), 0) AS ord_uri_in_exces,
  COALESCE(SUM(pe_flux), 0)    AS din_care_pe_flux
FROM (
  SELECT
    source_alop_id,
    COUNT(*)                                    AS nr_ord,
    COUNT(*) FILTER (WHERE flow_id IS NOT NULL) AS pe_flux
  FROM formulare_ord
  WHERE source_alop_id IS NOT NULL
    AND deleted_at IS NULL
  GROUP BY source_alop_id
  HAVING COUNT(*) > 1
) g;


-- ############################################################################
-- PASUL 4 · BLOCUL 4b — fluxuri paralele pe același document (agregat)
-- `sub_5s` > 0 ⇒ dovadă directă de dublu-clic pe „Pornește fluxul" (btnCreate).
-- Predicatul „flux viu" e copiat verbatim din liveFlowSql() (flow-provenance.mjs).
-- ############################################################################
SELECT
  COUNT(*)                                                        AS documente_cu_fluxuri_paralele,
  COALESCE(SUM(fluxuri_vii - 1), 0)                               AS fluxuri_in_exces,
  COUNT(*) FILTER (WHERE interval_creare < INTERVAL '60 seconds') AS sub_60s,
  COUNT(*) FILTER (WHERE interval_creare < INTERVAL '5 seconds')  AS sub_5s
FROM (
  SELECT
    m.tip, m.doc_id,
    COUNT(*)                              AS fluxuri_vii,
    MAX(f.created_at) - MIN(f.created_at) AS interval_creare
  FROM flows f
  CROSS JOIN LATERAL (VALUES
    ('df',  f.data->'meta'->>'dfId'),
    ('ord', f.data->'meta'->>'ordId')
  ) AS m(tip, doc_id)
  WHERE m.doc_id IS NOT NULL
    AND f.deleted_at IS NULL
    AND f.data->>'status' IS DISTINCT FROM 'cancelled'
    AND f.data->>'status' IS DISTINCT FROM 'refused'
  GROUP BY m.tip, m.doc_id
  HAVING COUNT(*) > 1
) g;


-- ############################################################################
-- PASUL 5 · BLOCUL 5 — reinițieri duble (`reinitiatedAs` scris dar necitit)
-- > 0 rânduri ⇒ confirmă empiric că al doilea clic pe „Reinițiază" chiar creează
--               un al doilea flux copil. Justifică #124f cu date.
-- ############################################################################
SELECT
  f.data->>'parentFlowId'               AS parinte,
  COUNT(*)                              AS copii,
  MIN(f.created_at)                     AS primul,
  MAX(f.created_at)                     AS ultimul,
  MAX(f.created_at) - MIN(f.created_at) AS interval_creare,
  array_agg(f.id ORDER BY f.created_at) AS copii_id
FROM flows f
WHERE f.data->>'parentFlowId' IS NOT NULL
  AND f.deleted_at IS NULL
GROUP BY f.data->>'parentFlowId'
HAVING COUNT(*) > 1
ORDER BY copii DESC, ultimul DESC;


-- ############################################################################
-- PASUL 6 · BLOCUL 6 — poziții de registru duplicate (sursa_id mintit pe server)
-- Fiecare rând = DOUĂ numere de registru consumate pentru un singur document.
-- Consecință juridică, nu cosmetică. Justifică #124g.
-- ############################################################################
SELECT
  a.org_id,
  a.registru,
  a.obiect,
  a.expeditor,
  a.numar_format              AS nr_1,
  b.numar_format              AS nr_2,
  a.created_at                AS creat_1,
  b.created_at                AS creat_2,
  b.created_at - a.created_at AS delta
FROM registru_intrari a
JOIN registru_intrari b
  ON  b.org_id     = a.org_id
 AND  b.registru   = a.registru
 AND  b.sursa_tip  = 'manual'
 AND  b.obiect     = a.obiect
 AND  b.expeditor  = a.expeditor
 AND  b.created_at > a.created_at
 AND  b.created_at < a.created_at + INTERVAL '60 seconds'
WHERE a.sursa_tip = 'manual'
ORDER BY delta ASC;


-- ============================================================================
-- CONDIȚIONALE — rulează-le doar dacă pașii de mai sus o cer
-- ============================================================================


-- ############################################################################
-- BLOCUL 1b — RULEAZĂ DOAR DACĂ pasul 2 (blocul 1) a întors 0 rânduri.
-- Ce grupuri DF blochează recrearea indexului. `pe_flux > 1` ⇒ decizie umană.
-- ############################################################################
SELECT
  source_alop_id,
  revizie_nr,
  COUNT(*)                                    AS nr_df,
  COUNT(*) FILTER (WHERE flow_id IS NOT NULL) AS pe_flux,
  MIN(created_at)                             AS primul,
  MAX(created_at)                             AS ultimul,
  array_agg(id ORDER BY created_at)           AS id_uri
FROM formulare_df
WHERE source_alop_id IS NOT NULL
  AND deleted_at IS NULL
GROUP BY source_alop_id, revizie_nr
HAVING COUNT(*) > 1
ORDER BY nr_df DESC, ultimul DESC;


-- ############################################################################
-- BLOCUL 2b — RULEAZĂ DOAR DACĂ pasul 3 a dat grupuri_cu_duplicate > 0.
-- `nr_ord_distincte > 1` ⇒ ordonanțări legitime multiple pe același dosar
--   ⇒ cheia (source_alop_id) singură e PREA STRICTĂ pentru un index unic.
-- `pe_flux = 0` ⇒ grup curățabil automat (soft-delete pe toate în afară de primul).
-- ############################################################################
SELECT
  o.source_alop_id,
  COUNT(*)                                      AS nr_ord,
  COUNT(*) FILTER (WHERE o.flow_id IS NOT NULL) AS pe_flux,
  COUNT(DISTINCT o.nr_ordonant_pl)
    FILTER (WHERE o.nr_ordonant_pl IS NOT NULL
                AND o.nr_ordonant_pl <> '')     AS nr_ord_distincte,
  COUNT(DISTINCT o.org_id)                      AS org_uri,
  MIN(o.created_at)                             AS primul,
  MAX(o.created_at)                             AS ultimul,
  MAX(o.created_at) - MIN(o.created_at)         AS interval_creare,
  array_agg(o.id     ORDER BY o.created_at)     AS id_uri,
  array_agg(o.status ORDER BY o.created_at)     AS statusuri
FROM formulare_ord o
WHERE o.source_alop_id IS NOT NULL
  AND o.deleted_at IS NULL
GROUP BY o.source_alop_id
HAVING COUNT(*) > 1
ORDER BY nr_ord DESC, ultimul DESC;


-- ############################################################################
-- BLOCUL 2c — semnătura de DUBLU-CLIC la ORD (perechi la sub 30 s).
-- Rândurile de aici sunt aproape sigur duplicate accidentale; grupurile din 2b
-- care NU apar aici sunt probabil ordonanțări legitime.
-- ############################################################################
SELECT
  a.source_alop_id,
  a.id                        AS ord_1,
  b.id                        AS ord_2,
  a.created_at                AS creat_1,
  b.created_at                AS creat_2,
  b.created_at - a.created_at AS delta,
  a.nr_ordonant_pl            AS nr_1,
  b.nr_ordonant_pl            AS nr_2
FROM formulare_ord a
JOIN formulare_ord b
  ON b.source_alop_id = a.source_alop_id
 AND b.created_at > a.created_at
 AND b.created_at < a.created_at + INTERVAL '30 seconds'
WHERE a.source_alop_id IS NOT NULL
  AND a.deleted_at IS NULL
  AND b.deleted_at IS NULL
ORDER BY delta ASC;


-- ############################################################################
-- BLOCUL 3b — dosare ALOP potențial duplicate (agregat).
-- Alimentează decizia deschisă de la #124h (ancora de idempotență pt POST /api/alop):
--   perechi = 0     ⇒ opțiunea 3 (nicio cheie pe server) devine rezonabilă;
--   perechi mare    ⇒ opțiunea 2 (cheie de idempotență de la client) se justifică.
-- ############################################################################
SELECT
  COUNT(*)                                AS perechi,
  COUNT(*) FILTER (WHERE b.df_id IS NULL) AS al_doilea_fara_df,
  COUNT(DISTINCT a.org_id)                AS organizatii_afectate,
  MIN(b.created_at - a.created_at)        AS delta_min,
  MAX(b.created_at - a.created_at)        AS delta_max
FROM alop_instances a
JOIN alop_instances b
  ON  b.org_id     = a.org_id
 AND  b.created_by = a.created_by
 AND  b.titlu      = a.titlu
 AND  b.created_at > a.created_at
 AND  b.created_at < a.created_at + INTERVAL '60 seconds'
WHERE a.cancelled_at IS NULL
  AND b.cancelled_at IS NULL;


-- ############################################################################
-- BLOCUL 3 — detaliul perechilor ALOP (rulează dacă 3b > 0).
-- `df_1` sau `df_2` NULL ⇒ acela e dosarul orfan, candidat la anulare.
-- ############################################################################
SELECT
  a.org_id,
  a.created_by,
  a.titlu,
  a.id                        AS alop_1,
  b.id                        AS alop_2,
  a.created_at                AS creat_1,
  b.created_at                AS creat_2,
  b.created_at - a.created_at AS delta,
  a.status                    AS status_1,
  b.status                    AS status_2,
  a.df_id                     AS df_1,
  b.df_id                     AS df_2
FROM alop_instances a
JOIN alop_instances b
  ON  b.org_id     = a.org_id
 AND  b.created_by = a.created_by
 AND  b.titlu      = a.titlu
 AND  b.created_at > a.created_at
 AND  b.created_at < a.created_at + INTERVAL '60 seconds'
WHERE a.cancelled_at IS NULL
  AND b.cancelled_at IS NULL
ORDER BY delta ASC;


-- ############################################################################
-- BLOCUL 4 — detaliul documentelor cu fluxuri paralele (rulează dacă 4b > 0).
-- Corespunde clasei D din flow-link-audit.mjs (#120). Dacă acel card arată 0 și
-- aici apar rânduri, cele două definiții au driftat.
-- ############################################################################
SELECT
  m.tip,
  m.doc_id,
  COUNT(*)                                             AS fluxuri_vii,
  MIN(f.created_at)                                    AS primul,
  MAX(f.created_at)                                    AS ultimul,
  MAX(f.created_at) - MIN(f.created_at)                AS interval_creare,
  array_agg(f.id              ORDER BY f.created_at)   AS flow_id_uri,
  array_agg(f.data->>'status' ORDER BY f.created_at)   AS statusuri
FROM flows f
CROSS JOIN LATERAL (VALUES
  ('df',  f.data->'meta'->>'dfId'),
  ('ord', f.data->'meta'->>'ordId')
) AS m(tip, doc_id)
WHERE m.doc_id IS NOT NULL
  AND f.deleted_at IS NULL
  AND f.data->>'status' IS DISTINCT FROM 'cancelled'
  AND f.data->>'status' IS DISTINCT FROM 'refused'
GROUP BY m.tip, m.doc_id
HAVING COUNT(*) > 1
ORDER BY fluxuri_vii DESC, ultimul DESC;


-- ############################################################################
-- BLOCUL 7 — atașamente duplicate (opțional, decide lotul #124i).
-- Impact vizual, nu financiar.
-- ############################################################################
SELECT 'formulare_atasamente' AS tabel,
       form_type::text        AS ctx_1,
       form_id::text          AS ctx_2,
       slot::text             AS ctx_3,
       filename,
       size_bytes,
       COUNT(*)                          AS aparitii,
       MAX(created_at) - MIN(created_at) AS interval_incarcare
  FROM formulare_atasamente
 WHERE deleted_at IS NULL
 GROUP BY form_type, form_id, slot, filename, size_bytes
HAVING COUNT(*) > 1

UNION ALL

SELECT 'flow_attachments',
       flow_id,
       NULL,
       NULL,
       filename,
       size_bytes,
       COUNT(*),
       NULL
  FROM flow_attachments
 GROUP BY flow_id, filename, size_bytes
HAVING COUNT(*) > 1

ORDER BY aparitii DESC;
