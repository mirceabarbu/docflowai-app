-- ============================================================================
-- SQL-222b — CAUZA CONFIRMATĂ: flux ORFAN cu `meta` GOL (ORD 45301)
-- DocFlowAI · producție v3.9.875 · 18.09.2026
-- Continuă SQL-222. Q1–Q6 rulate; verdictul e în Q5.
-- ============================================================================
--
-- ⛔ SECȚIUNEA A (Q7–Q10) e STRICT READ-ONLY.
-- ⚠️ SECȚIUNEA B (R1, R2) SCRIE. Nu o rula până nu confirmăm Q7–Q10 împreună.
-- ⚠️ Consola Railway adaugă `LIMIT n` la final ⇒ scrierile sunt împachetate în
--    CTE cu `RETURNING`, iar interogarea se închide cu un `SELECT` din CTE.
--    O SINGURĂ interogare pe execuție.
--
-- ── CE AU ARĂTAT Q1–Q6 ──────────────────────────────────────────────────────
-- Q3 = 0/0/0/0 și cardul „Consistență document↔flux" = ✅ 0  ⇒  auditul #120 e
--      ORB la această clasă, fiindcă toate detectoarele lui fac JOIN pe
--      `data->'meta'->>'ordId'`.
-- Q5 = 1 rând:  flux `PZ_2F1386A6E6`, document `OrdonantarePlata_45301_20260821`,
--      `completed = true`, `meta = {}`  ⇒  fluxul finalizat NU declară niciun
--      document. E invizibil pentru poarta de lansare #170, pentru garda de
--      reinițiere #114/#171, pentru PASUL 3 (scrierea pointerului) și pentru
--      auditul #120 — toate citesc `meta`.
-- Q1 = ORD 45301 are `flow_id` NULL  ⇒  badge-ul cade pe `fo.status='completed'`
--      ⇒  „✅ Completat".
--
-- ⇒ 48259 și 47757 NU sunt bug: `flow_id` NULL + niciun flux ⇒ formular completat,
--   nelansat încă. „Completat" e eticheta corectă.
-- ⇒ 48545 și 46151 au fluxuri lansate azi (18.09, 09:00 / 09:09), cu meta corectă,
--   2/5 și 1/5 semnături ⇒ sănătoase, calea bună funcționează.
-- ⇒ SINGURUL document defect este 45301.
-- ============================================================================


-- ████ SECȚIUNEA A — READ-ONLY ███████████████████████████████████████████████

-- ════════════════════════════════════════════════════════════════════════════
-- Q7 — Dosarul ALOP al lui 45301 (`source_alop_id` din Q1)
-- CRITIC ÎNAINTE DE REPARAȚIE: în momentul în care punem pointerul, ORD-ul
-- devine „aprobat" și tranziția leneșă din GET /api/alop/:id va împinge dosarul
-- `ordonantare → plata`, plus `tryAutoConfirmAlop` (OPME). Trebuie să știm
-- exact de unde pleacă dosarul, ca să știm unde ajunge.
-- ════════════════════════════════════════════════════════════════════════════
SELECT a.id                AS alop_id,
       a.status            AS status_dosar,
       a.df_id, a.df_flow_id, a.df_completed_at,
       a.ord_id, a.ord_flow_id, a.ord_completed_at,
       a.lichidare_confirmed_at,
       a.plata_suma_efectiva,
       a.cancelled_at,
       a.updated_at,
       (SELECT COUNT(*) FROM alop_ord_cicluri c WHERE c.alop_id = a.id) AS cicluri_arhivate
  FROM alop_instances a
 WHERE a.id = '16d86bd7-f7d8-427d-b3c1-2af2cd649ddc';


-- ════════════════════════════════════════════════════════════════════════════
-- Q8 — AMPLOAREA REALĂ a clasei „flux orfan" (fără filtrele prea strâmte din Q5)
-- Q5 cerea `deleted_at IS NULL` și prefixul 'Ordonantare%'. Aici ridicăm ambele:
-- includem fluxurile șterse și tiparul DF. Așteptat: 1 rând (cel deja știut).
-- Orice rând în plus = un document care nu știe că e semnat.
-- ════════════════════════════════════════════════════════════════════════════
SELECT f.id                                   AS flux,
       f.data->>'docName'                     AS document,
       f.data->>'status'                      AS flux_status,
       f.data->>'completed'                   AS flux_completed,
       (f.deleted_at IS NOT NULL)             AS flux_sters,
       f.data->'meta'                         AS meta,
       jsonb_array_length(COALESCE(f.data->'signers','[]'::jsonb)) AS semnatari,
       (SELECT COUNT(*)::int
          FROM jsonb_array_elements(COALESCE(f.data->'signers','[]'::jsonb)) s
         WHERE s->>'status' = 'signed')       AS semnate,
       f.org_id,
       f.created_at
  FROM flows f
 WHERE f.data->'meta'->>'ordId' IS NULL
   AND f.data->'meta'->>'dfId'  IS NULL
   AND (   COALESCE(f.data->>'docName','') ILIKE 'Ordonantare%'
        OR COALESCE(f.data->>'docName','') ILIKE 'DocumentFundamentare%')
 ORDER BY f.created_at DESC;


