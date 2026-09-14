-- ============================================================================
-- SQL-190b — REPARAȚIA DF 45748 (ALOP „Produse de curățenie", a7dc2f1c…)
--
-- Rulare în consola Railway: O SINGURĂ interogare pe execuție.
-- Ștergi din editor ce a rămas de la pasul anterior înainte de următorul pas.
-- Consola adaugă automat `LIMIT n` la final ⇒ fiecare scriere e împachetată în
-- CTE + `RETURNING`, iar interogarea se încheie cu un `SELECT` (tiparul cunoscut).
--
-- ── CE S-A ÎNTÂMPLAT (confirmat pe datele din SQL-190) ───────────────────────
--   26.08 12:38  FLOW_CREATED  PZ_4FD73C7BAF  (5 semnatari, 2 semnături)
--   28.08 08:36  FLOW_CANCELLED PZ_4FD73C7BAF
--   01.09 08:44:02 FLOW_CREATED PZ_01BA62F89A ← pre-setează formulare_df.flow_id
--   01.09 08:44:43 FLOW_CREATED PZ_3E88B4147C ← poarta #120 NU mută pointerul
--                                               (PZ_01BA… era încă VIU)
--   01.09 08:46:21 FLOW_CANCELLED PZ_01BA62F89A ← nimic nu re-evaluează pointerul
--   01.09→02.09    5/5 semnături pe PZ_3E88B4147C, completed=true
--
--   Rezultat: `formulare_df.flow_id` = PZ_01BA62F89A (ANULAT).
--   `docAprobatSql` cheiază pe pointerul DOCUMENTULUI ⇒ DF „Completat",
--   dosarul blocat în `angajare`, deși artefactul QES există pe PZ_3E88B4147C.
--
--   Handlerul `cancel` (lifecycle.mjs:585) resetează DF-ul doar dacă
--   `status='transmis_flux'`; aici statusul era 'completed' ⇒ 0 rânduri, iar
--   `formulare_df.flow_id` nu e atins niciodată la anulare (deliberat — proveniență).
--   Recurența e închisă din 02.09 de poarta de lansare #170 (crud.mjs:135):
--   un document nu mai poate primi un al doilea flux viu. E un reziduu istoric.
--
-- ── DE CE O SINGURĂ SCRIERE ─────────────────────────────────────────────────
--   Tot ce urmează se DERIVĂ din pointerul documentului:
--     · df_aprobat            ← sqlDosarAreAprobat (alop-dosar-sql.mjs)
--     · alop.df_flow_id       ← resync în tranziția lazy (alop.mjs:899,
--                               `df_flow_id = COALESCE($3, df_flow_id)`)
--     · alop.status angajare→lichidare + df_completed_at ← aceeași tranziție
--   ⇒ NU se scrie `alop_instances` de mână și NU se atinge `formulare_df.status`
--     (coloana e cache de afișare; pe calea cloud rămâne 'completed' — normal).
--   Aceeași regulă ca la reparațiile din 23.07 / 10.08 / 13.08.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- PASUL 0 — RECONTROL (read-only). Capturile sunt de ieri; starea se putea schimba.
--           Nu trece la PASUL 1 dacă rezultatul diferă de ce scrie mai jos.
-- ════════════════════════════════════════════════════════════════════════════
SELECT fd.id                                    AS df_id,
       fd.flow_id                               AS pointer_curent,
       fd.status                                AS status_coloana,
       fd.deleted_at IS NULL                    AS doc_viu,
       (SELECT COUNT(*) FROM flows f
         WHERE f.data->'meta'->>'dfId' = fd.id::text
           AND f.deleted_at IS NULL
           AND (f.data->>'status') IS DISTINCT FROM 'cancelled'
           AND (f.data->>'status') IS DISTINCT FROM 'refused'
           AND ((f.data->>'status') = 'completed'
                OR (f.data->>'completed')::boolean = true)) AS fluxuri_valid_semnate
  FROM formulare_df fd
 WHERE fd.nr_unic_inreg = '45748'
   AND fd.deleted_at IS NULL;

-- ⚠️ AȘTEPTAT: 1 rând · df_id = b119ef15-cb83-4abe-bfa5-06bfe6ad2a82
--    pointer_curent = PZ_01BA62F89A · doc_viu = true
--    fluxuri_valid_semnate = 1   ← dacă e 2, OPREȘTE-TE: două artefacte QES
--                                   pe același document, alegerea nu mai e evidentă.
--    Dacă pointer_curent e deja PZ_3E88B4147C, reparația s-a aplicat deja.


-- ════════════════════════════════════════════════════════════════════════════
-- PASUL 1 — REPARAȚIA. O singură scriere, autoprotejată și idempotentă.
--
--   Gărzi:
--     · ținta trebuie să existe, să fie VALID SEMNATĂ și să revendice CHIAR
--       acest document prin meta.dfId (nu se scrie un id „din memorie");
--     · sursa trebuie să fie exact pointerul greșit ⇒ a doua rulare dă 0 rânduri;
--     · documentul trebuie să fie nesters.
--   0 rânduri NU e eroare — e informația că precondiția nu mai e adevărată.
-- ════════════════════════════════════════════════════════════════════════════
WITH tinta AS (
  SELECT f.id
    FROM flows f
   WHERE f.id = 'PZ_3E88B4147C'
     AND f.deleted_at IS NULL
     AND (f.data->>'status') IS DISTINCT FROM 'cancelled'
     AND (f.data->>'status') IS DISTINCT FROM 'refused'
     AND ((f.data->>'status') = 'completed'
          OR (f.data->>'completed')::boolean = true)
     AND f.data->'meta'->>'dfId' = 'b119ef15-cb83-4abe-bfa5-06bfe6ad2a82'
),
reparat AS (
  UPDATE formulare_df fd
     SET flow_id    = (SELECT id FROM tinta),
         updated_at = NOW()
   WHERE fd.id = 'b119ef15-cb83-4abe-bfa5-06bfe6ad2a82'
     AND fd.deleted_at IS NULL
     AND fd.flow_id = 'PZ_01BA62F89A'
     AND EXISTS (SELECT 1 FROM tinta)
  RETURNING fd.id, fd.nr_unic_inreg, fd.revizie_nr, fd.flow_id, fd.status
)
SELECT * FROM reparat;

-- ⚠️ AȘTEPTAT: EXACT 1 rând, flow_id = PZ_3E88B4147C, status = 'completed'.
--    (`status` rămâne 'completed' — corect: aprobarea e derivată, nu stocată.)


-- ════════════════════════════════════════════════════════════════════════════
-- PASUL 2 — VERIFICARE (read-only): pointerul aprobă acum documentul?
--           Reproduce exact docAprobatSql.
-- ════════════════════════════════════════════════════════════════════════════
SELECT fd.nr_unic_inreg,
       fd.flow_id,
       f.data->>'status'                        AS flux_status,
       (f.data->>'completed')                   AS flux_completed,
       (
         fd.flow_id IS NOT NULL
         AND f.deleted_at IS NULL
         AND (f.data->>'status') IS DISTINCT FROM 'cancelled'
         AND (f.data->>'status') IS DISTINCT FROM 'refused'
         AND ((f.data->>'status') = 'completed'
              OR (f.data->>'completed')::boolean = true)
       )                                        AS df_aprobat
  FROM formulare_df fd
  JOIN flows f ON f.id = fd.flow_id
 WHERE fd.nr_unic_inreg = '45748' AND fd.deleted_at IS NULL;

-- ⚠️ AȘTEPTAT: df_aprobat = true.


-- ════════════════════════════════════════════════════════════════════════════
-- PASUL 3 — ÎN APLICAȚIE (nu în SQL): deschide dosarul ALOP „Produse de curățenie".
--
--   La deschidere se execută tranziția lazy din alop.mjs:888:
--     status 'angajare' → 'lichidare' · df_completed_at completat ·
--     df_flow_id resincronizat de pe PZ_4FD73C7BAF pe PZ_3E88B4147C.
--   În loguri: „[ALOP] lazy auto-tranziție angajare→lichidare (STS) … + resync df_flow_id".
--   Poarta de stări (migrația 109, RAISE EXCEPTION) permite angajare→lichidare.
-- ════════════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════════════
-- PASUL 4 — VERIFICARE DUPĂ DESCHIDERE (read-only)
-- ════════════════════════════════════════════════════════════════════════════
SELECT a.id, a.titlu, a.status, a.df_id, a.df_flow_id, a.df_completed_at, a.updated_at
  FROM alop_instances a
 WHERE a.id = 'a7dc2f1c-6e5a-408e-8227-05ece9566ca0';

-- ⚠️ AȘTEPTAT: status = 'lichidare' · df_flow_id = PZ_3E88B4147C · df_completed_at completat.
--
--    Dacă df_flow_id a rămas pe PZ_4FD73C7BAF ⇒ tranziția lazy nu s-a executat
--    (dosarul nu mai era în 'angajare'). ABIA ATUNCI se scrie de mână, gardat:
--
--      WITH fix AS (
--        UPDATE alop_instances
--           SET df_flow_id = 'PZ_3E88B4147C', updated_at = NOW()
--         WHERE id = 'a7dc2f1c-6e5a-408e-8227-05ece9566ca0'
--           AND cancelled_at IS NULL
--           AND df_flow_id = 'PZ_4FD73C7BAF'
--           AND df_id = 'b119ef15-cb83-4abe-bfa5-06bfe6ad2a82'
--        RETURNING id, status, df_flow_id
--      ) SELECT * FROM fix;
--
--    ⛔ NU forța `status` prin UPDATE — poarta din migrația 109 respinge orice
--       tranziție din afara matricei, iar aici nici nu e nevoie.


-- ════════════════════════════════════════════════════════════════════════════
-- PASUL 5 — MĂTURA CLASEI (read-only). ⭐ Rulează-l chiar dacă 45748 e reparat.
--
--   Aceeași formă de rupere, pe TOATE documentele: pointerul documentului NU e
--   pe un flux valid semnat, dar un ALT flux valid semnat îl revendică prin
--   data->'meta'. Detecția #120 NU vede clasa asta (clasa A cere flow_id NULL).
--
--   Rezultatul e ȘI poarta de acceptanță pentru PROMPT-190: dacă întoarce multe
--   rânduri legitime, predicatul se îngustează ÎNAINTE ca lotul să ajungă pe card.
-- ════════════════════════════════════════════════════════════════════════════
SELECT 'DF'                       AS tip,
       d.id::text                 AS doc_id,
       d.nr_unic_inreg            AS doc_nr,
       d.flow_id                  AS pointer_mort,
       fm.data->>'status'         AS pointer_status,
       fv.id                      AS flux_semnat,
       fv.updated_at              AS semnat_la
  FROM formulare_df d
  JOIN flows fm ON fm.id = d.flow_id
  JOIN flows fv ON fv.data->'meta'->>'dfId' = d.id::text AND fv.id <> d.flow_id
 WHERE d.deleted_at IS NULL
   AND d.flow_id IS NOT NULL
   AND (
        fm.deleted_at IS NULL
        AND (fm.data->>'status') IS DISTINCT FROM 'cancelled'
        AND (fm.data->>'status') IS DISTINCT FROM 'refused'
        AND ((fm.data->>'status') = 'completed'
             OR (fm.data->>'completed')::boolean = true)
       ) IS NOT TRUE
   AND fv.deleted_at IS NULL
   AND (fv.data->>'status') IS DISTINCT FROM 'cancelled'
   AND (fv.data->>'status') IS DISTINCT FROM 'refused'
   AND ((fv.data->>'status') = 'completed'
        OR (fv.data->>'completed')::boolean = true)

UNION ALL

SELECT 'ORD',
       d.id::text,
       d.nr_ordonant_pl,
       d.flow_id,
       fm.data->>'status',
       fv.id,
       fv.updated_at
  FROM formulare_ord d
  JOIN flows fm ON fm.id = d.flow_id
  JOIN flows fv ON fv.data->'meta'->>'ordId' = d.id::text AND fv.id <> d.flow_id
 WHERE d.deleted_at IS NULL
   AND d.flow_id IS NOT NULL
   AND (
        fm.deleted_at IS NULL
        AND (fm.data->>'status') IS DISTINCT FROM 'cancelled'
        AND (fm.data->>'status') IS DISTINCT FROM 'refused'
        AND ((fm.data->>'status') = 'completed'
             OR (fm.data->>'completed')::boolean = true)
       ) IS NOT TRUE
   AND fv.deleted_at IS NULL
   AND (fv.data->>'status') IS DISTINCT FROM 'cancelled'
   AND (fv.data->>'status') IS DISTINCT FROM 'refused'
   AND ((fv.data->>'status') = 'completed'
        OR (fv.data->>'completed')::boolean = true);

-- ⚠️ `IS NOT TRUE`, nu `NOT (…)`: un flux fără cheia `completed` produce NULL în
--    conjuncție, iar `NOT NULL` = NULL ⇒ rândul ar dispărea TĂCUT din rezultat.
--
-- ⚠️ Ce NU e în listă, deliberat: un document care pointează spre un flux anulat
--    și NU are niciun flux semnat care să-l revendice. Aceea e starea NORMALĂ
--    după orice anulare (pointerul rămâne ca proveniență) — sunt sute de cazuri.
--
--    Fiecare rând întors se repară cu PASUL 1, schimbând cele trei id-uri.
--    ⚠️ Înainte de fiecare reparație: verifică `alop_instances` (df_id/ord_id) —
--    la ORD, pointerul dosarului s-a agățat o dată de geamănul greșit (cb3c3618).
