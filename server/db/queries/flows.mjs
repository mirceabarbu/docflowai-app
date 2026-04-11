/**
 * server/db/queries/flows.mjs — flow queries (relational, v4).
 */

import { query, getOne, getMany, withTransaction } from '../index.mjs';
import { parsePagination, buildPaginationMeta } from '../../core/pagination.mjs';

export async function findFlowById(flowId) {
  return getOne(
    `SELECT f.*,
            COALESCE(
              json_agg(fs ORDER BY fs.step_order) FILTER (WHERE fs.id IS NOT NULL),
              '[]'
            ) AS signers
     FROM flows f
     LEFT JOIN flow_signers fs ON fs.flow_id = f.id
     WHERE f.id=$1 AND f.deleted_at IS NULL
     GROUP BY f.id`,
    [flowId]
  );
}

export async function listFlowsForOrg(orgId, queryParams = {}) {
  const { page, limit, offset } = parsePagination(queryParams);
  const { status, search } = queryParams;

  const conditions = ['f.org_id=$1', 'f.deleted_at IS NULL'];
  const vals = [orgId];
  let idx = 2;

  if (status) {
    conditions.push(`f.status=$${idx++}`);
    vals.push(status);
  }
  if (search) {
    conditions.push(`(f.title ILIKE $${idx} OR f.doc_name ILIKE $${idx})`);
    vals.push(`%${search}%`);
    idx++;
  }

  const where = conditions.join(' AND ');

  const rows = await getMany(
    `SELECT f.id, f.title, f.doc_name, f.doc_type, f.status,
            f.initiator_email, f.initiator_name, f.current_step,
            f.created_at, f.updated_at,
            COUNT(*) OVER() AS _total
     FROM flows f
     WHERE ${where}
     ORDER BY f.updated_at DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    [...vals, limit, offset]
  );

  const total = rows.length > 0 ? parseInt(rows[0]._total) : 0;
  const items = rows.map(({ _total, ...r }) => r);
  return { items, meta: buildPaginationMeta(total, page, limit) };
}

export async function softDeleteFlow(flowId, deletedBy) {
  return getOne(
    `UPDATE flows SET deleted_at=NOW(), deleted_by=$2, updated_at=NOW()
     WHERE id=$1 AND deleted_at IS NULL RETURNING id`,
    [flowId, deletedBy]
  );
}

export async function updateFlowStatus(flowId, status, { completedAt } = {}) {
  return getOne(
    `UPDATE flows SET
       status=$2,
       completed_at = CASE WHEN $2 IN ('completed','signed','approved') THEN COALESCE($3, NOW()) ELSE completed_at END,
       updated_at=NOW()
     WHERE id=$1 AND deleted_at IS NULL RETURNING id, status`,
    [flowId, status, completedAt ?? null]
  );
}

export async function getFlowSigners(flowId) {
  return getMany(
    'SELECT * FROM flow_signers WHERE flow_id=$1 ORDER BY step_order',
    [flowId]
  );
}

export async function findFlowBySignerToken(token) {
  return getOne(
    `SELECT f.* FROM flows f
     JOIN flow_signers fs ON fs.flow_id = f.id
     WHERE fs.token=$1 AND f.deleted_at IS NULL`,
    [token]
  );
}
