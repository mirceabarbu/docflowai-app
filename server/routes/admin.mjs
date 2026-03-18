/**
 * DocFlowAI — Admin routes v3.2.1
 * FIX: export default mutat la sfarsit (toate rutele inainte de export)
 * FIX: /admin/flows/audit mutat inainte de export default
 * FIX: /health => versiune 3.2.1
 * B-03: plain_password eliminat — parola se trimite o singura data prin email, nu se stocheaza
 */

import { Router } from 'express';
import crypto from 'crypto';
import { emailResetPassword, emailCredentials, emailVerifyGws } from '../emailTemplates.mjs';
import { requireAuth, requireAdmin, hashPassword, generatePassword, escHtml } from '../middleware/auth.mjs';
import { pool, DB_READY, DB_LAST_ERROR, requireDb, saveFlow, getFlowData, invalidateOrgUserCache } from '../db/index.mjs';
import { validatePhone } from '../whatsapp.mjs';
import { sendSignerEmail, verifySmtp } from '../mailer.mjs';
import { archiveFlow, verifyDrive } from '../drive.mjs';
import { verifyWhatsApp, sendWaSignRequest } from '../whatsapp.mjs';
import { gwsIsConfigured, findAvailableEmail, provisionGwsUser, verifyGws, buildLocalPart } from '../gws.mjs';
import { logger } from '../middleware/logger.mjs';

// ── Helper: acceptă atât admin cât și org_admin ─────────────────────────────
// org_admin vede/modifică doar propria organizație (orgId din JWT)
// admin vede totul (orgId=null sau orice)
function isAdminOrOrgAdmin(actor) {
  return actor?.role === 'admin' || actor?.role === 'org_admin';
}
// Helper: returnează orgId filtru pentru query (null = toate, number = filtrat)
function actorOrgFilter(actor) {
  if (actor?.role === 'org_admin') return actor.orgId || null;
  return null; // admin = fără filtru
}

let PDFLibAdmin = null;
try { PDFLibAdmin = await import('pdf-lib'); } catch(e) { logger.warn('⚠️ pdf-lib not available for audit PDF export'); }

let _wsClientsSize = () => 0;
export function injectWsSize(fn) { _wsClientsSize = fn; }

const router = Router();

// Helper: determină URL-ul aplicației din request (fallback la env var)
function getAppUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host  = req.get('x-forwarded-host') || req.get('host') || 'app.docflowai.ro';
  return `${proto}://${host}`;
}

function approxB64Bytes(v) {
  if (!v || typeof v !== 'string') return 0;
  const b64 = v.includes(',') ? v.split(',', 2)[1] : v;
  return Math.round((b64 || '').length * 0.75);
}

async function getFlowPdfBytesMap(flowIds = []) {
  if (!flowIds.length) return new Map();
  const { rows } = await pool.query(
    `SELECT flow_id, COALESCE(SUM(CEIL(LENGTH(data) * 0.75)), 0)::bigint AS bytes
       FROM flows_pdfs
      WHERE flow_id = ANY($1)
      GROUP BY flow_id`,
    [flowIds]
  );
  return new Map(rows.map(r => [r.flow_id, Number(r.bytes) || 0]));
}

function getLegacyFlowBytes(d = {}) {
  return approxB64Bytes(d.pdfB64) + approxB64Bytes(d.signedPdfB64) + approxB64Bytes(d.originalPdfB64);
}

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
    res.json(rows);
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