-- ════════════════════════════════════════════════════════════════════════════
-- Q9 — Verificarea fluxului ÎNAINTE de a-l lega: chiar e semnat cap-coadă?
-- Nu legăm un document semnat pe baza unui nume de fișier. Cerem dovada:
-- toți semnatarii `signed`, PDF semnat prezent în `flows_pdfs`, aceeași org.
-- Așteptat: semnatari = semnate = 5, are_pdf_semnat = true, org_id = org-ul ORD-ului.
-- ════════════════════════════════════════════════════════════════════════════
SELECT f.id                                   AS flux,
       f.data->>'docName'                     AS document,
       f.org_id                               AS flux_org,
       (SELECT fo.org_id FROM formulare_ord fo WHERE fo.nr_ordonant_pl='45301'
         AND fo.deleted_at IS NULL LIMIT 1)    AS ord_org,
       f.data->>'status'                      AS flux_status,
       f.data->>'completed'                   AS flux_completed,
       f.data->>'completedAt'                 AS finalizat_la,
       jsonb_array_length(COALESCE(f.data->'signers','[]'::jsonb)) AS semnatari,
       (SELECT COUNT(*)::int
          FROM jsonb_array_elements(COALESCE(f.data->'signers','[]'::jsonb)) s
         WHERE s->>'status' = 'signed')        AS semnate,
       (SELECT string_agg(s->>'name', ' | ' ORDER BY s->>'name')
          FROM jsonb_array_elements(COALESCE(f.data->'signers','[]'::jsonb)) s) AS nume_semnatari,
       EXISTS (SELECT 1 FROM flows_pdfs p
                WHERE p.flow_id = f.id AND p.key = 'signedPdfB64') AS are_pdf_semnat
  FROM flows f
 WHERE f.id = 'PZ_2F1386A6E6';


-- ════════════════════════════════════════════════════════════════════════════
-- Q10 — Control de normalitate: `completed=true` cu `status <> 'completed'`
-- Fluxul nostru are status 'active' ȘI completed true. Dacă tiparul e frecvent,
-- e forma istorică normală (`docAprobatSql` acceptă ambele) și nu e un al doilea
-- defect. Dacă e unic, mai săpăm.
-- ════════════════════════════════════════════════════════════════════════════
SELECT f.data->>'status'  AS flux_status,
       COUNT(*)           AS cate
  FROM flows f
 WHERE f.deleted_at IS NULL
   AND (f.data->>'completed')::boolean = true
 GROUP BY 1
 ORDER BY 2 DESC;


-- ████ SECȚIUNEA B — SCRIE. NU RULA ÎNAINTE DE CONFIRMARE ████████████████████
--
-- ⛔ PRECONDIȚII OBLIGATORII, toate verificate pe Q7–Q9:
--    1. Q9: semnatari = semnate, `are_pdf_semnat` = true, `flux_org` = `ord_org`.
--    2. Q8: exact 1 rând (nu reparăm o clasă pe care n-am măsurat-o integral).
--    3. Q7: ai citit starea dosarului și ești de acord cu unde ajunge după R2.
--    4. BACKUP `pg_dump` FĂCUT. R2 declanșează, la primul GET pe dosar,
--       tranziția `ordonantare → plata` + `tryAutoConfirmAlop` (OPME).
--
-- Ordinea NU e negociabilă: R1 (meta) întâi, R2 (pointer) al doilea.
-- R1 singur nu schimbă nimic operațional — doar face fluxul vizibil pentru
-- audit. R2 e cel care pornește cascada.

-- ── R1 — fluxul își declară documentul (JSONB `meta.ordId`) ─────────────────
-- Substituie <ORD_ID> cu `ord_id` din Q1 pentru nr. 45301:
--   24fdbeac-7c68-4817-9265-e913f353960e
WITH tinta AS (
  SELECT fo.id AS ord_id
    FROM formulare_ord fo
   WHERE fo.nr_ordonant_pl = '45301' AND fo.deleted_at IS NULL
), scris AS (
  UPDATE flows f
     SET data = jsonb_set(
                  jsonb_set(COALESCE(f.data, '{}'::jsonb), '{meta}',
                            COALESCE(f.data->'meta', '{}'::jsonb), true),
                  '{meta,ordId}', to_jsonb((SELECT ord_id::text FROM tinta)), true),
         updated_at = NOW()
   WHERE f.id = 'PZ_2F1386A6E6'
     AND f.data->'meta'->>'ordId' IS NULL            -- idempotent
     AND (SELECT COUNT(*) FROM tinta) = 1            -- fail-closed
  RETURNING f.id, f.data->'meta' AS meta_nou
)
SELECT * FROM scris;
-- Așteptat: 1 rând, `meta_nou` conține ordId-ul. 0 rânduri ⇒ deja aplicat sau
-- precondiția a picat — NU insista, revino la mine.


-- ── R2 — ORD-ul își recunoaște fluxul (pointerul) ───────────────────────────
-- ⚠️ DUPĂ R1. Aceasta e scrierea care pornește cascada ALOP.
WITH scris AS (
  UPDATE formulare_ord fo
     SET flow_id = 'PZ_2F1386A6E6',
         updated_at = NOW()
   WHERE fo.nr_ordonant_pl = '45301'
     AND fo.deleted_at IS NULL
     AND fo.flow_id IS NULL                          -- idempotent + fail-closed
     AND EXISTS (SELECT 1 FROM flows f
                  WHERE f.id = 'PZ_2F1386A6E6'
                    AND f.deleted_at IS NULL
                    AND f.data->'meta'->>'ordId' = fo.id::text)  -- R1 a rulat
  RETURNING fo.id, fo.nr_ordonant_pl, fo.status, fo.flow_id
)
SELECT * FROM scris;
-- Așteptat: 1 rând. Apoi, în aplicație:
--   · lista ORD: 45301 trece din „✅ Completat" în „🟢 Aprobat", apare ✍️
--   · deschide dosarul ALOP 16d86bd7… o dată — tranziția leneșă rulează acolo
--   · cardul „Consistență document↔flux" trebuie să rămână ✅ 0
-- ============================================================================
