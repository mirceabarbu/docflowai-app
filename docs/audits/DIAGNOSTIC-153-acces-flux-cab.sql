-- =============================================================================
-- DIAGNOSTIC #153 — accesul la continutul fluxului derivat din DF/ORD (CAB)
--
-- STRICT READ-ONLY. Contine EXCLUSIV interogari SELECT.
-- Zero UPDATE / DELETE / INSERT / ALTER / CREATE.
--
-- Se ruleaza pe PRODUCTIE, in consola Railway (psql). Fiecare interogare are
-- antet care spune la ce intrebare raspunde. Trimite inapoi rezultatele in
-- ordinea Q1..Q6.
--
-- Model de acces existent (poarta isFlowAccessAllowed, server/services/flow-access.mjs):
--   (a) token de semnatar  (b) initiator = data->>'initEmail'
--   (c) semnatar           = data->'signers'[].email
--   (d) admin / org_admin din aceeasi organizatie
--   (e) destinatar repartizat (flow_recipients: user SAU compartiment)
-- Compartimentul CAB al organizatiei NU apare in lista de mai sus — de aici bug-ul.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Q1 — Cate organizatii au cab_compartiment setat si cati utilizatori ACTIVI
--      are fiecare in acel compartiment.
--      (organizations.cab_compartiment vs users.compartiment, users.deleted_at IS NULL)
--      Raspunde la punctul 1 din Etapa A.
--      Coloana users_cab = numarul de oameni pe care fixul ii atinge, per org.
-- -----------------------------------------------------------------------------
SELECT
  o.id                                   AS org_id,
  o.name                                 AS organizatie,
  NULLIF(TRIM(o.cab_compartiment), '')   AS cab_compartiment,
  COUNT(u.id)                            AS users_cab_activi,
  COUNT(u.id) FILTER (WHERE u.role IN ('admin','org_admin')) AS din_care_admini,
  COUNT(u.id) FILTER (WHERE u.role NOT IN ('admin','org_admin')) AS din_care_useri_simpli
FROM organizations o
LEFT JOIN users u
       ON u.org_id = o.id
      AND u.deleted_at IS NULL
      AND NULLIF(TRIM(u.compartiment), '') IS NOT NULL
      AND TRIM(u.compartiment) = TRIM(o.cab_compartiment)
WHERE NULLIF(TRIM(o.cab_compartiment), '') IS NOT NULL
GROUP BY o.id, o.name, o.cab_compartiment
ORDER BY users_cab_activi DESC, o.id;


-- -----------------------------------------------------------------------------
-- Q2 — Cate fluxuri (nesterse) sunt referite din formulare_df si cate din
--      formulare_ord, pe organizatie. Documente nesterse (deleted_at IS NULL).
--      Raspunde la punctul 2 din Etapa A.
--      flux_dedup = fluxuri distincte legate de CEL PUTIN un DF sau ORD
--      (un flux poate fi referit si de DF si de ORD; coloana nu dubleaza).
-- -----------------------------------------------------------------------------
WITH legate AS (
  SELECT fd.org_id, fd.flow_id, 'df'::text AS sursa
    FROM formulare_df fd
   WHERE fd.flow_id IS NOT NULL AND fd.deleted_at IS NULL
  UNION ALL
  SELECT fo.org_id, fo.flow_id, 'ord'::text
    FROM formulare_ord fo
   WHERE fo.flow_id IS NOT NULL AND fo.deleted_at IS NULL
)
SELECT
  o.id                                                       AS org_id,
  o.name                                                     AS organizatie,
  COUNT(*) FILTER (WHERE l.sursa = 'df')                     AS referinte_df,
  COUNT(*) FILTER (WHERE l.sursa = 'ord')                    AS referinte_ord,
  COUNT(DISTINCT l.flow_id)                                  AS fluxuri_distincte_legate,
  COUNT(DISTINCT l.flow_id) FILTER (WHERE f.id IS NOT NULL AND f.deleted_at IS NULL)
                                                             AS din_care_fluxuri_vii
