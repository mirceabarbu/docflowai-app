-- ============================================================================
-- SQL-181b — sunt vii cele 6 conturi cu force_password_change?
--
-- READ-ONLY. Se rulează în consola Railway (Database → Data), un pas pe execuție.
--
-- De ce e nevoie: nu există coloană `last_login` și loginul NU scrie în audit_log,
-- deci „s-au logat?" nu se poate afla direct. Se afla însă „au FĂCUT ceva?" —
-- orice acțiune auditată poartă `actor_email`, iar tabela are index pe el.
--
-- Întrebarea la care răspunde: dacă poarta se aplică pe server, cine dintre cei
-- 6 se lovește de ea în prima zi de lucru?
-- ============================================================================

-- PASUL 1 — ultima activitate auditată a fiecăruia dintre cei 6
SELECT u.id,
       u.email,
       u.created_at                                   AS cont_creat,
       count(a.id)                                    AS evenimente_total,
       count(a.id) FILTER (WHERE a.created_at > NOW() - INTERVAL '30 days')  AS ev_30z,
       max(a.created_at)                              AS ultima_activitate
FROM users u
LEFT JOIN audit_log a ON a.actor_email = u.email
WHERE u.deleted_at IS NULL
  AND u.force_password_change
GROUP BY u.id, u.email, u.created_at
ORDER BY ultima_activitate DESC NULLS LAST;

-- PASUL 2 — control: aceiași 6 apar ca semnatari în fluxuri vii?
--           (un cont care semnează e cont viu, chiar dacă n-a produs audit propriu)
SELECT u.email,
       count(*) AS fluxuri_in_care_apare_ca_semnatar
FROM users u
JOIN flows f
  ON f.data->'signers' @> jsonb_build_array(jsonb_build_object('email', u.email))
WHERE u.deleted_at IS NULL
  AND u.force_password_change
  AND f.deleted_at IS NULL
  AND (f.data->>'status') IS DISTINCT FROM 'cancelled'
GROUP BY u.email
ORDER BY 2 DESC;

-- ============================================================================
-- INTERPRETARE
--
--  ultima_activitate NULL / foarte veche pentru toți 6
--      → conturi care n-au fost folosite niciodată cu parola resetată.
--        Poarta se poate aplica fără să anunți pe nimeni; cel mult, dezactivezi
--        conturile care oricum nu se mai folosesc.
--
--  1-2 activi
--      → îi anunți pe ei, personal, înainte de deploy. Un minut de telefon.
--
--  4-6 activi
--      → poarta se aplică, dar OBLIGATORIU cu ecranul care se impune singur
--        (frontendul trebuie să prindă codul nou și să deschidă modalul de
--        schimbare a parolei), altfel oamenii văd erori fără să înțeleagă de ce.
--        Atunci lotul are DOUĂ etape, nu una, și atinge si `public/`.
-- ============================================================================