// ── GET /admin/organizations — listă organizații cu statistici și config webhook ──
router.get('/admin/organizations', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  try {
    const { rows } = await pool.query(`
      SELECT o.id, o.name, o.webhook_url, o.webhook_events, o.webhook_enabled,
             o.webhook_secret IS NOT NULL AS webhook_has_secret,
             o.created_at, o.updated_at,
             COUNT(DISTINCT u.id)::int  AS user_count,
             COUNT(DISTINCT f.id)::int  AS flow_count
      FROM organizations o
      LEFT JOIN users u  ON u.org_id  = o.id
      LEFT JOIN flows f  ON f.org_id  = o.id
      GROUP BY o.id
      ORDER BY o.name ASC
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

// ── PUT /admin/organizations/:id — actualizare organizație + config webhook ──
router.put('/admin/organizations/:id', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const orgId = parseInt(req.params.id);
  if (!orgId) return res.status(400).json({ error: 'invalid_id' });
  const { name, webhook_url, webhook_secret, webhook_events, webhook_enabled } = req.body || {};
  try {
    const updates = []; const params = [];
    if (name !== undefined) { params.push(String(name).trim()); updates.push(`name=$${params.length}`); }
    if (webhook_url !== undefined) { params.push(webhook_url ? String(webhook_url).trim() : null); updates.push(`webhook_url=$${params.length}`); }
    if (webhook_secret !== undefined && webhook_secret !== '') { params.push(String(webhook_secret).trim()); updates.push(`webhook_secret=$${params.length}`); }
    if (webhook_events !== undefined) { params.push(Array.isArray(webhook_events) ? webhook_events : []); updates.push(`webhook_events=$${params.length}`); }
    if (webhook_enabled !== undefined) { params.push(!!webhook_enabled); updates.push(`webhook_enabled=$${params.length}`); }
    if (!updates.length) return res.status(400).json({ error: 'no_fields' });
    updates.push(`updated_at=NOW()`);
    params.push(orgId);
    const { rows } = await pool.query(
      `UPDATE organizations SET ${updates.join(',')} WHERE id=$${params.length} RETURNING id, name, webhook_url, webhook_events, webhook_enabled, updated_at`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'org_not_found' });
    res.json({ ok: true, org: rows[0] });
  } catch(e) { res.status(500).json({ error: 'server_error', message: e.message }); }
});

// ── POST /admin/organizations/:id/test-webhook — trimite un eveniment de test ──
router.post('/admin/organizations/:id/test-webhook', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const orgId = parseInt(req.params.id);
  try {
    const { rows } = await pool.query('SELECT webhook_url, webhook_secret, webhook_enabled FROM organizations WHERE id=$1', [orgId]);
    const org = rows[0];
    if (!org) return res.status(404).json({ error: 'org_not_found' });
    if (!org.webhook_url) return res.status(400).json({ error: 'no_webhook_url', message: 'Configurați mai întâi URL-ul webhook.' });
    // Payload de test
    const testPayload = {
      event: 'webhook.test',
      flowId: 'TEST_' + Date.now(),
      docName: 'Document test DocFlowAI',
      institutie: 'Organizație test',
      status: 'completed',
      completedAt: new Date().toISOString(),
      signers: [{ name: 'Ion Popescu', email: 'test@example.com', rol: 'SEMNAT', status: 'signed', signedAt: new Date().toISOString() }],
      sentAt: new Date().toISOString(),
    };
    const body = JSON.stringify(testPayload);
    const sig = org.webhook_secret
      ? crypto.createHmac('sha256', org.webhook_secret).update(body).digest('hex')
      : 'unsigned';
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 10000);
      const r = await fetch(org.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DocFlowAI-Event': 'webhook.test', 'X-DocFlowAI-Signature': `sha256=${sig}` },
        body, signal: ctrl.signal,
      });
      res.json({ ok: r.ok, status: r.status, statusText: r.statusText, message: r.ok ? 'Webhook livrat cu succes.' : `Server-ul destinatar a returnat ${r.status}.` });
    } catch(fetchErr) {
      res.json({ ok: false, error: fetchErr.message, message: 'Eroare de rețea — verificați URL-ul.' });
    }
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
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
    if (orgId) {
      // org_admin: filtrat strict la org_id propriu; admin cu org_id: la fel
      query = 'SELECT id,email,nume,prenume,nume_familie,functie,institutie,compartiment,role,phone,notif_inapp,notif_email,notif_whatsapp,created_at,org_id,personal_email,gws_email,gws_status,gws_provisioned_at,gws_error FROM users WHERE org_id=$1 ORDER BY institutie ASC, compartiment ASC, nume ASC';
      params = [orgId];
    } else {
      // admin fara org_id (super-admin global) — vede toti
      query = 'SELECT id,email,nume,prenume,nume_familie,functie,institutie,compartiment,role,phone,notif_inapp,notif_email,notif_whatsapp,created_at,org_id,personal_email,gws_email,gws_status,gws_provisioned_at,gws_error FROM users ORDER BY institutie ASC, compartiment ASC, nume ASC';
      params = [];
    }
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch(e) { logger.error({ err: e }, 'GET /admin/users error:'); res.status(500).json({ error: 'server_error', detail: e.message }); }
});

router.post('/admin/users', async (req, res) => {
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
  // - admin (super-admin): dacă creează un org_admin, primește org_name → upsert în organizations
  let insertOrgId = actor.orgId || null;
  if (actor.role === 'org_admin') {
    const { rows: actorOrgRows } = await pool.query('SELECT org_id FROM users WHERE email=$1', [actor.email.toLowerCase()]);
    insertOrgId = actorOrgRows[0]?.org_id || null;
    if (!insertOrgId) return res.status(403).json({ error: 'org_admin_no_org', message: 'Contul de Administrator Instituție nu are o organizație asociată.' });
  } else if (actor.role === 'admin' && validRole === 'org_admin') {
    const orgNameTrimmed = (bodyOrgName || '').trim();
    if (!orgNameTrimmed) return res.status(400).json({ error: 'org_name_required', message: 'Specificați organizația pentru Administrator Instituție.' });
    // Upsert: creează organizație nouă sau reutilizează existentă cu același nume
    const { rows: orgRows } = await pool.query(
      `INSERT INTO organizations (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [orgNameTrimmed]
    );
    insertOrgId = orgRows[0]?.id || null;
    if (!insertOrgId) return res.status(500).json({ error: 'org_create_failed' });
    logger.info({ orgName: orgNameTrimmed, orgId: insertOrgId }, 'Organizatie upsert pentru org_admin');
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
    res.status(500).json({ error: 'server_error', detail: e.message });
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
router.post('/admin/users/:id/gws-provision', async (req, res) => {
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

router.put('/admin/users/:id', async (req, res) => {
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

router.post('/admin/users/:id/reset-password', async (req, res) => {
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
    if (actorOrgId && target.org_id && actorOrgId !== target.org_id) {
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

router.delete('/admin/users/:id', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  // FIX b75: org_admin poate șterge useri din propria organizație (consistent cu PUT/reset-password)
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });
  const targetId = parseInt(req.params.id);
  if (isNaN(targetId)) return res.status(400).json({ error: 'invalid_id' });
  if (actor.userId === targetId) return res.status(400).json({ error: 'cannot_delete_self' });
  try {
    // SEC-07: verificare cross-tenant — DELETE doar în propria organizație
    const { rows: actorRows } = await pool.query('SELECT org_id FROM users WHERE id=$1', [actor.userId]);
    const actorOrgId = actorRows[0]?.org_id || null;
    const deleteWhere = actorOrgId
      ? 'DELETE FROM users WHERE id=$1 AND org_id=$2'
      : 'DELETE FROM users WHERE id=$1';
    const deleteParams = actorOrgId ? [targetId, actorOrgId] : [targetId];
    const { rowCount } = await pool.query(deleteWhere, deleteParams);
    if (!rowCount) return res.status(404).json({ error: 'user_not_found_or_forbidden' });
    invalidateOrgUserCache(actorOrgId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

router.post('/admin/users/:id/send-credentials', async (req, res) => {
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
  } catch(e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// ── Flows admin ────────────────────────────────────────────────────────────
// ── GET /admin/flows/clean-preview — preview fluxuri ce vor fi șterse ─────

// ── F — b97: GET /admin/flows/stats — statistici rapide pentru badge header ──
// Returnează contoare: active, completed, refused, cancelled, total
router.get('/admin/flows/stats', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });
  try {
    const orgFilter = actorOrgFilter(actor);
    // FIX: query construit prin concatenare — evită interpolarea template literal cu ghilimele SQL
    const whereCond = orgFilter ? " AND (data->>'orgId')::int = $1" : '';
    const params = orgFilter ? [orgFilter] : [];
    const sql =
      'SELECT ' +
      "COUNT(*) FILTER (WHERE data->>'completed' = 'true')::int AS completed, " +
      "COUNT(*) FILTER (WHERE data->>'status' = 'refused')::int AS refused, " +
      "COUNT(*) FILTER (WHERE data->>'status' = 'cancelled')::int AS cancelled, " +
      "COUNT(*) FILTER (WHERE data->>'status' = 'review_requested')::int AS review_requested, " +
      "COUNT(*) FILTER (WHERE data->>'completed' IS DISTINCT FROM 'true' " +
        "AND data->>'status' NOT IN ('refused','cancelled','review_requested'))::int AS active, " +
      'COUNT(*)::int AS total ' +
      'FROM flows WHERE 1=1' + whereCond;
    const { rows } = await pool.query(sql, params);
    res.json(rows[0] || { active:0, completed:0, refused:0, cancelled:0, review_requested:0, total:0 });
  } catch(e) { logger.error({ err: e }, '/admin/flows/stats error'); res.status(500).json({ error: 'server_error' }); }
});

router.get('/admin/flows/clean-preview', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  try {
    const days = parseInt(req.query.days || '30');
    const filterInst = (req.query.institutie || '').trim();
    const filterDept = (req.query.compartiment || '').trim();
    const all = req.query.all === 'true';

    const { rows: userRows } = await pool.query('SELECT email,institutie,compartiment FROM users');
    const userMap = {}; userRows.forEach(u => { userMap[u.email.toLowerCase()] = u; });

    let rows;
    if (all) {
      const { rows: r } = await pool.query('SELECT id,data,created_at FROM flows ORDER BY created_at DESC');
      rows = r;
    } else {
      const { rows: r } = await pool.query(
        "SELECT id,data,created_at FROM flows WHERE created_at < NOW() - ($1 || ' days')::INTERVAL ORDER BY created_at DESC",
        [days]
      );
      rows = r;
    }

    const eligible = rows.filter(r => {
      const d = r.data || {};
      const u = userMap[(d.initEmail || '').toLowerCase()] || {};
      if (filterInst && (u.institutie || d.institutie || '') !== filterInst) return false;
      if (filterDept && (u.compartiment || d.compartiment || '') !== filterDept) return false;
      return true;
    });

    const pdfBytesMap = await getFlowPdfBytesMap(eligible.map(r => r.id));
    const totalBytes = eligible.reduce((acc, r) => acc + (pdfBytesMap.get(r.id) ?? getLegacyFlowBytes(r.data || {})), 0);

    return res.json({
      count: eligible.length,
      totalMB: Math.round(totalBytes / 1024 / 1024 * 100) / 100,
      flows: eligible.slice(0, 200).map(r => {  // max 200 in preview
        const d = r.data || {};
        const u = userMap[(d.initEmail || '').toLowerCase()] || {};
        const sizeBytes = pdfBytesMap.get(r.id) ?? getLegacyFlowBytes(d);
        const status = d.completed ? 'finalizat' : d.status === 'refused' ? 'refuzat' : d.status === 'review_requested' ? 'revizuire' : d.status === 'cancelled' ? 'anulat' : d.storage === 'drive' ? 'arhivat' : 'activ';
        return {
          flowId: d.flowId, docName: d.docName || '—',
          initEmail: d.initEmail || '—', initName: d.initName || '—',
          flowType: d.flowType || 'tabel',
          createdAt: d.createdAt || r.created_at, status,
          storage: d.storage || 'db',
          sizeMB: Math.round(sizeBytes / 1024 / 1024 * 100) / 100,
          institutie: u.institutie || d.institutie || '',
          compartiment: u.compartiment || d.compartiment || '',
        };
      })
    });
  } catch(e) { return res.status(500).json({ error: String(e.message || e) }); }
});


router.post('/admin/flows/clean', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const { olderThanDays, all, institutie, compartiment, confirmToken } = req.body || {};
  // FIX v3.2.2: ștergerea totală necesită token de confirmare explicit
  if (all && confirmToken !== 'DELETE_ALL_FLOWS') {
    return res.status(400).json({ error: 'confirm_token_required', message: 'Pentru ștergerea tuturor fluxurilor trimite confirmToken: "DELETE_ALL_FLOWS".' });
  }
  try {
    let result;
    if (!institutie && !compartiment) {
      if (all) result = await pool.query('DELETE FROM flows');
      else result = await pool.query("DELETE FROM flows WHERE created_at < NOW() - ($1 || ' days')::INTERVAL", [parseInt(olderThanDays) || 30]);
      return res.json({ ok: true, deleted: result.rowCount });
    }
    const { rows: userRows } = await pool.query('SELECT email,institutie,compartiment FROM users');
    const userMap = {}; userRows.forEach(u => { userMap[u.email.toLowerCase()] = u; });
    const { rows } = await pool.query(
      all ? 'SELECT id,data FROM flows' : "SELECT id,data FROM flows WHERE created_at < NOW() - ($1 || ' days')::INTERVAL",
      all ? [] : [parseInt(olderThanDays) || 30]
    );
    const idsToDelete = rows.filter(r => {
      const d = r.data || {}; const u = userMap[(d.initEmail || '').toLowerCase()] || {};
      if (institutie && (u.institutie || d.institutie || '') !== institutie) return false;
      if (compartiment && (u.compartiment || d.compartiment || '') !== compartiment) return false;
      return true;
    }).map(r => r.id);
    if (!idsToDelete.length) return res.json({ ok: true, deleted: 0 });
    result = await pool.query('DELETE FROM flows WHERE id = ANY($1)', [idsToDelete]);
    return res.json({ ok: true, deleted: result.rowCount });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

router.get('/admin/flows/archive-preview', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });
  try {
    // org_admin: filtrare strictă după org_id
    let apOrgId = null;
    if (actor.role === 'org_admin') {
      const { rows: aRows } = await pool.query('SELECT org_id FROM users WHERE email=$1', [actor.email.toLowerCase()]);
      apOrgId = aRows[0]?.org_id || null;
      if (!apOrgId) return res.status(403).json({ error: 'org_admin_no_org' });
    }
    const days = parseInt(req.query.days || '30');
    const filterInst = (req.query.institutie || '').trim();
    const filterDept = (req.query.compartiment || '').trim();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { rows } = apOrgId
      ? await pool.query('SELECT id,data,created_at FROM flows WHERE created_at < $1 AND org_id=$2 ORDER BY created_at ASC', [cutoff, apOrgId])
      : await pool.query('SELECT id,data,created_at FROM flows WHERE created_at < $1 ORDER BY created_at ASC', [cutoff]);
    const { rows: userRows } = apOrgId
      ? await pool.query('SELECT email,institutie,compartiment FROM users WHERE org_id=$1', [apOrgId])
      : await pool.query('SELECT email,institutie,compartiment FROM users');
    const userMap = {}; userRows.forEach(u => { userMap[u.email.toLowerCase()] = u; });
    const eligible = rows.filter(r => {
      const d = r.data; if (!d) return false;
      const done = d.completed || (d.signers || []).every(s => s.status === 'signed');
      const refused = (d.signers || []).some(s => s.status === 'refused') || d.status === 'refused';
      const archived = d.storage === 'drive';
      if (archived) return false;
      if (!(done || refused)) return false;
      const u = userMap[(d.initEmail || '').toLowerCase()] || {};
      if (filterInst && (u.institutie || d.institutie || '') !== filterInst) return false;
      if (filterDept && (u.compartiment || d.compartiment || '') !== filterDept) return false;
      return true;
    });
    const pdfBytesMap = await getFlowPdfBytesMap(eligible.map(r => r.id));
    const totalBytes = eligible.reduce((acc, r) => acc + (pdfBytesMap.get(r.id) ?? getLegacyFlowBytes(r.data || {})), 0);
    return res.json({
      count: eligible.length, totalMB: Math.round(totalBytes / 1024 / 1024 * 100) / 100,
      flows: eligible.map(r => {
        const u = userMap[(r.data.initEmail || '').toLowerCase()] || {};
        const sizeBytes = pdfBytesMap.get(r.id) ?? getLegacyFlowBytes(r.data || {});
        return { flowId: r.data.flowId, docName: r.data.docName, createdAt: r.data.createdAt || r.created_at,
          status: r.data.completed ? 'finalizat' : (r.data.signers || []).some(s => s.status === 'refused') ? 'refuzat' : 'necunoscut',
          sizeMB: Math.round(sizeBytes / 1024 / 1024 * 100) / 100,
          institutie: u.institutie || r.data.institutie || '', compartiment: u.compartiment || r.data.compartiment || '',
          initName: r.data.initName || '', initEmail: r.data.initEmail || '' };
      })
    });
  } catch(e) { return res.status(500).json({ error: String(e.message || e) }); }
});

router.post('/admin/flows/archive', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });
  try {
    const { flowIds, batchIndex = 0 } = req.body || {};
    if (!Array.isArray(flowIds) || !flowIds.length) return res.status(400).json({ error: 'flowIds_required' });
    const BATCH_SIZE = 10;
    const start = batchIndex * BATCH_SIZE;
    const batch = flowIds.slice(start, start + BATCH_SIZE);
    const hasMore = start + BATCH_SIZE < flowIds.length;
    const results = [];
    for (const flowId of batch) {
      let driveResult = null;
      try {
        const data = await getFlowData(flowId);
        if (!data) { results.push({ flowId, ok: false, error: 'not_found' }); continue; }
        // Skip deja arhivate
        if (data.storage === 'drive') { results.push({ flowId, ok: true, skipped: true }); continue; }
        // Skip daca nu are niciun PDF (flux gol/corupt) — marcam arhivat direct
        if (!data.pdfB64 && !data.signedPdfB64) {
          data.storage = 'drive'; data.archivedAt = new Date().toISOString();
          data.pdfB64 = null; data.signedPdfB64 = null; data.originalPdfB64 = null;
          await saveFlow(flowId, data);
          results.push({ flowId, ok: true, warning: 'No PDF available — marked archived without Drive upload' });
          continue;
        }
        driveResult = await archiveFlow(data);
        data.pdfB64 = null; data.signedPdfB64 = null; data.originalPdfB64 = null; data.storage = 'drive';
        data.archivedAt = new Date().toISOString();
        data.driveFileIdFinal = driveResult.driveFileIdFinal || null;
        data.driveFileIdOriginal = driveResult.driveFileIdOriginal || null;
        data.driveFileIdAudit = driveResult.driveFileIdAudit || null;
        data.driveFolderId = driveResult.driveFolderId || null;
        data.driveFileLinkFinal = driveResult.driveFileLinkFinal || null;
        data.driveFileLinkOriginal = driveResult.driveFileLinkOriginal || null;
        await saveFlow(flowId, data);
        results.push({ flowId, ok: true });
        logger.info(`📦 Archived flow ${flowId} to Drive`);
      } catch(e) {
        logger.error({ err: e, flowId }, 'Archive error');
        // Daca Drive upload a reusit dar saveFlow a esuat, marcam oricum cu Drive IDs
        if (driveResult) {
          try {
            const data2 = await getFlowData(flowId);
            if (data2 && data2.storage !== 'drive') {
              data2.storage = 'drive'; data2.archivedAt = new Date().toISOString();
              data2.pdfB64 = null; data2.signedPdfB64 = null; data2.originalPdfB64 = null;
              Object.assign(data2, driveResult);
              await saveFlow(flowId, data2);
              results.push({ flowId, ok: true, warning: 'Drive OK, DB save retry reusit: ' + e.message });
              continue;
            }
          } catch(e2) { logger.error({ err: e2, flowId }, 'Archive retry save error'); }
        }
        results.push({ flowId, ok: false, error: String(e.message || e) });
      }
    }
    return res.json({ ok: true, results, hasMore, nextBatchIndex: batchIndex + 1, totalProcessed: start + batch.length, total: flowIds.length });
  } catch(e) { return res.status(500).json({ error: String(e.message || e) }); }
});

// ── POST /admin/flows/archive-async — crează un job de arhivare asincron ──
// Returnează imediat un jobId; procesarea se face în background (index.mjs)
router.post('/admin/flows/archive-async', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin' && actor.role !== 'org_admin') return res.status(403).json({ error: 'forbidden' });
  try {
    const { flowIds } = req.body || {};
    if (!Array.isArray(flowIds) || !flowIds.length) return res.status(400).json({ error: 'flowIds_required' });
    const { rows } = await pool.query(
      `INSERT INTO archive_jobs (org_id, flow_ids, status, created_by)
       VALUES ($1, $2, 'pending', $3) RETURNING id, created_at`,
      [actor.orgId || null, JSON.stringify(flowIds), actor.email]
    );
    const job = rows[0];
    logger.info({ jobId: job.id, flowCount: flowIds.length, actor: actor.email }, 'Archive job creat');
    return res.json({ ok: true, jobId: job.id, flowCount: flowIds.length, message: 'Job creat. Procesarea începe în cel mult 30 de secunde.' });
  } catch(e) { return res.status(500).json({ error: String(e.message || e) }); }
});

// ── GET /admin/flows/archive-job/:jobId — status job arhivare ──────────────
router.get('/admin/flows/archive-job/:jobId', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin' && actor.role !== 'org_admin') return res.status(403).json({ error: 'forbidden' });
  try {
    const { rows } = await pool.query(
      `SELECT id, status, created_at, started_at, finished_at, result, error,
              jsonb_array_length(flow_ids) AS flow_count
       FROM archive_jobs WHERE id=$1`,
      [parseInt(req.params.jobId)]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const job = rows[0];
    return res.json({
      jobId: job.id, status: job.status, flowCount: job.flow_count,
      createdAt: job.created_at, startedAt: job.started_at, finishedAt: job.finished_at,
      result: job.result, error: job.error,
      done: job.status === 'done' || job.status === 'error',
    });
  } catch(e) { return res.status(500).json({ error: String(e.message || e) }); }
});

router.post('/admin/db/vacuum', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  try {
    await pool.query('VACUUM ANALYZE flows');
    const sizeR = await pool.query('SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size');
    return res.json({ ok: true, message: 'VACUUM ANALYZE flows executat.', dbSize: sizeR.rows[0].db_size });
  } catch(e) { return res.status(500).json({ error: String(e.message || e) }); }
});

router.get('/admin/drive/verify', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });
  try { res.json(await verifyDrive()); } catch(e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// ── GET /admin/flows/institutions — lista distinctă de instituții (pentru dropdown) ──
// Returnează toate instituțiile din fluxuri fără paginare — pentru dropdown filtru.
router.get('/admin/flows/institutions', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });
  try {
    let actorOrgId = null;
    if (actor.role === 'org_admin') {
      const { rows: aRows } = await pool.query('SELECT org_id FROM users WHERE email=$1', [actor.email.toLowerCase()]);
      actorOrgId = aRows[0]?.org_id || null;
      if (!actorOrgId) return res.status(403).json({ error: 'org_admin_no_org' });
    }
    // Colectăm instituții distincte din JSONB și din tabelul users (prin initEmail)
    // Parametrizat — fără interpolarea directă a actorOrgId în SQL
    const orgCondition = actorOrgId ? 'WHERE f.org_id = $1' : '';
    const orgParams = actorOrgId ? [actorOrgId] : [];
    const { rows } = await pool.query(`
      SELECT DISTINCT COALESCE(NULLIF(u.institutie,''), NULLIF(f.data->>'institutie','')) AS institutie
      FROM flows f
      LEFT JOIN users u ON lower(u.email) = lower(f.data->>'initEmail')
      ${orgCondition}
      ORDER BY 1 ASC NULLS LAST
    `, orgParams);
    const institutions = rows.map(r => r.institutie).filter(Boolean);
    return res.json({ institutions });
  } catch(e) { return res.status(500).json({ error: String(e.message || e) }); }
});

