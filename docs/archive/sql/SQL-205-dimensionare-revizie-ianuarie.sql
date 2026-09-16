-- ============================================================================
-- DIMENSIONARE — revizia de început de an (ianuarie 2027)
-- DocFlowAI, producție. Doar SELECT, read-only. Rulează pe Railway → Console.
--
-- Întrebarea: câte DF-uri ar intra efectiv în revizia pe care responsabilul CAB
-- o face în primele 3 zile lucrătoare din ianuarie?
--   ~5   ⇒ feature = un buton pe ecranul DF-ului
--   ~200 ⇒ feature = ecran de lucru în masă, cu progres și reluare (alt lot, alt calendar)
--
-- Criteriile (aceleași predicate ca în aplicație, nu rescrise de mână):
--   • ultima revizie APROBATĂ per DOSAR (dosarKeyExpr din df-dosar-key.mjs,
--     validSignedFlowSql din flow-provenance.mjs)
--   • an_referinta declarat (DF legacy cu NULL nu se pot re-ancora automat — vezi Q2)
--   • bandă NENULĂ pentru anul țintă
--
-- ⚠️ Schimbă `an_tinta` dacă vrei alt an. Lasă 2027 pentru dimensionarea reală.
-- ⚠️ Regex-ul `^[0-9.]+$` înaintea `::numeric` e obligatoriu: fără el, un rând cu
--    valoare în format RON („150000,00") aruncă și cade toată interogarea.
-- ============================================================================

-- ─── Q1 — defalcarea: câte DF-uri, pe ce bandă, în ce stare e dosarul ────────
WITH params AS (
  SELECT 2027::int AS an_tinta
),
latest_approved_df AS (
  SELECT DISTINCT ON (COALESCE(fd.source_alop_id::text, fd.nr_unic_inreg))
         fd.id, fd.org_id, fd.nr_unic_inreg, fd.an_referinta,
         fd.rows_plati, fd.source_alop_id, fd.revizie_nr
    FROM formulare_df fd
    JOIN flows f ON f.id = fd.flow_id
   WHERE fd.deleted_at IS NULL
     AND fd.flow_id IS NOT NULL
     AND fd.nr_unic_inreg IS NOT NULL
     AND f.deleted_at IS NULL
     AND f.data->>'status' IS DISTINCT FROM 'cancelled'
     AND f.data->>'status' IS DISTINCT FROM 'refused'
     AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
   ORDER BY COALESCE(fd.source_alop_id::text, fd.nr_unic_inreg), fd.revizie_nr DESC NULLS LAST
),
cu_banda AS (
  SELECT d.*, p.an_tinta,
         (p.an_tinta - d.an_referinta) AS offset_an,
         (CASE
            WHEN (p.an_tinta - d.an_referinta) < 0 THEN 'plati_ani_precedenti'
            WHEN (p.an_tinta - d.an_referinta) = 0 THEN 'plati_estim_ancrt'
            WHEN (p.an_tinta - d.an_referinta) = 1 THEN 'plati_estim_an_np1'
            WHEN (p.an_tinta - d.an_referinta) = 2 THEN 'plati_estim_an_np2'
            WHEN (p.an_tinta - d.an_referinta) = 3 THEN 'plati_estim_an_np3'
            ELSE 'plati_estim_ani_ulter' END) AS banda
    FROM latest_approved_df d CROSS JOIN params p
   WHERE d.an_referinta IS NOT NULL
),
cu_suma AS (
  SELECT c.*,
         (SELECT COALESCE(SUM((r->>c.banda)::numeric), 0)
            FROM jsonb_array_elements(COALESCE(c.rows_plati, '[]'::jsonb)) r
           WHERE (r->>c.banda) ~ '^[0-9.]+$') AS suma_an_tinta
    FROM cu_banda c
)
SELECT s.org_id,
       COALESCE(a.status, '(fara dosar ALOP)') AS status_dosar,
       (a.cancelled_at IS NOT NULL)            AS dosar_anulat,
       s.banda,
       count(*)                                AS df_uri,
       round(sum(s.suma_an_tinta), 2)          AS suma_totala
  FROM cu_suma s
  LEFT JOIN alop_instances a ON a.id = s.source_alop_id
 WHERE s.suma_an_tinta > 0
 GROUP BY s.org_id, a.status, (a.cancelled_at IS NOT NULL), s.banda
 ORDER BY s.org_id, status_dosar, s.banda;


-- ─── Q2 — câte DF-uri APROBATE nu au an_referinta (legacy, pre-migrarea 085) ─
-- Astea NU se pot re-ancora automat: fără an de referință nu știm ce înseamnă
-- banda `ancrt`. Dacă numărul e mare, revizia de ianuarie are nevoie de o cale
-- manuală pentru ele, nu doar de butonul automat.
SELECT fd.org_id,
       count(*) FILTER (WHERE fd.an_referinta IS NULL)     AS fara_an_referinta,
       count(*) FILTER (WHERE fd.an_referinta IS NOT NULL) AS cu_an_referinta,
       min(fd.an_referinta)                                AS an_min,
       max(fd.an_referinta)                                AS an_max
  FROM formulare_df fd
  JOIN flows f ON f.id = fd.flow_id
 WHERE fd.deleted_at IS NULL
   AND fd.flow_id IS NOT NULL
   AND f.deleted_at IS NULL
   AND f.data->>'status' IS DISTINCT FROM 'cancelled'
   AND f.data->>'status' IS DISTINCT FROM 'refused'
   AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
 GROUP BY fd.org_id
 ORDER BY fd.org_id;
