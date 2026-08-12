-- ============================================================================
-- recon-124-duplicate-check.sql — DocFlowAI #124a
-- ============================================================================
-- SCOP: află dacă în PRODUCȚIE există deja duplicate, ÎNAINTE de a încerca
--       vreun index unic nou. Migrarea 095 (db/index.mjs:2131-2141) are deja un
--       `RAISE WARNING` exact pentru cazul în care indexul NU se poate crea din
--       cauza duplicatelor rămase — deci ăsta e un risc dovedit, nu teoretic.
--
-- ⛔ STRICT READ-ONLY. Doar SELECT. Niciun INSERT/UPDATE/DELETE/CREATE/ALTER,
--    niciun DO block, nicio funcție cu efecte. Se poate rula în siguranță pe
--    producție, în orice moment.
--
-- MOD DE RULARE (psql):
--     psql "$DATABASE_URL" -f docs/audits/recon-124-duplicate-check.sql
--
--   Rulează întâi BLOCUL 0. Dacă raportează o coloană lipsă, sari blocul marcat
--   ca dependent de ea — restul rulează independent.
--   ⚠️ NU folosi ON_ERROR_STOP=1 dacă vrei ca toate blocurile să ruleze chiar
--      dacă unul eșuează pe o coloană absentă.
--
-- VALIDAT (2026-08-12): scriptul a rulat integral, cu ON_ERROR_STOP=1, pe o
--   schemă FRESH construită prin server/tests/helpers/db-real.mjs → migrate()
--   (PostgreSQL 17, instanță efemeră). Toate cele 12 blocuri s-au executat fără
--   eroare; blocul 0 a confirmat `formulare_ord.revizie_nr = false`.
--   Schemă goală ⇒ 0 rânduri peste tot; rularea pe producție e cea care contează.
--
-- SCHEMA VERIFICATĂ (server/db/index.mjs @ v3.9.753) — nu presupune simetrie:
--   formulare_df  : source_alop_id, revizie_nr, org_id, deleted_at, flow_id   ✔
--   formulare_ord : source_alop_id, org_id, deleted_at, flow_id
--                   ⚠️ NU ARE revizie_nr (CREATE TABLE la db/index.mjs:939-970;
--                      mig. 084 adaugă doar source_alop_id, :1821)
--   alop_instances: created_by, titlu, org_id, created_at, cancelled_at, df_id
--   flows         : id TEXT, data JSONB, org_id, deleted_at, created_at
-- ============================================================================


-- ============================================================================
-- BLOCUL 0 — verificare de schemă. RULEAZĂ-L PRIMUL.
-- ----------------------------------------------------------------------------
-- Ce numără: existența coloanelor folosite mai jos.
-- Interpretare: orice rând cu exista = false ⇒ SARI blocul care depinde de el
--               (fiecare bloc își declară dependențele în antet).
-- ============================================================================
SELECT
  t.tabel,
  t.coloana,
  EXISTS (
    SELECT 1 FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.table_name   = t.tabel
       AND c.column_name  = t.coloana
  ) AS exista
FROM (VALUES
  ('formulare_df',  'source_alop_id'),
  ('formulare_df',  'revizie_nr'),
  ('formulare_df',  'nr_unic_inreg'),
  ('formulare_df',  'deleted_at'),
  ('formulare_ord', 'source_alop_id'),
  ('formulare_ord', 'deleted_at'),
  ('formulare_ord', 'nr_ordonant_pl'),
  ('formulare_ord', 'revizie_nr'),          -- așteptat: FALSE (ORD nu are revizii)
  ('alop_instances','cancelled_at'),
  ('alop_instances','titlu'),
  ('flows',         'deleted_at'),
  ('flows',         'org_id')
) AS t(tabel, coloana)
ORDER BY t.tabel, t.coloana;


