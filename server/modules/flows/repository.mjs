/**
 * server/modules/flows/repository.mjs — Flow data access layer (v4)
 */

import { pool, withTransaction } from '../../db/index.mjs';
import { generateId } from '../../core/ids.mjs';
import { parsePagination } from '../../core/pagination.mjs';

// ── createFlow ─────────────────────────────────────────────────────────────────

export async function createFlow({
  org_id, initiator_id, initiator_email, initiator_name,
  title, doc_name, doc_type = 'tabel', form_type = 'none', signers = [],
}) {
  const flowId = generateId();

  const signerRows = [];

  await withTransaction(async (client) => {
    // Build data JSONB compat blob (NO-TOUCH zone reads data->'signers')
    const signerData = signers.map((s, i) => ({
      id:    generateId(),
      order: i,
      email: s.email,
      name:  s.name  || '',
      role:  s.role  || null,
      functie: s.function || s.functie || null,
      status: 'pending',
    }));

    const dataBlob = {
      orgId:          org_id,
      initEmail:      initiator_email,
      initName:       initiator_name,
      title,
      docName:        doc_name,
      docType:        doc_type,
      status:         'draft',
      currentStep:    0,
      signers:        signerData,
    };

    await client.query(
      `INSERT INTO flows
         (id, org_id, initiator_id, initiator_email, initiator_name,
          title, doc_name, doc_type, form_type, status, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', $10::jsonb)`,
      [flowId, org_id, initiator_id ?? null, initiator_email, initiator_name,
       title, doc_name, doc_type, form_type, JSON.stringify(dataBlob)]
    );

    // Insert flow_signers
    for (let i = 0; i < signers.length; i++) {
      const s  = signers[i];
      const id = generateId();
      await client.query(
        `INSERT INTO flow_signers
           (id, flow_id, step_order, email, name, role, function, status, meta)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', '{}')`,
        [id, flowId, i, s.email, s.name || '', s.role || null, s.function || s.functie || null]
      );
      signerRows.push({
        id, flow_id: flowId, step_order: i,
        email: s.email, name: s.name || '',
        role: s.role || null, function: s.function || s.functie || null,
        status: 'pending', token: null, token_expires: null,
        signing_method: null, signed_at: null, decision: null, notes: null, meta: {},
      });
    }

    // flows_pdfs placeholder row — required for cloud-signing compat
    await client.query(
      `INSERT INTO flows_pdfs (flow_id, key, data, updated_at)
       VALUES ($1, 'pdfB64', '', NOW())
       ON CONFLICT (flow_id, key) DO NOTHING`,
      [flowId]
    );
  });

  return {
    id: flowId, org_id, initiator_id: initiator_id ?? null,
    initiator_email, initiator_name,
    title, doc_name, doc_type, form_type,
    status: 'draft', current_step: 0,
    metadata: {}, data: {},
    signers: signerRows,
  };
}

// ── getFlowById ────────────────────────────────────────────────────────────────

export async function getFlowById(flow_id, org_id) {
  const cond = org_id != null ? 'AND f.org_id = $2' : '';
  const params = org_id != null ? [flow_id, org_id] : [flow_id];
  const { rows } = await pool.query(
    `SELECT f.*,
       (SELECT json_agg(s ORDER BY s.step_order)
        FROM flow_signers s WHERE s.flow_id = f.id) AS signers
     FROM flows f
     WHERE f.id = $1 ${cond} AND f.deleted_at IS NULL`,
    params
  );
  if (!rows[0]) return null;
  const row = rows[0];
  row.signers = row.signers || [];
  return row;
}

// ── updateFlowStatus ──────────────────────────────────────────────────────────

export async function updateFlowStatus(flow_id, status, extra = {}) {
  const sets  = ['status=$2', 'updated_at=NOW()'];
  const vals  = [flow_id, status];
  let   idx   = 3;

  if (extra.completed_at !== undefined) {
    sets.push(`completed_at=$${idx++}`);
    vals.push(extra.completed_at);
  }
  if (extra.cancelled_at !== undefined) {
    sets.push(`deleted_by=$${idx++}`);  // reuse for cancel reason
    vals.push(extra.reason || null);
  }

  // Keep data JSONB status in sync for NO-TOUCH compat
  sets.push(`data = data || $${idx++}::jsonb`);
  vals.push(JSON.stringify({ status }));

  await pool.query(
    `UPDATE flows SET ${sets.join(', ')} WHERE id=$1`,
    vals
  );
}

// ── updateSigner ──────────────────────────────────────────────────────────────

export async function updateSigner(signer_id, updates) {
  const ALLOWED = [
    'status', 'token', 'token_expires', 'signed_at', 'signing_method',
    'decision', 'notes', 'email', 'name', 'delegated_from',
  ];
  const sets = [];
  const vals = [];
  let   idx  = 1;

  for (const [k, v] of Object.entries(updates)) {
    if (!ALLOWED.includes(k)) continue;
    sets.push(`${k}=$${idx++}`);
    vals.push(v);
  }
  if (sets.length === 0) return;

  vals.push(signer_id);
  await pool.query(
    `UPDATE flow_signers SET ${sets.join(', ')} WHERE id=$${idx}`,
    vals
  );
}

// ── getCurrentSigner ──────────────────────────────────────────────────────────

export async function getCurrentSigner(flow_id) {
  const { rows } = await pool.query(
    `SELECT * FROM flow_signers WHERE flow_id=$1 AND status='current' LIMIT 1`,
    [flow_id]
  );
  return rows[0] ?? null;
}

