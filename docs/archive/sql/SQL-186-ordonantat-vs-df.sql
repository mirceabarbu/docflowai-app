-- ============================================================================
-- SQL-186 — cât de mare e problema? (READ-ONLY, un pas pe execuție)
--
-- Context: `alop.ramas` se calculează azi ca df_valoare − suma_platita_total,
-- adică pe PLĂȚI CONFIRMATE. Un ORD emis și încă neplătit nu consumă disponibil
-- ⇒ se poate ordonanța peste valoarea documentului de fundamentare.
--
-- Aceste interogări spun dacă s-a materializat deja undeva, sau dacă am prins-o
-- înainte. Nu modifică nimic.
-- ============================================================================

-- PASUL 1 — pe fiecare dosar ALOP: DF aprobat vs total ORDONANȚAT vs total PLĂTIT
--   ordonantat_total = suma coloanei 4 de pe toate ORD-urile dosarului
--   (rândurile stau în formulare_ord.rows, JSONB; câmpul e suma_ordonantata_plata)
WITH ord_sume AS (
  SELECT o.id,
         o.alop_id,
         o.status,
         COALESCE((
           SELECT SUM( NULLIF(regexp_replace(r->>'suma_ordonantata_plata','[^0-9.\-]','','g'),'')::numeric )
             FROM jsonb_array_elements(o.rows) AS r
         ), 0) AS col4
    FROM formulare_ord o
   WHERE o.deleted_at IS NULL
)
SELECT a.id,
       a.titlu,
       a.status,
       ROUND(COALESCE(fd.val_df,0), 2)                                   AS df_aprobat,
       ROUND(SUM(os.col4), 2)                                            AS ordonantat_total,
       ROUND(COALESCE(a.suma_totala_platita,0)
           + COALESCE(a.plata_suma_efectiva,0), 2)                       AS platit_total,
       ROUND(COALESCE(fd.val_df,0) - SUM(os.col4), 2)                    AS disponibil_corect,
       ROUND(COALESCE(fd.val_df,0)
           - (COALESCE(a.suma_totala_platita,0)
            + COALESCE(a.plata_suma_efectiva,0)), 2)                     AS disponibil_afisat_azi,
       count(os.id)                                                      AS nr_ord
  FROM alop_instances a
  JOIN ord_sume os ON os.alop_id = a.id
  LEFT JOIN LATERAL (
        SELECT NULLIF(regexp_replace(fdx.valoare_totala_actualizata::text,'[^0-9.\-]','','g'),'')::numeric AS val_df
          FROM formulare_df fdx
         WHERE fdx.id = a.df_id
       ) fd ON TRUE
 WHERE a.cancelled_at IS NULL
 GROUP BY a.id, a.titlu, a.status, fd.val_df, a.suma_totala_platita, a.plata_suma_efectiva
HAVING SUM(os.col4) > 0
 ORDER BY (COALESCE(fd.val_df,0) - SUM(os.col4)) ASC;

-- ⚠️ Dacă `valoare_totala_actualizata` nu e numele coloanei cu valoarea DF-ului
--    (col.7 de la pct.4), înlocuiește-l — restul interogării rămâne valabil.
--    Cifra căutată e cea care apare pe card ca „DF actual".

-- ── CE URMĂREȘTI ────────────────────────────────────────────────────────────
--  disponibil_corect < 0        → S-A ORDONANȚAT PESTE ANGAJAMENT. Cazuri de
--                                 reparat manual, în ordinea din listă.
--  disponibil_corect >= 0, dar
--  mult mai mic decât
--  disponibil_afisat_azi        → nu s-a depășit încă, dar ecranul arată mai
--                                 mult decât există. Diferența e exact valoarea
--                                 ORD-urilor emise și neplătite.
-- ============================================================================


-- PASUL 2 — coloana 3 („plăți anterioare") pe fiecare ORD, în ordinea emiterii.
--           Verifici dacă valoarea salvată corespunde plăților din ciclurile
--           ANTERIOARE lui, sau dacă include și plata pe care el o ordonanțează.
SELECT o.id,
       o.alop_id,
       o.nr_ord,
       o.created_at,
       o.status,
       ROUND(COALESCE((
         SELECT SUM( NULLIF(regexp_replace(r->>'receptii','[^0-9.\-]','','g'),'')::numeric )
           FROM jsonb_array_elements(o.rows) AS r), 0), 2)               AS col2_receptii,
       ROUND(COALESCE((
         SELECT SUM( NULLIF(regexp_replace(r->>'plati_anterioare','[^0-9.\-]','','g'),'')::numeric )
           FROM jsonb_array_elements(o.rows) AS r), 0), 2)               AS col3_plati_ant,
       ROUND(COALESCE((
         SELECT SUM( NULLIF(regexp_replace(r->>'suma_ordonantata_plata','[^0-9.\-]','','g'),'')::numeric )
           FROM jsonb_array_elements(o.rows) AS r), 0), 2)               AS col4_ordonantat,
       ROUND(COALESCE((
         SELECT SUM( NULLIF(regexp_replace(r->>'receptii_neplatite','[^0-9.\-]','','g'),'')::numeric )
           FROM jsonb_array_elements(o.rows) AS r), 0), 2)               AS col5_salvat
  FROM formulare_ord o
 WHERE o.deleted_at IS NULL
   AND o.alop_id IS NOT NULL
 ORDER BY o.alop_id, o.created_at;

-- Pentru dosarul „Iluminat public": col3 de pe ORD 43759 ar trebui să fie
-- plata ciclului 1 (46.045,32), nu 99.308,88 (care include și plata pe care
-- chiar el o ordonanțează) și nici 300.424,95.


-- PASUL 3 — câte ORD-uri au col.5 salvat DIFERIT de col2−col3−col4?
--           Un rând aici înseamnă că cifra din document nu se mai potrivește
--           cu propria ei formulă — deci a fost rescrisă după calcul.
SELECT count(*) AS ord_cu_col5_incoerent
  FROM formulare_ord o
 WHERE o.deleted_at IS NULL
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements(o.rows) AS r
      WHERE abs(
              COALESCE(NULLIF(regexp_replace(r->>'receptii','[^0-9.\-]','','g'),'')::numeric,0)
            - COALESCE(NULLIF(regexp_replace(r->>'plati_anterioare','[^0-9.\-]','','g'),'')::numeric,0)
            - COALESCE(NULLIF(regexp_replace(r->>'suma_ordonantata_plata','[^0-9.\-]','','g'),'')::numeric,0)
            - COALESCE(NULLIF(regexp_replace(r->>'receptii_neplatite','[^0-9.\-]','','g'),'')::numeric,0)
            ) > 0.01
   );