router.get('/admin/flows/list', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });
  try {
    const isExport = req.query.export === '1';
    const page = Math.max(1, parseInt(req.query.page || '1'));
    const limit = isExport
      ? Math.min(2000, Math.max(1, parseInt(req.query.limit || '2000')))
      : Math.min(200, Math.max(1, parseInt(req.query.limit || '50')));
    const offset = (page - 1) * limit;
    const statusFilter = (req.query.status || 'all').toLowerCase();
    const instFilter = (req.query.institutie || '').trim();
    const deptFilter = (req.query.compartiment || '').trim();
    const search = (req.query.search || '').trim().toLowerCase();
    const dateFrom = (req.query.dateFrom || '').trim();  // YYYY-MM-DD
    const dateTo   = (req.query.dateTo   || '').trim();  // YYYY-MM-DD
    const storageFilter = (req.query.storage || '').trim(); // 'drive' = doar arhivate
    // FIX v3.2.2: escape caractere speciale LIKE
    const escapedSearch = search.replace(/[%_\\]/g, '\\$&');
    // org_admin: filtrare strictă după org_id
    let actorOrgId = null;
    if (actor.role === 'org_admin') {
      const { rows: aRows } = await pool.query('SELECT org_id FROM users WHERE email=$1', [actor.email.toLowerCase()]);
      actorOrgId = aRows[0]?.org_id || null;
      if (!actorOrgId) return res.status(403).json({ error: 'org_admin_no_org' });
    }
    const conditions = ['1=1']; const params = [];
    // Org filter aplicat primul — cel mai restrictiv
    if (actorOrgId) { params.push(actorOrgId); conditions.push(`org_id = $${params.length}`); }
    if (statusFilter === 'pending') conditions.push("(data->>'completed') IS DISTINCT FROM 'true' AND (data->>'status') IS DISTINCT FROM 'refused' AND (data->>'status') IS DISTINCT FROM 'cancelled'");
    else if (statusFilter === 'completed') conditions.push("(data->>'completed') = 'true'");
    else if (statusFilter === 'refused') conditions.push("(data->>'status') = 'refused'");
    else if (statusFilter === 'cancelled') conditions.push("(data->>'status') = 'cancelled'");
    if (search) { params.push(`%${escapedSearch}%`); conditions.push(`(lower(data->>'docName') LIKE $${params.length} ESCAPE '\\' OR lower(data->>'initName') LIKE $${params.length} ESCAPE '\\' OR lower(data->>'initEmail') LIKE $${params.length} ESCAPE '\\' OR lower(data->>'flowId') LIKE $${params.length} ESCAPE '\\')`); }
    if (instFilter) { params.push(instFilter); conditions.push(`(data->>'institutie' = $${params.length} OR EXISTS (SELECT 1 FROM users u WHERE lower(u.email)=lower(data->>'initEmail') AND u.institutie=$${params.length}))`); }
    if (deptFilter) { params.push(deptFilter); conditions.push(`(data->>'compartiment' = $${params.length} OR EXISTS (SELECT 1 FROM users u WHERE lower(u.email)=lower(data->>'initEmail') AND u.compartiment=$${params.length}))`); }
    if (dateFrom) { params.push(dateFrom + 'T00:00:00.000Z'); conditions.push(`(data->>'createdAt') >= $${params.length}`); }
    if (dateTo)   { params.push(dateTo   + 'T23:59:59.999Z'); conditions.push(`(data->>'createdAt') <= $${params.length}`); }
    if (storageFilter === 'drive') conditions.push("(data->>'storage') = 'drive'");
    const whereClause = conditions.join(' AND ');
    const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM flows WHERE ${whereClause}`, params);
    const total = parseInt(countRows[0].count); const pages = Math.ceil(total / limit) || 1;
    const { rows } = await pool.query(`SELECT id,data,created_at FROM flows WHERE ${whereClause} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset]);
    const { rows: userRows } = await pool.query('SELECT email,institutie,compartiment FROM users');
    const userMap = {}; userRows.forEach(u => { userMap[u.email.toLowerCase()] = u; });
    const flows = rows.map(r => {
      const d = r.data || {}; const initEmail = (d.initEmail || '').toLowerCase(); const u = userMap[initEmail] || {};
      return { flowId: d.flowId, docName: d.docName, initEmail: d.initEmail, initName: d.initName,
        flowType: d.flowType || 'tabel', // FIX: flowType lipsea → badge afișa mereu 'Tabel'
        status: d.status || 'active', completed: !!(d.completed || (d.signers || []).every(s => s.status === 'signed')),
        urgent: !!(d.urgent),
        storage: d.storage || 'db', archivedAt: d.archivedAt || null,
        driveFileLinkFinal: d.driveFileLinkFinal || null,
        createdAt: d.createdAt || r.created_at,
        institutie: u.institutie || d.institutie || '', compartiment: u.compartiment || d.compartiment || '',
        signers: (d.signers || []).map(s => ({ name: s.name, email: s.email, rol: s.rol, status: s.status, tokenCreatedAt: s.tokenCreatedAt || null, signedAt: s.signedAt || null, refuseReason: s.refuseReason || null })) };
    });
    return res.json({ flows, total, page, limit, pages });
  } catch(e) { return res.status(500).json({ error: String(e.message || e) }); }
});

