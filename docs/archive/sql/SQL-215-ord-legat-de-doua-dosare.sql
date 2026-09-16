-- ============================================================================
-- SQL-215 — ORD legat de două dosare ALOP (16.09.2026)
-- DocFlowAI, producție. Q1–Q4 = DOAR SELECT. R1 = SCRIERE (backup întâi).
-- ⚠️ Consola Railway: câte o interogare pe execuție.
--
-- Constatat: ORD 47842 (RATBV) apare pe dosarul RATBV (ciclul 4, corect) ȘI pe dosarul
-- „CONSUM CARBURANT" (lichidare, ciclul 1, GREȘIT). Singurul loc care scrie
-- `alop_instances.ord_id` e POST /api/alop/:id/link-ord, care verifică doar că dosarul-țintă
-- n-are încă un ORD. Nu verifică: că ORD-ul aparține dosarului (`source_alop_id`), că nu e
-- deja pe alt dosar (link-df ARE verificarea asta, link-ord nu), sau faza dosarului.
-- Frontendul cheamă link-ord la FIECARE salvare a ORD-ului, cu dosarul reținut în browser
-- (`window._alopContext`) ⇒ un context rămas de la alt dosar leagă ORD-ul acolo.
--
-- ⛔ PÂNĂ LA R1: NU lansa fluxul ORD 47842. La lansare, `crud.mjs` pune `ord_flow_id` pe
--    TOATE dosarele cu acel ord_id, iar la semnare doar unul (arbitrar) trece în plată.
-- ============================================================================


-- ─── Q1 — dosarele cu ORD suspect ───────────────────────────────────────────
--   GRESIT_REPARABIL  = ORD-ul aparține ALTUI dosar, iar acesta n-a lansat flux și e înainte
--                       de ordonanțare ⇒ R1 îl dezleagă.
--   GRESIT_ALTA_STARE = ORD-ul aparține ALTUI dosar, dar dosarul are flux ORD sau e mai avansat
--                       ⇒ NU rula R1 pe el, trimite-mi rândul.
--   FARA_PROVENIENTA  = ORD vechi, fără `source_alop_id` — informativ.
--   CORECT_DAR_FAZA   = ORD-ul e al dosarului, dar dosarul e înainte de ordonanțare — informativ.
SELECT fo.nr_ordonant_pl                      AS nr_ord,
       fo.beneficiar,
       a.titlu                                AS dosar,
       a.status,
       a.ciclu_curent,
       (a.ord_flow_id IS NOT NULL)            AS are_flux_ord,
       (SELECT count(*) FROM alop_instances a2
         WHERE a2.ord_id = fo.id AND a2.cancelled_at IS NULL) AS dosare_pe_acest_ord,
       CASE
         WHEN fo.source_alop_id IS NOT NULL AND fo.source_alop_id <> a.id
              AND a.ord_flow_id IS NULL AND a.status IN ('draft','angajare','lichidare')
           THEN 'GRESIT_REPARABIL'
         WHEN fo.source_alop_id IS NOT NULL AND fo.source_alop_id <> a.id
           THEN 'GRESIT_ALTA_STARE'
         WHEN fo.source_alop_id IS NULL
           THEN 'FARA_PROVENIENTA'
         ELSE 'CORECT_DAR_FAZA'
       END                                    AS verdict,
       a.updated_at                           AS dosar_actualizat_la,
       ub.email                               AS dosar_actualizat_de,
       a.id                                   AS alop_id,
       fo.id                                  AS ord_id,
       fo.source_alop_id                      AS ord_dosar_origine
  FROM alop_instances a
  JOIN formulare_ord fo ON fo.id = a.ord_id
  LEFT JOIN users ub    ON ub.id = a.updated_by
 WHERE a.cancelled_at IS NULL
   AND (   fo.source_alop_id IS DISTINCT FROM a.id
        OR a.status IN ('draft','angajare','lichidare')
        OR EXISTS (SELECT 1 FROM alop_instances a2
                    WHERE a2.ord_id = a.ord_id AND a2.id <> a.id AND a2.cancelled_at IS NULL))
 ORDER BY verdict, fo.nr_ordonant_pl, a.created_at;


