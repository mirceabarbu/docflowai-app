/**
 * DocFlowAI — Admin Users & GWS routes
 * Extras din admin.mjs (etapa 4b.1).
 *
 * Endpoints:
 *   GET    /users                          — useri din aceeași instituție (pentru dropdown semnatari)
 *   GET    /api/org/profile                — profil organizație pentru utilizatorul curent
 *   GET    /admin/users                    — lista utilizatori (admin/org_admin)
 *   POST   /admin/users                    — creare utilizator + GWS provisioning opțional
 *   GET    /admin/gws/preview-email        — preview email GWS înainte de creare
 *   POST   /admin/users/:id/gws-provision  — (re)provision cont Workspace
 *   GET    /admin/gws/verify               — testează conectivitatea cu Workspace
 *   POST   /admin/users/bulk-import        — import CSV utilizatori
 *   PUT    /admin/users/:id               — actualizare utilizator
 *   POST   /admin/users/:id/reset-password — resetare parolă
 *   DELETE /admin/users/:id               — ștergere utilizator
 *   PUT    /admin/users/:id/assign-org    — asignează organizație (super-admin only)
 *   POST   /admin/users/:id/send-credentials — retrimite credențiale
 */

import { Router } from 'express';
import { csrfMiddleware } from '../../middleware/csrf.mjs';
import crypto from 'crypto';
import { emailResetPassword, emailCredentials } from '../../emailTemplates.mjs';
import { requireAuth, hashPassword, generatePassword, escHtml } from '../../middleware/auth.mjs';
import { pool, requireDb, invalidateOrgUserCache } from '../../db/index.mjs';
import {
  validateLeaveSettings, setUserLeave, clearUserLeave, getLeaveInfo, batchGetLeaveInfo,
} from '../../services/user-leave.mjs';
import { validatePhone } from '../../whatsapp.mjs';
import { sendSignerEmail } from '../../mailer.mjs';
import { gwsIsConfigured, findAvailableEmail, provisionGwsUser, verifyGws, buildLocalPart } from '../../gws.mjs';
import { logger } from '../../middleware/logger.mjs';
import { isAdminOrOrgAdmin, getAppUrl } from './_helpers.mjs';

const router = Router();

// ── Users ──────────────────────────────────────────────────────────────────
// GET /users — returneaza useri din aceeasi institutie ca utilizatorul logat
// Folosit de initiator pentru dropdown semnatari
router.get('/users', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    // Citim institutia din DB (nu din JWT care poate fi vechi)
    const { rows: selfRows } = await pool.query('SELECT institutie FROM users WHERE email=$1', [actor.email.toLowerCase()]);
    const institutie = (selfRows[0]?.institutie || actor.institutie || '').trim();

    let query, params;
    if (institutie) {
      // Filtreaza pe institutie — userii din aceeasi institutie
      query = 'SELECT id,email,nume,functie,institutie,compartiment,org_id FROM users WHERE institutie=$1 ORDER BY nume ASC';
      params = [institutie];
    } else {
      // User fara institutie (ex: admin global) — vede toti userii din org
      const orgId = actor.orgId || null;
      if (orgId) {
        query = 'SELECT id,email,nume,functie,institutie,compartiment,org_id FROM users WHERE org_id=$1 ORDER BY nume ASC';
        params = [orgId];
      } else {
        query = 'SELECT id,email,nume,functie,institutie,compartiment,org_id FROM users ORDER BY nume ASC';
        params = [];
      }
    }
    const { rows } = await pool.query(query, params);

    // BLOC 4.1: îmbogățește fiecare user cu info concediu/delegare
    const userIds = rows.map(u => u.id).filter(Boolean);
    const leaveMap = await batchGetLeaveInfo(userIds);
    const enriched = rows.map(u => ({
      ...u,
      leave: leaveMap.get(u.id) || null,
    }));
    res.json(enriched);
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

// ── GET /api/org/profile — profil organizație pentru utilizatorul curent ──
// Accesibil oricărui utilizator autentificat — returnează org proprie.
// Folosit de formulare.html pentru auto-fill instituție + CIF + compartimente.
router.get('/api/org/profile', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    // PERF-FIX: org_id disponibil direct din JWT — fără query DB suplimentar
    const orgId = actor.orgId || null;
    if (!orgId) return res.json({ ok: true, org: null });

    const [orgResult, compResult] = await Promise.allSettled([
      pool.query('SELECT id, name, cif, compartimente FROM organizations WHERE id=$1', [orgId]),
      pool.query(
        `SELECT DISTINCT compartiment FROM users
         WHERE org_id=$1 AND compartiment IS NOT NULL AND compartiment <> ''
         ORDER BY compartiment ASC`,
        [orgId]
      ),
    ]);
    if (orgResult.status === 'rejected') throw orgResult.reason;
    if (!orgResult.value.rows.length) return res.json({ ok: true, org: null });
    const org = orgResult.value.rows[0];
    org.compartimente_utilizatori = compResult.status === 'fulfilled'
      ? compResult.value.rows.map(r => r.compartiment)
      : [];
    res.json({ ok: true, org });
  } catch(e) {
    logger.error({ err: e }, '/api/org/profile error');
    res.status(500).json({ error: 'server_error' });
  }
});

