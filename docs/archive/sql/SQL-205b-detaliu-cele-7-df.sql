-- ============================================================================
-- DETALIU — cele ~7 DF-uri cu bandă nenulă pe 2027, rând cu rând
-- Continuă SQL-205. Doar SELECT, read-only. Railway → Console.
--
-- Ce răspunde:
--   • care sunt documentele, pe ce compartiment, cu ce obiect
--   • TOATE benzile, nu doar cea țintă — ca să se vadă forma distribuției
--     multianuale (dacă np2/np3/ulter sunt nenule, angajamentul e pe mai mulți ani)
--   • creditele col.10 (`sum_rezv_crdt_bug_act`) — plafonul real, pe care revizia
--     trebuie să-l PROPUNĂ alunecat, dar CAB-ul să-l confirme cu cifra din bugetul 2027
--   • bifa „Stingere" — când e activă, banda anului curent e 0 prin construcție,
--     deci un np1 nenul pe un DF cu Stingere înseamnă altceva decât pe unul fără
--   • cât s-a plătit pe dosar și când s-a închis — pentru cazul `completed`
--
-- ⚠️ `left(..., 22/34)` doar ca să încapă în consola Railway. Scoate-le dacă vrei textul întreg.
-- ============================================================================

WITH params AS (SELECT 2027::int AS an_tinta),
latest_approved_df AS (
  SELECT DISTINCT ON (COALESCE(fd.source_alop_id::text, fd.nr_unic_inreg))
         fd.id, fd.org_id, fd.nr_unic_inreg, fd.an_referinta, fd.revizie_nr,
         fd.compartiment_specialitate, fd.obiect_fd_reviz_scurt,
         fd.ckbx_sting_ang_in_ancrt, fd.rows_plati, fd.rows_ctrl, fd.source_alop_id
    FROM formulare_df fd
    JOIN flows f ON f.id = fd.flow_id
   WHERE fd.deleted_at IS NULL AND fd.flow_id IS NOT NULL AND fd.nr_unic_inreg IS NOT NULL
     AND f.deleted_at IS NULL
     AND f.data->>'status' IS DISTINCT FROM 'cancelled'
     AND f.data->>'status' IS DISTINCT FROM 'refused'
     AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
   ORDER BY COALESCE(fd.source_alop_id::text, fd.nr_unic_inreg), fd.revizie_nr DESC NULLS LAST
),
b AS (
  SELECT d.*, p.an_tinta, (p.an_tinta - d.an_referinta) AS offset_an,
         (CASE WHEN (p.an_tinta - d.an_referinta) < 0 THEN 'plati_ani_precedenti'
               WHEN (p.an_tinta - d.an_referinta) = 0 THEN 'plati_estim_ancrt'
               WHEN (p.an_tinta - d.an_referinta) = 1 THEN 'plati_estim_an_np1'
               WHEN (p.an_tinta - d.an_referinta) = 2 THEN 'plati_estim_an_np2'
               WHEN (p.an_tinta - d.an_referinta) = 3 THEN 'plati_estim_an_np3'
               ELSE 'plati_estim_ani_ulter' END) AS banda
    FROM latest_approved_df d CROSS JOIN params p
   WHERE d.an_referinta IS NOT NULL
),
s AS (
  SELECT b.*,
    (SELECT COALESCE(SUM((r->>b.banda)::numeric),0) FROM jsonb_array_elements(COALESCE(b.rows_plati,'[]'::jsonb)) r
      WHERE (r->>b.banda) ~ '^[0-9.]+$') AS suma_tinta,
    (SELECT COALESCE(SUM((r->>'plati_estim_ancrt')::numeric),0) FROM jsonb_array_elements(COALESCE(b.rows_plati,'[]'::jsonb)) r
      WHERE (r->>'plati_estim_ancrt') ~ '^[0-9.]+$') AS b_ancrt,
    (SELECT COALESCE(SUM((r->>'plati_estim_an_np1')::numeric),0) FROM jsonb_array_elements(COALESCE(b.rows_plati,'[]'::jsonb)) r
      WHERE (r->>'plati_estim_an_np1') ~ '^[0-9.]+$') AS b_np1,
    (SELECT COALESCE(SUM((r->>'plati_estim_an_np2')::numeric),0) FROM jsonb_array_elements(COALESCE(b.rows_plati,'[]'::jsonb)) r
      WHERE (r->>'plati_estim_an_np2') ~ '^[0-9.]+$') AS b_np2,
    (SELECT COALESCE(SUM((r->>'plati_estim_an_np3')::numeric),0) FROM jsonb_array_elements(COALESCE(b.rows_plati,'[]'::jsonb)) r
      WHERE (r->>'plati_estim_an_np3') ~ '^[0-9.]+$') AS b_np3,
    (SELECT COALESCE(SUM((r->>'plati_estim_ani_ulter')::numeric),0) FROM jsonb_array_elements(COALESCE(b.rows_plati,'[]'::jsonb)) r
      WHERE (r->>'plati_estim_ani_ulter') ~ '^[0-9.]+$') AS b_ulter,
    (SELECT COALESCE(SUM((r->>'sum_rezv_crdt_bug_act')::numeric),0) FROM jsonb_array_elements(COALESCE(b.rows_ctrl,'[]'::jsonb)) r
      WHERE (r->>'sum_rezv_crdt_bug_act') ~ '^[0-9.]+$') AS credite_col10
  FROM b
)
SELECT s.nr_unic_inreg, s.revizie_nr AS rev, s.an_referinta AS an_ref,
       left(COALESCE(s.compartiment_specialitate,''), 22) AS compartiment,
       left(COALESCE(s.obiect_fd_reviz_scurt,''), 34)     AS obiect,
       a.status AS dosar,
       (s.ckbx_sting_ang_in_ancrt NOT IN ('','0','false','f','no','off')) AS sting,
       s.b_ancrt, s.b_np1, s.b_np2, s.b_np3, s.b_ulter, s.credite_col10,
       COALESCE(a.suma_totala_platita,0) + COALESCE(a.plata_suma_efectiva,0) AS platit_dosar,
       a.completed_at::date AS inchis_la
  FROM s LEFT JOIN alop_instances a ON a.id = s.source_alop_id
 WHERE s.suma_tinta > 0
 ORDER BY a.status, s.nr_unic_inreg;