-- ============================================================================
-- BLOCUL 1 — indexul unic al DF există în producție?
-- ----------------------------------------------------------------------------
-- Ce numără: prezența `df_source_alop_revizie_uniq` (migrarea 095).
-- Interpretare:
--   1 rând  ⇒ migrarea 095 a reușit; DF e protejat de dublu-clic la creare.
--   0 rânduri ⇒ ⚠️ CONSTATARE ÎN SINE: migrarea a eșuat TĂCUT (RAISE WARNING,
--               db/index.mjs:2139) pentru că au rămas duplicate pe care
--               dedup-ul automat nu le-a putut atinge (grupuri cu ≥2 DF-uri
--               având flow_id NOT NULL — vezi garda `fd.flow_id IS NULL`,
--               db/index.mjs:2128). În acest caz DF e la fel de neprotejat ca
--               ORD, iar blocul 2 trebuie citit ca fiind valabil și pentru DF.
-- ============================================================================
SELECT indexname, indexdef
  FROM pg_indexes
 WHERE schemaname = 'public'
   AND tablename  = 'formulare_df'
   AND indexname  = 'df_source_alop_revizie_uniq';


-- ============================================================================
-- BLOCUL 1b — dacă indexul LIPSEȘTE: care grupuri DF îl blochează?
-- ----------------------------------------------------------------------------
-- Rulează-l DOAR dacă blocul 1 a întors 0 rânduri.
-- Ce numără: grupurile (source_alop_id, revizie_nr) cu ≥2 DF-uri nețterse.
-- Interpretare: fiecare rând = un grup care trebuie rezolvat MANUAL înainte de
--               a putea recrea indexul. `pe_flux` > 1 înseamnă că dedup-ul
--               automat din 095 nu are voie să atingă grupul (ar rupe legături
--               de flux) ⇒ decizie umană obligatorie.
-- ============================================================================
SELECT
  source_alop_id,
  revizie_nr,
  COUNT(*)                                   AS nr_df,
  COUNT(*) FILTER (WHERE flow_id IS NOT NULL) AS pe_flux,
  MIN(created_at)                            AS primul,
  MAX(created_at)                            AS ultimul,
  array_agg(id ORDER BY created_at)          AS id_uri
FROM formulare_df
WHERE source_alop_id IS NOT NULL
  AND deleted_at IS NULL
GROUP BY source_alop_id, revizie_nr
HAVING COUNT(*) > 1
ORDER BY nr_df DESC, ultimul DESC
LIMIT 50;


-- ============================================================================
-- BLOCUL 2 — ORD duplicate pe source_alop_id  ⭐ ÎNTREBAREA PRINCIPALĂ
-- ----------------------------------------------------------------------------
-- Depinde de: formulare_ord.source_alop_id, formulare_ord.deleted_at (blocul 0).
--
-- Cheia oglindește DF-ul, MINUS `revizie_nr` — `formulare_ord` NU are coloana
-- (db/index.mjs:939-970). Deci cheia candidată pentru un index unic pe ORD este:
--     (source_alop_id) WHERE source_alop_id IS NOT NULL AND deleted_at IS NULL
-- (`org_id` e implicit: un source_alop_id aparține unei singure organizații,
--  dar îl includem în proiecție ca să se vadă dacă ipoteza e încălcată.)
--
-- Ce numără: câte grupuri source_alop_id au ≥2 ORD-uri nețterse.
-- Interpretare: DACĂ grupuri_cu_duplicate > 0 ⇒ indexul unic pe ORD **NU** se
--               poate crea fără curățare prealabilă.
-- ============================================================================
SELECT
  COUNT(*)                                          AS grupuri_cu_duplicate,
  COALESCE(SUM(nr_ord), 0)                          AS ord_uri_implicate,
  COALESCE(SUM(nr_ord - 1), 0)                      AS ord_uri_in_exces,
  COALESCE(SUM(pe_flux), 0)                         AS din_care_pe_flux
FROM (
  SELECT
    source_alop_id,
    COUNT(*)                                        AS nr_ord,
    COUNT(*) FILTER (WHERE flow_id IS NOT NULL)     AS pe_flux
  FROM formulare_ord
  WHERE source_alop_id IS NOT NULL
    AND deleted_at IS NULL
  GROUP BY source_alop_id
  HAVING COUNT(*) > 1
) g;