FROM legate l
JOIN organizations o ON o.id = l.org_id
LEFT JOIN flows f    ON f.id = l.flow_id
GROUP BY o.id, o.name
ORDER BY fluxuri_distincte_legate DESC, o.id;


-- -----------------------------------------------------------------------------
-- Q3 — ***DELTA REALA*** (punctul 3 din Etapa A, cel important).
--      Pentru fiecare utilizator ACTIV din compartimentul CAB al organizatiei
--      lui, cate fluxuri legate de un DF/ORD din aceeasi organizatie NU ii sunt
--      accesibile azi pe niciuna dintre caile existente:
--        - nu e initiator (data->>'initEmail')
--        - nu e semnatar  (data->'signers'[].email)
--        - nu e destinatar repartizat (flow_recipients: pe user SAU pe compartiment)
--      Adminii si org_adminii sunt EXCLUSI: ei au deja acces same-org.
--      Coloana deschise_de_fix = exact multimea pe care o deschide #153.
-- -----------------------------------------------------------------------------
WITH cab_users AS (
  SELECT u.id AS user_id, LOWER(u.email) AS email, u.nume, u.org_id,
         TRIM(u.compartiment) AS comp
    FROM users u
    JOIN organizations o ON o.id = u.org_id
   WHERE u.deleted_at IS NULL
     AND u.role NOT IN ('admin','org_admin')
     AND NULLIF(TRIM(o.cab_compartiment), '') IS NOT NULL
     AND NULLIF(TRIM(u.compartiment), '')     IS NOT NULL
     AND TRIM(u.compartiment) = TRIM(o.cab_compartiment)
),
fluxuri_cu_doc AS (
  SELECT DISTINCT org_id, flow_id FROM (
    SELECT fd.org_id, fd.flow_id FROM formulare_df  fd
     WHERE fd.flow_id IS NOT NULL AND fd.deleted_at IS NULL
    UNION ALL
    SELECT fo.org_id, fo.flow_id FROM formulare_ord fo
     WHERE fo.flow_id IS NOT NULL AND fo.deleted_at IS NULL
  ) x
),
perechi AS (
  SELECT
    cu.user_id, cu.email, cu.nume, cu.org_id, cu.comp,
    f.id AS flow_id,
    (LOWER(COALESCE(f.data->>'initEmail','')) = cu.email) AS e_initiator,
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(f.data->'signers') = 'array'
                    THEN f.data->'signers' ELSE '[]'::jsonb END) s
       WHERE LOWER(COALESCE(s->>'email','')) = cu.email
    ) AS e_semnatar,
    EXISTS (
      SELECT 1
        FROM flow_recipients fr
       WHERE fr.flow_id = f.id
         AND ( fr.recipient_user_id = cu.user_id
            OR TRIM(COALESCE(fr.recipient_compartiment,'')) = cu.comp )
    ) AS e_destinatar
  FROM cab_users cu
  JOIN fluxuri_cu_doc fcd ON fcd.org_id = cu.org_id
  JOIN flows f            ON f.id = fcd.flow_id AND f.deleted_at IS NULL
)
SELECT
  org_id,
  user_id,
  nume,
  email,
  comp                                                    AS compartiment_cab,
  COUNT(*)                                                AS fluxuri_cu_df_sau_ord,
  COUNT(*) FILTER (WHERE e_initiator OR e_semnatar OR e_destinatar) AS deja_accesibile,
  COUNT(*) FILTER (WHERE NOT (e_initiator OR e_semnatar OR e_destinatar)) AS deschise_de_fix
FROM perechi
GROUP BY org_id, user_id, nume, email, comp
ORDER BY deschise_de_fix DESC, org_id, user_id;