-- ─── Q2 — un ORD din ciclul ARHIVAT al unui dosar e ORD curent pe alt dosar ─
-- Așteptat: 0 rânduri.
SELECT fo.nr_ordonant_pl AS nr_ord,
       ar.titlu          AS dosar_arhiva,
       c.ciclu_nr,
       cur.titlu         AS dosar_curent,
       cur.status        AS status_dosar_curent
  FROM alop_ord_cicluri c
  JOIN alop_instances cur ON cur.ord_id = c.ord_id AND cur.id <> c.alop_id AND cur.cancelled_at IS NULL
  JOIN alop_instances ar  ON ar.id = c.alop_id
  JOIN formulare_ord fo   ON fo.id = c.ord_id;


-- ─── Q3 — același tip de problemă pe DF ─────────────────────────────────────
-- DF-ul curent al unui dosar provine din ALT dosar. Așteptat: 0 rânduri.
SELECT fd.nr_unic_inreg, fd.revizie_nr,
       a.titlu  AS dosar,
       a.status,
       src.titlu AS dosar_origine_df
  FROM alop_instances a
  JOIN formulare_df fd    ON fd.id = a.df_id
  LEFT JOIN alop_instances src ON src.id = fd.source_alop_id
 WHERE a.cancelled_at IS NULL
   AND fd.source_alop_id IS NOT NULL
   AND fd.source_alop_id <> a.id;


-- ─── Q4 — câte ORD-uri nu au proveniență, pe lună ───────────────────────────
-- Arată dacă regula „ORD-ul trebuie să aparțină dosarului" poate fi verificată pe toate
-- ORD-urile noi (fara_provenienta ≈ 0 în lunile recente) sau doar pe o parte.
SELECT to_char(fo.created_at, 'YYYY-MM')                             AS luna,
       count(*)                                                      AS ord_uri,
       count(*) FILTER (WHERE fo.source_alop_id IS NULL)             AS fara_provenienta,
       count(*) FILTER (WHERE fo.source_alop_id IS NULL
                          AND fo.df_id IS NULL)                      AS fara_provenienta_si_fara_df
  FROM formulare_ord fo
 WHERE fo.deleted_at IS NULL
 GROUP BY 1
 ORDER BY 1;


-- ─── R1 — REPARAȚIE (SCRIERE): dezleagă ORD-urile de pe dosarele greșite ────
-- ⛔ Backup întâi. Rulează DOAR dacă Q1 are EXACT 1 rând GRESIT_REPARABIL (CONSUM CARBURANT).
--    Altfel nu rula și trimite-mi Q1.
-- Atinge DOAR dosarul greșit, și doar dacă dosarul CORECT (cel din `source_alop_id`) pointează
-- și el spre ORD. Dosarul RATBV rămâne neatins. Gardă: exact 1 rând, altfel „division by zero"
-- și nu se scrie nimic.
WITH tinta AS (
  SELECT a.id, a.titlu, a.status, fo.id AS ord_id, fo.nr_ordonant_pl
    FROM alop_instances a
    JOIN formulare_ord fo ON fo.id = a.ord_id
   WHERE a.cancelled_at IS NULL
     AND fo.source_alop_id IS NOT NULL
     AND fo.source_alop_id <> a.id
     AND a.ord_flow_id IS NULL
     AND a.status IN ('draft','angajare','lichidare')
     AND EXISTS (SELECT 1 FROM alop_instances ok
                  WHERE ok.id = fo.source_alop_id AND ok.ord_id = fo.id AND ok.cancelled_at IS NULL)
),
upd AS (
  UPDATE alop_instances a
     SET ord_id = NULL, updated_at = NOW()
    FROM tinta t
   WHERE a.id = t.id AND a.ord_id = t.ord_id
  RETURNING a.id, t.titlu, t.status, t.nr_ordonant_pl
)
SELECT u.*,
       1 / (CASE WHEN (SELECT count(*) FROM upd) = 1 THEN 1 ELSE 0 END) AS garda_1_rand
  FROM upd u;
