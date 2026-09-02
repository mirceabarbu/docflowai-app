-- =============================================================================
-- DocFlowAI #159 — inventarul și purjarea materialului criptografic STS
-- persistat în fluxuri.  A se rula MANUAL, de Mircea, în consola Railway.
-- NU face parte din promptul pentru Claude Code.
-- =============================================================================
--
-- REGULI DE CONSOLĂ (verificate 12.08.2026):
--   • Consola Railway adaugă AUTOMAT `LIMIT n` la finalul interogării. Peste un
--     UPDATE/DELETE asta dă `syntax error at or near "LIMIT"`. De aceea fiecare
--     scriere de mai jos e împachetată într-un CTE și se încheie cu un SELECT —
--     LIMIT-ul adăugat cade pe SELECT-ul final și totul rămâne valid.
--   • Consola NU suportă BEGIN/COMMIT ca instrucțiuni separate.
--   • Se rulează O SINGURĂ interogare pe execuție. Șterge tot din editor înainte
--     de a lipi următoarea.
--
-- ORDINEA OBLIGATORIE:
--   1. Deploy-ul lui #159 în producție (altfel scurgerea continuă în paralel).
--   2. `pg_dump` de siguranță — PASUL 3 modifică date.
--   3. Pașii de inventar (1–3), apoi purjarea (4–6), apoi verificarea (7).
--   4. Pașii de scriere se rulează într-o fereastră FĂRĂ activitate de semnare
--      (seara). Predicatul `updated_at < NOW() - INTERVAL '1 hour'` protejează
--      sesiunile în curs — o sesiune STS expiră în 30 de minute — dar nu e un
--      motiv să rulezi în plin program.
-- =============================================================================


-- ── PASUL 1 — câte fluxuri poartă cheia privată ──────────────────────────────
-- Coloana `flows.data` NU conține PDF-uri (mutate în `flows_pdfs` la R-01),
-- deci scanarea e ieftină pe ~2.100 de rânduri.

SELECT
  count(*)                                             AS fluxuri_cu_cheie,
  count(*) FILTER (WHERE deleted_at IS NOT NULL)        AS din_care_sterse,
  min(created_at)                                      AS cel_mai_vechi,
  max(updated_at)                                      AS cea_mai_recenta_atingere
FROM flows
WHERE data::text LIKE '%privateKeyPem%';


-- ── PASUL 2 — distribuția pe stare (cât e „viu" și cât e istorie) ────────────

SELECT
  COALESCE(data->>'status', '(fără status)')           AS status,
  (data->>'completed')                                 AS completed,
  count(*)                                             AS nr
FROM flows
WHERE data::text LIKE '%privateKeyPem%'
GROUP BY 1, 2
ORDER BY nr DESC;


-- ── PASUL 3 — există sesiuni ÎN CURS? (dacă nr > 0, amână purjarea) ──────────
-- Un semnatar cu `stsPending = true` și flux atins în ultima oră poate fi în
-- mijlocul autentificării la STS. Purjarea i-ar rupe callback-ul.

SELECT count(*) AS sesiuni_posibil_in_curs
FROM flows
WHERE data::text LIKE '%privateKeyPem%'
  AND updated_at > NOW() - INTERVAL '1 hour'
  AND data->'signers' @> '[{"stsPending": true}]'::jsonb;


-- ── PASUL 4 — PURJAREA din fluxuri (SCRIERE — după pg_dump) ──────────────────
-- Scoate din fiecare semnatar: `privateKeyPem`, `codeVerifier`, `state`, `nonce`
-- din `stsProviderData`, plus `stsToken` de pe semnatar.
-- PĂSTREAZĂ restul (`hashBase64`, `docName`, `idpUrl`, `signUrl`, `clientId`,
-- `kid`, `redirectUri`, `signerEmail`, `stsOpId`, `stsCertPem`) — urma de audit
-- rămâne intactă, dispare doar materialul secret.
--
-- ⚠️ Garda `jsonb_typeof(...) = 'array'` NU e opțională: `jsonb_set` întoarce NULL
--    dacă subinterogarea dă NULL, iar asta ar goli coloana `data` a rândului.

WITH purjate AS (
  UPDATE flows f
     SET data = jsonb_set(
           f.data,
           '{signers}',
           (
             SELECT jsonb_agg(
                      CASE
                        WHEN s ? 'stsProviderData'
                        THEN (s - 'stsToken') || jsonb_build_object(
                               'stsProviderData',
                               (s->'stsProviderData')
                                 - 'privateKeyPem' - 'codeVerifier' - 'state' - 'nonce'
                             )
                        ELSE (s - 'stsToken')
                      END
                      ORDER BY ord
                    )
             FROM jsonb_array_elements(f.data->'signers') WITH ORDINALITY AS t(s, ord)
           )
         )
   WHERE f.data::text LIKE '%privateKeyPem%'
     AND jsonb_typeof(f.data->'signers') = 'array'
     AND f.updated_at < NOW() - INTERVAL '1 hour'
  RETURNING f.id
)
SELECT count(*) AS fluxuri_purjate FROM purjate;


-- ── PASUL 5 — tipul coloanei din bulk_signing_sessions (READ-ONLY) ───────────
-- `bulk-signing.mjs:79` scrie `sts_provider_data`. Verific tipul înainte de a
-- scrie, ca să nu aplic operatori jsonb peste o coloană TEXT.

SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'bulk_signing_sessions'
  AND column_name = 'sts_provider_data';


-- ── PASUL 6 — purjarea sesiunilor bulk EXPIRATE (SCRIERE) ────────────────────
-- Se rulează DOAR dacă PASUL 5 a arătat `jsonb`. Dacă e `text`, oprește-te și
-- spune-mi — schimb interogarea.

WITH purjate AS (
  UPDATE bulk_signing_sessions
     SET sts_provider_data =
           COALESCE(sts_provider_data, '{}'::jsonb)
             - 'privateKeyPem' - 'codeVerifier' - 'state' - 'nonce'
   WHERE sts_provider_data::text LIKE '%privateKeyPem%'
     AND expires_at < NOW()
  RETURNING id
)
SELECT count(*) AS sesiuni_bulk_purjate FROM purjate;


-- ── PASUL 7 — verificarea finală ─────────────────────────────────────────────
-- Ce rămâne aici sunt exact rândurile excluse de gărzi (fluxuri atinse în ultima
-- oră, sesiuni bulk încă valabile). Se reia interogarea 4/6 a doua zi.

SELECT
  (SELECT count(*) FROM flows
     WHERE data::text LIKE '%privateKeyPem%')                     AS fluxuri_ramase,
  (SELECT count(*) FROM bulk_signing_sessions
     WHERE sts_provider_data::text LIKE '%privateKeyPem%')        AS sesiuni_bulk_ramase;


-- ── PASUL 8 — control de nedeteriorare (READ-ONLY) ───────────────────────────
-- Dovada că purjarea nu a stricat structura: niciun flux nu trebuie să aibă
-- `signers` altfel decât array, și numărul de semnatari trebuie să fie neschimbat
-- față de ce știai înainte. Rulează-l ȘI înainte, ȘI după PASUL 4, și compară.

SELECT
  count(*)                                                        AS fluxuri_totale,
  count(*) FILTER (WHERE jsonb_typeof(data->'signers') <> 'array') AS signers_nu_e_array,
  sum(jsonb_array_length(data->'signers'))
    FILTER (WHERE jsonb_typeof(data->'signers') = 'array')        AS total_semnatari
FROM flows;