router.get('/admin/users', async (req, res) => {
  if (requireDb(res)) return;
  const user = requireAuth(req, res); if (!user) return;
  if (!isAdminOrOrgAdmin(user)) return res.status(403).json({ error: 'forbidden' });
  try {
    // Citim orgId din DB — JWT poate fi vechi
    const { rows: selfRows } = await pool.query('SELECT org_id FROM users WHERE email=$1', [user.email.toLowerCase()]);
    const orgId = selfRows[0]?.org_id || null;
    // org_admin TREBUIE să aibă org_id setat — altfel nu poate accesa
    if (user.role === 'org_admin' && !orgId) return res.status(403).json({ error: 'org_admin_no_org', message: 'Contul de Administrator Instituție nu are o organizație asociată. Contactați super-administratorul.' });
    let query, params;
    // FIX: role='admin' (super-admin) vede TOȚI userii indiferent de org_id propriu.
    // Filtrarea pe org_id se aplică DOAR pentru org_admin.
    if (user.role === 'org_admin' && orgId) {
      query = 'SELECT id,email,nume,prenume,nume_familie,functie,institutie,compartiment,role,phone,notif_inapp,notif_email,notif_whatsapp,created_at,org_id,personal_email,gws_email,gws_status,gws_provisioned_at,gws_error FROM users WHERE org_id=$1 ORDER BY institutie ASC, compartiment ASC, nume ASC';
      params = [orgId];
    } else {
      // admin (super-admin) — vede toți userii din toate organizațiile
      query = 'SELECT id,email,nume,prenume,nume_familie,functie,institutie,compartiment,role,phone,notif_inapp,notif_email,notif_whatsapp,created_at,org_id,personal_email,gws_email,gws_status,gws_provisioned_at,gws_error FROM users ORDER BY institutie ASC, compartiment ASC, nume ASC';
      params = [];
    }
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch(e) { logger.error({ err: e }, 'GET /admin/users error:'); res.status(500).json({ error: 'server_error' }); }
});

router.post('/admin/users', csrfMiddleware, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });

  const {
    email, password, nume, prenume, nume_familie,
    functie, institutie, compartiment, role, phone,
    notif_inapp, notif_email, notif_whatsapp, skip_verification,
    personal_email,
    create_gws, force_password_change, gws_as_login, org_name: bodyOrgName,
  } = req.body || {};

  const numeComplet = (prenume && nume_familie)
    ? `${nume_familie.trim()} ${prenume.trim()}`
    : (nume || '').trim();

  if (!numeComplet) return res.status(400).json({ error: 'email_and_nume_required' });

  // Dacă gws_as_login=true, emailul de login va fi setat după provision (nu e furnizat de admin)
  // Dacă nu, emailul trebuie furnizat explicit
  if (!gws_as_login && !email) return res.status(400).json({ error: 'email_and_nume_required' });

  const prn = (prenume || numeComplet.split(' ')[0] || '').trim();
  const fam = (nume_familie || numeComplet.split(' ').slice(1).join('') || '').trim();

  // Dacă gws_as_login, determinăm emailul disponibil ÎNAINTE de INSERT
  let loginEmail = email ? email.trim().toLowerCase() : null;
  let previewGwsEmail = null;
  if (gws_as_login && create_gws) {
    if (!gwsIsConfigured()) return res.status(503).json({ error: 'gws_not_configured' });
    if (!prn && !fam) return res.status(400).json({ error: 'gws_email_required' });
    try {
      previewGwsEmail = await findAvailableEmail(prn, fam);
      loginEmail = previewGwsEmail;
    } catch(e) {
      return res.status(400).json({ error: 'gws_email_required', detail: e.message });
    }
  }

  // org_admin nu poate crea alt admin sau org_admin cu rol superior propriului rol
  const allowedRoles = actor.role === 'admin' ? ['admin', 'org_admin', 'user'] : ['user'];
  const validRole = allowedRoles.includes(role) ? role : 'user';
  const plainPwd  = password && password.length >= 4 ? password : generatePassword();
  const phoneValidation = validatePhone((phone || '').trim());
  if (!phoneValidation.valid) return res.status(400).json({ error: 'phone_invalid', message: phoneValidation.error });
  const phoneVal = phoneValidation.normalized || (phone || '').trim();
  const ni = notif_inapp !== false; const ne = !!notif_email; const nw = !!notif_whatsapp;

  const needsVerification = !skip_verification;
  const verificationToken = needsVerification
    ? crypto.randomBytes(32).toString('hex')
    : null;

  // Determinăm org_id de folosit:
  // - org_admin: folosește propriul org_id din DB (nu poate crea în altă org)
  // - admin (super-admin): poate specifica org_name pentru ORICE rol (user, org_admin)
  //   dacă nu specifică, org_id rămâne null (nu e greșit, dar util să fie setat)
  let insertOrgId = actor.orgId || null;
  if (actor.role === 'org_admin') {
    const { rows: actorOrgRows } = await pool.query('SELECT org_id FROM users WHERE email=$1', [actor.email.toLowerCase()]);
    insertOrgId = actorOrgRows[0]?.org_id || null;
    if (!insertOrgId) return res.status(403).json({ error: 'org_admin_no_org', message: 'Contul de Administrator Instituție nu are o organizație asociată.' });
  } else if (actor.role === 'admin' && (bodyOrgName || '').trim()) {
    // Super-admin a specificat o organizație — upsert și asociem userul indiferent de rol
    const orgNameTrimmed = bodyOrgName.trim();
    const { rows: orgRows } = await pool.query(
      `INSERT INTO organizations (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [orgNameTrimmed]
    );
    insertOrgId = orgRows[0]?.id || null;
    if (!insertOrgId) return res.status(500).json({ error: 'org_create_failed' });
    logger.info({ orgName: orgNameTrimmed, orgId: insertOrgId, role: validRole }, 'Organizatie upsert pentru user nou');
  } else if (actor.role === 'admin' && validRole === 'org_admin') {
    // org_admin fără org_name specificat — eroare
    return res.status(400).json({ error: 'org_name_required', message: 'Specificați organizația pentru Administrator Instituție.' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO users
         (email, password_hash, nume, prenume, nume_familie,
          functie, institutie, compartiment, role, phone,
          notif_inapp, notif_email, notif_whatsapp, org_id,
          personal_email,
          email_verified, verification_token, verification_sent_at,
          force_password_change)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING id, email, nume, prenume, nume_familie, functie, institutie,
                 compartiment, role, phone,
                 notif_inapp, notif_email, notif_whatsapp, org_id,
                 personal_email, email_verified,
                 gws_email, gws_status`,
      [
        loginEmail, await hashPassword(plainPwd),
        numeComplet,
        prn, fam,
        (functie || '').trim(), (institutie || '').trim(), (compartiment || '').trim(),
        validRole, phoneVal, ni, ne, nw, insertOrgId,
        (personal_email || '').trim().toLowerCase() || null,
        !needsVerification,
        verificationToken,
        verificationToken ? new Date() : null,
        true,  // force_password_change — utilizatorul trebuie să schimbe parola la prima logare
      ]
    );
    const user = rows[0];

    // ── GWS Provisioning ─────────────────────────────────────────────────
    let gwsResult = null;
    if (create_gws && gwsIsConfigured()) {
      try {
        // Dacă gws_as_login, emailul a fost deja rezervat — îl refolosim direct
        const gwsEmail = previewGwsEmail || await findAvailableEmail(prn, fam);
        await provisionGwsUser({
          prenume: prn, numeFamilie: fam,
          gwsEmail, tempPassword: plainPwd,
          forcePasswordChange: !!force_password_change,
          personalEmail: (personal_email || '').trim() || null,
          phone: phoneVal, functie: (functie || '').trim(),
          institutie: (institutie || '').trim(),
        });
        await pool.query(
          `UPDATE users SET gws_email=$1, gws_status='active', gws_provisioned_at=NOW(), gws_error=NULL WHERE id=$2`,
          [gwsEmail, user.id]
        );
        user.gws_email  = gwsEmail;
        user.gws_status = 'active';
        gwsResult = { ok: true, gws_email: gwsEmail };
        logger.info(`✅ GWS: cont creat ${gwsEmail} pentru user ${user.id}`);
      } catch(gwsErr) {
        const errMsg = gwsErr.message || String(gwsErr);
        await pool.query(
          `UPDATE users SET gws_status='failed', gws_error=$1 WHERE id=$2`,
          [errMsg, user.id]
        );
        user.gws_status = 'failed';
        gwsResult = { ok: false, error: errMsg };
        logger.error({ userId: user.id, errMsg }, 'GWS provision esuat');
      }
    } else if (create_gws && !gwsIsConfigured()) {
      gwsResult = { ok: false, error: 'gws_not_configured' };
    }

    // ── Trimitere credențiale ─────────────────────────────────────────────
    // Destinație: emailul personal dacă există (mai ales când login = @docflowai.ro),
    // altfel emailul de login
    const credsDest = (personal_email || '').trim().toLowerCase() || loginEmail;
    const appUrl = getAppUrl(req);

    if (needsVerification && verificationToken) {
      const verifyLink = `${appUrl}/auth/verify-email/${verificationToken}`;
      sendSignerEmail({
        to: credsDest,
        subject: '✅ Verificare adresă email — DocFlowAI',
        html: `<div style="font-family:system-ui,sans-serif;max-width:500px;margin:0 auto;background:#0f1731;color:#eaf0ff;border-radius:16px;padding:36px;">
  <h2 style="color:#7c5cff;margin:0 0 16px;">✅ Verificare adresă email</h2>
  <p>Bună <strong>${escHtml(numeComplet)}</strong>,</p>
  <p>Contul tău DocFlowAI a fost creat de un administrator.</p>
  <div style="text-align:center;margin:28px 0;">
    <a href="${verifyLink}" style="background:#7c5cff;color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:1rem;">Verifică adresa email</a>
  </div>
  <p style="font-size:.82rem;color:#5a6a8a;">Sau copiază: <code style="color:#9db0ff;">${verifyLink}</code></p>
  <p style="font-size:.82rem;color:#5a6a8a;">Link expiră în 72h.</p>
</div>`,
      }).catch(e => logger.warn({ err: e, credsDest }, 'R-06: verificare email esuat'));
    }

    invalidateOrgUserCache(insertOrgId);
    res.status(201).json({
      ...user,
      // Parola returnată în response pentru afișare în modal (o singură dată) — nu se stochează
      tempPassword: plainPwd,
      credentials_sent_to: credsDest,
      verificationSent: needsVerification && !!verificationToken,
      gws: gwsResult,
    });
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'email_exists' });
    res.status(500).json({ error: 'server_error' });
  }
});

