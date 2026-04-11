/**
 * server/modules/audit/routes.mjs — Audit log API (v4)
 * Mounted at /api/audit in app.mjs
 */

import { Router }       from 'express';
import { pool }         from '../../db/index.mjs';
import { requireAuth }  from '../../middleware/auth.mjs';
import { getOrgId, isSuperAdmin } from '../../core/tenant.mjs';
import { ForbiddenError } from '../../core/errors.mjs';
import { parsePagination } from '../../core/pagination.mjs';

const router = Router();

function requireAdminRole(req, res, next) {
  if (!req.user || !['admin', 'superadmin', 'org_admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

// ── GET /api/audit/events ─────────────────────────────────────────────────────

router.get('/events', requireAuth, requireAdminRole, async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    const { flow_id, event_type, actor_email, from, to, ok } = req.query;

    const orgId = getOrgId(req);
    const conds = ['ae.org_id=$1'];
    const vals  = [orgId];
    let idx = 2;

    if (flow_id)     { conds.push(`ae.flow_id=$${idx++}`);           vals.push(flow_id); }
    if (event_type)  { conds.push(`ae.event_type=$${idx++}`);        vals.push(event_type); }
    if (actor_email) { conds.push(`ae.actor_email ILIKE $${idx++}`); vals.push(`%${actor_email}%`); }
    if (from)        { conds.push(`ae.created_at >= $${idx++}`);     vals.push(new Date(from)); }
    if (to)          { conds.push(`ae.created_at <= $${idx++}`);     vals.push(new Date(to)); }
    if (ok !== undefined && ok !== '') {
      conds.push(`ae.ok=$${idx++}`);
      vals.push(ok === 'true' || ok === '1');
    }

    const { rows } = await pool.query(
      `SELECT ae.*, COUNT(*) OVER() AS _total
       FROM audit_events ae
       WHERE ${conds.join(' AND ')}
       ORDER BY ae.created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...vals, limit, offset]
    );

    const total = rows.length > 0 ? parseInt(rows[0]._total) : 0;
    const items = rows.map(({ _total, ...r }) => r);
    res.json({
      events: items,
      meta:   { total, page, limit, pages: Math.ceil(total / limit) || 1 },
    });
  } catch (err) { next(err); }
});

// ── GET /api/audit/flows/:flow_id ─────────────────────────────────────────────

router.get('/flows/:flow_id', requireAuth, async (req, res, next) => {
  try {
    const orgId  = getOrgId(req);
    const flowId = req.params.flow_id;

    // Verify the flow belongs to the requesting org
    const { rows: flowCheck } = await pool.query(
      `SELECT org_id FROM flows WHERE id=$1 AND deleted_at IS NULL LIMIT 1`,
      [flowId]
    );
    if (!flowCheck[0]) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Flow not found' } });
    }
    if (!isSuperAdmin(req) && flowCheck[0].org_id !== orgId) {
      throw new ForbiddenError();
    }

    const { rows } = await pool.query(
      `SELECT * FROM audit_events
       WHERE flow_id=$1
       ORDER BY created_at DESC`,
      [flowId]
    );
    res.json({ events: rows });
  } catch (err) { next(err); }
});

// ── GET /api/audit/export ─────────────────────────────────────────────────────

router.get('/export', requireAuth, requireAdminRole, async (req, res, next) => {
  try {
    const orgId = getOrgId(req);
    const { from, to, event_type } = req.query;

    const conds = ['org_id=$1'];
    const vals  = [orgId];
    let idx = 2;

    if (event_type) { conds.push(`event_type=$${idx++}`);      vals.push(event_type); }
    if (from)       { conds.push(`created_at >= $${idx++}`);   vals.push(new Date(from)); }
    if (to)         { conds.push(`created_at <= $${idx++}`);   vals.push(new Date(to)); }

    const { rows } = await pool.query(
      `SELECT id, created_at, event_type, actor_email, flow_id, ok, message
       FROM audit_events
       WHERE ${conds.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT 50000`,
      vals
    );

    // Build CSV
    const CSV_HEADERS = 'id,created_at,event_type,actor_email,flow_id,ok,message\n';
    const csvBody = rows.map(r => [
      r.id,
      r.created_at?.toISOString() ?? '',
      _csvEsc(r.event_type),
      _csvEsc(r.actor_email ?? ''),
      _csvEsc(r.flow_id ?? ''),
      r.ok ? 'true' : 'false',
      _csvEsc(r.message ?? ''),
    ].join(',')).join('\n');

    const dateStr = new Date().toISOString().slice(0, 10);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="audit-${orgId}-${dateStr}.csv"`);
    res.send(CSV_HEADERS + csvBody);
  } catch (err) { next(err); }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function _csvEsc(val) {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export default router;
