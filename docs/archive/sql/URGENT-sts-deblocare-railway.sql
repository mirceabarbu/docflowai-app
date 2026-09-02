-- ═══════════════════════════════════════════════════════════════════════════
-- URGENT v2 — deblocare semnatari STS  ·  VARIANTĂ PENTRU CONSOLA RAILWAY
--
-- De ce v2: consola Railway adaugă automat „LIMIT n" la finalul a ce rulezi.
-- Peste un SELECT e inofensiv; peste un UPDATE dă „syntax error at or near LIMIT".
-- Soluție: UPDATE-ul stă într-un CTE, iar interogarea se termină cu SELECT.
-- Consola nu suportă nici BEGIN/COMMIT ca instrucțiuni separate ⇒ rulează
-- ÎNTÂI pasul 1 (read-only), verifică, abia apoi pasul 2.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- PASUL 1 — DIAGNOSTIC (READ-ONLY). Rulează-l singur, fără pasul 2.
-- ───────────────────────────────────────────────────────────────────────────
SELECT
  f.id                                   AS flow_id,
  f.data->>'docName'                     AS document,
  s.ord - 1                              AS signer_index,
  s.signer->>'email'                     AS semnatar,
  f.data->>'updatedAt'                   AS ultima_actualizare,
  now() - (f.data->>'updatedAt')::timestamptz AS de_cat_timp
FROM flows f
CROSS JOIN LATERAL jsonb_array_elements(f.data->'signers')
     WITH ORDINALITY AS s(signer, ord)
WHERE f.deleted_at IS NULL
  AND s.signer->>'stsPending' = 'true'
  AND f.data->>'status' IS DISTINCT FROM 'cancelled'
  AND f.data->>'status' IS DISTINCT FROM 'refused'
ORDER BY (f.data->>'updatedAt')::timestamptz ASC;

-- Interpretare:
--   • peste ~15 minute vechime = sigur blocat (clientul renunță la polling după 3 min)
--   • sub 15 minute = poate fi o semnare LEGITIMĂ în curs — pasul 2 o lasă în pace


-- ═══════════════════════════════════════════════════════════════════════════
-- PASUL 2 — DEBLOCARE. Rulează ACEASTĂ interogare SINGURĂ (șterge pasul 1 din
-- editor). Deblochează doar ce e mai vechi de 30 de minute. Tratează într-o
-- singură trecere și fluxurile cu MAI MULȚI semnatari blocați.
-- Returnează exact ce a modificat — compară cu ce ai văzut la pasul 1.
-- ═══════════════════════════════════════════════════════════════════════════
WITH pending AS (
  -- fluxuri cu cel puțin un semnatar în stsPending (filtrăm ÎNAINTE de orice cast)
  SELECT f.id, f.data
  FROM flows f
  WHERE f.deleted_at IS NULL
    AND f.data->>'status' IS DISTINCT FROM 'cancelled'
    AND f.data->>'status' IS DISTINCT FROM 'refused'
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(f.data->'signers') sx
      WHERE sx->>'stsPending' = 'true'
    )
),
tinta AS (
  -- doar cele vechi de peste 30 min; gardă de format ca un updatedAt malformat
  -- din alt flux să nu arunce eroare de cast
  SELECT id, data
  FROM pending
  WHERE (data->>'updatedAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
    AND (data->>'updatedAt')::timestamptz < now() - interval '30 minutes'
),
recalc AS (
  -- reconstruim întregul array de semnatari, punând stsPending=false pe TOȚI
  -- cei blocați din același flux (ordinea se păstrează prin ORDER BY s.ord)
  SELECT t.id,
         jsonb_agg(
           CASE WHEN s.signer->>'stsPending' = 'true'
                THEN s.signer || '{"stsPending": false}'::jsonb
                ELSE s.signer
           END
           ORDER BY s.ord
         ) AS signeri_noi
  FROM tinta t
  CROSS JOIN LATERAL jsonb_array_elements(t.data->'signers')
       WITH ORDINALITY AS s(signer, ord)
  GROUP BY t.id
),
upd AS (
  UPDATE flows f
  SET data = jsonb_set(f.data, '{signers}', r.signeri_noi, false)
  FROM recalc r
  WHERE f.id = r.id
  RETURNING f.id, f.data->>'docName' AS document
)
SELECT id AS flow_id, document, 'deblocat' AS rezultat
FROM upd
ORDER BY id;

-- Ce NU face, intenționat:
--   • nu șterge stsOpId / stsToken / stsCertPem  → rămân ca urmă de audit
--   • nu atinge signer.status                    → semnatarul poate reîncerca normal
--   • nu modifică updatedAt                      → nu falsificăm cronologia fluxului


-- ───────────────────────────────────────────────────────────────────────────
-- PASUL 3 — CONFIRMARE. Re-rulează PASUL 1.
-- Trebuie să întoarcă 0 rânduri (sau doar semnări mai noi de 30 de minute).
-- ───────────────────────────────────────────────────────────────────────────