// ── GET /admin/gws/preview-email — preview email GWS înainte de creare ─────
router.get('/admin/gws/preview-email', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });
  const { prenume, nume_familie } = req.query;
  if (!prenume && !nume_familie) return res.status(400).json({ error: 'prenume_or_nume_required' });
  if (!gwsIsConfigured()) return res.json({ configured: false });
  try {
    const available = await findAvailableEmail(prenume || '', nume_familie || '');
    const base = buildLocalPart(prenume || '', nume_familie || '');
    return res.json({ configured: true, email: available, base });
  } catch(e) {
    return res.json({ configured: true, error: e.message });
  }
});

// ── POST /admin/users/:id/gws-provision — (re)provision cont Workspace ─────
router.post('/admin/users/:id/gws-provision', csrfMiddleware, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });
  if (!gwsIsConfigured()) return res.status(503).json({ error: 'gws_not_configured' });

  const userId = parseInt(req.params.id);
  const { force_password_change } = req.body || {};

  try {
    const { rows } = await pool.query(
      'SELECT id, email, nume, prenume, nume_familie, functie, institutie, phone, personal_email, gws_email FROM users WHERE id=$1',
      [userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'user_not_found' });
    const u = rows[0];

    if (u.gws_email) {
      return res.status(409).json({ error: 'already_provisioned', gws_email: u.gws_email });
    }

    const prn = (u.prenume || u.nume?.split(' ')[0] || '').trim();
    const fam = (u.nume_familie || u.nume?.split(' ').slice(1).join('') || '').trim();
    const gwsEmail = await findAvailableEmail(prn, fam);
    const tempPwd  = generatePassword();  // B-03: generam parola noua, nu citim din DB

    await provisionGwsUser({
      prenume: prn, numeFamilie: fam,
      gwsEmail, tempPassword: tempPwd,
      forcePasswordChange: force_password_change !== false,
      personalEmail: u.personal_email || null,
      phone: u.phone, functie: u.functie, institutie: u.institutie,
    });
    await pool.query(
      `UPDATE users SET gws_email=$1, gws_status='active', gws_provisioned_at=NOW(), gws_error=NULL WHERE id=$2`,
      [gwsEmail, userId]
    );
    logger.info(`✅ GWS retry: cont creat ${gwsEmail} pentru user ${userId}`);
    return res.json({ ok: true, gws_email: gwsEmail });
  } catch(e) {
    const errMsg = e.message || String(e);
    await pool.query(
      `UPDATE users SET gws_status='failed', gws_error=$1 WHERE id=$2`,
      [errMsg, userId]
    ).catch(() => {});
    return res.status(500).json({ error: 'provision_failed', detail: errMsg });
  }
});

