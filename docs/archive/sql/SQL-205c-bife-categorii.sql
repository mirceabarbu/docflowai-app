-- ============================================================================
-- CATEGORII — bifele din Secțiunea A pe cele 7 DF-uri cu bandă pe 2027
-- Continuă SQL-205 / 205b. Doar SELECT, read-only. Railway → Console.
--
-- Întrebarea: cele două DF-uri cu credite_col10 = 0 (43191, 44400) sunt
-- „angajamente legale emise în contul anului următor" — adică au bifa
-- `ckbx_ang_leg_emise_ct_an_urm` — sau e altceva?
--
-- Contează pentru design: dacă DA, lotul reviziei are DOUĂ categorii, cu
-- semantici diferite:
--   • reportare  → col.10 nou = b_np1 (alunecare propusă, CAB confirmă)
--   • ACTIVARE   → col.10 pornește de la ZERO; nu există ce aluneca, valoarea
--                  vine integral din bugetul 2027
-- Dacă NU, cele două sunt DF-uri cu Secțiunea B necompletată, ceea ce e o
-- constatare diferită (și mai îngrijorătoare) — vezi `randuri_secB`.
--
-- Coloana `neacoperit` = angajament_total − credite_col10 − suma_tinta.
-- Nu e o eroare dacă e ≠ 0 (angajamentul se poate întinde pe ani nemăsurați aici),
-- dar valori mari arată unde documentul nu se închide aritmetic.
-- ============================================================================

WITH params AS (SELECT 2027::int AS an_tinta),
latest_approved_df AS (
  SELECT DISTINCT ON (COALESCE(fd.source_alop_id::text, fd.nr_unic_inreg))
         fd.id, fd.nr_unic_inreg, fd.an_referinta, fd.rows_plati, fd.rows_val, fd.rows_ctrl,
         fd.source_alop_id,
         fd.ckbx_fara_ang_emis_ancrt, fd.ckbx_cu_ang_emis_ancrt,
         fd.ckbx_sting_ang_in_ancrt, fd.ckbx_fara_plati_ang_in_ancrt,
         fd.ckbx_cu_plati_ang_in_mmani, fd.ckbx_ang_leg_emise_ct_an_urm,
         fd.ckbx_ramane_suma, fd.ramane_suma
    FROM formulare_df fd
    JOIN flows f ON f.id = fd.flow_id
   WHERE fd.deleted_at IS NULL AND fd.flow_id IS NOT NULL AND fd.nr_unic_inreg IS NOT NULL
     AND f.deleted_at IS NULL
     AND f.data->>'status' IS DISTINCT FROM 'cancelled'
     AND f.data->>'status' IS DISTINCT FROM 'refused'
     AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
   ORDER BY COALESCE(fd.source_alop_id::text, fd.nr_unic_inreg), fd.revizie_nr DESC NULLS LAST
),
t AS (
  SELECT d.*, p.an_tinta,
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
  SELECT t.*,
    (SELECT COALESCE(SUM((r->>t.banda)::numeric),0) FROM jsonb_array_elements(COALESCE(t.rows_plati,'[]'::jsonb)) r
      WHERE (r->>t.banda) ~ '^[0-9.]+$') AS suma_tinta,
    (SELECT COALESCE(SUM((r->>'valt_actualiz')::numeric),0) FROM jsonb_array_elements(COALESCE(t.rows_val,'[]'::jsonb)) r
      WHERE (r->>'valt_actualiz') ~ '^[0-9.]+$') AS angajament_total,
    (SELECT COALESCE(SUM((r->>'sum_rezv_crdt_bug_act')::numeric),0) FROM jsonb_array_elements(COALESCE(t.rows_ctrl,'[]'::jsonb)) r
      WHERE (r->>'sum_rezv_crdt_bug_act') ~ '^[0-9.]+$') AS credite_col10,
    (SELECT count(*) FROM jsonb_array_elements(COALESCE(t.rows_ctrl,'[]'::jsonb)) r) AS randuri_secB
  FROM t
),
bf AS (
  SELECT s.*,
    (s.ckbx_ang_leg_emise_ct_an_urm NOT IN ('','0','false','f','no','off')) AS ang_leg_an_urm,
    (s.ckbx_fara_ang_emis_ancrt     NOT IN ('','0','false','f','no','off')) AS fara_ang_ancrt,
    (s.ckbx_cu_ang_emis_ancrt       NOT IN ('','0','false','f','no','off')) AS cu_ang_ancrt,
    (s.ckbx_fara_plati_ang_in_ancrt NOT IN ('','0','false','f','no','off')) AS fara_plati_ancrt,
    (s.ckbx_cu_plati_ang_in_mmani   NOT IN ('','0','false','f','no','off')) AS plati_multianual,
    (s.ckbx_ramane_suma             NOT IN ('','0','false','f','no','off')) AS ramane_bifat
  FROM s
)
SELECT bf.nr_unic_inreg,
       (CASE WHEN bf.credite_col10 = 0 THEN 'ACTIVARE (col.10 = 0)'
             ELSE 'reportare' END)                       AS categorie,
       bf.ang_leg_an_urm, bf.fara_ang_ancrt, bf.cu_ang_ancrt,
       bf.fara_plati_ancrt, bf.plati_multianual, bf.ramane_bifat,
       NULLIF(bf.ramane_suma,'')                          AS ramane_suma,
       bf.angajament_total, bf.credite_col10, bf.suma_tinta,
       bf.randuri_secB,
       round(bf.angajament_total - bf.credite_col10 - bf.suma_tinta, 2) AS neacoperit
  FROM bf
 WHERE bf.suma_tinta > 0
 ORDER BY categorie, bf.nr_unic_inreg;