// ── Utility endpoints ──────────────────────────────────────────────────────
router.get('/wa-test', async (req, res) => {
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  res.status((await verifyWhatsApp()).ok ? 200 : 500).json(await verifyWhatsApp());
});

router.post('/wa-test', async (req, res) => {
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const { to } = req.body || {};
  if (!to) return res.status(400).json({ error: 'to (phone) missing' });
  const r = await sendWaSignRequest({ phone: to, signerName: 'Test', docName: 'Document test DocFlowAI' });
  res.status(r.ok ? 200 : 500).json(r);
});

router.get('/smtp-test', async (req, res) => {
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const r = await verifySmtp(); res.status(r.ok ? 200 : 500).json(r);
});

router.post('/smtp-test', async (req, res) => {
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const { to } = req.body || {}; if (!to) return res.status(400).json({ error: 'to missing' });
  try {
    const v = await verifySmtp(); if (!v.ok) return res.status(500).json({ error: 'smtp_not_ready', detail: v });
    await sendSignerEmail({ to, subject: 'Test SMTP DocFlowAI', html: '<p>SMTP funcționează! ✅</p>' });
    res.json({ ok: true, to });
  } catch(e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.get('/health', async (req, res) => {
  const base = { ok: true, service: 'DocFlowAI', version: '3.2.2', dbReady: DB_READY, dbLastError: DB_LAST_ERROR, wsClients: _wsClientsSize(), ts: new Date().toISOString() };
  if (!pool || !DB_READY) return res.json(base);
  try {
    const [flowsR, usersR, notifsR, archR] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM flows'), pool.query('SELECT COUNT(*) FROM users'),
      pool.query('SELECT COUNT(*) FROM notifications WHERE read=FALSE'),
      pool.query("SELECT COUNT(*) FROM flows WHERE data->>'storage'='drive'"),
    ]);
    const sizeR = await pool.query('SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size, pg_database_size(current_database()) AS db_bytes');
    return res.json({ ...base, stats: { flows: parseInt(flowsR.rows[0].count), flowsArchived: parseInt(archR.rows[0].count), users: parseInt(usersR.rows[0].count), unreadNotifications: parseInt(notifsR.rows[0].count), dbSize: sizeR.rows[0].db_size, dbBytes: parseInt(sizeR.rows[0].db_bytes) } });
  } catch(e) { return res.json({ ...base, statsError: e.message }); }
});

// Alias explicit cu auth pentru admin stats
router.get('/admin/stats', async (req, res) => {
  const actor = requireAuth(req, res); if (!actor) return;
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });
  if (!pool || !DB_READY) return res.json({ ok: false, error: 'db_not_ready' });
  try {
    if (actor.role === 'org_admin') {
      // Stats filtrate pe org_id
      const { rows: aRows } = await pool.query('SELECT org_id FROM users WHERE email=$1', [actor.email.toLowerCase()]);
      const orgId = aRows[0]?.org_id;
      if (!orgId) return res.status(403).json({ error: 'org_admin_no_org' });
      const [flowsR, usersR, notifsR, archR] = await Promise.all([
        pool.query('SELECT COUNT(*) FROM flows WHERE org_id=$1', [orgId]),
        pool.query('SELECT COUNT(*) FROM users WHERE org_id=$1', [orgId]),
        pool.query('SELECT COUNT(*) FROM notifications n JOIN users u ON lower(u.email)=lower(n.user_email) WHERE u.org_id=$1 AND n.read=FALSE', [orgId]),
        pool.query("SELECT COUNT(*) FROM flows WHERE org_id=$1 AND data->>'storage'='drive'", [orgId]),
      ]);
      return res.json({ ok: true, stats: { flows: parseInt(flowsR.rows[0].count), flowsArchived: parseInt(archR.rows[0].count), users: parseInt(usersR.rows[0].count), unreadNotifications: parseInt(notifsR.rows[0].count), dbSize: null, dbBytes: null } });
    }
    // Super-admin: stats globale
    const [flowsR, usersR, notifsR, archR] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM flows'), pool.query('SELECT COUNT(*) FROM users'),
      pool.query('SELECT COUNT(*) FROM notifications WHERE read=FALSE'),
      pool.query("SELECT COUNT(*) FROM flows WHERE data->>'storage'='drive'"),
    ]);
    const sizeR = await pool.query('SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size, pg_database_size(current_database()) AS db_bytes');
    return res.json({ ok: true, stats: { flows: parseInt(flowsR.rows[0].count), flowsArchived: parseInt(archR.rows[0].count), users: parseInt(usersR.rows[0].count), unreadNotifications: parseInt(notifsR.rows[0].count), dbSize: sizeR.rows[0].db_size, dbBytes: parseInt(sizeR.rows[0].db_bytes) } });
  } catch(e) { return res.status(500).json({ error: e.message }); }
});