-- -----------------------------------------------------------------------------
-- Q3b — Aceeasi delta, agregata pe organizatie (o singura cifra per institutie,
--       usor de citit). Aceleasi definitii ca Q3.
-- -----------------------------------------------------------------------------
WITH cab_users AS (
  SELECT u.id AS user_id, LOWER(u.email) AS email, u.org_id, TRIM(u.compartiment) AS comp
    FROM users u
    JOIN organizations o ON o.id = u.org_id
   WHERE u.deleted_at IS NULL
     AND u.role NOT IN ('admin','org_admin')
     AND NULLIF(TRIM(o.cab_compartiment), '') IS NOT NULL
     AND NULLIF(TRIM(u.compartiment), '')     IS NOT NULL
     AND TRIM(u.compartiment) = TRIM(o.cab_compartiment)
),
fluxuri_cu_doc AS (
  SELECT DISTINCT org_id, flow_id FROM (
    SELECT fd.org_id, fd.flow_id FROM formulare_df  fd
     WHERE fd.flow_id IS NOT NULL AND fd.deleted_at IS NULL
    UNION ALL
    SELECT fo.org_id, fo.flow_id FROM formulare_ord fo
     WHERE fo.flow_id IS NOT NULL AND fo.deleted_at IS NULL
  ) x
)
SELECT
  o.id   AS org_id,
  o.name AS organizatie,
  COUNT(DISTINCT cu.user_id) AS useri_cab,
  COUNT(*) FILTER (WHERE NOT (
      LOWER(COALESCE(f.data->>'initEmail','')) = cu.email
   OR EXISTS (SELECT 1 FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof(f.data->'signers') = 'array'
                     THEN f.data->'signers' ELSE '[]'::jsonb END) s
               WHERE LOWER(COALESCE(s->>'email','')) = cu.email)
   OR EXISTS (SELECT 1 FROM flow_recipients fr
               WHERE fr.flow_id = f.id
                 AND (fr.recipient_user_id = cu.user_id
                   OR TRIM(COALESCE(fr.recipient_compartiment,'')) = cu.comp))
  )) AS perechi_user_flux_deschise_de_fix
FROM cab_users cu
JOIN organizations o    ON o.id = cu.org_id
JOIN fluxuri_cu_doc fcd ON fcd.org_id = cu.org_id
JOIN flows f            ON f.id = fcd.flow_id AND f.deleted_at IS NULL
GROUP BY o.id, o.name
ORDER BY perechi_user_flux_deschise_de_fix DESC, o.id;


-- -----------------------------------------------------------------------------
-- Q4 — Cate fluxuri VII ale organizatiei NU au niciun DF/ORD atasat.
--      Aceasta este multimea care ramane, CORECT, inchisa pentru CAB.
--      Raspunde la punctul 4 din Etapa A. Raportul cele-doua-coloane arata
--      cat de mare ar fi fost gaura daca faceam o ramura pe rol in flow-access.
--      NOTA: fluxurile cu org_id NULL (legacy) sunt numarate separat in Q5.
-- -----------------------------------------------------------------------------
WITH fluxuri_cu_doc AS (
  SELECT DISTINCT flow_id FROM (
    SELECT fd.flow_id FROM formulare_df  fd WHERE fd.flow_id IS NOT NULL AND fd.deleted_at IS NULL
    UNION ALL
    SELECT fo.flow_id FROM formulare_ord fo WHERE fo.flow_id IS NOT NULL AND fo.deleted_at IS NULL
  ) x
)
SELECT
  o.id   AS org_id,
  o.name AS organizatie,
  COUNT(*)                                                     AS fluxuri_vii_total,
  COUNT(*) FILTER (WHERE fcd.flow_id IS NOT NULL)              AS cu_df_sau_ord_se_deschid,
  COUNT(*) FILTER (WHERE fcd.flow_id IS NULL)                  AS fara_df_ord_raman_inchise,
  ROUND(100.0 * COUNT(*) FILTER (WHERE fcd.flow_id IS NULL) / NULLIF(COUNT(*),0), 1)
                                                               AS pct_raman_inchise
