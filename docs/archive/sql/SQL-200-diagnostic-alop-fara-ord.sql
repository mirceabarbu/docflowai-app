-- ============================================================================
-- SQL-200 — DIAGNOSTIC: divergența „ALOP fără document" pe ORD 42714
--
-- READ-ONLY. Un pas pe execuție. NU repară nimic.
--
-- ALOP: 06c71fef-593d-4321-8075-daf1c7f007bf
-- ORD : 2edd5722-72ea-49f5-b6f7-5508929a5d3d  (nr. 42714)
--
-- ÎNTREBAREA: dosarul e rupt, sau detectorul e prea larg?
--
--   `noua-lichidare` (alop.mjs:1751) ARHIVEAZĂ ciclul în alop_ord_cicluri și
--   GOLEȘTE alop.ord_id ca să pornească ciclul următor. ORD-ul vechi rămâne
--   legat prin source_alop_id — legitim. Detectorul clasei C nu verifică
--   ciclurile arhivate, deci ar raporta cazul ăsta ca divergență.
--
--   PASUL 1 decide. Dacă ORD-ul apare într-un ciclu arhivat ⇒ FALS POZITIV,
--   nu se atinge niciun rând de date; se îngustează detectorul.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- PASUL 1 — ⭐ ÎNTREBAREA DECISIVĂ: ORD-ul aparține unui ciclu arhivat?
-- ════════════════════════════════════════════════════════════════════════════
SELECT c.id            AS ciclu_id,
       c.ciclu_nr,
       c.status         AS ciclu_status,
       c.ord_id,
       c.ord_flow_id,
       c.an_exercitiu,
       c.lichidare_confirmed_at,
       c.plata_confirmed_at,
       c.plata_suma_efectiva,
       c.created_at
  FROM alop_ord_cicluri c
 WHERE c.alop_id = '06c71fef-593d-4321-8075-daf1c7f007bf'
 ORDER BY c.ciclu_nr;

-- ⚠️ Un rând cu ord_id = '2edd5722-72ea-49f5-b6f7-5508929a5d3d'
--      ⇒ FALS POZITIV. Dosarul e sănătos, ciclul a fost închis normal.
--        Nu se repară date. Se îngustează detectorul (vezi nota de la final).
--    ZERO rânduri, sau cicluri care nu conțin ORD-ul
--      ⇒ divergență reală: pointerul s-a pierdut. Continuă cu pașii 2–4.


-- ════════════════════════════════════════════════════════════════════════════
-- PASUL 2 — starea dosarului
-- ════════════════════════════════════════════════════════════════════════════
SELECT a.id, a.titlu, a.status, a.ciclu_curent, a.cancelled_at,
       a.df_id, a.df_flow_id, a.df_completed_at,
       a.ord_id, a.ord_flow_id, a.ord_completed_at,
       a.lichidare_confirmed_at, a.plata_confirmed_at, a.plata_suma_efectiva,
       a.suma_totala_platita, a.updated_at
  FROM alop_instances a
 WHERE a.id = '06c71fef-593d-4321-8075-daf1c7f007bf';

-- ⚠️ `ciclu_curent` > 1 întărește ipoteza „noua-lichidare".
--    `status` spune unde e dosarul acum: angajare (ciclu nou pornit) vs plata/completed.


-- ════════════════════════════════════════════════════════════════════════════
-- PASUL 3 — ORD-ul și fluxul lui
-- ════════════════════════════════════════════════════════════════════════════
SELECT d.id, d.nr_ordonant_pl, d.status, d.source_alop_id, d.df_id,
       d.flow_id, d.deleted_at, d.created_at, d.updated_at,
       f.data->>'status'          AS flux_status,
       (f.data->>'completed')     AS flux_completed,
       f.deleted_at IS NOT NULL   AS flux_sters,
       f.data->'meta'->>'ordId'   AS flux_revendica_ord,
       (
         f.deleted_at IS NULL
         AND (f.data->>'status') IS DISTINCT FROM 'cancelled'
         AND (f.data->>'status') IS DISTINCT FROM 'refused'
         AND ((f.data->>'status') = 'completed'
              OR (f.data->>'completed')::boolean = true)
       )                          AS flux_valid_semnat
  FROM formulare_ord d
  LEFT JOIN flows f ON f.id = d.flow_id
 WHERE d.id = '2edd5722-72ea-49f5-b6f7-5508929a5d3d';

-- ⚠️ Verifică și dacă mai există ALTE ORD-uri pe același dosar:
--    dacă ciclul 2 și-a creat propriul ORD, dosarul chiar are ord_id — altul.


-- ════════════════════════════════════════════════════════════════════════════
-- PASUL 4 — toate ORD-urile dosarului, ca să se vadă succesiunea ciclurilor
-- ════════════════════════════════════════════════════════════════════════════
SELECT d.id, d.nr_ordonant_pl, d.status, d.flow_id, d.deleted_at, d.created_at,
       (SELECT c.ciclu_nr FROM alop_ord_cicluri c
         WHERE c.ord_id = d.id) AS apartine_ciclului
  FROM formulare_ord d
 WHERE d.source_alop_id = '06c71fef-593d-4321-8075-daf1c7f007bf'
 ORDER BY d.created_at;

-- ⚠️ `apartine_ciclului` NULL pe ORD-ul curent e normal — ciclul curent nu e
--    încă arhivat. NULL pe un ORD vechi, în timp ce altele au număr de ciclu,
--    e semnalul unei rupturi reale.
-- ============================================================================
