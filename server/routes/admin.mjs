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
import { isAdminOrOrgAdmin, actorOrgFilter, getAppUrl } from './admin/_helpers.mjs';
import usersRouter from './admin/users.mjs';
import organizationsRouter from './admin/organizations.mjs';
import flowsRouter from './admin/flows.mjs';

// BUG-01: versiune citită din package.json — single source of truth (ca în index.mjs)
const _pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url)));
const APP_VERSION = _pkg.version;

let _wsClientsSize = () => 0;
export function injectWsSize(fn) { _wsClientsSize = fn; }

const router = Router();
router.use(usersRouter);
router.use(organizationsRouter);
router.use(flowsRouter);

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
