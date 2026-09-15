-- =============================================================================
-- DocFlowAI — DIAGNOSTIC read-only: „Fluxuri paralele" pe ORD 44269
-- Document: 00109593-f81a-4afc-aeeb-99d8a5980cc4
-- Fluxuri raportate de cardul de divergențe: PZ_01109043C0, PZ_617A554F79
--
-- ⛔ ZERO scrieri. Nicio interogare de mai jos nu modifică nimic.
-- ⚠️ Consola Railway adaugă automat `LIMIT n`. Fiecare interogare de aici e un
--    SELECT de nivel superior, deci e inofensiv. Rulezi UNA pe execuție
--    (ștergi textul precedent din editor înainte de următoarea).
-- =============================================================================


-- ── 1. CINE E FLUXUL AUTORITAR ───────────────────────────────────────────────
-- Răspunde direct la întrebarea „care e legat?": coloanele `e_pointerul_documentului`
-- și `e_pointerul_alop`. Adevărul îl deține `formulare_ord.flow_id` — lista de
-- formulare afișează un singur flux tocmai pentru că citește pointerul acela.
-- Al doilea flux există în `flows` și revendică ORD-ul prin `data->'meta'->>'ordId'`,
-- dar nu e pointat de nimeni.

SELECT
  f.id                                        AS flux,
  f.created_at                                AS creat_la,
  (f.data->>'status')                         AS status,
  (f.data->>'completed')                      AS completed,
  (f.data->>'adminCancelled')                 AS admin_cancelled,
  f.deleted_at                                AS sters_la,
  (fo.flow_id = f.id)                         AS e_pointerul_documentului,
  (a.ord_flow_id = f.id)                      AS e_pointerul_alop,
  jsonb_array_length(COALESCE(f.data->'signers', '[]'::jsonb))  AS nr_semnatari,
  (SELECT count(*) FROM jsonb_array_elements(COALESCE(f.data->'signers','[]'::jsonb)) s
    WHERE s->>'status' = 'signed')            AS semnaturi_puse,
  EXISTS (SELECT 1 FROM flows_pdfs fp
           WHERE fp.flow_id = f.id AND fp.key = 'signedPdfB64')  AS are_pdf_semnat,
  (f.data->>'storage')                        AS storage,
  (SELECT string_agg(s->>'email', '  →  ' ORDER BY o)
     FROM jsonb_array_elements(COALESCE(f.data->'signers','[]'::jsonb))
          WITH ORDINALITY t(s, o))            AS semnatari,
  (SELECT string_agg(COALESCE(s->>'signedAt', '—'), ' | ' ORDER BY o)
     FROM jsonb_array_elements(COALESCE(f.data->'signers','[]'::jsonb))
          WITH ORDINALITY t(s, o))            AS momente_semnare
FROM flows f
LEFT JOIN formulare_ord fo
       ON fo.id = '00109593-f81a-4afc-aeeb-99d8a5980cc4'::uuid
LEFT JOIN alop_instances a
       ON a.ord_id = fo.id AND a.cancelled_at IS NULL
WHERE f.data->'meta'->>'ordId' = '00109593-f81a-4afc-aeeb-99d8a5980cc4'
ORDER BY f.created_at;

-- CUM SE CITEȘTE:
--   • `e_pointerul_documentului = true`  → ACESTA e fluxul pe care îl vede aplicația.
--   • diferența dintre `creat_la`-urile celor două fluxuri spune ce s-a întâmplat:
--       – câteva secunde  ⇒ dublu-click la lansare;
--       – ore/zile        ⇒ relansare deliberată cu altă listă de semnatari, fără
--                            anularea celui vechi (tiparul semnalat la 04.08 și 11.08).
--   • dacă listele de `semnatari` diferă, a doua variantă e cea corectă.
--   • `are_pdf_semnat` arată care flux poartă efectiv documentul semnat. Dacă e `false`
--     pe fluxul pointat și `true` pe celălalt, NU anula nimic — ăsta e cazul grav și
--     îmi scrii înainte de orice acțiune.


-- ── 2. CONTEXT ALOP (ce vede utilizatorul în dosar) ──────────────────────────

SELECT
  a.id                     AS alop_id,
  a.titlu,
  a.status                 AS status_alop,
  a.ord_id,
  a.ord_flow_id,
  a.ord_completed_at,
  a.df_id,
  a.df_flow_id,
  fo.nr_ordonant_pl        AS nr_ord,
  fo.status                AS status_ord,
  fo.flow_id               AS ord_flow_id_din_document,
  (a.ord_flow_id IS DISTINCT FROM fo.flow_id) AS pointeri_divergenti
