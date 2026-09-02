-- ═══════════════════════════════════════════════════════════════════════════
-- URGENT — semnatari blocați în „Așteptăm aprobarea ta pe email / PUSH"
-- Cauza: pollSignatureResult clasifică o eroare permanentă ca „waiting",
-- deci signers[i].stsPending rămâne true pentru totdeauna, iar frontendul
-- repornește polling-ul la fiecare refresh (signer-status → shouldResumePoll).
--
-- PASUL 1 e READ-ONLY. Rulează-l întâi și uită-te la rezultat.
-- PASUL 2 scrie în producție — rulează-l în tranzacție, verifică, apoi COMMIT.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- PASUL 1 — DIAGNOSTIC (READ-ONLY, sigur de rulat oricând)
-- Cine e blocat, de când, pe ce document.
-- ───────────────────────────────────────────────────────────────────────────
SELECT
  f.id                                   AS flow_id,
  f.data->>'docName'                     AS document,
  s.ord - 1                              AS signer_index,   -- indexul din array (0-based)
  s.signer->>'email'                     AS semnatar,
  s.signer->>'status'                    AS status_semnatar,
  s.signer->>'stsOpId'                   AS sts_op_id,
  f.data->>'updatedAt'                   AS ultima_actualizare,
  now() - (f.data->>'updatedAt')::timestamptz AS de_cat_timp
FROM flows f
CROSS JOIN LATERAL jsonb_array_elements(f.data->'signers')
     WITH ORDINALITY AS s(signer, ord)
WHERE f.deleted_at IS NULL
  AND s.signer->>'stsPending' = 'true'
  -- fluxuri încă vii (predicatul de la #122): un flux anulat/refuzat nu ne interesează
  AND f.data->>'status' IS DISTINCT FROM 'cancelled'
  AND f.data->>'status' IS DISTINCT FROM 'refused'
ORDER BY (f.data->>'updatedAt')::timestamptz ASC;

-- Interpretare:
--   • „de_cat_timp" peste ~15 minute = sigur blocat (STS cere aprobarea în minute,
--     iar clientul oricum renunță după 3 minute de polling).
--   • Sub 15 minute = posibil o semnare LEGITIMĂ în curs. NU o atinge.


-- ───────────────────────────────────────────────────────────────────────────
-- PASUL 2 — DEBLOCARE (SCRIE ÎN PRODUCȚIE)
--
-- Deblochează DOAR semnatarii blocați de peste 30 de minute, ca să nu întrerupi
-- o semnare legitimă în curs. Pune stsPending=false ⇒ frontendul nu mai reia
-- bucla, iar semnatarul poate reîncerca semnarea normal.
--
-- ⚠️ NU șterge stsOpId / stsToken / stsCertPem — sunt urme de audit.
-- ⚠️ Rulează în tranzacție. Verifică numărul de rânduri ÎNAINTE de COMMIT.
-- ───────────────────────────────────────────────────────────────────────────
BEGIN;

WITH blocati AS (
  SELECT
    f.id            AS flow_id,
    (s.ord - 1)::int AS idx
  FROM flows f
  CROSS JOIN LATERAL jsonb_array_elements(f.data->'signers')
       WITH ORDINALITY AS s(signer, ord)
  WHERE f.deleted_at IS NULL
    AND s.signer->>'stsPending' = 'true'
    AND f.data->>'status' IS DISTINCT FROM 'cancelled'
    AND f.data->>'status' IS DISTINCT FROM 'refused'
    AND (f.data->>'updatedAt')::timestamptz < now() - interval '30 minutes'
)
UPDATE flows f
SET data = jsonb_set(
             f.data,
             ARRAY['signers', b.idx::text, 'stsPending'],
             'false'::jsonb,
             false
           )
FROM blocati b
WHERE f.id = b.flow_id;

-- Verifică: numărul de rânduri actualizate trebuie să corespundă cu ce ai văzut la PASUL 1.
-- Apoi re-rulează interogarea de la PASUL 1 ÎNAINTE de COMMIT — trebuie să întoarcă 0 rânduri
-- (sau doar semnări legitime mai noi de 30 de minute).

-- COMMIT;    -- ← decomentează DOAR după ce ai verificat
-- ROLLBACK;  -- ← dacă ceva nu arată bine


-- ───────────────────────────────────────────────────────────────────────────
-- NOTĂ pentru un flux cu MAI MULȚI semnatari blocați
-- jsonb_set actualizează un singur index pe rând. Dacă la PASUL 1 vezi același
-- flow_id de două ori, rulează blocul de la PASUL 2 de două ori (a doua rulare
-- prinde al doilea semnatar). Re-rulează PASUL 1 până întoarce 0.
-- ───────────────────────────────────────────────────────────────────────────