-- ----------------------------------------------------------------------------
-- BLOCUL 2b — detaliul grupurilor ORD duplicate (max 50).
-- Interpretare: `pe_flux = 0` ⇒ grup curățabil automat (soft-delete pe toate
--               în afară de cel mai vechi, tiparul din 095). `pe_flux >= 1`
--               ⇒ curățare MANUALĂ: nu ștergi un ORD care are flux de semnare.
--               `nr_ord_distincte` > 1 înseamnă că ORD-urile au numere de
--               ordonanțare diferite — probabil NU sunt dublu-clic, ci
--               ordonanțări legitime multiple pe același dosar ⇒ atunci cheia
--               (source_alop_id) singură e PREA STRICTĂ pentru un index unic.
-- ----------------------------------------------------------------------------
SELECT
  o.source_alop_id,
  COUNT(*)                                                        AS nr_ord,
  COUNT(*) FILTER (WHERE o.flow_id IS NOT NULL)                   AS pe_flux,
  COUNT(DISTINCT o.nr_ordonant_pl)
    FILTER (WHERE o.nr_ordonant_pl IS NOT NULL
                AND o.nr_ordonant_pl <> '')                       AS nr_ord_distincte,
  COUNT(DISTINCT o.org_id)                                        AS org_uri,
  MIN(o.created_at)                                               AS primul,
  MAX(o.created_at)                                               AS ultimul,
  MAX(o.created_at) - MIN(o.created_at)                           AS interval_creare,
  array_agg(o.id      ORDER BY o.created_at)                      AS id_uri,
  array_agg(o.status  ORDER BY o.created_at)                      AS statusuri
FROM formulare_ord o
WHERE o.source_alop_id IS NOT NULL
  AND o.deleted_at IS NULL
GROUP BY o.source_alop_id
HAVING COUNT(*) > 1
ORDER BY nr_ord DESC, ultimul DESC
LIMIT 50;


-- ----------------------------------------------------------------------------
-- BLOCUL 2c — semnătura de DUBLU-CLIC vs. ordonanțări legitime multiple.
-- Ce numără: perechile de ORD pe același ALOP create la mai puțin de 30 s una
--            de alta. 30 s = generos față de un dublu-clic (< 2 s), dar
--            suficient de scurt cât să excludă două ordonanțări introduse
--            deliberat de un om.
-- Interpretare: rândurile de aici sunt aproape sigur duplicate accidentale.
--               Grupurile din 2b care NU apar aici sunt probabil legitime.
-- ----------------------------------------------------------------------------
SELECT
  a.source_alop_id,
  a.id            AS ord_1,
  b.id            AS ord_2,
  a.created_at    AS creat_1,
  b.created_at    AS creat_2,
  b.created_at - a.created_at AS delta,
  a.nr_ordonant_pl AS nr_1,
  b.nr_ordonant_pl AS nr_2
FROM formulare_ord a
JOIN formulare_ord b
  ON b.source_alop_id = a.source_alop_id
 AND b.created_at > a.created_at
 AND b.created_at < a.created_at + INTERVAL '30 seconds'
WHERE a.source_alop_id IS NOT NULL
  AND a.deleted_at IS NULL
  AND b.deleted_at IS NULL
ORDER BY delta ASC
LIMIT 50;


-- ============================================================================
-- BLOCUL 3 — dosare ALOP potențial duplicate
-- ----------------------------------------------------------------------------
-- Depinde de: alop_instances.cancelled_at, .titlu (blocul 0).
--
-- FEREASTRA ALEASĂ: 60 de secunde.
--   De ce nu 2 s (durata unui dublu-clic): `createAlop` (alop.js:320) nu are
--   nicio gardă și nici feedback vizual, iar POST-ul include două SELECT-uri
--   preliminare (șablon org + nume user, alop.mjs:447-456) înainte de INSERT.
--   Pe o conexiune lentă, al doilea clic „de nerăbdare" vine la 5-20 s, nu la 2.
--   De ce nu 10 min: un utilizator poate crea legitim două dosare goale
--   consecutive (`titlu` default 'ALOP nou', alop.mjs:485) în câteva minute.
--   60 s prinde nerăbdarea, ratează munca deliberată.
--
-- Ce numără: perechi de ALOP-uri ale ACELUIAȘI creator, în aceeași organizație,
--            cu ACELAȘI titlu, la sub 60 s distanță.
-- Interpretare: fiecare rând e un candidat la duplicat accidental. Verifică
--               `df_1`/`df_2`: dacă unul e NULL, acela e dosarul orfan (candidat
--               la ștergere prin `cancelAlop`, care oricum refuză dacă are DF —
--               `cancel_blocked_df_exists`, alop.js:1143).
-- ============================================================================
SELECT
  a.org_id,
  a.created_by,
  a.titlu,
  a.id                          AS alop_1,
  b.id                          AS alop_2,
  a.created_at                  AS creat_1,
  b.created_at                  AS creat_2,
  b.created_at - a.created_at   AS delta,
  a.status                      AS status_1,
  b.status                      AS status_2,
  a.df_id                       AS df_1,
  b.df_id                       AS df_2
