/**
 * DocFlowAI — Admin routes v3.2.1
 * FIX: export default mutat la sfarsit (toate rutele inainte de export)
 * FIX: /admin/flows/audit mutat inainte de export default
 * FIX: /health => versiune 3.2.1
 * B-03: plain_password eliminat — parola se trimite o singura data prin email, nu se stocheaza
 */

import { Router } from 'express';
import { readFileSync } from 'fs';
import { csrfMiddleware } from '../middleware/csrf.mjs';
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
import { listAllProviders, getProvider, getOrgProviders, getOrgProviderConfig } from '../signing/index.mjs';

// BUG-01: versiune citită din package.json — single source of truth (ca în index.mjs)
const _pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url)));
const APP_VERSION = _pkg.version;

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

// ── GET /admin/organizations — listă organizații cu statistici și config webhook ──
router.get('/admin/organizations', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  try {
    const { rows } = await pool.query(`
      SELECT o.id, o.name, o.cif, o.compartimente, o.webhook_url, o.webhook_events, o.webhook_enabled,
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
router.put('/admin/organizations/:id', csrfMiddleware, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const orgId = parseInt(req.params.id);
  if (!orgId) return res.status(400).json({ error: 'invalid_id' });
  const { name, webhook_url, webhook_secret, webhook_events, webhook_enabled,
          signing_providers_enabled, signing_providers_config,
          cif, compartimente } = req.body || {};
  try {
    const updates = []; const params = [];
    if (name !== undefined) { params.push(String(name).trim()); updates.push(`name=$${params.length}`); }
    if (cif !== undefined) { params.push(cif ? String(cif).replace(/\D/g,'').substring(0,10) : null); updates.push(`cif=$${params.length}`); }
    if (compartimente !== undefined && Array.isArray(compartimente)) {
      params.push(compartimente.map(c => String(c).trim()).filter(Boolean));
      updates.push(`compartimente=$${params.length}`);
    }
    if (webhook_url !== undefined) { params.push(webhook_url ? String(webhook_url).trim() : null); updates.push(`webhook_url=$${params.length}`); }
    if (webhook_secret !== undefined && webhook_secret !== '') { params.push(String(webhook_secret).trim()); updates.push(`webhook_secret=$${params.length}`); }
    if (webhook_events !== undefined) { params.push(Array.isArray(webhook_events) ? webhook_events : []); updates.push(`webhook_events=$${params.length}`); }
    if (webhook_enabled !== undefined) { params.push(!!webhook_enabled); updates.push(`webhook_enabled=$${params.length}`); }
    // Signing providers — salvate doar dacă coloana există în DB (migrarea 033)
    // Dacă coloana lipsește, ignorăm silențios (non-fatal — webhook se salvează oricum)
    if (signing_providers_enabled !== undefined && Array.isArray(signing_providers_enabled)) {
      try {
        const { rows: colCheck } = await pool.query(
          `SELECT 1 FROM information_schema.columns
           WHERE table_name='organizations' AND column_name='signing_providers_enabled' LIMIT 1`
        );
        if (colCheck.length > 0) {
          const enabled = signing_providers_enabled.includes('local-upload')
            ? signing_providers_enabled : ['local-upload', ...signing_providers_enabled];
          params.push(enabled); updates.push(`signing_providers_enabled=$${params.length}`);
          if (signing_providers_config !== undefined && typeof signing_providers_config === 'object') {
            params.push(JSON.stringify(signing_providers_config));
            updates.push(`signing_providers_config=$${params.length}`);
          }
        }
      } catch(colErr) { /* coloana nu există — ignorăm */ }
    }
    if (!updates.length) return res.status(400).json({ error: 'no_fields' });
    updates.push(`updated_at=NOW()`);
    params.push(orgId);
    const { rows } = await pool.query(
      `UPDATE organizations SET ${updates.join(',')} WHERE id=$${params.length} RETURNING id, name, cif, compartimente, webhook_url, webhook_events, webhook_enabled, updated_at`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'org_not_found' });
    res.json({ ok: true, org: rows[0] });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

// ── POST /admin/organizations/:id/test-webhook — trimite un eveniment de test ──
router.post('/admin/organizations/:id/test-webhook', csrfMiddleware, async (req, res) => {
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




// ── Signing Providers — API ──────────────────────────────────────────────
// ── POST /admin/signing/sts/generate-keypair — generează pereche chei RSA pentru STS ──
// Super-admin generează cheia publică de trimis la STS + cheia privată de configurat.
// Nu necesită CSRF — nu modifică stare în DB, generează chei RSA în memorie și le returnează.
router.post('/admin/signing/sts/generate-keypair', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  try {
    const { generateKeyPairSync } = await import('crypto');
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength:     2048,
      publicKeyEncoding:  { type: 'pkcs1', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    logger.info({ actor: actor.email }, 'STS: pereche chei RSA generată');
    res.json({
      ok:            true,
      publicKeyPem:  publicKey,
      privateKeyPem: privateKey,
      instructions:  'Trimiteți publicKeyPem la STS (contact@sts.ro) pentru a primi client_id și kid. Stocați privateKeyPem în configurația providerului STS.',
    });
  } catch(e) {
    res.status(500).json({ error: 'keygen_failed' });
  }
});


// Arhitectură: provideri la nivel de org (ce e disponibil), ales per semnatar.

// GET /admin/signing/providers — toți providerii disponibili în platformă
router.get('/admin/signing/providers', async (req, res) => {
  const actor = requireAuth(req, res); if (!actor) return;
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });
  res.json(listAllProviders());
});

// GET /admin/organizations/:id/signing — configurația curentă de signing a unei org
router.get('/admin/organizations/:id/signing', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });
  const orgId = parseInt(req.params.id);
  if (!orgId) return res.status(400).json({ error: 'invalid_id' });
  try {
    const { rows } = await pool.query(
      'SELECT id, name, signing_providers_enabled, signing_providers_config FROM organizations WHERE id=$1',
      [orgId]
    );
    if (!rows.length) return res.status(404).json({ error: 'org_not_found' });
    const org = rows[0];
    // Returnăm config fără API keys (securitate) — doar metadata
    const configSafe = {};
    for (const [pid, cfg] of Object.entries(org.signing_providers_config || {})) {
      if (pid === 'sts-cloud') {
        // STS: returnăm câmpurile non-sensitive complet, mascăm cheia privată
        configSafe[pid] = {
          clientId:       cfg.clientId      || '',
          kid:            cfg.kid            || '',
          redirectUri:    cfg.redirectUri    || '',
          idpUrl:         cfg.idpUrl         || '',
          apiUrl:         cfg.apiUrl         || '',
          publicKeyPem:   cfg.publicKeyPem   || '',  // non-sensitivă, returnată complet
          hasPrivateKey:  !!(cfg.privateKeyPem),      // boolean — nu returnăm cheia privată
        };
      } else {
        configSafe[pid] = { apiUrl: cfg.apiUrl || '', hasApiKey: !!(cfg.apiKey), hasWebhookSecret: !!(cfg.webhookSecret) };
      }
    }
    res.json({
      orgId:    org.id,
      name:     org.name,
      enabled:  org.signing_providers_enabled || ['local-upload'],
      configSafe,
      providers: getOrgProviders(org),
    });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

// PUT /admin/organizations/:id/signing — actualizează providerii activi + configurația
// Doar super-admin — configurația conține API keys sensibile
router.put('/admin/organizations/:id/signing', csrfMiddleware, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden', message: 'Doar super-admin poate configura providerii de semnare.' });
  const orgId = parseInt(req.params.id);
  if (!orgId) return res.status(400).json({ error: 'invalid_id' });
  const { enabled, config } = req.body || {};
  if (!Array.isArray(enabled) || !enabled.length) {
    return res.status(400).json({ error: 'enabled_required', message: 'Lista de provideri activi nu poate fi goală.' });
  }
  // Validăm că toți providerii din enabled există în platformă
  const allIds = listAllProviders().map(p => p.id);
  const unknown = enabled.filter(id => !allIds.includes(id));
  if (unknown.length) return res.status(400).json({ error: 'unknown_providers', unknown, available: allIds });
  // 'local-upload' trebuie să fie întotdeauna în listă (fallback obligatoriu)
  const finalEnabled = enabled.includes('local-upload') ? enabled : ['local-upload', ...enabled];
  try {
    // Mergem config-ul nou cu cel existent (nu suprascrie API keys omise)
    const { rows: existing } = await pool.query('SELECT signing_providers_config FROM organizations WHERE id=$1', [orgId]);
    if (!existing.length) return res.status(404).json({ error: 'org_not_found' });
    const existingConfig = existing[0].signing_providers_config || {};
    const mergedConfig   = { ...existingConfig };
    for (const [pid, cfg] of Object.entries(config || {})) {
      mergedConfig[pid] = { ...(existingConfig[pid] || {}), ...cfg };
    }
    const { rows } = await pool.query(
      `UPDATE organizations
          SET signing_providers_enabled = $1,
              signing_providers_config  = $2,
              updated_at = NOW()
        WHERE id = $3
        RETURNING id, name, signing_providers_enabled, updated_at`,
      [finalEnabled, JSON.stringify(mergedConfig), orgId]
    );
    logger.info({ orgId, enabled: finalEnabled, actor: actor.email }, 'Signing providers actualizați');
    res.json({ ok: true, org: rows[0] });
  } catch(e) { logger.error({ err: e }, 'PUT signing error'); res.status(500).json({ error: 'server_error' }); }
});

// POST /admin/signing/verify — verifică conexiunea cu un provider
router.post('/admin/signing/verify', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const { providerId, config } = req.body || {};
  if (!providerId) return res.status(400).json({ error: 'providerId_required' });
  try {
    let effectiveConfig = { ...(config || {}) };
    // Dacă frontend-ul semnalează că trebuie folosită cheia stocată în DB (câmp gol = nu s-a introdus una nouă)
    if (effectiveConfig._useStoredPrivateKey && actor.orgId) {
      try {
        const { rows: orgRows } = await pool.query(
          'SELECT signing_providers_config FROM organizations WHERE id=$1', [actor.orgId]
        );
        const storedKey = orgRows[0]?.signing_providers_config?.[providerId]?.privateKeyPem;
        if (storedKey) effectiveConfig.privateKeyPem = storedKey;
      } catch(_) { /* non-fatal — continuăm fără cheie */ }
    }
    delete effectiveConfig._useStoredPrivateKey;
    const provider = getProvider(providerId);
    const result   = await provider.verify(effectiveConfig);
    res.json(result);
  } catch(e) {
    res.status(500).json({ ok: false, error: 'server_error' });
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

// ── POST /admin/onboarding — Wizard creare instituție nouă ──────────────────
// Crează în un singur pas: organizație nouă + utilizator org_admin + trimite credențiale
// Disponibil doar pentru super-admin
router.post('/admin/onboarding', csrfMiddleware, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden', message: 'Doar super-adminul poate crea instituții noi.' });

  const { org_name, admin_email, admin_name, admin_functie, admin_phone, cif } = req.body || {};

  if (!org_name || !String(org_name).trim())
    return res.status(400).json({ error: 'org_name_required' });
  if (!admin_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(admin_email))
    return res.status(400).json({ error: 'admin_email_invalid' });
  if (!admin_name || !String(admin_name).trim())
    return res.status(400).json({ error: 'admin_name_required' });

  const orgName    = String(org_name).trim();
  const adminEmail = admin_email.trim().toLowerCase();
  const adminName  = String(admin_name).trim();
  const adminFunctie = (admin_functie || 'Administrator Instituție').trim();
  const adminPhone = (admin_phone || '').trim();
  const orgCif = cif ? String(cif).replace(/\D/g, '').substring(0, 10) || null : null;

  try {
    // 1. Verificam ca emailul nu exista deja
    const { rows: existingUser } = await pool.query(
      'SELECT id FROM users WHERE lower(email)=$1', [adminEmail]
    );
    if (existingUser.length > 0)
      return res.status(409).json({ error: 'email_exists', message: `Utilizatorul ${adminEmail} există deja.` });

    // 2. Cream sau gasim organizatia
    const { rows: existingOrg } = await pool.query(
      'SELECT id FROM organizations WHERE lower(name)=lower($1)', [orgName]
    );
    let orgId;
    if (existingOrg.length > 0) {
      orgId = existingOrg[0].id;
      logger.info({ orgName, orgId }, 'Onboarding: org existenta refolosita');
    } else {
      const { rows: newOrg } = await pool.query(
        'INSERT INTO organizations (name, cif) VALUES ($1, $2) RETURNING id', [orgName, orgCif]
      );
      orgId = newOrg[0].id;
      logger.info({ orgName, orgId, orgCif }, 'Onboarding: org noua creata');
    }

    // 3. Cream utilizatorul org_admin cu parola temporara
    const tempPassword = generatePassword();
    const passwordHash = await hashPassword(tempPassword);
    const { rows: newUser } = await pool.query(
      `INSERT INTO users (email, password_hash, nume, functie, institutie, role, org_id,
        notif_inapp, notif_email, force_password_change, created_at)
       VALUES ($1,$2,$3,$4,$5,'org_admin',$6,true,true,true,NOW())
       RETURNING id, email, nume`,
      [adminEmail, passwordHash, adminName, adminFunctie, orgName, orgId]
    );
    const userId = newUser[0].id;

    // 4. Trimitem email cu credentiale
    const appUrl = getAppUrl(req);
    try {
      await sendSignerEmail({
        to: adminEmail,
        ...emailCredentials({ appUrl, numeUser: adminName, email: adminEmail, newPwd: tempPassword }),
      });
      logger.info({ adminEmail, orgName }, 'Onboarding: credentiale trimise');
    } catch(mailErr) {
      logger.warn({ err: mailErr, adminEmail }, 'Onboarding: email credentiale esuat (non-fatal)');
    }

    res.json({
      ok: true,
      orgId,
      orgName,
      userId,
      adminEmail,
      tempPassword, // returnat catre super-admin ca fallback
      message: `Instituția „${orgName}" a fost creată. Credențialele au fost trimise la ${adminEmail}.`,
    });
  } catch(e) {
    logger.error({ err: e }, 'Onboarding error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── GET /admin/analytics — dashboard analytics per organizație ───────────────
// Returnează statistici agregate: fluxuri, semnatari, timpii medii, activitate
// Super-admin: vede toate org. org_admin: vede doar propria org.
router.get('/admin/analytics', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });

  try {
    const orgFilter = actorOrgFilter(actor);
    const params    = orgFilter ? [orgFilter] : [];
    const whereOrg  = orgFilter ? `AND org_id = $1` : '';  // PERF: org_id coloana indexata, nu JSONB
    const whereOrgDel = orgFilter ? `AND org_id = $1 AND deleted_at IS NULL` : 'AND deleted_at IS NULL';  // PERF: org_id coloana indexata

    // Statistici generale fluxuri
    const { rows: flowStats } = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE (data->>'completed')='true')::int AS completed,
        COUNT(*) FILTER (WHERE (data->>'status')='refused')::int AS refused,
        COUNT(*) FILTER (WHERE (data->>'status')='cancelled')::int AS cancelled,
        COUNT(*) FILTER (WHERE (data->>'completed') IS DISTINCT FROM 'true'
          AND (data->>'status') NOT IN ('refused','cancelled','review_requested'))::int AS active,
        COUNT(*) FILTER (WHERE (data->>'urgent')='true')::int AS urgent,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS last_7_days,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS last_30_days,
        ROUND(AVG(
          CASE WHEN (data->>'completed')='true' AND (data->>'completedAt') IS NOT NULL
          THEN EXTRACT(EPOCH FROM (
            (data->>'completedAt')::timestamptz - created_at
          ))/3600
          END
        )::numeric, 1) AS avg_completion_hours
      FROM flows WHERE 1=1 ${whereOrgDel}
    `, params);

    // Fluxuri pe luni - ultimele 6 luni
    const { rows: byMonth } = await pool.query(`
      SELECT
        TO_CHAR(created_at, 'YYYY-MM') AS month,
        COUNT(*)::int AS created,
        COUNT(*) FILTER (WHERE (data->>'completed')='true')::int AS completed
      FROM flows
      WHERE created_at >= NOW() - INTERVAL '6 months' ${whereOrgDel.replace('AND deleted_at IS NULL', 'AND deleted_at IS NULL')}
      GROUP BY month ORDER BY month ASC
    `, params);

    // Semnatari per status
    const { rows: signerStats } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE s->>'status'='signed')::int AS signed,
        COUNT(*) FILTER (WHERE s->>'status'='refused')::int AS refused,
        COUNT(*) FILTER (WHERE s->>'status'='current')::int AS pending
      FROM flows f,
           jsonb_array_elements(f.data->'signers') s
      WHERE 1=1 ${whereOrgDel}
    `, params);

    // Top 5 initiatori (cele mai multe fluxuri)
    const { rows: topInitiatori } = await pool.query(`
      SELECT (data->>'initEmail') AS email, (data->>'initName') AS name,
             COUNT(*)::int AS flows
      FROM flows WHERE 1=1 ${whereOrgDel}
      GROUP BY email, name ORDER BY flows DESC LIMIT 5
    `, params);

    // Utilizatori activi
    const { rows: userStats } = await pool.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE role='org_admin')::int AS admins,
             COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS new_last_30
      FROM users WHERE 1=1 ${orgFilter ? 'AND org_id=$1' : ''}
    `, params);

    // Distributie tip flux (tabel vs ancore)
    const { rows: byFlowType } = await pool.query(`
      SELECT (data->>'flowType') AS flow_type, COUNT(*)::int AS cnt
      FROM flows WHERE 1=1 ${whereOrgDel}
      GROUP BY flow_type ORDER BY cnt DESC
    `, params);

    // Timp mediu de semnare per semnatar (cat asteapta fiecare)
    const { rows: avgSignTime } = await pool.query(`
      SELECT
        ROUND(AVG(
          CASE WHEN s->>'signedAt' IS NOT NULL AND s->>'notifiedAt' IS NOT NULL
          THEN EXTRACT(EPOCH FROM (
            (s->>'signedAt')::timestamptz - (s->>'notifiedAt')::timestamptz
          ))/3600
          END
        )::numeric, 1) AS avg_sign_hours,
        COUNT(*) FILTER (WHERE s->>'status'='signed')::int AS total_signed
      FROM flows f,
           jsonb_array_elements(f.data->'signers') s
      WHERE 1=1 ${whereOrgDel}
    `, params);

    // Fluxuri urgente finalizate vs nerezolvate
    const { rows: urgentStats } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE (data->>'urgent')='true')::int AS total_urgent,
        COUNT(*) FILTER (WHERE (data->>'urgent')='true' AND (data->>'completed')='true')::int AS urgent_completed,
        COUNT(*) FILTER (WHERE (data->>'urgent')='true' AND (data->>'status')='refused')::int AS urgent_refused
      FROM flows WHERE 1=1 ${whereOrgDel}
    `, params);

    // Top 5 semnatari (cel mai des solicitati)
    const { rows: topSigners } = await pool.query(`
      SELECT lower(s->>'email') AS email, (s->>'name') AS name,
             COUNT(*)::int AS appearances,
             COUNT(*) FILTER (WHERE s->>'status'='signed')::int AS signed,
             COUNT(*) FILTER (WHERE s->>'status'='refused')::int AS refused
      FROM flows f,
           jsonb_array_elements(f.data->'signers') s
      WHERE s->>'email' IS NOT NULL ${whereOrgDel.replace('WHERE 1=1', '')}
      GROUP BY lower(s->>'email'), name
      ORDER BY appearances DESC LIMIT 5
    `, params);

    res.json({
      ok: true,
      flows:         flowStats[0] || {},
      byMonth,
      signers:       signerStats[0] || {},
      topInitiatori,
      topSigners,
      users:         userStats[0] || {},
      byFlowType,
      avgSignTime:   avgSignTime[0] || {},
      urgentStats:   urgentStats[0] || {},
      generatedAt:   new Date().toISOString(),
    });
  } catch(e) {
    logger.error({ err: e }, '/admin/analytics error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── GET /admin/analytics/summary — KPI + timeline 30z + provideri ──────────
router.get('/admin/analytics/summary', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });

  try {
    const orgFilter = actorOrgFilter(actor);
    const params    = orgFilter ? [orgFilter] : [];
    const whereOrg  = orgFilter ? 'AND org_id = $1' : '';
    const whereOrgDel = orgFilter ? 'AND org_id = $1 AND deleted_at IS NULL' : 'AND deleted_at IS NULL';

    // Total fluxuri per status
    const { rows: statusRows } = await pool.query(`
      SELECT data->>'status' AS status, COUNT(*)::int AS count
      FROM flows WHERE 1=1 ${whereOrgDel}
      GROUP BY data->>'status'
    `, params);

    const flows = { total: 0, completed: 0, refused: 0, cancelled: 0, in_progress: 0, draft: 0 };
    for (const r of statusRows) {
      flows.total += r.count;
      if (r.status === 'completed')   flows.completed   += r.count;
      else if (r.status === 'refused')  flows.refused     += r.count;
      else if (r.status === 'cancelled') flows.cancelled  += r.count;
      else if (r.status === 'in_progress') flows.in_progress += r.count;
      else if (r.status === 'draft')    flows.draft       += r.count;
    }

    // Timeline 30 zile
    const { rows: timeline } = await pool.query(`
      SELECT
        DATE(created_at AT TIME ZONE 'Europe/Bucharest') AS data,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE data->>'status' = 'completed')::int AS completate,
        COUNT(*) FILTER (WHERE data->>'status' = 'refused')::int AS refuzate
      FROM flows
      WHERE created_at >= NOW() - INTERVAL '30 days' ${whereOrgDel.replace('AND deleted_at IS NULL', 'AND deleted_at IS NULL')}
      GROUP BY DATE(created_at AT TIME ZONE 'Europe/Bucharest')
      ORDER BY data ASC
    `, params);

    // Top provideri semnare din audit_log
    const provParams = orgFilter ? [orgFilter] : [];
    const provWhere  = orgFilter ? 'AND org_id = $1' : '';
    const { rows: providers } = await pool.query(`
      SELECT payload->>'method' AS provider, COUNT(*)::int AS total
      FROM audit_log
      WHERE event_type = 'SIGNED_PDF_UPLOADED' ${provWhere}
      GROUP BY payload->>'method'
      ORDER BY total DESC
    `, provParams);

    // Timp mediu finalizare (ore)
    const { rows: avgRows } = await pool.query(`
      SELECT ROUND(AVG(
        EXTRACT(EPOCH FROM (updated_at - created_at)) / 3600
      )::numeric, 1) AS avg_hours
      FROM flows
      WHERE data->>'status' = 'completed'
      AND updated_at > created_at
      ${whereOrgDel}
    `, params);

    // Utilizatori activi
    const { rows: userRows } = await pool.query(`
      SELECT COUNT(*)::int AS total FROM users
      WHERE status = 'active' ${orgFilter ? 'AND org_id = $1' : ''}
    `, params);

    // Fluxuri active acum
    const { rows: activeRows } = await pool.query(`
      SELECT COUNT(*)::int AS total FROM flows
      WHERE data->>'status' IN ('active', 'in_progress')
      AND deleted_at IS NULL ${whereOrg}
    `, params);

    res.json({
      flows,
      timeline,
      providers,
      avg_hours:    avgRows[0]?.avg_hours   ?? null,
      users_active: userRows[0]?.total      ?? 0,
      flows_active: activeRows[0]?.total    ?? 0,
    });
  } catch(e) {
    logger.error({ err: e }, '/admin/analytics/summary error');
    res.status(500).json({ error: 'server_error' });
  }
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
    const whereCond = orgFilter ? ' AND org_id = $1' : '';  // PERF: org_id coloana indexata
    const params = orgFilter ? [orgFilter] : [];
    const sql =
      'SELECT ' +
      "COUNT(*) FILTER (WHERE data->>'completed' = 'true')::int AS completed, " +
      "COUNT(*) FILTER (WHERE data->>'status' = 'refused')::int AS refused, " +
      "COUNT(*) FILTER (WHERE data->>'status' = 'cancelled')::int AS cancelled, " +
      "COUNT(*) FILTER (WHERE data->>'status' = 'review_requested')::int AS review_requested, " +
      "COUNT(*) FILTER (WHERE data->>'completed' IS DISTINCT FROM 'true' " +
        "AND (data->>'status' IS NULL OR data->>'status' NOT IN ('refused','cancelled','review_requested')))::int AS active, " +
      'COUNT(*)::int AS total ' +
      'FROM flows WHERE 1=1 AND deleted_at IS NULL' + whereCond;
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
  } catch(e) { return res.status(500).json({ error: 'server_error' }); }
});


