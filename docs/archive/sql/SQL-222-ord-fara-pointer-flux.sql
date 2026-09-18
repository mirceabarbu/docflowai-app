-- ============================================================================
-- SQL-222 — RECON: ORD afișat „Completat" deși fluxul de semnare e FINALIZAT
-- DocFlowAI · producție v3.9.874 · 18.09.2026
-- ============================================================================
--
-- ⛔ STRICT READ-ONLY. Niciun UPDATE / DELETE / INSERT în acest fișier.
-- ⚠️ Consola Railway adaugă automat `LIMIT n` la final — inofensiv pe SELECT.
--    Rulează O SINGURĂ interogare pe execuție (șterge restul din editor).
--
-- ── CE VERIFICĂM ────────────────────────────────────────────────────────────
-- Badge-ul din lista ORD (server/routes/formulare/shared.mjs:~870-890) se
-- derivă EXCLUSIV din `formulare_ord.flow_id`:
--     flow_id NULL  ⇒  nu e nici „Trimis flux", nici „Aprobat", nici „Neaprobat"
--                   ⇒  badge-ul cade pe coloana `fo.status` = 'completed'
--                   ⇒  se afișează „✅ Completat"
-- Simptomul secundar care confirmă ipoteza: butonul ✍️ („Deschide fluxul de
-- semnare") lipsește din rândurile din capturi — el cere `flow_id && flow_viu`.
--
-- Fluxul, în schimb, își știe documentul prin `data->'meta'->>'ordId'`. Deci
-- legătura e ruptă ÎNTR-O SINGURĂ DIRECȚIE: fluxul știe de ORD, ORD-ul nu știe
-- de flux. Aceasta e clasa A („doc_fara_flux") din auditul #120.
--
-- ⚠️ ÎNAINTE DE A RULA CEVA AICI: deschide Admin → Dashboard → cardul
--    „Consistență document↔flux" și dă click pe el. Raportul există deja în
--    aplicație (GET /admin/flow-link-divergences) și listează exact clasa A.
--    Interogările de mai jos adaugă ce raportul NU vede (Q3, Q4, Q6).
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- Q1 — Starea pointerului pentru cele 5 ORD-uri din capturi
-- Așteptat dacă ipoteza e corectă: `flow_id` NULL pe toate.
-- Dacă `flow_id` e NON-NULL, citește `flux_status` / `flux_sters`: alt scenariu
-- (flux anulat sau soft-șters ⇒ badge-ul cade tot pe „Completat").
-- ════════════════════════════════════════════════════════════════════════════
SELECT fo.nr_ordonant_pl              AS nr,
       fo.id                          AS ord_id,
       fo.status                      AS status_coloana,
       fo.flow_id                     AS pointer_flow_id,
       (f.id IS NOT NULL)             AS flux_pointat_exista,
       (f.deleted_at IS NOT NULL)     AS flux_sters,
       f.data->>'status'              AS flux_status,
       f.data->>'completed'           AS flux_completed,
       fo.source_alop_id,
       fo.updated_at
  FROM formulare_ord fo
  LEFT JOIN flows f ON f.id = fo.flow_id
 WHERE fo.nr_ordonant_pl IN ('48545','48259','47757','46151','45301')
   AND fo.deleted_at IS NULL
 ORDER BY fo.nr_ordonant_pl DESC;


-- ════════════════════════════════════════════════════════════════════════════
-- Q2 — Cine revendică aceste ORD-uri prin `meta.ordId`
-- VERDICT: `pointer_flow_id` NULL + `flux_revendicator` prezent și finalizat
--          ⇒ clasa A confirmată (documentul semnat nu știe că e semnat).
-- Dacă apar 2+ rânduri pentru același ORD ⇒ fluxuri paralele (clasa D).
-- ════════════════════════════════════════════════════════════════════════════
SELECT fo.nr_ordonant_pl              AS nr,
       fo.flow_id                     AS pointer_flow_id,
       f.id                           AS flux_revendicator,
       f.data->>'status'              AS flux_status,
       f.data->>'completed'           AS flux_completed,
       (f.deleted_at IS NOT NULL)     AS flux_sters,
       jsonb_array_length(COALESCE(f.data->'signers','[]'::jsonb)) AS semnatari,
       (SELECT COUNT(*)::int
          FROM jsonb_array_elements(COALESCE(f.data->'signers','[]'::jsonb)) s
         WHERE s->>'status' = 'signed')                            AS semnate,
       f.created_at                   AS flux_creat,
       f.data->>'docName'             AS document
  FROM formulare_ord fo
  JOIN flows f ON f.data->'meta'->>'ordId' = fo.id::text
 WHERE fo.nr_ordonant_pl IN ('48545','48259','47757','46151','45301')
   AND fo.deleted_at IS NULL
 ORDER BY fo.nr_ordonant_pl DESC, f.created_at;


-- ════════════════════════════════════════════════════════════════════════════
-- Q3 — AMPLOAREA, pe toată producția, pe TREI categorii
-- Predicatele sunt COPIATE din services/flow-provenance.mjs (sursa unică):
--   validSigned = nețters + nu cancelled + nu refused + finalizat
--   live        = nețters + nu cancelled + nu refused (poate fi în semnare)
--
-- `A_semnat`    = ce vede deja cardul din Admin (clasa A).
-- `B_in_semnare`= GAURA: ORD fără pointer, cu flux VIU dar ÎNCĂ NESEMNAT.
--                 Auditul #120 NU îl vede (clasa A cere flux semnat, clasa D
--                 cere 2+ fluxuri). Ăsta e „o parte din ele sunt pe flux".
--   `C_df_*`    = oglinda pe DF, ca să știm dacă e specific ORD sau general.
-- ════════════════════════════════════════════════════════════════════════════
SELECT
  (SELECT COUNT(*) FROM formulare_ord d
     JOIN flows f ON f.data->'meta'->>'ordId' = d.id::text
    WHERE d.flow_id IS NULL AND d.deleted_at IS NULL
      AND f.deleted_at IS NULL
      AND f.data->>'status' IS DISTINCT FROM 'cancelled'
      AND f.data->>'status' IS DISTINCT FROM 'refused'
      AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
  ) AS a_ord_fara_pointer_flux_semnat,
  (SELECT COUNT(*) FROM formulare_ord d
     JOIN flows f ON f.data->'meta'->>'ordId' = d.id::text
    WHERE d.flow_id IS NULL AND d.deleted_at IS NULL
      AND f.deleted_at IS NULL
      AND f.data->>'status' IS DISTINCT FROM 'cancelled'
      AND f.data->>'status' IS DISTINCT FROM 'refused'
      AND NOT (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
  ) AS b_ord_fara_pointer_flux_in_semnare,
  (SELECT COUNT(*) FROM formulare_df d
     JOIN flows f ON f.data->'meta'->>'dfId' = d.id::text
    WHERE d.flow_id IS NULL AND d.deleted_at IS NULL
      AND f.deleted_at IS NULL
      AND f.data->>'status' IS DISTINCT FROM 'cancelled'
      AND f.data->>'status' IS DISTINCT FROM 'refused'
      AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
  ) AS c_df_fara_pointer_flux_semnat,
  (SELECT COUNT(*) FROM formulare_df d
     JOIN flows f ON f.data->'meta'->>'dfId' = d.id::text
    WHERE d.flow_id IS NULL AND d.deleted_at IS NULL
      AND f.deleted_at IS NULL
      AND f.data->>'status' IS DISTINCT FROM 'cancelled'
      AND f.data->>'status' IS DISTINCT FROM 'refused'
      AND NOT (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
  ) AS d_df_fara_pointer_flux_in_semnare;


-- ════════════════════════════════════════════════════════════════════════════
-- Q4 — CÂND s-a rupt: distribuția pe lună a ORD-urilor din categoria A+B
-- Dacă rândurile sunt împrăștiate pe multe luni ⇒ defect vechi, sistemic
-- (pointerul se scrie o singură dată, best-effort, la crearea fluxului).
-- Dacă sunt concentrate într-o lună ⇒ regresie introdusă de o versiune anume.
-- ════════════════════════════════════════════════════════════════════════════
SELECT to_char(f.created_at, 'YYYY-MM')            AS luna_flux,
       COUNT(*)                                     AS cate,
       COUNT(*) FILTER (WHERE f.data->>'status' = 'completed'
                           OR (f.data->>'completed')::boolean = true) AS din_care_semnate,
       MIN(d.nr_ordonant_pl)                        AS exemplu_nr
  FROM formulare_ord d
  JOIN flows f ON f.data->'meta'->>'ordId' = d.id::text
 WHERE d.flow_id IS NULL AND d.deleted_at IS NULL
   AND f.deleted_at IS NULL
   AND f.data->>'status' IS DISTINCT FROM 'cancelled'
   AND f.data->>'status' IS DISTINCT FROM 'refused'
 GROUP BY 1
 ORDER BY 1;


-- ════════════════════════════════════════════════════════════════════════════
-- Q5 — Fluxuri ORFANE: fluxuri de ordonanțare care nu revendică NICIUN ORD
-- (`meta.ordId` lipsă). Acestea sunt invizibile și pentru auditul #120, și
-- pentru Q2/Q3/Q4 de mai sus — singura urmă e numele documentului.
-- Așteptat: 0 rânduri. Orice rând ⇒ un al treilea mod de rupere a legăturii.
-- ════════════════════════════════════════════════════════════════════════════
SELECT f.id                           AS flux,
       f.data->>'docName'             AS document,
       f.data->>'status'              AS flux_status,
       f.data->>'completed'           AS flux_completed,
       f.data->'meta'                 AS meta,
       f.created_at
  FROM flows f
 WHERE f.deleted_at IS NULL
   AND f.data->'meta'->>'ordId' IS NULL
   AND COALESCE(f.data->>'docName','') ILIKE 'Ordonantare%'
 ORDER BY f.created_at DESC;


-- ════════════════════════════════════════════════════════════════════════════
-- Q6 — IMPACTUL FINANCIAR: dosare ALOP blocate în `ordonantare` din cauza asta
-- Dosarul nu trece la `plata` fiindcă TOATE căile (self-heal #2 din
-- routes/alop.mjs:~1042 și tranziția leneșă de sub el) citesc
-- `formulare_ord.flow_id`. Fără pointer, dosarul rămâne agățat, deși ORD-ul e
-- semnat. Aici stă paguba reală, nu în eticheta din listă.
-- ════════════════════════════════════════════════════════════════════════════
SELECT a.id                           AS alop_id,
       a.status                       AS status_dosar,
       a.ord_id,
       d.nr_ordonant_pl               AS ord_nr,
       d.flow_id                      AS ord_pointer,
       a.ord_flow_id,
       f.id                           AS flux_semnat,
       f.data->>'status'              AS flux_status,
       a.updated_at
  FROM alop_instances a
  JOIN formulare_ord d ON d.id = a.ord_id AND d.deleted_at IS NULL
  JOIN flows f ON f.data->'meta'->>'ordId' = d.id::text
 WHERE a.cancelled_at IS NULL
   AND d.flow_id IS NULL
   AND f.deleted_at IS NULL
   AND f.data->>'status' IS DISTINCT FROM 'cancelled'
   AND f.data->>'status' IS DISTINCT FROM 'refused'
   AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
 ORDER BY a.updated_at DESC;


-- ════════════════════════════════════════════════════════════════════════════
-- CE FAC CU REZULTATELE (Mircea → Claude chat)
-- ────────────────────────────────────────────────────────────────────────────
-- Trimite-mi: Q1, Q2, Q3 (obligatoriu), plus Q4/Q5/Q6 dacă Q3 dă non-zero.
-- Pe baza lor scriu promptul #222 cu DOUĂ componente separabile:
--   (1) GARDĂ la finalizare — nicio cale de semnare nu mai poate lăsa un
--       document semnat fără pointer (adopție idempotentă prin `meta`, cu
--       EXACT predicatul din flow-provenance.mjs, ca auditul și reparația să
--       nu poată diverge niciodată);
--   (2) REPARAȚIA DE DATE pentru rândurile existente — separată, cu backup,
--       niciodată automată (un document semnat nu se re-leagă tăcut).
-- ⛔ Nu rulez nimic până nu văd cifrele. Fără măsurătoare = ghicit.
-- ============================================================================