// ── GET /admin/gws/verify — testează conectivitatea cu Workspace ───────────
router.get('/admin/gws/verify', async (req, res) => {
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const result = await verifyGws();
  res.status(result.ok ? 200 : 503).json(result);
});

// ── POST /admin/users/bulk-import — import CSV utilizatori ──────────────────
// Format CSV: email,nume,functie,compartiment (header opțional)
// Disponibil pentru admin și org_admin (org_admin importă doar în org sa)
router.post('/admin/users/bulk-import', csrfMiddleware, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });

  const { csvData, send_credentials = false } = req.body || {};
  if (!csvData || !String(csvData).trim())
    return res.status(400).json({ error: 'csv_required' });

  // Determinam org_id
  let targetOrgId = null;
  let targetInstitutie = '';
  if (actor.role === 'org_admin') {
    const { rows } = await pool.query('SELECT org_id, institutie FROM users WHERE id=$1', [actor.userId]);
    targetOrgId = rows[0]?.org_id || null;
    targetInstitutie = rows[0]?.institutie || '';
    if (!targetOrgId) return res.status(403).json({ error: 'no_org' });
  }

  // Parsam CSV
  const lines = String(csvData).trim().split(/\r?\n/);
  const results = { created: [], skipped: [], errors: [] };
  let isFirstLine = true;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const cols = line.split(',').map(c => c.trim().replace(/^["']|["']$/g, ''));
    const [emailCol, numeCol, functieCol, compartimentCol] = cols;

    // Skip header dacă prima linie conține 'email' ca text
    if (isFirstLine && emailCol.toLowerCase() === 'email') { isFirstLine = false; continue; }
    isFirstLine = false;

    const email = (emailCol || '').toLowerCase();
    const nume  = (numeCol || '').trim();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      results.errors.push({ line: rawLine, reason: 'email invalid' });
      continue;
    }
    if (!nume) {
      results.errors.push({ line: rawLine, reason: 'numele lipsește' });
      continue;
    }

    try {
      // Verificam daca exista deja
      const { rows: existing } = await pool.query(
        'SELECT id FROM users WHERE lower(email)=$1', [email]
      );
      if (existing.length > 0) {
        results.skipped.push({ email, reason: 'există deja' });
        continue;
      }

      const tempPwd = generatePassword();
      const hash    = await hashPassword(tempPwd);
      const functie = (functieCol || '').trim();
      const comp    = (compartimentCol || '').trim();

      const { rows: newUser } = await pool.query(
        `INSERT INTO users (email, password_hash, nume, functie, compartiment, institutie,
          role, org_id, notif_inapp, notif_email, force_password_change, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'user',$7,true,true,true,NOW())
         RETURNING id, email`,
        [email, hash, nume, functie, comp, targetInstitutie || '', targetOrgId]
      );

      if (send_credentials) {
        try {
          const appUrl = getAppUrl(req);
          await sendSignerEmail({
            to: email,
            ...emailCredentials({ appUrl, numeUser: nume, email, newPwd: tempPwd }),
          });
        } catch(mailErr) {
          logger.warn({ err: mailErr, email }, 'bulk-import: email credentiale esuat');
        }
      }

      results.created.push({ email, nume, tempPassword: send_credentials ? undefined : tempPwd });
    } catch(e) {
      results.errors.push({ line: rawLine, reason: String(e.message || e).substring(0, 100) });
    }
  }

  logger.info({
    actor: actor.email, created: results.created.length,
    skipped: results.skipped.length, errors: results.errors.length
  }, 'Bulk import utilizatori');

  res.json({
    ok: true,
    summary: {
      total: lines.filter(l => l.trim()).length,
      created: results.created.length,
      skipped: results.skipped.length,
      errors:  results.errors.length,
    },
    results,
  });
});