// SEC-01: soft delete — nu mai ștergem fizic, marcăm deleted_at + deleted_by
// SEC-04: csrfMiddleware adăugat — operație distructivă
router.post('/admin/flows/clean', csrfMiddleware, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const { olderThanDays, all, institutie, compartiment, confirmToken } = req.body || {};
  if (all && confirmToken !== 'DELETE_ALL_FLOWS') {
    return res.status(400).json({ error: 'confirm_token_required', message: 'Pentru ștergerea tuturor fluxurilor trimite confirmToken: "DELETE_ALL_FLOWS".' });
  }
  try {
    const now = new Date().toISOString();
    let result;
    if (!institutie && !compartiment) {
      if (all) {
        result = await pool.query(
          'UPDATE flows SET deleted_at=$1, deleted_by=$2 WHERE deleted_at IS NULL',
          [now, actor.email]
        );
      } else {
        result = await pool.query(
          "UPDATE flows SET deleted_at=$1, deleted_by=$2 WHERE deleted_at IS NULL AND created_at < NOW() - ($3 || ' days')::INTERVAL",
          [now, actor.email, parseInt(olderThanDays) || 30]
        );
      }
      return res.json({ ok: true, deleted: result.rowCount });
    }
    const { rows: userRows } = await pool.query('SELECT email,institutie,compartiment FROM users');
    const userMap = {}; userRows.forEach(u => { userMap[u.email.toLowerCase()] = u; });
    const { rows } = await pool.query(
      all
        ? 'SELECT id,data FROM flows WHERE deleted_at IS NULL'
        : "SELECT id,data FROM flows WHERE deleted_at IS NULL AND created_at < NOW() - ($1 || ' days')::INTERVAL",
      all ? [] : [parseInt(olderThanDays) || 30]
    );
    const idsToDelete = rows.filter(r => {
      const d = r.data || {}; const u = userMap[(d.initEmail || '').toLowerCase()] || {};
      if (institutie && (u.institutie || d.institutie || '') !== institutie) return false;
      if (compartiment && (u.compartiment || d.compartiment || '') !== compartiment) return false;
      return true;
    }).map(r => r.id);
    if (!idsToDelete.length) return res.json({ ok: true, deleted: 0 });
    result = await pool.query(
      'UPDATE flows SET deleted_at=$1, deleted_by=$2 WHERE id = ANY($3) AND deleted_at IS NULL',
      [now, actor.email, idsToDelete]
    );
    return res.json({ ok: true, deleted: result.rowCount });
  } catch(e) { logger.error({ err: e }, 'flows/clean error'); res.status(500).json({ error: 'server_error' }); }
});

