/**
 * Admin routes — audit events & log.
 * DocFlowAI — server/routes/admin/audit.mjs
 */

import { Router } from 'express';
import { requireAuth, requireAdmin } from '../../middleware/auth.mjs';
import { pool, requireDb } from '../../db/index.mjs';
import { logger } from '../../middleware/logger.mjs';

const router = Router();

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
