/**
 * Admin routes — maintenance & utility endpoints.
 * (onboarding, vacuum, drive verify, wa-test, smtp-test, health)
 * DocFlowAI — server/routes/admin/maintenance.mjs
 */

import { Router } from 'express';
import { readFileSync } from 'fs';
import { csrfMiddleware } from '../../middleware/csrf.mjs';
import { requireAuth, hashPassword, generatePassword } from '../../middleware/auth.mjs';
import { pool, DB_READY, DB_LAST_ERROR, requireDb, invalidateOrgUserCache } from '../../db/index.mjs';
import { logger } from '../../middleware/logger.mjs';
import { verifyDrive } from '../../drive.mjs';
import { verifyWhatsApp, sendWaSignRequest } from '../../whatsapp.mjs';
import { sendSignerEmail, verifySmtp } from '../../mailer.mjs';
import { emailCredentials } from '../../emailTemplates.mjs';
import { isAdminOrOrgAdmin, getAppUrl } from './_helpers.mjs';

// Versiune citită din package.json (single source of truth)
const _pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url)));
const APP_VERSION = _pkg.version;

// WebSocket clients counter — injectat din index.mjs după startup
let _wsClientsSize = () => 0;
export function injectWsSize(fn) { _wsClientsSize = fn; }

const router = Router();

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

export default router;