router.put('/admin/users/:id', csrfMiddleware, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });
  const targetId = parseInt(req.params.id);
  if (isNaN(targetId)) return res.status(400).json({ error: 'invalid_id' });
  const { email, nume, prenume, nume_familie, functie, institutie, compartiment, password, role, phone, notif_inapp, notif_email, notif_whatsapp, personal_email } = req.body || {};
  const updates = [], vals = []; let i = 1;
  if (email) { updates.push(`email=$${i++}`); vals.push(email.trim().toLowerCase()); }
  if (nume !== undefined) { updates.push(`nume=$${i++}`); vals.push((nume || '').trim()); }
  if (prenume !== undefined) { updates.push(`prenume=$${i++}`); vals.push((prenume || '').trim()); }
  if (nume_familie !== undefined) { updates.push(`nume_familie=$${i++}`); vals.push((nume_familie || '').trim()); }
  if (functie !== undefined) { updates.push(`functie=$${i++}`); vals.push((functie || '').trim()); }
  if (institutie !== undefined) { updates.push(`institutie=$${i++}`); vals.push((institutie || '').trim()); }
  if (compartiment !== undefined) { updates.push(`compartiment=$${i++}`); vals.push((compartiment || '').trim()); }
  if (personal_email !== undefined) { updates.push(`personal_email=$${i++}`); vals.push((personal_email || '').trim().toLowerCase() || null); }
  if (role) {
    const allowedRolesUpd = actor.role === 'admin' ? ['admin', 'org_admin', 'user'] : ['user'];
    if (allowedRolesUpd.includes(role)) { updates.push(`role=$${i++}`); vals.push(role); }
  }
  if (phone !== undefined) {
    const pv = validatePhone((phone || '').trim());
    if (!pv.valid) return res.status(400).json({ error: 'phone_invalid', message: pv.error });
    updates.push(`phone=$${i++}`); vals.push(pv.normalized || (phone || '').trim());
  }
  if (notif_inapp !== undefined) { updates.push(`notif_inapp=$${i++}`); vals.push(!!notif_inapp); }
  if (notif_email !== undefined) { updates.push(`notif_email=$${i++}`); vals.push(!!notif_email); }
  if (notif_whatsapp !== undefined) { updates.push(`notif_whatsapp=$${i++}`); vals.push(!!notif_whatsapp); }
  let newPlainPwd = null;
  if (password && password.length >= 4) {
    updates.push(`password_hash=$${i++}`); vals.push(await hashPassword(password));
    newPlainPwd = password;
  }
  if (!updates.length) return res.status(400).json({ error: 'nothing_to_update' });
  vals.push(targetId);
  try {
    const { rows } = await pool.query(
      `UPDATE users SET ${updates.join(',')} WHERE id=$${i} RETURNING id,email,nume,functie,institutie,compartiment,role,phone,notif_inapp,notif_email,notif_whatsapp,org_id`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'user_not_found' });
    invalidateOrgUserCache(rows[0].org_id || null);
    return res.json(rows[0]);
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'email_exists' });
    return res.status(500).json({ error: 'server_error' });
  }
});