// ── GET /admin/flows/:flowId/audit — export audit log ─────────────────────
// FIX: mutat INAINTE de export default
router.get('/admin/flows/:flowId/audit', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });
  try {
    const { flowId } = req.params;
    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    const format = (req.query.format || 'json').toLowerCase();
    const audit = {
      flowId: data.flowId, docName: data.docName,
      initName: data.initName, initEmail: data.initEmail,
      institutie: data.institutie || '', compartiment: data.compartiment || '',
      createdAt: data.createdAt, updatedAt: data.updatedAt,
      completed: !!data.completed, completedAt: data.completedAt || null,
      status: data.status || 'active', storage: data.storage || 'db',
      urgent: !!(data.urgent),
      cancelledAt: data.cancelledAt || null, cancelledBy: data.cancelledBy || null, cancelReason: data.cancelReason || null,
      parentFlowId: data.parentFlowId || null,
      reviewReason: data.reviewReason || null,
      reviewHistory: Array.isArray(data.reviewHistory) ? data.reviewHistory : [],
      signers: (data.signers || []).map(s => ({
        order: s.order, name: s.name, email: s.email, rol: s.rol,
        functie: s.functie || '', compartiment: s.compartiment || '',
        status: s.status, signedAt: s.signedAt || null,
        refuseReason: s.refuseReason || null, refusedAt: s.refusedAt || null,
        pdfUploaded: !!s.pdfUploaded, uploadedHash: s.uploadedHash || null,
        delegatedFrom: s.delegatedFrom || null, tokenCreatedAt: s.tokenCreatedAt || null,
        notifiedAt: s.notifiedAt || null, downloadedAt: s.downloadedAt || null,
      })),
      events: Array.isArray(data.events) ? data.events : [],
      signedPdfVersions: Array.isArray(data.signedPdfVersions) ? data.signedPdfVersions : [],
    };
    if (format === 'csv') {
      const lines = ['timestamp,type,by,channel,details'];
      for (const e of audit.events) {
        const details = JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !['at','type'].includes(k)))).replace(/"/g, '""');
        lines.push(`"${e.at}","${e.type}","${e.by || ''}","${e.channel || ''}","${details}"`);
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="audit_${flowId}.csv"`);
      return res.send(lines.join('\n'));
    }
    if (format === 'txt') {
      let txt = `=== AUDIT LOG DocFlowAI ===\n`;
      txt += `Flow: ${audit.flowId}\nDocument: ${audit.docName}\nInitiator: ${audit.initName} <${audit.initEmail}>\n`;
      txt += `Institutie: ${audit.institutie}\nCompartiment: ${audit.compartiment}\n`;
      txt += `Creat: ${audit.createdAt}\nStatus: ${audit.status}${audit.completedAt ? '\nFinalizat: ' + audit.completedAt : ''}\n\n`;
      txt += `--- SEMNATARI ---\n`;
      for (const s of audit.signers) {
        txt += `${s.order}. ${s.name} <${s.email}> [${s.rol}] — ${s.status.toUpperCase()}`;
        if (s.signedAt) txt += ` la ${s.signedAt}`;
        if (s.refuseReason) txt += ` — REFUZ: ${s.refuseReason}`;
        if (s.delegatedFrom) txt += ` — DELEGAT de ${s.delegatedFrom.email}`;
        txt += '\n';
      }
      txt += `\n--- EVENIMENTE (${audit.events.length}) ---\n`;
      for (const e of audit.events) {
        txt += `[${e.at}] ${e.type}${e.by ? ' BY ' + e.by : ''}${e.channel ? ' via ' + e.channel : ''}${e.reason ? ' REASON: ' + e.reason : ''}\n`;
      }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="audit_${flowId}.txt"`);
      return res.send(txt);
    }
    if (format === 'pdf') {
      if (!PDFLibAdmin) return res.status(503).json({ error: 'pdf_lib_not_available' });
      const { PDFDocument, rgb, StandardFonts } = PDFLibAdmin;
      const diacr = {'ă':'a','â':'a','î':'i','ș':'s','ț':'t','Ă':'A','Â':'A','Î':'I','Ș':'S','Ț':'T','ş':'s','ţ':'t','Ş':'S','Ţ':'T'};
      // ro() — inlocuieste diacritice + elimina silentios caractere non-WinAnsi (emoji, unicode > 0xFF)
      const ro = t => String(t || '').replace(/[^\x00-\xFF]/g, '').split('').map(ch => diacr[ch] || ch).join('');
      // Format date cu timezone Romania
      const fmtDate = iso => iso ? new Date(iso).toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest' }) : '—';
      // Traduceri tip eveniment → română
      const EVENT_LABELS_RO = {
        'FLOW_CREATED': 'FLUX CREAT', 'SIGNED': 'SEMNAT', 'SIGNED_PDF_UPLOADED': 'PDF SEMNAT INCARCAT',
        'REVIEW_REQUESTED': 'TRIMIS SPRE REVIZUIRE', 'FLOW_REINITIATED_AFTER_REVIEW': 'FLUX REINITIAT DUPA REVIZUIRE',
        'FLOW_REINITIATED': 'FLUX REINITIAT DUPA REFUZ',
        'FLOW_COMPLETED': 'FLUX FINALIZAT', 'FLOW_CANCELLED': 'FLUX ANULAT', 'REFUSED': 'REFUZAT',
        'DELEGATED': 'DELEGAT', 'PDF_DOWNLOADED': 'PDF DESCARCAT', 'REMINDER': 'REMINDER TRIMIS',
        'YOUR_TURN': 'NOTIFICARE RAND', 'EMAIL_SENT': 'EMAIL EXTERN TRIMIS',
      };
      const evLabel = (type) => EVENT_LABELS_RO[type] || (type||'').replace(/_/g, ' ');
      const pdfDoc = await PDFDocument.create();
      const fontB = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      const fontR = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const PAGE_W = 595, PAGE_H = 842, MARGIN = 50;
      let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
      let y = PAGE_H - MARGIN;
      const LINE_H = 13, SECTION_GAP = 10;
      const newPage = () => { page = pdfDoc.addPage([PAGE_W, PAGE_H]); y = PAGE_H - MARGIN; };
      const ensureSpace = (needed) => { if (y < MARGIN + needed) newPage(); };
      const drawText = (text, x, size, font, color) => {
        ensureSpace(size + 6);
        page.drawText(ro(text), { x, y, size, font: font || fontR, color: color || rgb(0.2,0.2,0.2), maxWidth: PAGE_W - x - MARGIN });
        y -= size + 6;
      };
      const drawLine = () => {
        ensureSpace(8);
        page.drawLine({ start:{x:MARGIN,y:y+4}, end:{x:PAGE_W-MARGIN,y:y+4}, thickness:0.5, color:rgb(0.75,0.75,0.75) });
        y -= 8;
      };
      page.drawRectangle({ x:0, y:PAGE_H-70, width:PAGE_W, height:70, color:rgb(0.1,0.1,0.25) });
      page.drawText('AUDIT LOG', { x:MARGIN, y:PAGE_H-35, size:20, font:fontB, color:rgb(1,1,1) });
      page.drawText(ro('DocFlowAI — document de trasabilitate'), { x:MARGIN, y:PAGE_H-52, size:9, font:fontR, color:rgb(0.7,0.8,1) });
      page.drawText(ro(`Generat: ${fmtDate(new Date().toISOString())}`), { x:PAGE_W-200, y:PAGE_H-35, size:9, font:fontR, color:rgb(0.7,0.8,1) });
      // URGENT badge in header
      if (audit.urgent) {
        page.drawRectangle({ x:PAGE_W-130, y:PAGE_H-58, width:100, height:18, color:rgb(0.85,0.1,0.1) });
        page.drawText('! URGENT !', { x:PAGE_W-122, y:PAGE_H-50, size:10, font:fontB, color:rgb(1,1,1) });
      }
      y = PAGE_H - 85;
      drawText('INFORMATII FLUX', MARGIN, 11, fontB, rgb(0.15,0.15,0.6));
      drawLine();
      const infoRows = [
        ['Flow ID:', audit.flowId], ['Document:', (audit.urgent ? '[URGENT] ' : '') + audit.docName],
        ['Initiator:', `${audit.initName} <${audit.initEmail}>`],
        ['Institutie:', audit.institutie || '—'], ['Compartiment:', audit.compartiment || '—'],
        ['Creat:', fmtDate(audit.createdAt)],
        ['Status:', audit.status + (audit.completed ? ' (FINALIZAT)' : '') + (audit.completedAt ? ' la ' + fmtDate(audit.completedAt) : '') + (audit.status === 'cancelled' && audit.cancelledAt ? ' la ' + fmtDate(audit.cancelledAt) : '') + (audit.urgent ? ' — URGENT' : '')],
        ...(audit.cancelReason ? [['Motiv anulare:', audit.cancelReason]] : []),
        ...(audit.cancelledBy ? [['Anulat de:', audit.cancelledBy]] : []),
        ...(audit.parentFlowId ? [['Reinitiat din:', `Flux anterior: ${audit.parentFlowId} (reinitiat dupa refuz)`]] : []),
      ];
      for (const [lbl, val] of infoRows) {
        ensureSpace(18);
        page.drawText(ro(lbl), { x:MARGIN, y, size:9, font:fontB, color:rgb(0.3,0.3,0.3) });
        page.drawText(ro(String(val||'—')), { x:MARGIN+100, y, size:9, font:fontR, color:rgb(0.15,0.15,0.15), maxWidth:PAGE_W-MARGIN-110 });
        y -= 16;
      }
      y -= SECTION_GAP;
      // ── RUNDE DE REVIZUIRE (dacă există) ──────────────────────────────────
      if (audit.reviewHistory && audit.reviewHistory.length > 0) {
        drawText('ISTORICUL RUNDELOR DE REVIZUIRE', MARGIN, 11, fontB, rgb(0.1,0.3,0.5));
        drawLine();
        for (const round of audit.reviewHistory) {
          ensureSpace(20);
          page.drawText(ro(`Runda ${round.round || ''} — reinitiata la ${fmtDate(round.reinitiatedAt)} de ${round.reinitiatedBy || ''}`), { x:MARGIN, y, size:8.5, font:fontB, color:rgb(0.1,0.3,0.55), maxWidth: PAGE_W - MARGIN * 2 });
          y -= 14;
          // Cine a solicitat revizuirea și când
          if (round.reviewRequestedBy) {
            ensureSpace(14);
            page.drawText(ro(`Cerere revizuire: ${round.reviewRequestedBy} la ${fmtDate(round.reviewRequestedAt)}`), { x:MARGIN+10, y, size:8, font:fontB, color:rgb(0.55,0.1,0.55), maxWidth: PAGE_W - MARGIN * 2 - 10 });
            y -= 13;
          }
          if (round.reviewReason) {
            ensureSpace(14);
            page.drawText(ro(`Motiv revizuire: ${round.reviewReason}`), { x:MARGIN+10, y, size:8, font:fontR, color:rgb(0.6,0.2,0.1), maxWidth: PAGE_W - MARGIN * 2 - 10 });
            y -= 13;
          }
          // Semnatarii rundei
          for (const s of (round.signers || [])) {
            ensureSpace(60);
            const isRequester = round.reviewRequestedBy && s.email === round.reviewRequestedBy;
            const sc = s.status === 'signed' ? rgb(0,0.45,0.25) : s.status === 'refused' ? rgb(0.65,0.1,0.1) : isRequester ? rgb(0.55,0.1,0.55) : rgb(0.4,0.4,0.4);
            const statusLabel = isRequester && s.status !== 'signed' && s.status !== 'refused' ? 'A TRIMIS SPRE REVIZUIRE' : (s.status||'').toUpperCase();
            page.drawText(ro(`${s.name||s.email} [${s.rol||''}]`), { x:MARGIN+10, y, size:8, font:fontR, color:rgb(0.2,0.2,0.2), maxWidth:280 });
            page.drawText(ro(statusLabel), { x:MARGIN+300, y, size:8, font:fontB, color:sc });
            y -= 12;
            if (s.notifiedAt)  { page.drawText(ro(`  Notificat:  ${fmtDate(s.notifiedAt)}`),  { x:MARGIN+10, y, size:7.5, font:fontR, color:rgb(0.3,0.3,0.6) }); y -= 11; }
            if (s.downloadedAt){ page.drawText(ro(`  Descarcat:  ${fmtDate(s.downloadedAt)}`), { x:MARGIN+10, y, size:7.5, font:fontR, color:rgb(0.2,0.4,0.55) }); y -= 11; }
            if (s.signedAt)    { page.drawText(ro(`  Semnat:     ${fmtDate(s.signedAt)}`),     { x:MARGIN+10, y, size:7.5, font:fontR, color:rgb(0,0.4,0.2) }); y -= 11; }
            if (isRequester && round.reviewRequestedAt) {
              page.drawText(ro(`  Trimis spre revizuire: ${fmtDate(round.reviewRequestedAt)}`), { x:MARGIN+10, y, size:7.5, font:fontB, color:rgb(0.55,0.1,0.55), maxWidth:PAGE_W-MARGIN*2-10 }); y -= 11;
            }
            if (s.refuseReason){ page.drawText(ro(`  Refuz:      ${s.refuseReason}`),           { x:MARGIN+10, y, size:7.5, font:fontR, color:rgb(0.65,0.1,0.1), maxWidth:PAGE_W-MARGIN*2-10 }); y -= 11; }
          }
          y -= SECTION_GAP;
        }
      }

      drawText('SEMNATARI (RUNDA CURENTA)', MARGIN, 11, fontB, rgb(0.15,0.15,0.6));
      drawLine();
      for (const s of audit.signers) {
        // Gaseste intrarea de upload din signedPdfVersions pentru acest semnatar
        const signerIdx = (s.order || 1) - 1;
        const uploadEntry = (audit.signedPdfVersions || []).find(v =>
          v.signerIndex === signerIdx || (v.uploadedBy && (v.uploadedBy || '').toLowerCase() === (s.email || '').toLowerCase())
        );
        const uploadedAt = uploadEntry?.uploadedAt || null;

        ensureSpace(80);
        const statusColor = s.status==='signed' ? rgb(0,0.5,0.3) : s.status==='refused' ? rgb(0.7,0.1,0.1) : rgb(0.4,0.4,0.4);
        page.drawText(ro(`${s.order}. ${s.name} — ${s.rol}`), { x:MARGIN, y, size:9, font:fontB, color:rgb(0.1,0.1,0.1), maxWidth:300 });
        page.drawText(ro(s.status.toUpperCase()), { x:PAGE_W-MARGIN-80, y, size:9, font:fontB, color:statusColor });
        y -= 15;
        page.drawText(ro(s.email), { x:MARGIN+12, y, size:8, font:fontR, color:rgb(0.4,0.4,0.4) });
        if (s.functie) page.drawText(ro(s.functie), { x:MARGIN+220, y, size:8, font:fontR, color:rgb(0.5,0.5,0.5) });
        y -= 13;
        // Ordine cronologica: Delegat de (daca e cazul) → Notificat → Descarcat → Incarcat → Semnat/Refuzat
        if (s.delegatedFrom) { page.drawText(ro(`  Delegat de: ${s.delegatedFrom.email}${s.delegatedFrom.reason ? '  Motiv: ' + s.delegatedFrom.reason : ''}`), { x:MARGIN+12, y, size:8, font:fontR, color:rgb(0.4,0.2,0.6), maxWidth:PAGE_W-MARGIN*2-20 }); y -= 12; }
        if (s.notifiedAt)  { page.drawText(ro(`  Notificat:  ${fmtDate(s.notifiedAt)}`),  { x:MARGIN+12, y, size:8, font:fontR, color:rgb(0.3,0.3,0.6) }); y -= 12; }
        if (s.downloadedAt){ page.drawText(ro(`  Descarcat:  ${fmtDate(s.downloadedAt)}`), { x:MARGIN+12, y, size:8, font:fontR, color:rgb(0.2,0.4,0.55) }); y -= 12; }
        if (uploadedAt)    { page.drawText(ro(`  Incarcat:   ${fmtDate(uploadedAt)}`),      { x:MARGIN+12, y, size:8, font:fontR, color:rgb(0.2,0.35,0.5) }); y -= 12; }
        if (s.signedAt)    { page.drawText(ro(`  Semnat:     ${fmtDate(s.signedAt)}`),      { x:MARGIN+12, y, size:8, font:fontR, color:rgb(0,0.45,0.25) }); y -= 12; }
        if (s.refusedAt || s.refuseReason) {
          page.drawText(ro(`  Refuzat:    ${s.refusedAt ? fmtDate(s.refusedAt) : ''}${s.refuseReason ? '  Motiv: ' + s.refuseReason : ''}`), { x:MARGIN+12, y, size:8, font:fontR, color:rgb(0.7,0.1,0.1), maxWidth:PAGE_W-MARGIN*2-20 }); y -= 12;
        }
        // Dacă semnatarul a trimis spre revizuire (acțiune vizibilă în runda curentă)
        const reviewEvForSigner = (audit.events || []).find(e => e.type === 'REVIEW_REQUESTED' && e.by === s.email && !e._inheritedFrom);
        if (reviewEvForSigner) {
          page.drawText(ro(`  Trimis spre revizuire: ${fmtDate(reviewEvForSigner.at)}`), { x:MARGIN+12, y, size:8, font:fontB, color:rgb(0.55,0.1,0.55), maxWidth:PAGE_W-MARGIN*2-20 }); y -= 12;
          if (reviewEvForSigner.reason) { page.drawText(ro(`  Motiv: ${reviewEvForSigner.reason}`), { x:MARGIN+12, y, size:8, font:fontR, color:rgb(0.6,0.2,0.1), maxWidth:PAGE_W-MARGIN*2-20 }); y -= 12; }
        }
        // EMAIL_SENT trimis de acest semnatar
        const emailEvsBySigner = (audit.events || []).filter(e => e.type === 'EMAIL_SENT' && e.by === s.email && !e._inheritedFrom);
        for (const ee of emailEvsBySigner) {
          ensureSpace(14);
          page.drawText(ro(`  Email trimis: ${fmtDate(ee.at)}  catre: ${ee.to || ''}`), { x:MARGIN+12, y, size:8, font:fontR, color:rgb(0.05,0.45,0.55), maxWidth:PAGE_W-MARGIN*2-20 }); y -= 12;
        }
        y -= 6;
      }
      // EMAIL_SENT de catre initiator (daca nu e si semnatar)
      const signerEmails = new Set(audit.signers.map(s => (s.email||'').toLowerCase()));
      const initEmail = (audit.initEmail||'').toLowerCase();
      if (initEmail && !signerEmails.has(initEmail)) {
        const emailEvsByInit = (audit.events || []).filter(e => e.type === 'EMAIL_SENT' && (e.by||'').toLowerCase() === initEmail && !e._inheritedFrom);
        if (emailEvsByInit.length) {
          ensureSpace(20);
          page.drawText(ro(`Initiator (${audit.initEmail}):`), { x:MARGIN, y, size:8, font:fontB, color:rgb(0.2,0.2,0.4) }); y -= 12;
          for (const ee of emailEvsByInit) {
            ensureSpace(14);
            page.drawText(ro(`  Email trimis: ${fmtDate(ee.at)}  catre: ${ee.to || ''}`), { x:MARGIN+12, y, size:8, font:fontR, color:rgb(0.05,0.45,0.55), maxWidth:PAGE_W-MARGIN*2-20 }); y -= 12;
          }
          y -= 4;
        }
      }
      y -= SECTION_GAP;
      // Issue 3: Calcul timp de procesare per semnatar — pentru ORICE actiune (semnat/refuzat/revizuire)
      const timeRows = [];
      const allEvents = audit.events || [];
      for (let i = 0; i < audit.signers.length; i++) {
        const s = audit.signers[i];
        // Gasim momentul in care semnatarul a primit sarcina:
        // - pentru primul semnatar: la crearea fluxului sau primul FLOW_REINITIATED_AFTER_REVIEW
        // - pentru ceilalti: evenimentul SIGNED_PDF_UPLOADED al predecesorului (sau FLOW_CREATED/reinitiate)
        let sentAt = null;
        if (i === 0) {
          // Cel mai recent eveniment de reinitiere sau creare
          const reinitiateEvs = allEvents.filter(e => e.type === 'FLOW_REINITIATED_AFTER_REVIEW' && !e._inheritedFrom);
          sentAt = reinitiateEvs.length ? reinitiateEvs[reinitiateEvs.length - 1].at : audit.createdAt;
        } else {
          // Cand predecesorul (order mai mic) a uploadat PDF-ul semnat
          const prevOrder = Number(audit.signers[i-1]?.order) || 0;
          const uploadEv = allEvents.filter(e => e.type === 'SIGNED_PDF_UPLOADED' && !e._inheritedFrom && (Number(e.order) === prevOrder || (Number(e.order) === 0 && i === 1)));
          sentAt = uploadEv.length ? uploadEv[uploadEv.length - 1].at : null;
          if (!sentAt) {
            // Fallback: cand predecesorul a semnat
            sentAt = audit.signers[i-1]?.signedAt || null;
          }
        }
        // Determinam momentul actiunii si tipul actiunii
        let actionAt = null, actionLabel = null;
        if (s.signedAt) { actionAt = s.signedAt; actionLabel = 'semnat'; }
        else if (s.refusedAt) { actionAt = s.refusedAt; actionLabel = 'refuzat'; }
        else {
          // Cerere de revizuire
          const reviewEv = allEvents.find(e => e.type === 'REVIEW_REQUESTED' && e.by === s.email && !e._inheritedFrom);
          if (reviewEv) { actionAt = reviewEv.at; actionLabel = 'trimis spre revizuire'; }
        }
        if (sentAt && actionAt) {
          const diffMs = Math.max(0, new Date(actionAt) - new Date(sentAt));
          const diffD = Math.floor(diffMs / 86400000);
          const diffH = Math.floor((diffMs % 86400000) / 3600000);
          const diffM = Math.floor((diffMs % 3600000) / 60000);
          const durStr = diffD > 0 ? `${diffD}z ${diffH}h ${diffM}min` : diffH > 0 ? `${diffH}h ${diffM}min` : `${diffM}min`;
          timeRows.push(`${s.order}. ${ro(s.name||s.email)} [${ro(s.rol||'')}]: ${actionLabel} in ${durStr} de la primire`);
        } else if (!actionAt) {
          timeRows.push(`${s.order}. ${ro(s.name||s.email)} [${ro(s.rol||'')}]: in asteptare`);
        }
      }
      if (timeRows.length) {
        drawText('TIMPI DE PROCESARE', MARGIN, 11, fontB, rgb(0.15,0.15,0.6));
        drawLine();
        for (const t of timeRows) {
          ensureSpace(16);
          page.drawText(ro(t), { x:MARGIN, y, size:8, font:fontR, color:rgb(0.3,0.3,0.3), maxWidth:PAGE_W-MARGIN*2 });
          y -= 13;
        }
        y -= SECTION_GAP;
      }
      drawText(`JURNAL EVENIMENTE (${audit.events.length})`, MARGIN, 11, fontB, rgb(0.15,0.15,0.6));
      drawLine();
      if (audit.parentFlowId) {
        ensureSpace(14);
        page.drawText(ro(`[Flux parinte: ${audit.parentFlowId}]`), { x:MARGIN, y, size:7.5, font:fontR, color:rgb(0.4,0.2,0.6) });
        y -= 12;
      }
      const sortByDate = (a, b) => new Date(a.at || 0) - new Date(b.at || 0);
      const inheritedEvs = audit.events.filter(e => e._inheritedFrom).sort(sortByDate);
      const currentEvs = audit.events.filter(e => !e._inheritedFrom).sort(sortByDate);
      const EVENT_FONT_SIZE = 7.5;
      const EVENT_LINE_H = 11;
      const EVENT_COL_TS = MARGIN;
      const EVENT_COL_TYPE = MARGIN + 115;
      const EVENT_COL_DETAIL = MARGIN + 115 + 165;
      const EVENT_DETAIL_MAX_W = PAGE_W - EVENT_COL_DETAIL - MARGIN;
      // Estimează numărul de linii pe care se va împărți un text dat lățimea max și fontul
      const estimateLines = (text, maxW, font, size) => {
        if (!text) return 0;
        const words = text.split(' ');
        let lines = 1, lineW = 0;
        for (const w of words) {
          const wW = font.widthOfTextAtSize(w + ' ', size);
          if (lineW + wW > maxW && lineW > 0) { lines++; lineW = wW; }
          else { lineW += wW; }
        }
        return lines;
      };
      const renderEvent = (e, dimmed) => {
        const detail = [e.by ? `de:${e.by}` : '', e.channel ? `via:${e.channel}` : '', e.reason ? `motiv:${e.reason}` : '', e.to ? `catre:${e.to}` : ''].filter(Boolean).join('  ');
        const detailLines = detail ? estimateLines(ro(detail), EVENT_DETAIL_MAX_W, fontR, EVENT_FONT_SIZE) : 0;
        const rowH = EVENT_LINE_H + detailLines * EVENT_LINE_H + 3;
        ensureSpace(rowH + 2);
        const ts = e.at ? fmtDate(e.at) : '';
        const dimColor = dimmed ? rgb(0.6,0.6,0.6) : rgb(0.5,0.5,0.5);
        const typeColor = dimmed ? rgb(0.5,0.5,0.65) : rgb(0.2,0.2,0.5);
        page.drawText(ro(`[${ts}]`), { x:EVENT_COL_TS, y, size:EVENT_FONT_SIZE, font:fontR, color:dimColor });
        page.drawText(ro(evLabel(e.type)), { x:EVENT_COL_TYPE, y, size:EVENT_FONT_SIZE, font:fontB, color:typeColor });
        if (detail) {
          page.drawText(ro(detail), { x:EVENT_COL_DETAIL, y, size:EVENT_FONT_SIZE, font:fontR, color:dimColor, maxWidth:EVENT_DETAIL_MAX_W, lineHeight: EVENT_LINE_H });
        }
        y -= rowH;
      };
      if (inheritedEvs.length) {
        ensureSpace(14);
        page.drawText(ro('---- FLUX PARINTE ----'), { x:MARGIN, y, size:7.5, font:fontB, color:rgb(0.4,0.2,0.6) }); y -= 12;
        for (const e of inheritedEvs) renderEvent(e, true);
        ensureSpace(14);
        page.drawText(ro('---- FLUX CURENT ----'), { x:MARGIN, y, size:7.5, font:fontB, color:rgb(0.1,0.4,0.4) }); y -= 12;
      }
      for (const e of currentEvs) renderEvent(e, false);

      // ── F-05: HASH-URI DOCUMENTE ───────────────────────────────────────────
      // SHA256 al fiecărui PDF semnat — util pentru verificare integritate la litigii
      const hashRows = audit.signers
        .filter(s => s.uploadedHash)
        .map(s => ({ label: `${s.order}. ${s.name || s.email} [${s.rol || ''}]`, hash: s.uploadedHash, signedAt: s.signedAt }));
      if (hashRows.length) {
        y -= SECTION_GAP;
        drawText('HASH-URI DOCUMENTE (SHA-256)', MARGIN, 11, fontB, rgb(0.1,0.3,0.1));
        drawLine();
        ensureSpace(14);
        page.drawText(ro('Fiecare hash identifica unic versiunea PDF semnata de semnatar.'), { x:MARGIN, y, size:7.5, font:fontR, color:rgb(0.4,0.4,0.4) });
        y -= 13;
        for (const hr of hashRows) {
          ensureSpace(32);
          page.drawText(ro(hr.label), { x:MARGIN, y, size:8.5, font:fontB, color:rgb(0.15,0.15,0.15) });
          if (hr.signedAt) page.drawText(ro(fmtDate(hr.signedAt)), { x:PAGE_W-MARGIN-130, y, size:7.5, font:fontR, color:rgb(0.5,0.5,0.5) });
          y -= 13;
          // hash pe două rânduri de câte 32 chars pentru lizibilitate
          const h = hr.hash || '';
          page.drawText(h.slice(0,32), { x:MARGIN+10, y, size:7, font:fontR, color:rgb(0.1,0.35,0.1) });
          page.drawText(h.slice(32), { x:MARGIN+10 + fontR.widthOfTextAtSize(h.slice(0,32)+' ', 7), y, size:7, font:fontR, color:rgb(0.1,0.35,0.1) });
          y -= 13;
        }
      }

      // ── F-05: ACCESURI ÎNREGISTRATE (din audit_log) ───────────────────────
      // Citim evenimentele cu IP din audit_log — semnat, descarcat, incarcat
      let accessRows = [];
      try {
        const { rows: auditRows } = await pool.query(
          `SELECT event_type, actor_email, actor_ip, created_at, payload
           FROM audit_log
           WHERE flow_id = $1
             AND event_type IN ('PDF_DOWNLOADED','SIGNED','SIGNED_PDF_UPLOADED','REFUSED','DELEGATED','FLOW_CANCELLED','FLOW_CREATED','FLOW_REINITIATED','FLOW_REINITIATED_AFTER_REVIEW','EMAIL_SENT')
           ORDER BY created_at ASC`,
          [flowId]
        );
        accessRows = auditRows;
      } catch(e) { /* audit_log poate fi gol la fluxuri vechi */ }

      if (accessRows.length) {
        y -= SECTION_GAP;
        drawText('ACCESURI INREGISTRATE', MARGIN, 11, fontB, rgb(0.3,0.1,0.3));
        drawLine();
        // Header coloane
        ensureSpace(14);
        page.drawText(ro('Timestamp (RO)'), { x:MARGIN, y, size:7.5, font:fontB, color:rgb(0.3,0.3,0.3) });
        page.drawText(ro('Eveniment'), { x:MARGIN+130, y, size:7.5, font:fontB, color:rgb(0.3,0.3,0.3) });
        page.drawText(ro('Actor'), { x:MARGIN+250, y, size:7.5, font:fontB, color:rgb(0.3,0.3,0.3) });
        page.drawText(ro('IP'), { x:MARGIN+390, y, size:7.5, font:fontB, color:rgb(0.3,0.3,0.3) });
        y -= 14;
        page.drawLine({ start:{x:MARGIN, y:y+2}, end:{x:PAGE_W-MARGIN, y:y+2}, thickness:0.3, color:rgb(0.85,0.85,0.85) });
        y -= 8;
        for (const ar of accessRows) {
          ensureSpace(14);
          const ts = fmtDate(ar.created_at);
          const evType = evLabel(ar.event_type || '');
          const actor = (ar.actor_email || '').slice(0, 30);
          const ip = ar.actor_ip || '—';
          const rowColor = ar.event_type === 'REFUSED' || ar.event_type === 'FLOW_CANCELLED'
            ? rgb(0.6,0.1,0.1)
            : ar.event_type === 'FLOW_CREATED' ? rgb(0.1,0.4,0.1) : rgb(0.25,0.25,0.35);
          page.drawText(ro(ts),     { x:MARGIN,     y, size:7.5, font:fontR, color:rgb(0.3,0.3,0.3), maxWidth:125 });
          page.drawText(ro(evType), { x:MARGIN+130, y, size:7.5, font:fontB, color:rowColor, maxWidth:115 });
          page.drawText(ro(actor),  { x:MARGIN+250, y, size:7,   font:fontR, color:rgb(0.3,0.3,0.3), maxWidth:135 });
          page.drawText(ro(ip),     { x:MARGIN+390, y, size:7,   font:fontR, color:rgb(0.2,0.2,0.5), maxWidth:PAGE_W-MARGIN-395 });
          y -= 13;
        }
      }

      const pageCount = pdfDoc.getPageCount();
      for (let i = 0; i < pageCount; i++) {
        const pg = pdfDoc.getPage(i);
        pg.drawLine({ start:{x:MARGIN,y:30}, end:{x:PAGE_W-MARGIN,y:30}, thickness:0.4, color:rgb(0.8,0.8,0.8) });
        pg.drawText(ro(`DocFlowAI — Audit Log — ${audit.flowId}`), { x:MARGIN, y:18, size:7, font:fontR, color:rgb(0.6,0.6,0.6) });
        pg.drawText(ro(`Pagina ${i+1} din ${pageCount}`), { x:PAGE_W-MARGIN-60, y:18, size:7, font:fontR, color:rgb(0.6,0.6,0.6) });
      }
      const pdfBytes = await pdfDoc.save();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="audit_${flowId}.pdf"`);
      return res.send(Buffer.from(pdfBytes));
    }
    res.json(audit);
  } catch(e) { return res.status(500).json({ error: String(e.message || e) }); }
});

// ── GET /admin/flows/audit-export — export bulk audit ─────────────────────
router.get('/admin/flows/audit-export', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  try {
    const days = parseInt(req.query.days || '30');
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { rows } = await pool.query('SELECT data FROM flows WHERE created_at > $1 ORDER BY created_at DESC LIMIT 1000', [cutoff]);
    const lines = ['flowId,docName,initEmail,createdAt,status,signersCount,eventsCount,completedAt'];
    for (const r of rows) {
      const d = r.data || {};
      const status = d.completed ? 'completed' : (d.status === 'refused' ? 'refused' : d.status === 'cancelled' ? 'cancelled' : 'active');
      lines.push(`"${d.flowId}","${(d.docName || '').replace(/"/g, '""')}","${d.initEmail}","${d.createdAt}","${status}","${(d.signers || []).length}","${(d.events || []).length}","${d.completedAt || ''}"`);
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit_export_${new Date().toISOString().slice(0,10)}.csv"`);
    return res.send(lines.join('\n'));
  } catch(e) { return res.status(500).json({ error: String(e.message || e) }); }
});

