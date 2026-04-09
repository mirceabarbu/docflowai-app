/**
 * server/db/queries/audit.mjs — audit event queries (v4 audit_events table).
 */

import { getMany } from '../index.mjs';
import { parsePagination, buildPaginationMeta } from '../../core/pagination.mjs';

export async function logAuditEvent({
  orgId, flowId, actorId, actorEmail, actorType = 'user',
  eventType, channel = 'api', ok = true, message, meta = {}, ipAddress,
}) {
  // Use pool directly to avoid circular dep; import here lazily
  const { pool } = await import('../index.mjs');
  await pool.query(
    `INSERT INTO audit_events
       (org_id, flow_id, actor_id, actor_email, actor_type,
        event_type, channel, ok, message, meta, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
    [
      orgId ?? null, flowId ?? null, actorId ?? null,
      actorEmail ?? null, actorType,
      eventType, channel, ok,
      message ?? null, JSON.stringify(meta), ipAddress ?? null,
    ]
  );
}

export async function listAuditEventsForOrg(orgId, queryParams = {}) {
  const { page, limit, offset } = parsePagination(queryParams);
  const rows = await getMany(
    `SELECT *, COUNT(*) OVER() AS _total
     FROM audit_events
     WHERE org_id=$1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [orgId, limit, offset]
  );
  const total = rows.length > 0 ? parseInt(rows[0]._total) : 0;
  const items = rows.map(({ _total, ...r }) => r);
  return { items, meta: buildPaginationMeta(total, page, limit) };
}

export async function listAuditEventsForFlow(flowId) {
  return getMany(
    `SELECT * FROM audit_events WHERE flow_id=$1 ORDER BY created_at DESC`,
    [flowId]
  );
}
