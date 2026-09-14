-- ============================================================================
-- SQL-189 — s-au pierdut semnături prin scriere concurentă? (READ-ONLY)
--
-- Context: `saveFlow` (db/index.mjs) scrie obiectul `data` ÎNTREG, cu
--   ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data
-- adică last-write-wins, fără `version` și fără tranzacție între JSONB și
-- flows_pdfs. Două cereri concurente pe același flux citesc, modifică, scriu —
-- a doua o suprascrie pe prima. Pe un flux de semnare asta înseamnă o
-- semnătură dispărută din signers[], deși PDF-ul semnat există în flows_pdfs.
--
-- audit_log e martorul independent: fiecare semnătură reușită scrie un
-- SIGNED_PDF_UPLOADED, iar acela NU trece prin saveFlow.
--
-- Un pas pe execuție. Nu modifică nimic.
-- ============================================================================

-- PASUL 1 — control de formă: câte evenimente, pe ce căi, câte fluxuri
SELECT COALESCE(payload->>'via', '(fara via)') AS cale,
       count(*)                                AS evenimente,
       count(DISTINCT flow_id)                 AS fluxuri,
       min(created_at)::date                   AS din,
       max(created_at)::date                   AS pana
  FROM audit_log
 WHERE event_type = 'SIGNED_PDF_UPLOADED'
 GROUP BY 1
 ORDER BY 2 DESC;

-- ⚠️ Dacă totalul e mult sub 9.610 (cifra măsurată pe 02.09), înseamnă că
--    forma s-a schimbat — oprește-te și spune-mi, restul nu mai e valid.


-- PASUL 2 — ⭐ CAZUL CARE CONTEAZĂ
-- Fluxuri unde numărul de semnături din JSONB e MAI MIC decât numărul de
-- semnături confirmate de audit. Fiecare rând e o semnătură care s-a produs
-- și nu se mai vede în flux.
WITH sem_audit AS (
  SELECT flow_id, count(DISTINCT actor_email) AS semnaturi_audit
    FROM audit_log
   WHERE event_type = 'SIGNED_PDF_UPLOADED'
     AND actor_email IS NOT NULL
   GROUP BY flow_id
),
sem_jsonb AS (
  SELECT f.id AS flow_id,
         count(*) FILTER (
           WHERE (s->>'signed')::boolean IS TRUE
              OR s->>'signedAt' IS NOT NULL
              OR s->>'status' = 'signed'
         ) AS semnaturi_flux,
         count(*) AS total_semnatari
    FROM flows f
    LEFT JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(f.data->'signers') = 'array'
                THEN f.data->'signers' ELSE '[]'::jsonb END) AS s ON TRUE
   WHERE f.deleted_at IS NULL
   GROUP BY f.id
)
SELECT j.flow_id,
       a.semnaturi_audit,
       j.semnaturi_flux,
       j.total_semnatari,
       a.semnaturi_audit - j.semnaturi_flux AS lipsa
  FROM sem_jsonb j
  JOIN sem_audit a ON a.flow_id = j.flow_id
 WHERE a.semnaturi_audit > j.semnaturi_flux
 ORDER BY (a.semnaturi_audit - j.semnaturi_flux) DESC, j.flow_id
 LIMIT 100;


-- PASUL 3 — a doua față: PDF semnat prezent, dar fluxul nu e finalizat
--           (marker _signedPdfB64Present pierdut la o suprascriere)
SELECT f.id AS flow_id,
       (f.data->>'completed')                       AS completed,
       (f.data->>'status')                          AS status,
       (f.data->>'_signedPdfB64Present')            AS marker_jsonb,
       EXISTS (SELECT 1 FROM flows_pdfs p
                WHERE p.flow_id = f.id AND p.key = 'signedPdfB64') AS pdf_exista
  FROM flows f
 WHERE f.deleted_at IS NULL
   AND EXISTS (SELECT 1 FROM flows_pdfs p
                WHERE p.flow_id = f.id AND p.key = 'signedPdfB64')
   AND COALESCE(f.data->>'_signedPdfB64Present','false') <> 'true'
 LIMIT 50;


-- PASUL 4 — cât de des se scrie „în același timp" pe același flux
--           (evenimente pe același flux la mai puțin de 5 secunde distanță)
SELECT count(*) AS perechi_sub_5s,
       count(DISTINCT flow_id) AS fluxuri_afectate
  FROM (
    SELECT flow_id,
           created_at,
           lag(created_at) OVER (PARTITION BY flow_id ORDER BY created_at) AS prev
      FROM audit_log
     WHERE event_type IN ('SIGNED_PDF_UPLOADED','SIGNED','FLOW_UPDATED')
  ) t
 WHERE prev IS NOT NULL
   AND created_at - prev < INTERVAL '5 seconds';

-- ============================================================================
-- INTERPRETARE
--
--  PASUL 2 gol            → cursa nu s-a materializat niciodată. Reparația
--                           rămâne corectă, dar preventivă ⇒ NU merită să
--                           deschidem zona NO-TOUCH acum.
--
--  PASUL 2 cu rânduri     → s-au pierdut semnături în documente QES. Devine
--                           prioritatea absolută, iar reparația (`version`
--                           optimist + tranzacție în saveFlow) cere
--                           autorizația ta explicită pentru zona NO-TOUCH,
--                           ca la #160.
--
--  PASUL 3 cu rânduri     → PDF-uri semnate „orfane": artefactul QES există,
--                           fluxul nu-l mai vede. Recuperabile, a nu se purja.
--
--  PASUL 4                → cât de aproape trece sistemul de cursă în mod
--                           obișnuit. Un număr mare cu pasul 2 gol înseamnă
--                           „am avut noroc", nu „nu se poate întâmpla".
-- ============================================================================
