-- ============================================================================
-- SQL-214 — starea 2FA și a Registraturii (16.09.2026)
-- DocFlowAI, producție. Q1, Q2, Q3 = DOAR SELECT. R1 = SCRIERE, doar la nevoie.
-- ⚠️ Consola Railway: câte o interogare pe execuție.
-- ============================================================================


-- ─── Q1 — cine are 2FA activat sau un secret generat ────────────────────────
-- Pagina de login NU are al doilea pas (codul TOTP). Un cont cu totp_enabled = true
-- NU se mai poate autentifica din interfață.
--   secret_generat = true, totp_enabled = false ⇒ setup început, neconfirmat: inofensiv.
--   totp_enabled = true ⇒ contul e blocat la login ⇒ R1.
SELECT u.id, u.email, u.role, u.org_id,
       u.totp_enabled,
       (u.totp_secret IS NOT NULL)                          AS secret_generat,
       COALESCE(array_length(u.totp_backup_codes, 1), 0)    AS coduri_backup
  FROM users u
 WHERE u.deleted_at IS NULL
   AND (u.totp_enabled OR u.totp_secret IS NOT NULL)
 ORDER BY u.totp_enabled DESC, u.email;


-- ─── R1 — DEBLOCARE (SCRIERE): dezactivează 2FA pe UN cont ──────────────────
-- Rulează DOAR dacă Q1 arată totp_enabled = true pe un cont care trebuie să se logheze.
-- Înlocuiește emailul. Fără backup necesar: sunt trei coloane ale unui singur utilizator,
-- iar starea veche (2FA activ) e exact cea care blochează.
WITH upd AS (
  UPDATE users
     SET totp_enabled = false, totp_secret = NULL, totp_backup_codes = NULL
   WHERE lower(email) = lower('admin@docflowai.ro')
     AND deleted_at IS NULL
  RETURNING id, email, totp_enabled
)
SELECT * FROM upd;


-- ─── Q2 — Registratură: toate setările modulului, pe orice nivel ────────────
-- Modulul are default ACTIV în catalog. Un override poate fi pe org, pe compartiment
-- sau pe utilizator — toate contează pentru cine vede ecranul.
SELECT me.scope_type,
       me.scope_id,
       COALESCE(o.name, u.email, me.scope_id) AS tinta,
       me.enabled,
       me.set_at,
       sb.email                               AS setat_de
  FROM module_entitlements me
  LEFT JOIN organizations o ON me.scope_type = 'org'  AND o.id::text = me.scope_id
  LEFT JOIN users u         ON me.scope_type = 'user' AND u.id::text = me.scope_id
  LEFT JOIN users sb        ON sb.id = me.set_by
 WHERE me.module_key = 'registratura'
 ORDER BY me.scope_type, tinta;


-- ─── Q3 — câte numere s-au alocat, per organizație și lună ──────────────────
-- `iesire` = numere puse AUTOMAT pe fiecare flux creat (tipărite în subsolul PDF-ului
-- înainte de semnare). `intrare` = înregistrări făcute manual din ecranul Registratură.
-- Compară lunile de după `set_at` din Q2 cu cele dinainte.
SELECT o.name                                   AS organizatie,
       r.an,
       to_char(r.data_inreg, 'YYYY-MM')         AS luna,
       count(*) FILTER (WHERE r.directie = 'iesire')  AS numere_pe_fluxuri,
       count(*) FILTER (WHERE r.directie = 'intrare') AS intrari_manuale,
       min(r.numar_format)                      AS primul,
       max(r.numar_format)                      AS ultimul
  FROM registru_intrari r
  JOIN organizations o ON o.id = r.org_id
 GROUP BY o.name, r.an, to_char(r.data_inreg, 'YYYY-MM')
 ORDER BY o.name, luna;
