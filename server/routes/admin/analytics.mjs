/**
 * Admin routes — analytics, stats, user activity.
 * DocFlowAI — server/routes/admin/analytics.mjs
 */

import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.mjs';
import { pool, DB_READY, DB_LAST_ERROR, requireDb } from '../../db/index.mjs';
import { logger } from '../../middleware/logger.mjs';
import { isAdminOrOrgAdmin, actorOrgFilter } from './_helpers.mjs';

const router = Router();

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

export default router;