router.post('/admin/users/:id/reset-password', csrfMiddleware, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });
  const targetId = parseInt(req.params.id);
  if (isNaN(targetId)) return res.status(400).json({ error: 'invalid_id' });
  // SEC-07: verificare cross-tenant — adminul poate reseta parola doar userilor din org sa
  try {
    const { rows: targetRows } = await pool.query('SELECT id,email,nume,org_id FROM users WHERE id=$1', [targetId]);
    if (!targetRows.length) return res.status(404).json({ error: 'user_not_found' });
    const target = targetRows[0];
    // Verifică că target aparține aceleiași organizații ca actorul
    const { rows: actorRows } = await pool.query('SELECT org_id FROM users WHERE id=$1', [actor.userId]);
    const actorOrgId = actorRows[0]?.org_id || null;
    // FIX: role='admin' (super-admin) poate reseta parola oricărui user
    if (actor.role === 'org_admin' && actorOrgId && target.org_id && actorOrgId !== target.org_id) {
      return res.status(403).json({ error: 'forbidden_cross_tenant' });
    }
    const newPwd = generatePassword();
    // SEC-04: increment token_version → invalidează JWT-urile active ale utilizatorului
    await pool.query('UPDATE users SET password_hash=$1, force_password_change=TRUE, token_version=COALESCE(token_version,1)+1 WHERE id=$2', [await hashPassword(newPwd), targetId]);
    // SEC-02: parola trimisă EXCLUSIV pe email — nu returnată în response
    const appUrl = getAppUrl(req);
    await sendSignerEmail({
      to: target.email,
      ...emailResetPassword({ appUrl, numeUser: target.nume, email: target.email, newPwd })
    }).catch(e => logger.warn({ err: e, email: target.email }, 'reset-password email esuat'));
    // Returnăm parola și emailul în response — afișate în modal ca fallback
    res.json({ ok: true, email: target.email, tempPassword: newPwd, message: `Parolă nouă trimisă pe email la ${target.email}` });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

router.delete('/admin/users/:id', csrfMiddleware, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  // FIX b75: org_admin poate șterge useri din propria organizație (consistent cu PUT/reset-password)
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });
  const targetId = parseInt(req.params.id);
  if (isNaN(targetId)) return res.status(400).json({ error: 'invalid_id' });
  if (actor.userId === targetId) return res.status(400).json({ error: 'cannot_delete_self' });
  try {
    // SEC-07: verificare cross-tenant — org_admin poate șterge DOAR din propria org
    // FIX: role='admin' (super-admin) poate șterge din orice org, indiferent de org_id propriu
    const { rows: actorRows } = await pool.query('SELECT org_id FROM users WHERE id=$1', [actor.userId]);
    const actorOrgId = actorRows[0]?.org_id || null;
    let deleteWhere, deleteParams;
    if (actor.role === 'org_admin' && actorOrgId) {
      deleteWhere  = 'DELETE FROM users WHERE id=$1 AND org_id=$2';
      deleteParams = [targetId, actorOrgId];
    } else {
      // super-admin: ștergere fără restricție de org
      deleteWhere  = 'DELETE FROM users WHERE id=$1';
      deleteParams = [targetId];
    }
    const { rowCount } = await pool.query(deleteWhere, deleteParams);
    if (!rowCount) return res.status(404).json({ error: 'user_not_found_or_forbidden' });
    invalidateOrgUserCache(actorOrgId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});


