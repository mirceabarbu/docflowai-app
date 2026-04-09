/**
 * server/db/queries/signing.mjs — signature session queries.
 */

import { getOne, getMany } from '../index.mjs';
import { generateId } from '../../core/ids.mjs';

export async function createSignatureSession({
  flowId, signerId, documentRevisionId, providerCode, providerSessionId,
}) {
  const id = generateId();
  return getOne(
    `INSERT INTO signature_sessions
       (id, flow_id, signer_id, document_revision_id, provider_code,
        provider_session_id, status, started_at)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',NOW())
     RETURNING *`,
    [id, flowId, signerId, documentRevisionId ?? null,
     providerCode, providerSessionId ?? null]
  );
}

export async function updateSignatureSession(id, fields) {
  const allowed = ['status', 'provider_session_id', 'completed_at',
    'failure_reason', 'certificate_thumbprint', 'certificate_subject',
    'certificate_issuer', 'provider_payload'];
  const sets = [];
  const vals = [];
  let idx = 1;
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k} = $${idx++}`);
    vals.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
  }
  if (sets.length === 0) return getSignatureSessionById(id);
  sets.push(`updated_at = NOW()`);
  vals.push(id);
  return getOne(
    `UPDATE signature_sessions SET ${sets.join(', ')} WHERE id=$${idx} RETURNING *`,
    vals
  );
}

export async function getSignatureSessionById(id) {
  return getOne('SELECT * FROM signature_sessions WHERE id=$1', [id]);
}

export async function listSessionsForFlow(flowId) {
  return getMany(
    `SELECT * FROM signature_sessions WHERE flow_id=$1 ORDER BY created_at DESC`,
    [flowId]
  );
}

export async function getActiveSessionForSigner(flowId, signerId) {
  return getOne(
    `SELECT * FROM signature_sessions
     WHERE flow_id=$1 AND signer_id=$2 AND status='pending'
     ORDER BY created_at DESC LIMIT 1`,
    [flowId, signerId]
  );
}