FROM alop_instances a
JOIN alop_instances b
  ON  b.org_id     = a.org_id
 AND  b.created_by = a.created_by
 AND  b.titlu      = a.titlu
 AND  b.created_at > a.created_at
 AND  b.created_at < a.created_at + INTERVAL '60 seconds'
WHERE a.cancelled_at IS NULL
  AND b.cancelled_at IS NULL
ORDER BY delta ASC
LIMIT 50;


-- ----------------------------------------------------------------------------
-- BLOCUL 3b — agregat ALOP: cât de răspândit e fenomenul?
-- Interpretare: `perechi` = numărul de duplicate probabile. Dacă e 0, opțiunea 3
--               din Secțiunea B a raportului (nicio cheie pe server) devine
--               rezonabilă. Dacă e mare, opțiunea 2 (cheie de idempotență) se
--               justifică.
-- ----------------------------------------------------------------------------
SELECT
  COUNT(*)                                                    AS perechi,
  COUNT(*) FILTER (WHERE b.df_id IS NULL)                     AS al_doilea_fara_df,
  COUNT(DISTINCT a.org_id)                                    AS organizatii_afectate,
  MIN(b.created_at - a.created_at)                            AS delta_min,
  MAX(b.created_at - a.created_at)                            AS delta_max
FROM alop_instances a
JOIN alop_instances b
  ON  b.org_id     = a.org_id
 AND  b.created_by = a.created_by
 AND  b.titlu      = a.titlu
 AND  b.created_at > a.created_at
 AND  b.created_at < a.created_at + INTERVAL '60 seconds'
WHERE a.cancelled_at IS NULL
  AND b.cancelled_at IS NULL;