// ── getSignerByToken ──────────────────────────────────────────────────────────

export async function getSignerByToken(token) {
  const { rows } = await pool.query(
    `SELECT fs.*, f.org_id, f.status AS flow_status, f.doc_name, f.doc_type,
            f.initiator_id, f.title
     FROM flow_signers fs
     JOIN flows f ON f.id = fs.flow_id
     WHERE fs.token=$1 AND fs.token_expires > NOW()
       AND f.deleted_at IS NULL`,
    [token]
  );
  return rows[0] ?? null;
}

// ── getNextPendingSigner ──────────────────────────────────────────────────────

export async function getNextPendingSigner(flow_id, after_step_order) {
  const { rows } = await pool.query(
    `SELECT * FROM flow_signers
     WHERE flow_id=$1 AND step_order > $2 AND status='pending'
     ORDER BY step_order ASC LIMIT 1`,
    [flow_id, after_step_order]
  );
  return rows[0] ?? null;
}

// ── listFlows ─────────────────────────────────────────────────────────────────

export async function listFlows(org_id, {
  actor_id, actor_email, actor_role,
  status, page, limit, search,
} = {}) {
  const { page: p, limit: lim, offset } = parsePagination({ page, limit });
  const isAdmin = actor_role === 'admin' || actor_role === 'superadmin';

  const conds = ['f.org_id=$1', 'f.deleted_at IS NULL'];
  const vals  = [org_id];
  let   idx   = 2;

  if (!isAdmin) {
    conds.push(
      `(f.initiator_id=$${idx++} OR EXISTS (
         SELECT 1 FROM flow_signers fs
         WHERE fs.flow_id=f.id AND lower(fs.email)=lower($${idx++})
       ))`
    );
    vals.push(actor_id, actor_email || '');
  }

  if (status) {
    conds.push(`f.status=$${idx++}`);
    vals.push(status);
  }

  if (search) {
    const q = `%${search.toLowerCase()}%`;
    conds.push(
      `(lower(f.title) LIKE $${idx} OR lower(f.doc_name) LIKE $${idx} OR lower(f.initiator_email) LIKE $${idx})`
    );
    vals.push(q);
    idx++;
  }

  const where = conds.join(' AND ');

  const { rows } = await pool.query(
    `SELECT f.*, COUNT(*) OVER() AS _total
     FROM flows f
     WHERE ${where}
     ORDER BY f.updated_at DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    [...vals, lim, offset]
  );

  const total = rows.length > 0 ? parseInt(rows[0]._total) : 0;
  const flows = rows.map(({ _total, ...r }) => r);
  return { flows, total, page: p, limit: lim };
}

// ── softDeleteFlow ────────────────────────────────────────────────────────────

export async function softDeleteFlow(flow_id, org_id) {
  const { rows } = await pool.query(
    `UPDATE flows SET deleted_at=NOW(), updated_at=NOW()
     WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL
     RETURNING id`,
    [flow_id, org_id]
  );
  return rows[0] ?? null;
}

// ── insertDocumentRevision ────────────────────────────────────────────────────

export async function insertDocumentRevision({
  flow_id, revision_type, pdf_base64, sha256, size_bytes, created_by_id,
}) {
  const id = generateId();

  const { rows: noRows } = await pool.query(
    `SELECT COALESCE(MAX(revision_no), 0) + 1 AS next_no
     FROM document_revisions WHERE flow_id=$1`,
    [flow_id]
  );
  const revision_no = noRows[0].next_no;

  await pool.query(
    `INSERT INTO document_revisions
       (id, flow_id, revision_no, revision_type, pdf_base64, sha256, size_bytes, created_by_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, flow_id, revision_no, revision_type,
     pdf_base64, sha256, size_bytes ?? null, created_by_id ?? null]
  );

  return { id, revision_no };
}

// ── updateFlowDocument ────────────────────────────────────────────────────────

export async function updateFlowDocument(flow_id, base64, originalName) {
  // flows_pdfs — read by cloud-signing.mjs (NO-TOUCH) directly
  await pool.query(
    `INSERT INTO flows_pdfs (flow_id, key, data, updated_at) VALUES ($1, 'pdfB64', $2, NOW())
     ON CONFLICT (flow_id, key) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()`,
    [flow_id, base64]
  );
  await pool.query(
    `INSERT INTO flows_pdfs (flow_id, key, data, updated_at) VALUES ($1, 'docName', $2, NOW())
     ON CONFLICT (flow_id, key) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()`,
    [flow_id, originalName]
  );

  // flows.metadata + flows.data JSONB compat
  await pool.query(
    `UPDATE flows SET
       metadata    = metadata    || $2::jsonb,
       data        = data        || $3::jsonb,
       doc_name    = $4,
       updated_at  = NOW()
     WHERE id=$1`,
    [
      flow_id,
      JSON.stringify({ hasDocument: true, originalFileName: originalName }),
      JSON.stringify({ pdfB64: base64, docName: originalName, _pdfB64Present: true }),
      originalName,
    ]
  );
}

// ── getFlowRevisions ──────────────────────────────────────────────────────────

export async function getFlowRevisions(flow_id) {
  const { rows } = await pool.query(
    `SELECT id, flow_id, revision_no, revision_type, sha256, size_bytes, created_by_id, created_at
     FROM document_revisions WHERE flow_id=$1 ORDER BY revision_no DESC`,
    [flow_id]
  );
  return rows;
}
