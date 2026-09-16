-- ============================================================================
-- SQL-213 — MĂSURĂTORI DUPĂ v3.9.865 (16.09.2026)
-- DocFlowAI, producție. DOAR SELECT, read-only.
--
-- ⚠️ Consola Railway adaugă singură `LIMIT n` și rulează O SINGURĂ interogare
--    pe execuție ⇒ copiază și rulează Q1, Q2, Q3 separat, pe rând.
--
-- Fiecare interogare răspunde la o întrebare care decide DACĂ un lot e necesar.
-- Rezultat zero = lotul nu se scrie. Asta e un rezultat bun, nu unul ratat.
-- ============================================================================


-- ─── Q1 — cele 4 linii „IBAN diferit" (555.075,55 lei): lista de lucru ──────
-- Nu decide un lot. E lista pentru corectarea MANUALĂ din interfață (calea A din
-- docs/docs-plati-transe-conturi-diferite.md), dosar cu dosar, cu extrasul în față.
-- Toate statusurile rămân în rezultat intenționat: rulată din nou după fiecare
-- acceptare, arată progresul (linia trece din `unmatched` în `manual`).
SELECT l.org_id,
       i.created_at::date       AS data_import,
       l.nr_op,
       l.suma_op,
       l.den_beneficiar,
       l.cif_beneficiar,
       l.cod_angajament,
       l.indicator_angajament,
       l.match_status,
       l.matched_alop_id,
       l.match_notes,
       l.id                     AS linie_id
  FROM opme_lines l
  JOIN opme_imports i ON i.id = l.opme_import_id
 WHERE l.match_notes ILIKE '%IBAN diferit%'
 ORDER BY l.org_id, i.created_at, l.nr_op;


-- ─── Q2 — pointeri rămași pe fluxuri finalizate DAR anulate/refuzate/șterse ─
-- Întrebarea: forma laxă `status='completed' OR completed=true` (fără excluderea
-- lui cancelled/refused) mai e scrisă în 8 locuri: clasa8.mjs (suma ordonanțărilor),
-- alop.mjs (ord_aprobat pe card, candidații de auto-legare, ruta admin de resync),
-- trasabilitate.mjs ×3. Un flux anulat administrativ PĂSTREAZĂ completed=true.
-- Azi aceste locuri sunt apărate INDIRECT: anularea golește pointerii
-- (flow-undo.mjs, lifecycle.mjs), deci JOIN-ul nu mai găsește fluxul.
--   0 rânduri  ⇒ apărarea prin pointer ține ⇒ NU se scrie lot.
--   >0 rânduri ⇒ exact aceste documente apar azi ca aprobate/ordonanțate greșit.
WITH ptr AS (
  SELECT 'formulare_ord.flow_id'::text AS sursa, fo.org_id, fo.id::text AS obiect_id, fo.flow_id::text AS flow_id
    FROM formulare_ord fo
   WHERE fo.deleted_at IS NULL AND fo.flow_id IS NOT NULL
  UNION ALL
  SELECT 'formulare_df.flow_id', fd.org_id, fd.id::text, fd.flow_id::text
    FROM formulare_df fd
   WHERE fd.deleted_at IS NULL AND fd.flow_id IS NOT NULL
  UNION ALL
  SELECT 'alop_instances.ord_flow_id', a.org_id, a.id::text, a.ord_flow_id::text
    FROM alop_instances a
   WHERE a.ord_flow_id IS NOT NULL
  UNION ALL
  SELECT 'alop_instances.df_flow_id', a.org_id, a.id::text, a.df_flow_id::text
    FROM alop_instances a
   WHERE a.df_flow_id IS NOT NULL
)
SELECT p.sursa,
       p.org_id,
       p.obiect_id,
       p.flow_id,
       f.data->>'status'          AS status_flux,
       f.data->>'completed'       AS steag_completed,
       (f.deleted_at IS NOT NULL) AS flux_sters
  FROM ptr p
  JOIN flows f ON f.id::text = p.flow_id
 WHERE f.data->>'completed' = 'true'
   AND (f.data->>'status' IN ('cancelled', 'refused') OR f.deleted_at IS NOT NULL)
 ORDER BY p.sursa, p.org_id, p.obiect_id;


-- ─── Q3 — cine a folosit efectiv căile excepționale de la #209–#211 ─────────
-- Întrebarea: `confirma-plata` e rezervată CAB-ului, cu org_admin EXCLUS deliberat
-- (#126 B1, separare de atribuții). Dar după #210 un org_admin poate ACCEPTA o linie
-- OPME (care confirmă plata prin matcher) și poate RELUA o confirmare. Q3 arată dacă
-- asimetria a fost deja folosită de cineva din afara CAB-ului.
--   e_cab = false pe vreun rând ⇒ decizia de politică devine urgentă, nu teoretică.
SELECT al.event_type,
       al.org_id,
       al.actor_email,
       u.role,
       u.compartiment,
       o.cab_compartiment,
       (COALESCE(TRIM(u.compartiment), '') <> ''
        AND TRIM(u.compartiment) = TRIM(o.cab_compartiment)) AS e_cab,
       count(*)           AS evenimente,
       min(al.created_at) AS primul,
       max(al.created_at) AS ultimul
  FROM audit_log al
  LEFT JOIN users u         ON lower(u.email) = lower(al.actor_email)
  LEFT JOIN organizations o ON o.id = al.org_id
 WHERE al.event_type IN ('opme_line_accepted_manual', 'plata_confirmare_reluata')
 GROUP BY al.event_type, al.org_id, al.actor_email, u.role, u.compartiment, o.cab_compartiment
 ORDER BY al.event_type, al.org_id, al.actor_email;
