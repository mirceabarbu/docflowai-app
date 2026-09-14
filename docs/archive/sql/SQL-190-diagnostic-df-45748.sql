-- ============================================================================
-- SQL-190 — diagnostic DF 45748: aprobat pe flux, „completat" în listă
--
-- READ-ONLY. Un pas pe execuție. NU repară nimic.
--
-- Ipoteza de verificat: `formulare_df.flow_id` pointează spre unul dintre
-- fluxurile ANULATE (26.08 sau 01.09), nu spre cel FINALIZAT. Predicatul de
-- aprobare (`docAprobatSql`) cheiază pe flow_id-ul DOCUMENTULUI, nu pe
-- „există vreun flux finalizat" ⇒ cu pointerul pe un flux anulat, documentul
-- rămâne „Completat", iar dosarul ALOP rămâne în `angajare`.
--
-- Ecranul „Administrare fluxuri" arată TREI fluxuri pe 45748:
--   finalizat 01.09 · anulat 01.09 · anulat 26.08
-- Cele două din 01.09 sugerează o dublă lansare — poarta care o interzice a
-- intrat abia la #170, pe 02.09. Ar fi deci un incident istoric, nu o regresie
-- a loturilor recente. Pașii de mai jos confirmă sau infirmă.
-- ============================================================================

-- PASUL 1 — documentul: unde pointează și ce status are
SELECT fd.id,
       fd.nr_unic_inreg,
       fd.revizie_nr,
       fd.status                AS status_coloana,
       fd.flow_id               AS pointer_flux,
       fd.source_alop_id,
       fd.created_at,
       fd.updated_at
  FROM formulare_df fd
 WHERE fd.nr_unic_inreg = '45748'
   AND fd.deleted_at IS NULL
 ORDER BY fd.revizie_nr;

-- PASUL 2 — ⭐ toate fluxurile care revendică acest document, cu verdictul de aprobare
--           Coloana `ar_aproba` reproduce exact docAprobatSql.
WITH doc AS (
  SELECT id, flow_id FROM formulare_df
   WHERE nr_unic_inreg = '45748' AND deleted_at IS NULL
   ORDER BY revizie_nr DESC LIMIT 1
)
SELECT f.id                                            AS flow_id,
       (f.id = (SELECT flow_id FROM doc))              AS este_pointerul,
       f.data->>'status'                               AS status,
       (f.data->>'completed')                          AS completed,
       f.deleted_at IS NOT NULL                        AS sters,
       f.data->'meta'->>'dfId'                         AS revendica_doc,
       jsonb_array_length(
         CASE WHEN jsonb_typeof(f.data->'signers')='array'
              THEN f.data->'signers' ELSE '[]'::jsonb END)  AS nr_semnatari,
       EXISTS (SELECT 1 FROM flows_pdfs p
                WHERE p.flow_id = f.id AND p.key='signedPdfB64') AS are_pdf_semnat,
       f.created_at,
       f.updated_at,
       (
         f.deleted_at IS NULL
         AND (f.data->>'status') IS DISTINCT FROM 'cancelled'
         AND (f.data->>'status') IS DISTINCT FROM 'refused'
         AND ((f.data->>'status') = 'completed' OR (f.data->>'completed')::boolean = true)
       )                                               AS ar_aproba
  FROM flows f, doc
 WHERE f.data->'meta'->>'dfId' = doc.id::text
    OR f.id = doc.flow_id
 ORDER BY f.created_at;

-- ⚠️ Ce urmărești: EXACT UN rând cu ar_aproba = true. Dacă acel rând are
--    este_pointerul = false, ipoteza e confirmată: pointerul e pe fluxul greșit.

-- PASUL 3 — dosarul ALOP: ce pointeri are
SELECT a.id,
       a.titlu,
       a.status,
       a.df_id,
       a.df_flow_id,
       a.ord_id,
       a.ord_flow_id,
       a.df_completed_at,
       a.updated_at
  FROM alop_instances a
 WHERE a.cancelled_at IS NULL
   AND (a.titlu ILIKE '%curățenie%' OR a.titlu ILIKE '%curatenie%'
        OR a.df_id IN (SELECT id FROM formulare_df
                        WHERE nr_unic_inreg='45748' AND deleted_at IS NULL));

-- PASUL 4 — cronologia, ca să se vadă ce s-a întâmplat pe 01.09
SELECT a.created_at, a.flow_id, a.event_type, a.actor_email,
       left(a.payload::text, 120) AS payload
  FROM audit_log a
 WHERE a.flow_id IN (
        SELECT f.id FROM flows f, formulare_df fd
         WHERE fd.nr_unic_inreg='45748' AND fd.deleted_at IS NULL
           AND (f.data->'meta'->>'dfId' = fd.id::text OR f.id = fd.flow_id))
 ORDER BY a.created_at;

-- ============================================================================
-- INTERPRETARE
--
--  Pasul 2: un singur ar_aproba=true, dar este_pointerul=false
--      → pointerul e pe fluxul greșit. Reparația e mutarea lui pe fluxul
--        finalizat, urmată de relegarea dosarului (selfHealAlopDfLink).
--        NU se face orbește — vezi mai jos.
--
--  Pasul 2: DOUĂ rânduri cu ar_aproba=true
--      → două fluxuri finalizate pe același document. Caz mai grav; înainte de
--        orice reparație trebuie ales care e artefactul QES valid (cel cu
--        are_pdf_semnat = true și semnatarii compleți).
--
--  Pasul 2: zero ar_aproba=true
--      → ipoteza e greșită, fluxul „finalizat" din ecranul de administrare
--        înseamnă altceva. Oprește-te și spune-mi.
--
--  Pasul 3: df_flow_id NULL cu df_id completat
--      → e și cazul de la #188 (10 dosare), reparabil singur la aprobare.
--
--  ⛔ Nicio reparație manuală înainte de a citi rezultatele. Poarta ALOP e
--     ENFORCING de la migrația 109: o tranziție de status în afara matricei e
--     refuzată de bază, iar forțarea ei cere coborârea temporară a porții.
-- ============================================================================
