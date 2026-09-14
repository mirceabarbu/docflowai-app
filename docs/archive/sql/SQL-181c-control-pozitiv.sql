-- ============================================================================
-- SQL-181c — CONTROL POZITIV pentru zerourile de la 181b
--
-- READ-ONLY. Un pas pe execuție.
--
-- De ce: 181b a întors 0 evenimente și NULL la ultima_activitate pentru TOȚI cei
-- șase, iar interogarea pe semnatari a întors 0 rânduri. Un zero atât de curat
-- poate însemna două lucruri complet diferite:
--   (a) conturile chiar n-au fost folosite niciodată     → poarta e gratuită
--   (b) filtrul nu prinde nimic, pentru nimeni            → măsurătoarea e mută
-- Fără pașii de mai jos nu se poate spune care dintre ele. (Exact capcana în
-- care am căzut la P0-06 pe 28.08: zero evenimente însemna „codul nu s-a
-- executat", nu „invariantul a ținut".)
-- ============================================================================

-- PASUL 1 — audit_log leagă în general evenimente de utilizatori reali?
--           Dacă `utilizatori_cu_audit` e ~0, coloana nu se populează cu emailuri
--           de utilizatori și PASUL 1 din 181b nu dovedește nimic.
SELECT
  (SELECT count(*) FROM audit_log)                            AS evenimente_total,
  (SELECT count(DISTINCT actor_email) FROM audit_log
     WHERE actor_email IS NOT NULL)                           AS emailuri_distincte_in_audit,
  (SELECT count(*) FROM users u
     WHERE u.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM audit_log a WHERE a.actor_email = u.email))
                                                              AS utilizatori_cu_audit,
  (SELECT count(*) FROM users WHERE deleted_at IS NULL)       AS utilizatori_activi;

-- PASUL 2 — aceeași interogare ca 181b, dar pe TOȚI utilizatorii activi.
--           Dacă și aici toată lumea e pe zero, problema e măsurătoarea.
--           Dacă majoritatea au evenimente și doar cei 6 sunt pe zero, zeroul e real.
SELECT u.id, u.email, u.force_password_change AS steag,
       count(a.id)      AS evenimente_total,
       max(a.created_at) AS ultima_activitate
FROM users u
LEFT JOIN audit_log a ON a.actor_email = u.email
WHERE u.deleted_at IS NULL
GROUP BY u.id, u.email, u.force_password_change
ORDER BY evenimente_total DESC, u.id;

-- PASUL 3 — control pozitiv pentru interogarea pe semnatari:
--           containment-ul pe `signers` prinde pe cineva, oricine?
SELECT count(DISTINCT u.email) AS utilizatori_gasiti_ca_semnatari
FROM users u
JOIN flows f
  ON f.data->'signers' @> jsonb_build_array(jsonb_build_object('email', u.email))
WHERE u.deleted_at IS NULL
  AND f.deleted_at IS NULL;

-- ============================================================================
-- INTERPRETARE
--
--  PASUL 1: utilizatori_cu_audit ≈ 0        → măsurătoarea 181b e MUTĂ, se reia altfel
--  PASUL 2: majoritatea au evenimente,
--           cei 6 sunt singurii pe zero      → zeroul e REAL: conturi provizionate,
--                                              niciodată folosite
--  PASUL 3: 0                                → containment-ul nu funcționează, iar
--                                              „0 fluxuri ca semnatar" nu dovedea nimic
-- ============================================================================
