-- =============================================================================
-- DocFlowAI — ORD 46055: fluxul finalizat nu mai e legat de ALOP
-- Diagnostic READ-ONLY (pașii 1–4), apoi reparație gardată (pasul 5).
-- A se rula MANUAL, în consola Railway.
-- =============================================================================
--
-- REGULI DE CONSOLĂ: o singură interogare pe execuție; scrierile se împachetează
-- în CTE și se încheie cu SELECT (consola adaugă automat `LIMIT n`, care peste un
-- UPDATE dă eroare de sintaxă). Fără BEGIN/COMMIT ca instrucțiuni separate.
--
-- ⛔ Pasul 5 NU se rulează până nu confirmi rezultatele pașilor 1–4. Reconstituirea
--    mea a cauzei poate fi greșită; datele decid, nu raționamentul.
-- =============================================================================


-- ── PASUL 1 — cele două fluxuri ale ORD 46055 ────────────────────────────────
-- Vreau să văd: care e FINALIZAT, care e ANULAT, în ce ordine au fost create,
-- și ce ORD revendică fiecare prin `meta.ordId`.

SELECT
  f.id                                      AS flow_id,
  f.data->>'docName'                        AS document,
  f.data->>'status'                         AS status,
  (f.data->>'completed')::boolean           AS completed,
  f.data->>'completedAt'                    AS completed_at,
  f.data->>'cancelledAt'                    AS cancelled_at,
  f.data->>'cancelledBy'                    AS cancelled_by,
  f.data->'meta'->>'ordId'                  AS meta_ord_id,
  f.deleted_at,
  f.created_at
FROM flows f
WHERE f.data->>'docName' LIKE '%46055%'
ORDER BY f.created_at;


-- ── PASUL 2 — documentul ORD și pointerul lui autoritar ──────────────────────
-- `formulare_ord.flow_id` e sursa autoritară. `aprobat` NU e coloană, e derivat:
-- flow_id NOT NULL + flux nesters + flux completat. Dacă pointerul stă pe fluxul
-- ANULAT, documentul apare „Completat" în loc de „Aprobat" — exact ce se vede în UI.

SELECT
  o.id                                      AS ord_id,
  o.nr_ordonant_pl,
  o.status                                  AS ord_status,
  o.flow_id                                 AS pointer_autoritar,
  o.source_alop_id,
  o.created_at, o.updated_at, o.deleted_at,
  f.data->>'status'                         AS flux_status,
  (f.data->>'completed')::boolean           AS flux_completed,
  f.deleted_at                              AS flux_deleted_at,
  (o.flow_id IS NOT NULL
     AND f.deleted_at IS NULL
     AND ((f.data->>'completed')::boolean = true
          OR f.data->>'status' = 'completed'))  AS aprobat_derivat
FROM formulare_ord o
LEFT JOIN flows f ON f.id::text = o.flow_id
WHERE o.nr_ordonant_pl = '46055';


-- ── PASUL 3 — starea ALOP-ului (ciclul VIU trăiește aici) ────────────────────

SELECT
  a.id                                      AS alop_id,
  a.status,
  a.ciclu_curent,
  a.ord_id,
  a.ord_flow_id,
  a.ord_completed_at,
  a.df_id, a.df_flow_id,
  a.cancelled_at,
  a.updated_at
FROM alop_instances a
WHERE a.id = (
  SELECT o.source_alop_id FROM formulare_ord o
   WHERE o.nr_ordonant_pl = '46055' AND o.deleted_at IS NULL
   ORDER BY o.created_at LIMIT 1
);


-- ── PASUL 4 — istoricul pe cicluri (ARHIVAR: doar cicluri ÎNCHISE) ───────────
-- Aștept UN rând (ciclul 1, ORD 45325, plată 127.293,19). Ciclul 2 NU trebuie să
-- apară aici — el trăiește pe `alop_instances`. Dacă apare, opriți-vă și spuneți-mi.

SELECT c.ciclu_nr, c.ord_id, c.ord_flow_id, c.status,
       c.lichidare_confirmed_at, c.plata_confirmed_at, c.plata_suma_efectiva
FROM alop_ord_cicluri c
WHERE c.alop_id = (
  SELECT o.source_alop_id FROM formulare_ord o
   WHERE o.nr_ordonant_pl = '46055' AND o.deleted_at IS NULL
   ORDER BY o.created_at LIMIT 1
)
ORDER BY c.ciclu_nr;


-- ═════════════════════════════════════════════════════════════════════════════
-- PASUL 5 — REPARAȚIA (SCRIERE). Numai după confirmarea pașilor 1–4.
-- Înlocuiește cele două marcaje cu id-urile REALE din pasul 1.
--
-- Ideea: se mută pointerul autoritar `formulare_ord.flow_id` de pe fluxul ANULAT
-- pe cel FINALIZAT. Nu ating `alop_instances` — self-heal #2 (`alop.mjs:1015`)
-- repopulează singur `ord_flow_id`, trece ALOP-ul `ordonantare → plata` și pune
-- `ord_completed_at` la prima deschidere a dosarului. Azi refuză, corect: pointerul
-- arată spre un flux MORT, iar garda nu resuscită fluxuri moarte.
--
-- Gărzi: se schimbă doar dacă pointerul e chiar pe fluxul anulat (idempotent — a
-- doua rulare dă 0 rânduri), iar fluxul țintă trebuie să fie viu, completat ȘI să
-- revendice EXACT acest ORD prin `meta.ordId`. 0 rânduri = o gardă a picat, nu
-- „nu s-a întâmplat nimic": recitiți pașii 1–2 înainte de a forța ceva.
-- ═════════════════════════════════════════════════════════════════════════════

WITH reparat AS (
  UPDATE formulare_ord o
     SET flow_id    = 'PUNE_AICI_FLUXUL_FINALIZAT',
         updated_at = NOW()
   WHERE o.nr_ordonant_pl = '46055'
     AND o.deleted_at IS NULL
     AND o.flow_id = 'PUNE_AICI_FLUXUL_ANULAT'
     AND EXISTS (
       SELECT 1 FROM flows f
        WHERE f.id::text = 'PUNE_AICI_FLUXUL_FINALIZAT'
          AND f.deleted_at IS NULL
          AND ((f.data->>'completed')::boolean = true
               OR f.data->>'status' = 'completed')
          AND f.data->'meta'->>'ordId' = o.id::text
     )
  RETURNING o.id, o.nr_ordonant_pl, o.flow_id
)
SELECT * FROM reparat;


-- ── PASUL 6 — verificare, DUPĂ ce ai deschis dosarul ALOP în aplicație ───────
-- Deschiderea declanșează self-heal #2. Aștept: ord_flow_id = fluxul finalizat,
-- status = 'plata', ord_completed_at completat, aprobat_derivat = true.

SELECT
  a.status, a.ord_flow_id, a.ord_completed_at,
  o.flow_id AS pointer_autoritar,
  (o.flow_id IS NOT NULL AND f.deleted_at IS NULL
     AND ((f.data->>'completed')::boolean = true
          OR f.data->>'status' = 'completed'))  AS aprobat_derivat
FROM alop_instances a
JOIN formulare_ord o ON o.source_alop_id = a.id AND o.nr_ordonant_pl = '46055'
LEFT JOIN flows f ON f.id::text = o.flow_id
WHERE o.deleted_at IS NULL;