router.get('/admin/flows/archive-preview', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });
  try {
    // org_admin: filtrare strictă după org_id
    // PERF-FIX: org_id din JWT — verificat la autentificare
    let apOrgId = null;
    if (actor.role === 'org_admin') {
      apOrgId = actor.orgId || null;
      if (!apOrgId) return res.status(403).json({ error: 'org_admin_no_org' });
    }
    const days = parseInt(req.query.days || '30');
    const filterInst = (req.query.institutie || '').trim();
    const filterDept = (req.query.compartiment || '').trim();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { rows } = apOrgId
      ? await pool.query('SELECT id,data,created_at FROM flows WHERE created_at < $1 AND org_id=$2 AND deleted_at IS NULL ORDER BY created_at ASC', [cutoff, apOrgId])
      : await pool.query('SELECT id,data,created_at FROM flows WHERE created_at < $1 AND deleted_at IS NULL ORDER BY created_at ASC', [cutoff]);
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
  } catch(e) { return res.status(500).json({ error: 'server_error' }); }
});

router.post('/admin/flows/archive', csrfMiddleware, async (req, res) => {
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
        driveResult = await archiveFlow(data, pool);
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
  } catch(e) { return res.status(500).json({ error: 'server_error' }); }
});

// ── POST /admin/flows/archive-async — crează un job de arhivare asincron ──
// Returnează imediat un jobId; procesarea se face în background (index.mjs)
router.post('/admin/flows/archive-async', csrfMiddleware, async (req, res) => {
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
  } catch(e) { return res.status(500).json({ error: 'server_error' }); }
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
  } catch(e) { return res.status(500).json({ error: 'server_error' }); }
});