// ── PUT /admin/users/:id/assign-org — asignează organizație unui user (super-admin only) ──
router.put('/admin/users/:id/assign-org', csrfMiddleware, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden', message: 'Doar super-admin poate reasigna organizații.' });
  const targetId = parseInt(req.params.id);
  if (isNaN(targetId)) return res.status(400).json({ error: 'invalid_id' });
  const { org_id, org_name } = req.body || {};
  try {
    let newOrgId = org_id ? parseInt(org_id) : null;
    // Dacă s-a trimis org_name în loc de org_id, căutăm/creăm organizația
    if (!newOrgId && org_name) {
      const { rows } = await pool.query(
        `INSERT INTO organizations (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [org_name.trim()]
      );
      newOrgId = rows[0]?.id || null;
    }
    const { rowCount } = await pool.query(
      'UPDATE users SET org_id = $1 WHERE id = $2',
      [newOrgId, targetId]
    );
    if (!rowCount) return res.status(404).json({ error: 'user_not_found' });
    logger.info({ targetId, newOrgId, actor: actor.email }, 'assign-org: org_id actualizat');
    res.json({ ok: true, userId: targetId, org_id: newOrgId });
  } catch(e) { logger.error({ err: e }, 'assign-org error'); res.status(500).json({ error: 'server_error' }); }
});

router.post('/admin/users/:id/send-credentials', csrfMiddleware, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });
  const targetId = parseInt(req.params.id);
  try {
    // SEC-07: cross-tenant check — org_admin poate trimite credențiale doar userilor din org sa
    const { rows } = await pool.query('SELECT email,nume,functie,org_id FROM users WHERE id=$1', [targetId]);
    const u = rows[0];
    if (!u) return res.status(404).json({ error: 'user_not_found' });
    // cross-tenant: org_admin poate acționa doar pe userii din propria org
    if (actor.role === 'org_admin') {
      const { rows: actorRows } = await pool.query('SELECT org_id FROM users WHERE id=$1', [actor.userId]);
      const actorOrgId = actorRows[0]?.org_id || null;
      if (!actorOrgId || actorOrgId !== u.org_id) return res.status(403).json({ error: 'forbidden_cross_tenant' });
    }
    const newPwd = generatePassword();
    // SEC-04: increment token_version → invalidează JWT-urile active
    await pool.query('UPDATE users SET password_hash=$1, force_password_change=TRUE, token_version=COALESCE(token_version,1)+1 WHERE id=$2', [await hashPassword(newPwd), targetId]);
    const appUrl = getAppUrl(req);
    await sendSignerEmail({
      to: u.email, ...emailCredentials({ appUrl, numeUser: u.nume, email: u.email, newPwd }),

    });
    // Returnăm parola și emailul către admin — afișate în modal ca fallback
    // dacă emailul nu ajunge la utilizator (parola este trimisă și pe email)
    res.json({ ok: true, email: u.email, tempPassword: newPwd, message: `Credențiale trimise pe email la ${u.email}` });
  } catch(e) { res.status(500).json({ ok: false, error: 'server_error' }); }
});


// ═══════════════════════════════════════════════════════════════════════════
// LEAVE / DELEGATION ENDPOINTS (BLOC 4.1)
// ═══════════════════════════════════════════════════════════════════════════

const LEAVE_ERR_MSG = {
  leave_dates_required: 'Datele de concediu sunt obligatorii.',
  leave_dates_invalid_format: 'Format dată invalid (necesar YYYY-MM-DD).',
  leave_end_before_start: 'Data sfârșit nu poate fi înainte de data început.',
  leave_start_in_past: 'Concediu nu poate fi setat retroactiv.',
  delegate_invalid: 'Delegat invalid.',
  user_not_found: 'Utilizator inexistent.',
  delegate_not_found: 'Delegatul nu există.',
  delegate_different_org: 'Delegatul trebuie să fie din aceeași instituție.',
  delegate_has_own_delegate: 'Delegatul ales are deja propriul delegat (lanț de delegări neacceptat).',
  leave_reason_too_long: 'Motivul depășește 500 de caractere.',
};

function _mapLeaveError(err, res) {
  const code = err?.message || 'server_error';
  const userMsg = LEAVE_ERR_MSG[code] || 'Eroare neașteptată.';
  const status = (code in LEAVE_ERR_MSG) ? 400 : 500;
  return res.status(status).json({ error: code, message: userMsg });
}

// ── PUT /api/users/me/leave — userul își setează singur concediu ────────────
router.put('/api/users/me/leave', csrfMiddleware, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows: meRows } = await pool.query(
      'SELECT id FROM users WHERE email=$1', [actor.email.toLowerCase()]
    );
    if (!meRows.length) return res.status(404).json({ error: 'user_not_found' });
    const targetUserId = meRows[0].id;

    const { leave_start, leave_end, delegate_user_id, leave_reason } = req.body || {};
    const input = {
      targetUserId,
      leaveStart: leave_start || null,
      leaveEnd: leave_end || null,
      delegateUserId: delegate_user_id ? Number(delegate_user_id) : null,
      leaveReason: leave_reason || null,
    };
    await validateLeaveSettings(input);
    await setUserLeave(input);
    invalidateOrgUserCache?.();
    const info = await getLeaveInfo(targetUserId);
    res.json({ ok: true, leave: info });
  } catch (err) {
    _mapLeaveError(err, res);
  }
});

// ── DELETE /api/users/me/leave — userul își anulează singur concediul ──────
router.delete('/api/users/me/leave', csrfMiddleware, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows: meRows } = await pool.query(
      'SELECT id FROM users WHERE email=$1', [actor.email.toLowerCase()]
    );
    if (!meRows.length) return res.status(404).json({ error: 'user_not_found' });
    await clearUserLeave(meRows[0].id);
    invalidateOrgUserCache?.();
    res.json({ ok: true, leave: null });
  } catch (err) {
    _mapLeaveError(err, res);
  }
});

// ── PUT /admin/users/:id/leave — admin setează concediu pentru oricine ─────
router.put('/admin/users/:id/leave', csrfMiddleware, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin' && actor.role !== 'org_admin') {
    return res.status(403).json({ error: 'admin_only' });
  }

  const targetUserId = Number(req.params.id);
  if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
    return res.status(400).json({ error: 'invalid_user_id' });
  }
  try {
    const { rows: orgRows } = await pool.query(
      `SELECT u_actor.org_id AS actor_org, u_target.org_id AS target_org
       FROM users u_actor
       JOIN users u_target ON u_target.id = $2
       WHERE u_actor.email = $1`,
      [actor.email.toLowerCase(), targetUserId]
    );
    if (!orgRows.length) return res.status(404).json({ error: 'user_not_found' });
    if (orgRows[0].actor_org !== orgRows[0].target_org) {
      return res.status(403).json({ error: 'different_org' });
    }

    const { leave_start, leave_end, delegate_user_id, leave_reason } = req.body || {};
    const input = {
      targetUserId,
      leaveStart: leave_start || null,
      leaveEnd: leave_end || null,
      delegateUserId: delegate_user_id ? Number(delegate_user_id) : null,
      leaveReason: leave_reason || null,
    };
    await validateLeaveSettings(input);
    await setUserLeave(input);
    invalidateOrgUserCache?.();
    const info = await getLeaveInfo(targetUserId);
    res.json({ ok: true, leave: info });
  } catch (err) {
    _mapLeaveError(err, res);
  }
});

// ── DELETE /admin/users/:id/leave — admin anulează concediu ────────────────
router.delete('/admin/users/:id/leave', csrfMiddleware, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin' && actor.role !== 'org_admin') {
    return res.status(403).json({ error: 'admin_only' });
  }

  const targetUserId = Number(req.params.id);
  if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
    return res.status(400).json({ error: 'invalid_user_id' });
  }
  try {
    const { rows: orgRows } = await pool.query(
      `SELECT u_actor.org_id AS actor_org, u_target.org_id AS target_org
       FROM users u_actor
       JOIN users u_target ON u_target.id = $2
       WHERE u_actor.email = $1`,
      [actor.email.toLowerCase(), targetUserId]
    );
    if (!orgRows.length) return res.status(404).json({ error: 'user_not_found' });
    if (orgRows[0].actor_org !== orgRows[0].target_org) {
      return res.status(403).json({ error: 'different_org' });
    }
    await clearUserLeave(targetUserId);
    invalidateOrgUserCache?.();
    res.json({ ok: true, leave: null });
  } catch (err) {
    _mapLeaveError(err, res);
  }
});

export default router;