-- ============================================================================
-- BLOCUL 4 — FLUXURI PARALELE pe același document (DF sau ORD)
-- ----------------------------------------------------------------------------
-- Depinde de: flows.deleted_at (blocul 0).
--
-- ⚠️ Predicatul „flux VIU" e refolosit VERBATIM din `liveFlowSql()`
--    (server/services/flow-provenance.mjs, sursă unică de la #122):
--        f.deleted_at IS NULL
--        AND f.data->>'status' IS DISTINCT FROM 'cancelled'
--        AND f.data->>'status' IS DISTINCT FROM 'refused'
--    Un flux ANULAT poate păstra `completed = true` în blob — de aceea NU se
--    filtrează pe `completed`, ci exact pe predicatul de mai sus. Dacă
--    `liveFlowSql` se schimbă vreodată, scriptul ăsta trebuie resincronizat.
--
-- Ce numără: documente (dfId/ordId din data->'meta') revendicate simultan de
--            ≥2 fluxuri VII.
-- Interpretare: fiecare rând e un caz real de „btnCreate apăsat de mai multe
--               ori" (sau reinițiere dublă). Corespunde clasei D din
--               flow-link-audit.mjs (#120) — dacă acel card arată 0 și scriptul
--               ăsta arată > 0, cele două definiții au driftat.
-- ============================================================================
SELECT
  m.tip,
  m.doc_id,
  COUNT(*)                                            AS fluxuri_vii,
  MIN(f.created_at)                                   AS primul,
  MAX(f.created_at)                                   AS ultimul,
  MAX(f.created_at) - MIN(f.created_at)               AS interval_creare,
  array_agg(f.id                ORDER BY f.created_at) AS flow_id_uri,
  array_agg(f.data->>'status'   ORDER BY f.created_at) AS statusuri
FROM flows f
CROSS JOIN LATERAL (VALUES
  ('df',  f.data->'meta'->>'dfId'),
  ('ord', f.data->'meta'->>'ordId')
) AS m(tip, doc_id)
WHERE m.doc_id IS NOT NULL
  AND f.deleted_at IS NULL
  AND f.data->>'status' IS DISTINCT FROM 'cancelled'
  AND f.data->>'status' IS DISTINCT FROM 'refused'
GROUP BY m.tip, m.doc_id
HAVING COUNT(*) > 1
ORDER BY fluxuri_vii DESC, ultimul DESC
LIMIT 50;


-- ----------------------------------------------------------------------------
-- BLOCUL 4b — agregat fluxuri paralele + semnătura de dublu-clic.
-- Interpretare: `sub_60s` = fluxuri paralele născute din clicuri repetate
--               (nu din reinițieri legitime, care sunt separate în timp).
--               Ăsta e numărul care măsoară direct problema raportată.
-- ----------------------------------------------------------------------------
SELECT
  COUNT(*)                                                      AS documente_cu_fluxuri_paralele,
  COALESCE(SUM(fluxuri_vii - 1), 0)                             AS fluxuri_in_exces,
  COUNT(*) FILTER (WHERE interval_creare < INTERVAL '60 seconds') AS sub_60s,
  COUNT(*) FILTER (WHERE interval_creare < INTERVAL '5 seconds')  AS sub_5s
FROM (
  SELECT
    m.tip, m.doc_id,
    COUNT(*)                              AS fluxuri_vii,
    MAX(f.created_at) - MIN(f.created_at) AS interval_creare
  FROM flows f
  CROSS JOIN LATERAL (VALUES
    ('df',  f.data->'meta'->>'dfId'),
    ('ord', f.data->'meta'->>'ordId')
  ) AS m(tip, doc_id)
  WHERE m.doc_id IS NOT NULL
    AND f.deleted_at IS NULL
    AND f.data->>'status' IS DISTINCT FROM 'cancelled'
    AND f.data->>'status' IS DISTINCT FROM 'refused'
  GROUP BY m.tip, m.doc_id
  HAVING COUNT(*) > 1
) g;


-- ============================================================================
-- BLOCUL 5 — reinițieri duble (`reinitiatedAs` necitit, lifecycle.mjs:131)
-- ----------------------------------------------------------------------------
-- Ce numără: fluxuri-părinte care au ≥2 copii (`data->>'parentFlowId'`).
-- Interpretare: > 0 confirmă empiric constatarea din raport — al doilea clic pe
--               „Reinițiază" chiar creează al doilea flux copil. Fixul #124f
--               (citirea lui `reinitiatedAs`) devine justificat cu date.
-- ============================================================================
SELECT
  f.data->>'parentFlowId'                              AS parinte,
  COUNT(*)                                             AS copii,
  MIN(f.created_at)                                    AS primul,
  MAX(f.created_at)                                    AS ultimul,
  MAX(f.created_at) - MIN(f.created_at)                AS interval_creare,
  array_agg(f.id ORDER BY f.created_at)                AS copii_id
FROM flows f
WHERE f.data->>'parentFlowId' IS NOT NULL
  AND f.deleted_at IS NULL
GROUP BY f.data->>'parentFlowId'
HAVING COUNT(*) > 1
ORDER BY copii DESC, ultimul DESC
LIMIT 50;


-- ============================================================================
-- BLOCUL 6 — poziții de registru duplicate (sursa_id mintit pe server)
-- ----------------------------------------------------------------------------
-- Ce numără: perechi de înregistrări manuale în același registru, aceeași
--            organizație, ACELAȘI obiect + expeditor, la sub 60 s distanță.
--            `sursa_tip = 'manual'` izolează exact calea `saveModal`
--            (registratura.mjs:203, unde sursa_id = randomUUID() server-side).
-- Interpretare: fiecare rând = două NUMERE DE REGISTRU consumate pentru un
--               singur document. Consecință juridică, nu cosmetică.
-- ============================================================================
SELECT
  a.org_id,
  a.registru,
  a.obiect,
  a.expeditor,
  a.numar_format              AS nr_1,
  b.numar_format              AS nr_2,
  a.created_at                AS creat_1,
  b.created_at                AS creat_2,
  b.created_at - a.created_at AS delta
FROM registru_intrari a
JOIN registru_intrari b
  ON  b.org_id     = a.org_id
 AND  b.registru   = a.registru
 AND  b.sursa_tip  = 'manual'
 AND  b.obiect     = a.obiect
 AND  b.expeditor  = a.expeditor
 AND  b.created_at > a.created_at
 AND  b.created_at < a.created_at + INTERVAL '60 seconds'
WHERE a.sursa_tip = 'manual'
ORDER BY delta ASC
LIMIT 50;


-- ============================================================================
-- BLOCUL 7 — atașamente duplicate (formular + flux)
-- ----------------------------------------------------------------------------
-- Ce numără: același fișier (nume + dimensiune) încărcat de ≥2 ori pe același
--            document/slot, respectiv pe același flux.
-- Interpretare: impact vizual, nu financiar. Alimentează decizia pe lotul #124i.
--               Atenție la fals-pozitive: copierea formular→flux
--               (`copyFormularAttachmentsToFlow`) DUPLICĂ intenționat bytes-ul
--               în `flow_attachments`, dar e idempotentă prin
--               `NOT EXISTS(flow_id, filename)` — deci un duplicat pe
--               `flow_attachments` cu același `filename` NU ar trebui să existe.
-- ============================================================================
SELECT 'formulare_atasamente' AS tabel,
       form_type::text        AS ctx_1,
       form_id::text          AS ctx_2,
       slot::text             AS ctx_3,
       filename,
       size_bytes,
       COUNT(*)               AS aparitii,
       MAX(created_at) - MIN(created_at) AS interval_incarcare
  FROM formulare_atasamente
 WHERE deleted_at IS NULL
 GROUP BY form_type, form_id, slot, filename, size_bytes
HAVING COUNT(*) > 1

UNION ALL

SELECT 'flow_attachments',
       flow_id,
       NULL,
       NULL,
       filename,
       size_bytes,
       COUNT(*),
       NULL
  FROM flow_attachments
 GROUP BY flow_id, filename, size_bytes
HAVING COUNT(*) > 1

ORDER BY aparitii DESC
LIMIT 50;


-- ============================================================================
-- INTERPRETARE FINALĂ — ce decid rezultatele
-- ============================================================================
--
-- BLOCUL 1 gol (indexul DF LIPSEȘTE)
--     ⇒ migrarea 095 a eșuat tăcut în producție. Rulează 1b, rezolvă manual
--       grupurile, apoi decide dacă recreezi indexul. DF e la fel de expus ca
--       ORD până atunci. Ăsta e cel mai prost rezultat posibil al scriptului.
--
-- BLOCUL 2 `grupuri_cu_duplicate` = 0
--     ⇒ ✅ indexul unic pe ORD (lotul #124e) SE POATE crea direct, fără
--       curățare prealabilă.
--
-- BLOCUL 2 `grupuri_cu_duplicate` > 0
--     ⇒ ⛔ indexul unic pe ORD **NU** se poate crea fără curățare prealabilă.
--       Migrarea ar cădea în `EXCEPTION WHEN unique_violation` (tiparul 095) și
--       ar lăsa poarta deschisă, tăcut. Ordinea corectă:
--         1. rulează 2b + 2c;
--         2. dacă în 2b `nr_ord_distincte > 1` pe multe grupuri ⇒ cheia
--            (source_alop_id) singură e PREA STRICTĂ — mai multe ordonanțări
--            legitime pe același dosar sunt un caz real (multi-ORD,
--            `alop_ord_cicluri`). Atunci NU face indexul; mergi doar pe
--            `SELECT` de dedup cu fereastră, sau pe cheie de idempotență;
--         3. dacă `nr_ord_distincte <= 1` și `pe_flux = 0` ⇒ duplicate
--            accidentale curate; soft-delete pe toate în afară de cel mai vechi
--            (tiparul din 095), APOI indexul.
--
-- BLOCUL 4b `sub_5s` > 0
--     ⇒ dovadă directă de dublu-clic pe `btnCreate`. Prioritizează #124c.
--
-- BLOCUL 5 > 0
--     ⇒ dovadă directă că `reinitiatedAs` nu protejează nimic. Justifică #124f.
--
-- BLOCUL 6 > 0
--     ⇒ numere de registru consumate degeaba. Justifică #124g.
--
-- ============================================================================
