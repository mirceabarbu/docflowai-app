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
import { emailVerifyGws, emailCredentials } from '../emailTemplates.mjs';
import { requireAuth, requireAdmin, hashPassword, generatePassword } from '../middleware/auth.mjs';
import { pool, DB_READY, DB_LAST_ERROR, requireDb, invalidateOrgUserCache } from '../db/index.mjs';
import { sendSignerEmail, verifySmtp } from '../mailer.mjs';
import { verifyDrive } from '../drive.mjs';
import { verifyWhatsApp, sendWaSignRequest } from '../whatsapp.mjs';
import { logger } from '../middleware/logger.mjs';
import { isAdminOrOrgAdmin, getAppUrl } from './admin/_helpers.mjs';
import usersRouter from './admin/users.mjs';
import organizationsRouter from './admin/organizations.mjs';
import flowsRouter from './admin/flows.mjs';
import analyticsRouter from './admin/analytics.mjs';

// BUG-01: versiune citită din package.json — single source of truth (ca în index.mjs)
const _pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url)));
const APP_VERSION = _pkg.version;

let _wsClientsSize = () => 0;
export function injectWsSize(fn) { _wsClientsSize = fn; }

const router = Router();
router.use(usersRouter);
router.use(organizationsRouter);
router.use(flowsRouter);
router.use(analyticsRouter);

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