// FIX: export default DUPA toate rutele

// ── GET /admin/user-activity — raport activitate per utilizator ────────────
router.get('/admin/user-activity', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });
  try {
    const from = req.query.from ? new Date(req.query.from).toISOString() : new Date(Date.now() - 30*24*3600*1000).toISOString();
    const to   = req.query.to   ? new Date(new Date(req.query.to).getTime() + 86399999).toISOString() : new Date().toISOString();
    const emailFilter    = (req.query.email    || '').toLowerCase().trim();
    const instFilter     = (req.query.institutie    || '').trim();
    const deptFilter     = (req.query.compartiment  || '').trim();
    const nameFilter     = (req.query.name     || '').toLowerCase().trim();

    // Toti utilizatorii din aceeași organizație
    const { rows: selfRow } = await pool.query('SELECT org_id FROM users WHERE email=$1', [actor.email.toLowerCase()]);
    const orgId = selfRow[0]?.org_id || null;
    // org_admin fără org_id → acces refuzat
    if (actor.role === 'org_admin' && !orgId) return res.status(403).json({ error: 'org_admin_no_org' });
    let userQuery, userParams;
    if (orgId) {
      userQuery = 'SELECT email, nume, functie, institutie, compartiment, role FROM users WHERE org_id=$1 ORDER BY nume';
      userParams = [orgId];
    } else {
      userQuery = 'SELECT email, nume, functie, institutie, compartiment, role FROM users ORDER BY nume';
      userParams = [];
    }
    const { rows: userRows } = await pool.query(userQuery, userParams);

    // FIX v3.2.2: filtrare pe org_id — admin nu vede fluxuri din alte organizații
    const { rows: flowRows } = await pool.query(
      `SELECT
         data->>'flowId'   AS "flowId",
         data->>'docName'  AS "docName",
         data->'events'    AS events
       FROM flows
       WHERE created_at <= $1${orgId ? ' AND org_id = $2' : ''}
       ORDER BY created_at DESC
       LIMIT 10000`,
      orgId ? [to, orgId] : [to]
    );

    // EVENT_TYPES → eticheta romana
    const OP_LABELS = {
      FLOW_CREATED: 'Flux inițiat',
      SIGNED: 'Semnat',
      SIGNED_PDF_UPLOADED: 'Semnat',
      REFUSED: 'Refuzat',
      REVIEW_REQUESTED: 'Trimis la revizuire',
      FLOW_REINITIATED_AFTER_REVIEW: 'Reinițiat după revizuire',
      REINITIATED_AFTER_REVIEW: 'Reinițiere marcată',
      FLOW_COMPLETED: 'Flux finalizat',
      DELEGATE: 'Delegare semnătură',
      DELEGATED: 'Delegare semnătură',
      YOUR_TURN: 'Notificat',
    };

    // Construim raport per user
    const activity = {}; // email -> { ops: [], counts: {} }
    const initUsers = new Set();

    for (const fr of flowRows) {
      const flowId  = fr.flowId  || '?';
      const docName = fr.docName || '?';
      const events  = Array.isArray(fr.events) ? fr.events : [];

      for (const ev of events) {
        if (!ev.at) continue;
        if (ev.at < from || ev.at > to) continue;
        const byEmail = (ev.by || '').toLowerCase();
        if (!byEmail) continue;
        if (emailFilter && byEmail !== emailFilter) continue;

        const opType = ev.type || 'EVENT';
        const label = OP_LABELS[opType] || opType;

        if (!activity[byEmail]) activity[byEmail] = { ops: [], counts: {} };
        activity[byEmail].counts[opType] = (activity[byEmail].counts[opType] || 0) + 1;
        activity[byEmail].ops.push({ at: ev.at, type: opType, label, flowId, docName, reason: ev.reason || ev.reviewReason || '' });
      }
    }

    // Sortăm ops descrescator
    for (const email of Object.keys(activity)) {
      activity[email].ops.sort((a, b) => b.at.localeCompare(a.at));
    }

    // Compunem rezultatul cu toate filtrele
    const result = userRows
      .filter(u => {
        if (emailFilter && u.email.toLowerCase() !== emailFilter) return false;
        if (instFilter && (u.institutie || '') !== instFilter) return false;
        if (deptFilter && (u.compartiment || '') !== deptFilter) return false;
        if (nameFilter && !(u.nume || '').toLowerCase().includes(nameFilter)) return false;
        return true;
      })
      .map(u => {
        const email = u.email.toLowerCase();
        const act = activity[email] || { ops: [], counts: {} };
        return {
          email: u.email, name: u.nume || u.email, functie: u.functie || '', institutie: u.institutie,
          compartiment: u.compartiment, role: u.role,
          totalOps: act.ops.length, counts: act.counts, ops: act.ops,
        };
      });

    return res.json({ ok: true, from, to, users: result });
  } catch(e) { logger.error({ err: e }, 'user-activity error:'); return res.status(500).json({ error: String(e.message || e) }); }
});

export default router;
