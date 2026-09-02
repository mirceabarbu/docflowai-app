-- =============================================================================
-- DocFlowAI — DIAGNOSTIC read-only: „Fluxuri paralele" pe DF
-- Document: 50c980ac-a473-4b72-af62-d961f1790753
-- Fluxuri raportate: PZ_01CAA11CFE, PZ_1B8C0B5B65
--
-- ⛔ ZERO scrieri. ⚠️ Rulează UNA pe execuție (consola Railway adaugă LIMIT).
-- Varianta DF a diagnosticului scris pentru ORD 44269 — cheia din meta e `dfId`,
-- iar pointerii sunt formulare_df.flow_id și alop_instances.df_flow_id.
-- =============================================================================


-- ── 1. CARE FLUX E CEL LEGAT ─────────────────────────────────────────────────

SELECT
  f.id                                        AS flux,
  f.created_at                                AS creat_la,
  (f.data->>'status')                         AS status,
  (f.data->>'completed')                      AS completed,
  (f.data->>'adminCancelled')                 AS admin_cancelled,
  f.deleted_at                                AS sters_la,
  (fd.flow_id = f.id)                         AS e_pointerul_documentului,
  (a.df_flow_id = f.id)                       AS e_pointerul_alop,
  jsonb_array_length(COALESCE(f.data->'signers', '[]'::jsonb))  AS nr_semnatari,
  (SELECT count(*) FROM jsonb_array_elements(COALESCE(f.data->'signers','[]'::jsonb)) s
    WHERE s->>'status' = 'signed')            AS semnaturi_puse,
  EXISTS (SELECT 1 FROM flows_pdfs fp
           WHERE fp.flow_id = f.id AND fp.key = 'signedPdfB64')  AS are_pdf_semnat,
  (SELECT string_agg(s->>'email', '  →  ' ORDER BY o)
     FROM jsonb_array_elements(COALESCE(f.data->'signers','[]'::jsonb))
          WITH ORDINALITY t(s, o))            AS semnatari,
  (SELECT string_agg(COALESCE(s->>'rol','—'), ' | ' ORDER BY o)
     FROM jsonb_array_elements(COALESCE(f.data->'signers','[]'::jsonb))
          WITH ORDINALITY t(s, o))            AS atribute
FROM flows f
LEFT JOIN formulare_df fd
       ON fd.id = '50c980ac-a473-4b72-af62-d961f1790753'::uuid
LEFT JOIN alop_instances a
       ON a.df_id = fd.id AND a.cancelled_at IS NULL
WHERE f.data->'meta'->>'dfId' = '50c980ac-a473-4b72-af62-d961f1790753'
ORDER BY f.created_at;

-- CUM SE CITEȘTE:
--   • `e_pointerul_documentului = true` → fluxul pe care îl vede aplicația.
--   • diferența dintre `creat_la`: secunde ⇒ dublu-click; ore/zile ⇒ relansare
--     deliberată fără anularea celui vechi.
--   • dacă `semnatari` sau `atribute` diferă, a doua listă e de obicei cea corectă
--     (cineva a relansat fiindcă prima era greșită).
--   • dacă `are_pdf_semnat` e `false` pe fluxul pointat și `true` pe celălalt —
--     NU anula nimic, scrie-mi.


-- ── 2. CONTEXTUL DOCUMENTULUI ȘI AL DOSARULUI ────────────────────────────────

SELECT
  fd.nr_unic_inreg,
  fd.subtitlu_df,
  fd.revizie_nr,
  fd.status                  AS status_df,
  fd.flow_id                 AS pointer_document,
  a.id                       AS alop_id,
  a.titlu                    AS titlu_alop,
  a.status                   AS status_alop,
  a.df_flow_id               AS pointer_alop,
  (a.df_flow_id IS DISTINCT FROM fd.flow_id) AS pointeri_divergenti
FROM formulare_df fd
LEFT JOIN alop_instances a ON a.df_id = fd.id AND a.cancelled_at IS NULL
WHERE fd.id = '50c980ac-a473-4b72-af62-d961f1790753'::uuid;


-- ── 3. CÂT DE DES SE ÎNTÂMPLĂ, DE FAPT ───────────────────────────────────────
-- Contorul de divergențe arată doar ce e VIU acum. Asta arată tot istoricul:
-- fiecare document care a avut vreodată 2+ fluxuri, indiferent dacă între timp
-- unul a fost anulat. Distanța în secunde între lansări separă dublu-click-ul
-- (sub 10 s) de relansarea deliberată.

SELECT
  tip,
  count(*)                                        AS documente,
  count(*) FILTER (WHERE delta_sec <= 10)         AS probabil_dublu_click,
  count(*) FILTER (WHERE delta_sec > 10)          AS relansari_deliberate,
  ROUND(AVG(delta_sec)::numeric, 0)               AS delta_mediu_sec
FROM (
  SELECT 'df' AS tip,
         f.data->'meta'->>'dfId' AS doc_id,
         EXTRACT(EPOCH FROM (MAX(f.created_at) - MIN(f.created_at))) AS delta_sec
    FROM flows f
   WHERE f.data->'meta'->>'dfId' IS NOT NULL
   GROUP BY 1, 2 HAVING count(*) >= 2
  UNION ALL
  SELECT 'ord',
         f.data->'meta'->>'ordId',
         EXTRACT(EPOCH FROM (MAX(f.created_at) - MIN(f.created_at)))
    FROM flows f
   WHERE f.data->'meta'->>'ordId' IS NOT NULL
   GROUP BY 1, 2 HAVING count(*) >= 2
) m
GROUP BY tip ORDER BY tip;


-- ── 4. CÂT DE DES A REFUZAT SERVERUL SĂ MUTE POINTERUL ───────────────────────
-- Serverul DETECTEAZĂ deja situația la lansare (crud.mjs:476) și scrie un
-- `logger.warn`, dar nu spune nimic utilizatorului. Dacă motorul de loguri are
-- retenție suficientă, caută textul:
--
--     "documentul e deja pe un flux activ"
--
-- Numărul de apariții din ultima lună = de câte ori cineva a lansat un al doilea
-- flux fără să afle. Ăsta e argumentul pentru lotul de prevenție.
-- =============================================================================
