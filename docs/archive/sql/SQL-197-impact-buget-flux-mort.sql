-- ============================================================================
-- SQL-197 — Cât buget se consumă AZI pe DF-uri cu aprobarea desfăcută
--
-- READ-ONLY. Rulează ÎNAINTE de a livra #197.
-- Rezultatul îți spune două lucruri:
--   1. dacă bugetul afișat azi în Clasa 8 e greșit, și cu cât;
--   2. ce se va schimba vizibil pentru utilizatori după deploy —
--      „Rămâne din buget" va CREȘTE pe dosarele din listă.
--
-- Consola Railway: o singură interogare pe execuție.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- PASUL 1 — DF-urile numărate azi ca aprobate, deși fluxul lor e mort
--
-- Reproduce predicatul actual din clasa8.mjs (doar „finalizat"), apoi arată
-- care dintre rânduri NU ar trece de garda completă.
-- ════════════════════════════════════════════════════════════════════════════
SELECT fd.org_id,
       fd.nr_unic_inreg,
       fd.revizie_nr,
       fd.id                        AS df_id,
       fd.flow_id,
       f.data->>'status'            AS flux_status,
       (f.data->>'completed')       AS flux_completed,
       f.deleted_at IS NOT NULL     AS flux_sters,
       (SELECT COALESCE(SUM(NULLIF(r->>'sum_rezv_crdt_bug_act','')::numeric), 0)
          FROM jsonb_array_elements(COALESCE(fd.rows_ctrl, '[]'::jsonb)) r)
                                    AS suma_consumata_gresit
  FROM formulare_df fd
  JOIN flows f ON f.id = fd.flow_id
 WHERE fd.deleted_at IS NULL
   AND fd.flow_id IS NOT NULL
   AND fd.nr_unic_inreg IS NOT NULL
   -- predicatul ACTUAL din clasa8.mjs:
   AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
   -- ...dar fluxul e de fapt mort:
   AND (f.deleted_at IS NOT NULL
        OR (f.data->>'status') = 'cancelled'
        OR (f.data->>'status') = 'refused')
 ORDER BY fd.org_id, fd.nr_unic_inreg, fd.revizie_nr;

-- ⚠️ ZERO rânduri ⇒ bugetul afișat azi e corect, iar #197 e pură prevenție.
--    Rânduri ⇒ fiecare e o sumă consumată din buget fără temei.


-- ════════════════════════════════════════════════════════════════════════════
-- PASUL 2 — Impactul REAL, pe dosar
--
-- Contează doar dosarele unde revizia moartă e cea mai MARE: acolo
-- `DISTINCT ON … ORDER BY revizie_nr DESC` o alege pe ea, în locul reviziei
-- aprobate anterior. Dacă există o revizie vie mai nouă, dosarul e deja corect.
-- ════════════════════════════════════════════════════════════════════════════
WITH df_cu_stare AS (
  SELECT fd.org_id, fd.nr_unic_inreg, fd.revizie_nr, fd.id, fd.rows_ctrl,
         (f.deleted_at IS NULL
          AND (f.data->>'status') IS DISTINCT FROM 'cancelled'
          AND (f.data->>'status') IS DISTINCT FROM 'refused')            AS flux_viu
    FROM formulare_df fd
    JOIN flows f ON f.id = fd.flow_id
   WHERE fd.deleted_at IS NULL
     AND fd.flow_id IS NOT NULL
     AND fd.nr_unic_inreg IS NOT NULL
     AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
),
aleasa_azi AS (
  SELECT DISTINCT ON (org_id, nr_unic_inreg) *
    FROM df_cu_stare
   ORDER BY org_id, nr_unic_inreg, revizie_nr DESC NULLS LAST
),
aleasa_dupa_fix AS (
  SELECT DISTINCT ON (org_id, nr_unic_inreg) *
    FROM df_cu_stare
   WHERE flux_viu
   ORDER BY org_id, nr_unic_inreg, revizie_nr DESC NULLS LAST
)
SELECT a.org_id,
       a.nr_unic_inreg,
       a.revizie_nr                                    AS revizie_folosita_azi,
       d.revizie_nr                                    AS revizie_dupa_fix,
       (SELECT COALESCE(SUM(NULLIF(r->>'sum_rezv_crdt_bug_act','')::numeric),0)
          FROM jsonb_array_elements(COALESCE(a.rows_ctrl,'[]'::jsonb)) r) AS consum_azi,
       COALESCE((SELECT COALESCE(SUM(NULLIF(r->>'sum_rezv_crdt_bug_act','')::numeric),0)
          FROM jsonb_array_elements(COALESCE(d.rows_ctrl,'[]'::jsonb)) r), 0) AS consum_dupa_fix
  FROM aleasa_azi a
  LEFT JOIN aleasa_dupa_fix d
         ON d.org_id = a.org_id AND d.nr_unic_inreg = a.nr_unic_inreg
 WHERE a.flux_viu IS NOT TRUE
 ORDER BY a.org_id, a.nr_unic_inreg;

-- ⚠️ `revizie_dupa_fix` NULL ⇒ dosarul nu are nicio revizie cu flux viu:
--    după corecție dispare complet din consumul de buget. Corect, dar de
--    anunțat utilizatorului — o cifră care se schimbă fără explicație
--    erodează încrederea în tot centralizatorul.
--
-- ⚠️ Diferența `consum_azi − consum_dupa_fix` e exact suma care se eliberează
--    pe fiecare cod SSI. Notează-o înainte de deploy ca s-o poți confrunta
--    cu ce arată aplicația după.
-- ============================================================================