FROM formulare_ord fo
LEFT JOIN alop_instances a ON a.ord_id = fo.id AND a.cancelled_at IS NULL
WHERE fo.id = '00109593-f81a-4afc-aeeb-99d8a5980cc4'::uuid;

-- `pointeri_divergenti = true` e semnalul de alarmă: documentul arată spre un flux,
-- iar dosarul ALOP spre altul. Atunci NU anula nimic până nu stabilim care e semnat.


-- ── 3. INVENTAR GENERAL — toate documentele cu 2+ fluxuri vii ────────────────
-- Aceleași clase ca în cardul de divergențe, dar îmbogățite cu numărul documentului
-- și cu marcajul „care flux e pointerul" — exact informația care lipsește azi din
-- ecranul de admin (clasa D întoarce `doc_nr` și `alop_id` NULL).

SELECT
  'ord'                                        AS tip,
  fo.nr_ordonant_pl                            AS nr_document,
  m.doc_id,
  count(*)                                     AS fluxuri_vii,
  string_agg(
    m.flux || CASE WHEN m.flux = fo.flow_id THEN ' ★POINTER' ELSE '' END
           || ' (' || COALESCE(m.status,'—')
           || CASE WHEN m.completed = 'true' THEN ', finalizat' ELSE '' END || ')',
    E'\n' ORDER BY m.creat)                     AS fluxuri
FROM (
  SELECT f.data->'meta'->>'ordId' AS doc_id,
         f.id                     AS flux,
         f.data->>'status'        AS status,
         f.data->>'completed'     AS completed,
         f.created_at             AS creat
    FROM flows f
   WHERE f.data->'meta'->>'ordId' IS NOT NULL
     AND f.deleted_at IS NULL
     AND f.data->>'status' IS DISTINCT FROM 'cancelled'
     AND f.data->>'status' IS DISTINCT FROM 'refused'
) m
JOIN formulare_ord fo ON fo.id::text = m.doc_id AND fo.deleted_at IS NULL
GROUP BY m.doc_id, fo.nr_ordonant_pl, fo.flow_id
HAVING count(*) >= 2

UNION ALL

SELECT
  'df'                                         AS tip,
  fd.nr_unic_inreg                             AS nr_document,
  m.doc_id,
  count(*)                                     AS fluxuri_vii,
  string_agg(
    m.flux || CASE WHEN m.flux = fd.flow_id THEN ' ★POINTER' ELSE '' END
           || ' (' || COALESCE(m.status,'—')
           || CASE WHEN m.completed = 'true' THEN ', finalizat' ELSE '' END || ')',
    E'\n' ORDER BY m.creat)                     AS fluxuri
FROM (
  SELECT f.data->'meta'->>'dfId' AS doc_id,
         f.id                    AS flux,
         f.data->>'status'       AS status,
         f.data->>'completed'    AS completed,
         f.created_at            AS creat
    FROM flows f
   WHERE f.data->'meta'->>'dfId' IS NOT NULL
     AND f.deleted_at IS NULL
     AND f.data->>'status' IS DISTINCT FROM 'cancelled'
     AND f.data->>'status' IS DISTINCT FROM 'refused'
) m
JOIN formulare_df fd ON fd.id::text = m.doc_id AND fd.deleted_at IS NULL
GROUP BY m.doc_id, fd.nr_unic_inreg, fd.flow_id
HAVING count(*) >= 2

ORDER BY 1, 2;


-- =============================================================================
-- CE FACI CU REZULTATUL
--
-- Cazul AȘTEPTAT (fluxul pointat e și cel semnat, al doilea e un orfan):
--   închizi orfanul din interfață — Admin → Fluxuri → anulare pe fluxul care NU are
--   ★POINTER. Fără SQL. După anulare, cardul de divergențe trebuie să scadă la 0.
--   Anularea prin interfață trece prin `lifecycle.mjs`, care golește pointerii DOAR
--   dacă chiar arătau spre fluxul anulat (garda de la #164) ⇒ pointerul fluxului bun
--   rămâne intact.
--
-- Cazul GRAV (pointerul arată spre fluxul FĂRĂ PDF semnat, iar celălalt îl are):
--   NU anula nimic. Trimite-mi rezultatul interogării 1 și scriem împreună relegarea,
--   cu CTE + RETURNING, ca la ORD 46055.
-- =============================================================================
