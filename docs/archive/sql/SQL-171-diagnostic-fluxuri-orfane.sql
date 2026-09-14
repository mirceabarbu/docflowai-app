-- =====================================================================
-- SQL-171 — Cât de mare e gaura de la `reinitiate`  (STRICT READ-ONLY)
-- Rulare: consola Railway → Database → Data
-- ⚠️ O SINGURĂ interogare pe execuție. Șterge tot din editor înainte de
--    următoarea. Fără LIMIT la coadă — consola adaugă singură unul.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. FLUXURI ORFANE VII: revendică un DF/ORD prin `meta`, dar pointerul
--    documentului arată în ALTĂ parte (sau nicăieri).
--    Astea sunt fluxurile pe care garda #114 de azi NU le vede.
-- Citire: `total` = expunerea brută. 0 ⇒ gaura e doar teoretică.
-- ---------------------------------------------------------------------
SELECT
  CASE WHEN f.data->'meta'->>'dfId' IS NOT NULL THEN 'df' ELSE 'ord' END AS tip,
  count(*) AS total
FROM flows f
LEFT JOIN formulare_df  fd ON fd.id::text = f.data->'meta'->>'dfId'
LEFT JOIN formulare_ord fo ON fo.id::text = f.data->'meta'->>'ordId'
WHERE f.deleted_at IS NULL
  AND f.data->>'status' IS DISTINCT FROM 'cancelled'
  AND f.data->>'status' IS DISTINCT FROM 'refused'
  AND (f.data->'meta'->>'dfId' IS NOT NULL OR f.data->'meta'->>'ordId' IS NOT NULL)
  AND (
        (f.data->'meta'->>'dfId'  IS NOT NULL AND (fd.flow_id IS NULL OR fd.flow_id <> f.id))
     OR (f.data->'meta'->>'ordId' IS NOT NULL AND (fo.flow_id IS NULL OR fo.flow_id <> f.id))
      )
GROUP BY 1;


-- ---------------------------------------------------------------------
-- 2. EXPUNEREA REALĂ: dintre orfani, câți sunt chiar reinițiabili azi?
--    (au un semnatar `refused`, refuzatorul nu e APROBAT, și nu au deja
--     un copil prin `reinitiatedAs`)
--    Butonul „Reinițiază" apare exact pe astea.
-- ---------------------------------------------------------------------
SELECT f.id,
       f.created_at,
       f.data->>'docName'          AS document,
       f.data->>'status'           AS status,
       f.data->'meta'->>'dfId'     AS df_id,
       f.data->'meta'->>'ordId'    AS ord_id,
       f.data->>'reinitiatedAs'    AS deja_reinitiat
FROM flows f
LEFT JOIN formulare_df  fd ON fd.id::text = f.data->'meta'->>'dfId'
LEFT JOIN formulare_ord fo ON fo.id::text = f.data->'meta'->>'ordId'
WHERE f.deleted_at IS NULL
  AND f.data->>'status' IS DISTINCT FROM 'cancelled'
  AND (f.data->'meta'->>'dfId' IS NOT NULL OR f.data->'meta'->>'ordId' IS NOT NULL)
  AND (
        (f.data->'meta'->>'dfId'  IS NOT NULL AND (fd.flow_id IS NULL OR fd.flow_id <> f.id))
     OR (f.data->'meta'->>'ordId' IS NOT NULL AND (fo.flow_id IS NULL OR fo.flow_id <> f.id))
      )
  AND f.data->>'reinitiatedAs' IS NULL
  AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(f.data->'signers')='array' THEN f.data->'signers' ELSE '[]'::jsonb END) s
         WHERE s->>'status' = 'refused'
      )
ORDER BY f.created_at DESC;


-- ---------------------------------------------------------------------
-- 3. CONTROL: documente cu 2+ fluxuri VII, azi.
--    Poarta #170 e live de pe 02.09 ⇒ nu trebuie să apară perechi noi,
--    create AMBELE după acea dată. Cele vechi rămân până la anulare.
-- Citire: dacă `cel_mai_nou` e ulterior deploy-ului lui #170 la AMBELE
--    fluxuri ale unui grup, poarta are o gaură pe care n-o știm.
-- ---------------------------------------------------------------------
SELECT COALESCE(f.data->'meta'->>'dfId', f.data->'meta'->>'ordId') AS doc_id,
       CASE WHEN f.data->'meta'->>'dfId' IS NOT NULL THEN 'df' ELSE 'ord' END AS tip,
       count(*)                       AS fluxuri_vii,
       min(f.created_at)              AS cel_mai_vechi,
       max(f.created_at)              AS cel_mai_nou,
       array_agg(f.id ORDER BY f.created_at)          AS id_uri,
       array_agg(f.data->>'status' ORDER BY f.created_at) AS statusuri
FROM flows f
WHERE f.deleted_at IS NULL
  AND f.data->>'status' IS DISTINCT FROM 'cancelled'
  AND f.data->>'status' IS DISTINCT FROM 'refused'
  AND (f.data->'meta'->>'dfId' IS NOT NULL OR f.data->'meta'->>'ordId' IS NOT NULL)
GROUP BY 1, 2
HAVING count(*) > 1
ORDER BY max(f.created_at) DESC;