router.post('/admin/db/vacuum', csrfMiddleware, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  try {
    await pool.query('VACUUM ANALYZE flows');
    const sizeR = await pool.query('SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size');
    return res.json({ ok: true, message: 'VACUUM ANALYZE flows executat.', dbSize: sizeR.rows[0].db_size });
  } catch(e) { return res.status(500).json({ error: 'server_error' }); }
});

router.get('/admin/drive/verify', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });
  try { res.json(await verifyDrive()); } catch(e) { res.status(500).json({ ok: false, error: 'server_error' }); }
});

// ── GET /admin/flows/institutions — lista distinctă de instituții (pentru dropdown) ──
// Returnează toate instituțiile din fluxuri fără paginare — pentru dropdown filtru.
router.get('/admin/flows/institutions', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });
  try {
    // PERF-FIX: org_id din JWT — verificat la autentificare
    let actorOrgId = null;
    if (actor.role === 'org_admin') {
      actorOrgId = actor.orgId || null;
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
  } catch(e) { return res.status(500).json({ error: 'server_error' }); }
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
    // org_admin: filtrare strictă după org_id — din JWT (PERF-FIX: fără query DB suplimentar)
    let actorOrgId = null;
    if (actor.role === 'org_admin') {
      actorOrgId = actor.orgId || null;
      if (!actorOrgId) return res.status(403).json({ error: 'org_admin_no_org' });
    }
    const conditions = ['1=1']; const params = [];
    // Org filter aplicat primul — cel mai restrictiv
    // FIX BUG-JOIN-01: f.org_id explicit — LEFT JOIN users u face org_id ambiguu
    if (actorOrgId) { params.push(actorOrgId); conditions.push(`f.org_id = $${params.length}`); }
    if (statusFilter === 'pending') conditions.push("(data->>'completed') IS DISTINCT FROM 'true' AND (data->>'status') IS DISTINCT FROM 'refused' AND (data->>'status') IS DISTINCT FROM 'cancelled'");
    else if (statusFilter === 'completed') conditions.push("(data->>'completed') = 'true'");
    else if (statusFilter === 'refused') conditions.push("(data->>'status') = 'refused'");
    else if (statusFilter === 'cancelled') conditions.push("(data->>'status') = 'cancelled'");
    if (search) { params.push(`%${escapedSearch}%`); conditions.push(`(lower(data->>'docName') LIKE $${params.length} ESCAPE '\\' OR lower(data->>'initName') LIKE $${params.length} ESCAPE '\\' OR lower(data->>'initEmail') LIKE $${params.length} ESCAPE '\\' OR lower(data->>'flowId') LIKE $${params.length} ESCAPE '\\')`); }
    // PERF-FIX-06: instFilter/deptFilter prin LEFT JOIN (deja prezent) — elimina EXISTS corelat per rând
    if (instFilter) { params.push(instFilter); conditions.push(`(COALESCE(NULLIF(u.institutie,''), f.data->>'institutie') = $${params.length})`); }
    if (deptFilter) { params.push(deptFilter); conditions.push(`(COALESCE(NULLIF(u.compartiment,''), f.data->>'compartiment') = $${params.length})`); }
    // BUG-03: folosim coloana TIMESTAMPTZ created_at (nu data->>'createdAt' string) — corect și indexabil
    if (dateFrom) { params.push(dateFrom + 'T00:00:00.000Z'); conditions.push(`created_at >= $${params.length}::timestamptz`); }
    if (dateTo)   { params.push(dateTo   + 'T23:59:59.999Z'); conditions.push(`created_at <= $${params.length}::timestamptz`); }
    if (storageFilter === 'drive') conditions.push("(data->>'storage') = 'drive'");
    const whereClause = conditions.join(' AND ');
    // PERF-FIX-05: window function COUNT OVER() — un singur round-trip DB în loc de două
    const { rows: allRows } = await pool.query(`
      SELECT f.id, f.data, f.created_at,
             COALESCE(NULLIF(u.institutie,''), f.data->>'institutie') AS institutie,
             COALESCE(NULLIF(u.compartiment,''), f.data->>'compartiment') AS compartiment,
             COUNT(*) OVER() AS _total
      FROM flows f
      LEFT JOIN users u ON lower(u.email) = lower(f.data->>'initEmail')
      WHERE ${whereClause} AND f.deleted_at IS NULL
      ORDER BY f.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);
    const total = allRows.length > 0 ? parseInt(allRows[0]._total) : 0;
    const pages = Math.ceil(total / limit) || 1;
    const rows = allRows.map(r => { const { _total, ...rest } = r; return rest; });
    const flows = rows.map(r => {
      const d = r.data || {};
      return { flowId: d.flowId, docName: d.docName, initEmail: d.initEmail, initName: d.initName,
        flowType: d.flowType || 'tabel',
        status: d.status || 'active', completed: !!(d.completed || (d.signers || []).every(s => s.status === 'signed')),
        urgent: !!(d.urgent),
        storage: d.storage || 'db', archivedAt: d.archivedAt || null,
        driveFileLinkFinal: d.driveFileLinkFinal || null,
        createdAt: d.createdAt || r.created_at,
        institutie: r.institutie || '', compartiment: r.compartiment || '',
        signers: (d.signers || []).map(s => ({ name: s.name, email: s.email, rol: s.rol, status: s.status, tokenCreatedAt: s.tokenCreatedAt || null, signedAt: s.signedAt || null, refuseReason: s.refuseReason || null })) };
    });
    return res.json({ flows, total, page, limit, pages });
  } catch(e) { return res.status(500).json({ error: 'server_error' }); }
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
  } catch(e) { res.status(500).json({ ok: false, error: 'server_error' }); }
});

router.get('/health', async (req, res) => {
  const base = { ok: true, service: 'DocFlowAI', version: APP_VERSION, dbReady: DB_READY, dbLastError: DB_LAST_ERROR, wsClients: _wsClientsSize(), ts: new Date().toISOString() };
  if (!pool || !DB_READY) return res.json(base);
  try {
    const [flowsR, usersR, notifsR, archR] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM flows WHERE deleted_at IS NULL'), pool.query('SELECT COUNT(*) FROM users'),
      pool.query('SELECT COUNT(*) FROM notifications WHERE read=FALSE'),
      pool.query("SELECT COUNT(*) FROM flows WHERE deleted_at IS NULL AND data->>'storage'='drive'"),
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
      // Stats filtrate pe org_id — din JWT (PERF-FIX: fără query DB suplimentar)
      const orgId = actor.orgId || null;
      if (!orgId) return res.status(403).json({ error: 'org_admin_no_org' });
      const [flowsR, usersR, notifsR, archR] = await Promise.all([
        pool.query('SELECT COUNT(*) FROM flows WHERE deleted_at IS NULL AND org_id=$1', [orgId]),
        pool.query('SELECT COUNT(*) FROM users WHERE org_id=$1', [orgId]),
        pool.query('SELECT COUNT(*) FROM notifications n JOIN users u ON lower(u.email)=lower(n.user_email) WHERE u.org_id=$1 AND n.read=FALSE', [orgId]),
        pool.query("SELECT COUNT(*) FROM flows WHERE deleted_at IS NULL AND org_id=$1 AND data->>'storage'='drive'", [orgId]),
      ]);
      return res.json({ ok: true, stats: { flows: parseInt(flowsR.rows[0].count), flowsArchived: parseInt(archR.rows[0].count), users: parseInt(usersR.rows[0].count), unreadNotifications: parseInt(notifsR.rows[0].count), dbSize: null, dbBytes: null } });
    }
    // Super-admin: stats globale
    const [flowsR, usersR, notifsR, archR] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM flows WHERE deleted_at IS NULL'), pool.query('SELECT COUNT(*) FROM users'),
      pool.query('SELECT COUNT(*) FROM notifications WHERE read=FALSE'),
      pool.query("SELECT COUNT(*) FROM flows WHERE deleted_at IS NULL AND data->>'storage'='drive'"),
    ]);
    const sizeR = await pool.query('SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size, pg_database_size(current_database()) AS db_bytes');
    return res.json({ ok: true, stats: { flows: parseInt(flowsR.rows[0].count), flowsArchived: parseInt(archR.rows[0].count), users: parseInt(usersR.rows[0].count), unreadNotifications: parseInt(notifsR.rows[0].count), dbSize: sizeR.rows[0].db_size, dbBytes: parseInt(sizeR.rows[0].db_bytes) } });
  } catch(e) { return res.status(500).json({ error: 'server_error' }); }
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
        'EMAIL_OPENED': 'EMAIL DESCHIS DE DESTINATAR',
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
      // Construim userMap ÎNAINTE de renderEvent (evităm TDZ cu let)
      const userMap = {};
      try {
        const { rows: uRows } = await pool.query('SELECT email, nume FROM users WHERE org_id = $1', [data.orgId]);
        uRows.forEach(u => { if (u.email) userMap[u.email.toLowerCase()] = u; });
        for (const s of (data.signers || [])) {
          if (s.email && !userMap[s.email.toLowerCase()])
            userMap[s.email.toLowerCase()] = { email: s.email, nume: s.name || s.email };
        }
      } catch { /* non-fatal */ }

      const renderEvent = (e, dimmed) => {
        // Înlocuim email cu Nume Prenume din userMap dacă există
        const resolveActor = (email) => {
          if (!email) return '';
          const u = userMap[(email || '').toLowerCase()];
          return u?.nume || email;
        };
        const actorLabel = e.by ? `de:${resolveActor(e.by)}` : '';
        const detail = [actorLabel, e.channel ? `via:${e.channel}` : '', e.reason ? `motiv:${e.reason}` : '', e.to ? `catre:${e.to}` : ''].filter(Boolean).join('  ');
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
             AND event_type IN ('PDF_DOWNLOADED','SIGNED','SIGNED_PDF_UPLOADED','REFUSED','DELEGATED','FLOW_CANCELLED','FLOW_CREATED','FLOW_REINITIATED','FLOW_REINITIATED_AFTER_REVIEW','EMAIL_SENT','EMAIL_OPENED')
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
          // Afișăm Nume Prenume dacă există în userMap, altfel emailul
          const actorUser = userMap[(ar.actor_email || '').toLowerCase()] || {};
          const actor = (actorUser.nume || ar.actor_email || '—').slice(0, 30);
          const ip = ar.actor_ip || '—';
          const rowColor = ar.event_type === 'REFUSED' || ar.event_type === 'FLOW_CANCELLED'
            ? rgb(0.6,0.1,0.1)
            : ar.event_type === 'FLOW_CREATED' ? rgb(0.1,0.4,0.1)
            : ar.event_type === 'EMAIL_OPENED' ? rgb(0.1,0.45,0.3)
            : rgb(0.25,0.25,0.35);
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
  } catch(e) { return res.status(500).json({ error: 'server_error' }); }
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
  } catch(e) { return res.status(500).json({ error: 'server_error' }); }
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

    // Toti utilizatorii din aceeași organizație — org_id din JWT (PERF-FIX)
    const orgId = actor.orgId || null;
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
  } catch(e) { logger.error({ err: e }, 'user-activity error:'); return res.status(500).json({ error: 'server_error' }); }
});

// ── GET /admin/audit-events/types — lista distinctă de tipuri de evenimente ──
router.get('/admin/audit-events/types', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (await requireAdmin(req, res)) return;
  try {
    const orgId  = actor.role === 'admin' ? null : actor.orgId;
    const { rows } = await pool.query(
      `SELECT DISTINCT event_type FROM audit_log
       WHERE ($1::int IS NULL OR org_id = $1)
       ORDER BY event_type`,
      [orgId]
    );
    return res.json({ types: rows.map(r => r.event_type) });
  } catch(e) { logger.error({ err: e }, '/admin/audit-events/types error'); return res.status(500).json({ error: 'server_error' }); }
});

// ── GET /admin/audit-events — audit log cu filtrare și paginare ───────────────
router.get('/admin/audit-events', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (await requireAdmin(req, res)) return;
  try {
    const orgId    = actor.role === 'admin' ? null : actor.orgId;
    const flowId   = req.query.flow_id   || null;
    const evType   = req.query.event_type || null;
    const from     = req.query.from       || null;
    const to       = req.query.to         || null;
    const page     = Math.max(1, parseInt(req.query.page)  || 1);
    const limit    = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const offset   = (page - 1) * limit;

    const baseWhere = `
      WHERE ($1::int  IS NULL OR org_id      = $1)
        AND ($2::text IS NULL OR flow_id     = $2)
        AND ($3::text IS NULL OR event_type  = $3)
        AND ($4::timestamptz IS NULL OR created_at >= $4)
        AND ($5::timestamptz IS NULL OR created_at <= $5)`;
    const params = [orgId, flowId, evType, from, to];

    const joinUsers = `LEFT JOIN users u ON lower(u.email) = lower(ae.actor_email)`;
    const selectName = `COALESCE(NULLIF(u.nume,''), ae.actor_email) AS actor_name`;

    // Export CSV
    if (req.query.format === 'csv') {
      const { rows } = await pool.query(
        `SELECT ae.id, ae.created_at, ae.event_type, ae.actor_email, ${selectName},
                ae.flow_id, ae.actor_ip, ae.payload
         FROM audit_log ae ${joinUsers} ${baseWhere.replace(/\bae\./g, 'ae.')}
         ORDER BY ae.created_at DESC LIMIT 10000`,
        params
      );
      const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = [
        'ID,Data,Tip eveniment,Actor,Flow ID,IP,Mesaj',
        ...rows.map(r => [
          r.id,
          new Date(r.created_at).toISOString(),
          esc(r.event_type),
          esc(r.actor_name || r.actor_email || ''),
          esc(r.flow_id || ''),
          esc(r.actor_ip || ''),
          esc(r.payload?.message || ''),
        ].join(',')),
      ];
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="audit-${Date.now()}.csv"`);
      return res.send(lines.join('\r\n'));
    }

    // baseWhere references columns without table alias — re-alias for JOIN query
    const baseWhereAe = baseWhere.replace(/\borg_id\b/g, 'ae.org_id')
      .replace(/\bflow_id\b/g, 'ae.flow_id')
      .replace(/\bevent_type\b/g, 'ae.event_type')
      .replace(/\bcreated_at\b/g, 'ae.created_at');

    const [{ rows: countRows }, { rows: events }] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total FROM audit_log ae ${joinUsers} ${baseWhereAe}`, params),
      pool.query(
        `SELECT ae.id, ae.created_at, ae.event_type, ae.actor_email, ${selectName},
                ae.flow_id, ae.actor_ip, ae.payload
         FROM audit_log ae ${joinUsers} ${baseWhereAe}
         ORDER BY ae.created_at DESC LIMIT $6 OFFSET $7`,
        [...params, limit, offset]
      ),
    ]);

    const total = parseInt(countRows[0].total);
    return res.json({
      events: events.map(r => ({
        id:          r.id,
        created_at:  r.created_at,
        event_type:  r.event_type,
        actor_email: r.actor_email || null,
        actor_name:  r.actor_name  || r.actor_email || null,
        flow_id:     r.flow_id     || null,
        channel:     r.payload?.channel || 'api',
        ok:          r.payload?.ok !== false,
        message:     r.payload?.message || null,
        meta:        r.payload || {},
      })),
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch(e) { logger.error({ err: e }, '/admin/audit-events error'); return res.status(500).json({ error: 'server_error' }); }
});

export default router;
