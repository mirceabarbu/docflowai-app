-- ============================================================================
-- SQL-181 — măsurătoare READ-ONLY înainte de a aplica force_password_change
--            pe server (lot viitor). NU modifică nimic.
--
-- Se rulează în consola Railway (Database → Data). Fiecare pas SEPARAT.
-- Consola adaugă automat LIMIT la finalul interogării — inofensiv peste SELECT.
--
-- Întrebarea la care răspunde: dacă aplicăm steagul pe server (blocare până la
-- schimbarea parolei), câți oameni sunt blocați în prima secundă?
-- ============================================================================

-- PASUL 1 — câte conturi ACTIVE au steagul pus
SELECT
  count(*) FILTER (WHERE force_password_change)                        AS cu_steag,
  count(*) FILTER (WHERE NOT force_password_change OR force_password_change IS NULL) AS fara_steag,
  count(*)                                                             AS total_active
FROM users
WHERE deleted_at IS NULL;

-- PASUL 2 — cine sunt, ca să se vadă dacă e vorba de conturi vii sau de rămășițe
--           de la provizionare. `last_login` poate lipsi ca nume de coloană:
--           dacă întoarce eroare, scoate coloana din SELECT și rulează din nou.
SELECT id, email, role, org_id, created_at
FROM users
WHERE deleted_at IS NULL
  AND force_password_change
ORDER BY created_at DESC;

-- PASUL 3 — steagul pus pe conturi care s-au și logat de atunci
--           (dacă un cont are token_version > 1 și steagul încă pus, înseamnă
--            că steagul supraviețuiește unei resetări fără schimbare de parolă)
SELECT count(*) AS cu_steag_si_sesiuni_reciclate
FROM users
WHERE deleted_at IS NULL
  AND force_password_change
  AND COALESCE(token_version, 1) > 1;

-- ============================================================================
-- INTERPRETARE
--
--  cu_steag = 0        → aplicarea pe server e gratuită; nimeni nu e blocat.
--                        Lotul devine mecanic.
--  cu_steag mic (1-5)  → se aplică, dar se anunță oamenii înainte, sau se șterge
--                        steagul pentru conturile care nu-l mai justifică.
--  cu_steag mare       → aplicarea pe server, fără un ecran de schimbare a
--                        parolei care să se impună singur, blochează instituția
--                        luni dimineață. Atunci ordinea corectă e invers:
--                        întâi ecranul, apoi poarta.
-- ============================================================================
