-- ============================================================================
-- SQL-188 — cât de des e col.3 divergentă pe aceeași cheie? (READ-ONLY)
--
-- Întrebarea care decide dacă avem nevoie de excepția „ignoră 0-urile":
-- un ORD multi-bloc creat ÎNAINTE de #128k are col.3 scrisă doar în primul bloc
-- și 0,00 în al doilea. Sub regula strictă de la #187 asta e o inconsistență
-- ⇒ derivarea tace și responsabilul CAB completează manual.
--
-- Dacă apare rar, lăsăm regula strictă. Dacă apare des, adăugăm excepția.
-- Un pas pe execuție. Nu modifică nimic.
-- ============================================================================

WITH randuri AS (
  SELECT o.id                                   AS ord_id,
         o.nr_ord,
         o.created_at,
         upper(regexp_replace(concat_ws('||',
             COALESCE(r->>'cod_angajament',''),
             COALESCE(r->>'indicator_angajament',''),
             COALESCE(r->>'program',''),
             COALESCE(r->>'cod_SSI', r->>'cod_ssi','')
           ), '\s+', ' ', 'g'))                 AS cheie,
         COALESCE(NULLIF(regexp_replace(r->>'plati_anterioare','[^0-9.\-]','','g'),'')::numeric, 0) AS col3
    FROM formulare_ord o,
         jsonb_array_elements(o.rows) AS r
   WHERE o.deleted_at IS NULL
),
pe_cheie AS (
  SELECT ord_id, nr_ord, created_at, cheie,
         count(*)                                        AS nr_randuri,
         count(DISTINCT col3)                            AS valori_distincte,
         count(DISTINCT col3) FILTER (WHERE col3 <> 0)   AS valori_nenule_distincte,
         bool_or(col3 = 0)                               AS are_zero,
         array_agg(DISTINCT col3 ORDER BY col3)          AS valori
    FROM randuri
   GROUP BY ord_id, nr_ord, created_at, cheie
  HAVING count(*) > 1
)
SELECT
  count(*) FILTER (WHERE valori_distincte = 1)                                  AS coerente,
  count(*) FILTER (WHERE valori_distincte > 1 AND valori_nenule_distincte <= 1) AS divergente_doar_prin_zero,
  count(*) FILTER (WHERE valori_nenule_distincte > 1)                           AS divergente_real,
  count(*)                                                                      AS total_chei_multi_rand
FROM pe_cheie;

-- ── PASUL 2 — lista cazurilor, ca să le poți privi ──────────────────────────
-- (rulează separat, după ce vezi cifrele de mai sus)
--
-- WITH ... (același CTE)
-- SELECT ord_id, nr_ord, created_at, cheie, nr_randuri, valori
--   FROM pe_cheie
--  WHERE valori_distincte > 1
--  ORDER BY created_at DESC;

-- ── INTERPRETARE ────────────────────────────────────────────────────────────
--  divergente_doar_prin_zero = 0  → regula strictă de la #187 rămâne. Nicio
--                                   excepție, niciun cod în plus.
--
--  divergente_doar_prin_zero > 0  → sunt ORD-uri de dinainte de #128k. Merită
--                                   excepția, în trei ramuri:
--                                     0 valori nenule  ⇒ col3 = 0 (legitim: nimic plătit anterior)
--                                     1 valoare nenulă ⇒ aceea e valoarea
--                                     2+ nenule        ⇒ inconsistent, fără prefill
--                                   Un 0 într-un bloc înseamnă „nu s-a scris",
--                                   nu „zero lei" — aceeași distincție ca null vs 0
--                                   la indicatorul nou.
--
--  divergente_real > 0            → anomalie de date, indiferent de regulă.
--                                   Rulează pasul 2 și uită-te la ele una câte una.
-- ============================================================================