FROM flows f
JOIN organizations o        ON o.id = f.org_id
LEFT JOIN fluxuri_cu_doc fcd ON fcd.flow_id = f.id
WHERE f.deleted_at IS NULL
GROUP BY o.id, o.name
ORDER BY fluxuri_vii_total DESC, o.id;


-- -----------------------------------------------------------------------------
-- Q5 — Igiena datelor, pentru a sti daca cifrele de mai sus au gauri:
--      (a) fluxuri vii fara org_id (legacy) — nu apar in Q4;
--      (b) referinte flow_id din formulare care nu au flux corespondent;
--      (c) referinte in care org-ul formularului difera de org-ul fluxului
--          (daca exista, ramura noua — scopata pe org-ul actorului — le refuza).
-- -----------------------------------------------------------------------------
SELECT 'a_fluxuri_vii_fara_org_id' AS verificare, COUNT(*)::text AS valoare
  FROM flows f WHERE f.deleted_at IS NULL AND f.org_id IS NULL
UNION ALL
SELECT 'b_referinte_df_fara_flux', COUNT(*)::text
  FROM formulare_df fd
 WHERE fd.flow_id IS NOT NULL AND fd.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM flows f WHERE f.id = fd.flow_id)
UNION ALL
SELECT 'b_referinte_ord_fara_flux', COUNT(*)::text
  FROM formulare_ord fo
 WHERE fo.flow_id IS NOT NULL AND fo.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM flows f WHERE f.id = fo.flow_id)
UNION ALL
SELECT 'c_df_org_diferit_de_flux_org', COUNT(*)::text
  FROM formulare_df fd JOIN flows f ON f.id = fd.flow_id
 WHERE fd.deleted_at IS NULL AND f.org_id IS NOT NULL AND f.org_id <> fd.org_id
UNION ALL
SELECT 'c_ord_org_diferit_de_flux_org', COUNT(*)::text
  FROM formulare_ord fo JOIN flows f ON f.id = fo.flow_id
 WHERE fo.deleted_at IS NULL AND f.org_id IS NOT NULL AND f.org_id <> fo.org_id;


-- -----------------------------------------------------------------------------
-- Q6 — Control de coerenta pe compartimente: cate valori distincte de
--      users.compartiment exista per organizatie si care dintre ele se
--      potrivesc EXACT (case-sensitive, asa cum compara isCabDept) cu
--      organizations.cab_compartiment. Daca apare o valoare care difera doar
--      prin litere mari/mici sau diacritice, oamenii aceia NU sunt vazuti ca CAB
--      nici azi, nici dupa fix — si asta ar explica un raport de tip
--      "tot nu merge la X".
-- -----------------------------------------------------------------------------
SELECT
  o.id   AS org_id,
  o.name AS organizatie,
  NULLIF(TRIM(o.cab_compartiment),'') AS cab_compartiment_org,
  TRIM(u.compartiment)                AS compartiment_user,
  COUNT(*)                            AS useri_activi,
  (TRIM(u.compartiment) = TRIM(o.cab_compartiment))                     AS potrivire_exacta,
  (LOWER(TRIM(u.compartiment)) = LOWER(TRIM(o.cab_compartiment)))       AS potrivire_case_insensitive
FROM users u
JOIN organizations o ON o.id = u.org_id
WHERE u.deleted_at IS NULL
  AND NULLIF(TRIM(o.cab_compartiment),'') IS NOT NULL
  AND NULLIF(TRIM(u.compartiment),'')     IS NOT NULL
  AND LOWER(TRIM(u.compartiment)) = LOWER(TRIM(o.cab_compartiment))
GROUP BY o.id, o.name, o.cab_compartiment, TRIM(u.compartiment)
ORDER BY o.id, useri_activi DESC;
