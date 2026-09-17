-- ============================================================================
-- PROCEDURĂ: ANULAREA UNUI DOSAR ALOP GREȘIT / ABANDONAT
-- DocFlowAI · Railway → Postgres → Database → Data (consola SQL)
-- ============================================================================
--
-- CÂND O FOLOSEȘTI
--   Un dosar ALOP a fost deschis greșit sau a fost abandonat (ex.: DF-ul a fost neaprobat, iar
--   inițiatorul a deschis alt dosar în loc să facă revizie). Butonul „Șterge" din aplicație nu
--   merge, fiindcă dosarul are un DF legat.
--
-- CE FACE
--   Dosarul devine „Anulat": dispare din lista ALOP și nu mai poate fi deschis sau folosit.
--   DF-urile lui dispar din lista DF. Nimic nu se șterge definitiv: datele, fluxurile și jurnalul
--   rămân în bază.
--
-- CE NU POATE FACE (procedura refuză singură)
--   Dosare trecute de angajare, cu ORD, cu un DF aprobat sau cu un DF pe flux în curs de semnare.
--
-- ÎNAINTE DE ORICE
--   Confirmă cu inițiatorul că dosarul e greșit și că nu mai are nimic de preluat din el.
--
-- ⚠️ CONSOLA RAILWAY RULEAZĂ O SINGURĂ INTEROGARE ODATĂ.
--    Copiezi DOAR blocul pasului (de la primul rând până la „;" inclusiv), îl rulezi, citești
--    rezultatul, apoi treci la pasul următor.
-- ============================================================================



-- ████████████████████████████████████████████████████████████████████████████
-- PASUL 1 — GĂSEȘTE DOSARUL ȘI COPIAZĂ-I ID-UL                     (doar citire)
-- ████████████████████████████████████████████████████████████████████████████
-- Listează dosarele active care n-au mers mai departe de angajare și nu au nimic aprobat.
-- Caută dosarul după titlu / inițiator. Coloana „pereche" arată dacă același inițiator are un
-- dosar asemănător (cel corect, de obicei).
-- ➜ Copiază valoarea din ULTIMA coloană, `alop_id` (ex.: 36f523c6-9a5a-4fc3-9206-1d89d6f71519).

WITH df_stare AS (
  SELECT fd.source_alop_id AS alop_id,
         count(*) AS revizii,
         string_agg(DISTINCT COALESCE(fd.nr_unic_inreg, '(fără nr)'), ', ') AS nr_df,
         bool_or(COALESCE(f.data->>'status','') = 'completed'
                 OR COALESCE(f.data->>'completed','') = 'true') AS are_aprobata,
         bool_or(f.id IS NOT NULL AND f.deleted_at IS NULL
                 AND COALESCE(f.data->>'status','') NOT IN ('completed','refused','cancelled','rejected')
                 AND COALESCE(f.data->>'completed','') <> 'true') AS are_flux_in_curs,
         max(fd.updated_at) AS ultima_activitate_df
    FROM formulare_df fd
    LEFT JOIN flows f ON f.id::text = fd.flow_id
   WHERE fd.deleted_at IS NULL AND fd.source_alop_id IS NOT NULL
   GROUP BY fd.source_alop_id
)
SELECT a.titlu,
       COALESCE(u.nume, u.email)                                   AS initiator,
       a.status,
       s.nr_df,
       s.revizii,
       a.valoare_totala,
       GREATEST(a.updated_at, s.ultima_activitate_df)::date        AS ultima_activitate,
       a.created_at::date                                          AS creat_la,
       (b.id IS NOT NULL)                                          AS dublura_probabila,
       CASE WHEN b.id IS NOT NULL
            THEN left(b.titlu, 40) || ' · ' || b.status || ' · creat ' || to_char(b.created_at, 'DD.MM.YYYY')
                 || CASE WHEN b.created_at > a.created_at THEN ' (mai nou)' ELSE ' (mai vechi)' END
       END                                                         AS pereche,
       a.id                                                        AS alop_id
  FROM alop_instances a
  JOIN df_stare s   ON s.alop_id = a.id
  LEFT JOIN users u ON u.id = a.created_by
  LEFT JOIN LATERAL (
    SELECT b.id, b.titlu, b.status, b.created_at
      FROM alop_instances b
     WHERE b.org_id = a.org_id
       AND b.created_by = a.created_by
       AND b.id <> a.id
       AND b.cancelled_at IS NULL
       AND (b.valoare_totala = a.valoare_totala
            OR lower(left(b.titlu, 25)) = lower(left(a.titlu, 25)))
     ORDER BY abs(extract(epoch FROM (b.created_at - a.created_at)))
     LIMIT 1
  ) b ON TRUE
 WHERE a.cancelled_at IS NULL
   AND a.status IN ('draft','angajare')
   AND a.ord_id IS NULL
   AND NOT s.are_aprobata
   AND NOT s.are_flux_in_curs
 ORDER BY dublura_probabila DESC, ultima_activitate;



-- ████████████████████████████████████████████████████████████████████████████
-- ÎNAINTE DE PAȘII 2, 3, 4:
--   În pașii de mai jos apare de mai multe ori id-ul fals
--       00000000-0000-0000-0000-000000000000
--   Înlocuiește-l PESTE TOT (în pașii 2, 3 și 4) cu id-ul copiat la pasul 1.
--   Cel mai simplu: în editor, Find & Replace (Ctrl+H) pe tot fișierul, apoi copiezi pașii.
-- ████████████████████████████████████████████████████████████████████████████



-- ████████████████████████████████████████████████████████████████████████████
-- PASUL 2 — VERIFICĂ DACĂ DOSARUL POATE FI ANULAT                   (doar citire)
-- ████████████████████████████████████████████████████████████████████████████
-- Uită-te la ultima coloană, `verdict`:
--   POATE_FI_ANULAT  ➜ mergi la pasul 3.
--   REFUZ: ...        ➜ OPREȘTE-TE. Dosarul nu se anulează cu această procedură (motivul e scris).
--   DEJA_ANULAT       ➜ nimic de făcut.
--   niciun rând       ➜ id-ul e greșit (verifică înlocuirea).

SELECT a.titlu,
       a.status,
       (a.ord_id IS NOT NULL)                                             AS are_ord,
       (SELECT count(*) FROM formulare_df fd
         WHERE fd.source_alop_id = a.id AND fd.deleted_at IS NULL)         AS revizii_df,
       (SELECT string_agg(COALESCE(fd.nr_unic_inreg,'(fără nr)') || ' R' || fd.revizie_nr
                          || ' ' || fd.status || ' / flux: ' || COALESCE(f.data->>'status','—'), ' | ')
          FROM formulare_df fd LEFT JOIN flows f ON f.id::text = fd.flow_id
         WHERE fd.source_alop_id = a.id AND fd.deleted_at IS NULL)         AS detalii_df,
       CASE
         WHEN a.cancelled_at IS NOT NULL                     THEN 'DEJA_ANULAT'
         WHEN a.status NOT IN ('draft','angajare')           THEN 'REFUZ: faza ' || a.status
         WHEN a.ord_id IS NOT NULL                           THEN 'REFUZ: are ORD'
         WHEN EXISTS (SELECT 1 FROM formulare_df fd JOIN flows f ON f.id::text = fd.flow_id
                       WHERE fd.source_alop_id = a.id AND fd.deleted_at IS NULL
                         AND (COALESCE(f.data->>'status','') = 'completed'
                              OR COALESCE(f.data->>'completed','') = 'true'))
                                                             THEN 'REFUZ: revizie DF aprobată'
         WHEN EXISTS (SELECT 1 FROM formulare_df fd JOIN flows f ON f.id::text = fd.flow_id
                       WHERE fd.source_alop_id = a.id AND fd.deleted_at IS NULL AND f.deleted_at IS NULL
                         AND COALESCE(f.data->>'status','') NOT IN ('completed','refused','cancelled','rejected')
                         AND COALESCE(f.data->>'completed','') <> 'true')
                                                             THEN 'REFUZ: DF pe flux în curs'
         WHEN EXISTS (SELECT 1 FROM formulare_df fd JOIN formulare_ord fo ON fo.df_id = fd.id
                       WHERE fd.source_alop_id = a.id AND fd.deleted_at IS NULL AND fo.deleted_at IS NULL)
                                                             THEN 'REFUZ: o revizie are ORD'
         ELSE 'POATE_FI_ANULAT'
       END                                                                 AS verdict
  FROM alop_instances a
 WHERE a.id = '00000000-0000-0000-0000-000000000000'::uuid;



-- ████████████████████████████████████████████████████████████████████████████
-- PASUL 3 — ANULEAZĂ                                                  (SCRIERE)
-- ████████████████████████████████████████████████████████████████████████████
-- ⛔ ÎNTÂI BACKUP: Railway → Postgres → Backups → creează un backup și așteaptă să se termine.
-- ⛔ Rulezi DOAR dacă pasul 2 a dat POATE_FI_ANULAT.
--
-- Rezultat corect: dosare_anulate = 1, revizii_sterse = revizii_existente, garda = 1.
-- Dacă apare eroarea „division by zero": NU s-a scris nimic (siguranța a oprit operația).
-- Nu repeta la întâmplare — trimite rezultatul pasului 2 pentru analiză.

WITH p AS (
  SELECT '00000000-0000-0000-0000-000000000000'::uuid AS alop_id
),
adm AS (
  SELECT id, email FROM users WHERE lower(email) = 'admin@docflowai.ro' LIMIT 1
),
tinta_alop AS (
  SELECT a.id
    FROM alop_instances a, p
   WHERE a.id = p.alop_id
     AND a.cancelled_at IS NULL
     AND a.status IN ('draft','angajare')
     AND a.ord_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM formulare_df fd JOIN flows f ON f.id::text = fd.flow_id
                      WHERE fd.source_alop_id = a.id AND fd.deleted_at IS NULL
                        AND (COALESCE(f.data->>'status','') = 'completed'
                             OR COALESCE(f.data->>'completed','') = 'true'
                             OR (f.deleted_at IS NULL
                                 AND COALESCE(f.data->>'status','') NOT IN ('refused','cancelled','rejected'))))
     AND NOT EXISTS (SELECT 1 FROM formulare_df fd JOIN formulare_ord fo ON fo.df_id = fd.id
                      WHERE fd.source_alop_id = a.id AND fd.deleted_at IS NULL AND fo.deleted_at IS NULL)
),
revizii_toate AS (
  SELECT fd.id FROM formulare_df fd, p
   WHERE fd.source_alop_id = p.alop_id AND fd.deleted_at IS NULL
),
del AS (
  UPDATE formulare_df fd
     SET deleted_at = NOW(), updated_at = NOW(), updated_by = (SELECT id FROM adm)
   WHERE fd.deleted_at IS NULL
     AND fd.source_alop_id IN (SELECT id FROM tinta_alop)
  RETURNING fd.id, fd.org_id, fd.status, fd.revizie_nr
),
aud AS (
  INSERT INTO formulare_audit (org_id, form_type, form_id, actor_id, actor_email, event_type, from_status, meta)
  SELECT d.org_id, 'df', d.id, (SELECT id FROM adm), (SELECT email FROM adm), 'sters', d.status,
         jsonb_build_object('motiv', 'SQL-220: dosar ALOP abandonat, anulat la cererea inițiatorului',
                            'revizie_nr', d.revizie_nr)
    FROM del d
  RETURNING form_id
),
canc AS (
  UPDATE alop_instances a
     SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW(), updated_by = (SELECT id FROM adm)
    FROM tinta_alop t
   WHERE a.id = t.id
  RETURNING a.id
)
SELECT (SELECT count(*) FROM canc)          AS dosare_anulate,
       (SELECT count(*) FROM del)           AS revizii_sterse,
       (SELECT count(*) FROM revizii_toate) AS revizii_existente,
       1 / (CASE WHEN (SELECT count(*) FROM canc) = 1
                  AND (SELECT count(*) FROM del) = (SELECT count(*) FROM revizii_toate)
                  AND (SELECT count(*) FROM aud) = (SELECT count(*) FROM del)
                  AND (SELECT count(*) FROM adm) = 1
             THEN 1 ELSE 0 END)             AS garda;



-- ████████████████████████████████████████████████████████████████████████████
-- PASUL 4 — VERIFICĂ REZULTATUL                                     (doar citire)
-- ████████████████████████████████████████████████████████████████████████████
-- Corect: rândul ALOP are status „cancelled" și o dată în „marcat_la"; fiecare rând DF are o
-- dată în „marcat_la" (= șters din liste). Gata.

SELECT 'ALOP' AS tip, a.titlu AS denumire, a.status, a.cancelled_at AS marcat_la, NULL::int AS rev
  FROM alop_instances a
 WHERE a.id = '00000000-0000-0000-0000-000000000000'::uuid
UNION ALL
SELECT 'DF', COALESCE(fd.nr_unic_inreg,'(fără nr)'), fd.status, fd.deleted_at, fd.revizie_nr
  FROM formulare_df fd
 WHERE fd.source_alop_id = '00000000-0000-0000-0000-000000000000'::uuid
 ORDER BY 1, 5;
