/**
 * server/modules/archive/service.mjs — Flow archive service (v4)
 */

import crypto from 'crypto';

import { pool }           from '../../db/index.mjs';
import { generateId }     from '../../core/ids.mjs';
import { NotFoundError, AppError } from '../../core/errors.mjs';
import { logAuditEvent }  from '../../db/queries/audit.mjs';
import { logger }         from '../../middleware/logger.mjs';
import { getFlowById }    from '../flows/repository.mjs';
import { uploadToDrive }  from './drive.mjs';

// ── archiveFlow ───────────────────────────────────────────────────────────────

/**
 * Arhivează PDF-ul final al unui flux completat pe Google Drive.
 *
 * @param {string} flow_id
 * @param {number} org_id
 * @returns {Promise<{ archiveJobId, driveFileId, webViewLink }>}
 */
export async function archiveFlow(flow_id, org_id) {
  // 1. Verifică flow-ul
  const flow = await getFlowById(flow_id, org_id);
  if (!flow) throw new NotFoundError('Flow');
  if (flow.status !== 'completed') {
    throw new AppError('Doar fluxuri finalizate pot fi arhivate', 409, 'WRONG_STATUS');
  }

  // 2. Ia ultima revizie semnată
  const { rows: revRows } = await pool.query(
    `SELECT * FROM document_revisions
     WHERE flow_id=$1 AND revision_type IN ('signed_final','signed_partial','original')
     ORDER BY revision_no DESC LIMIT 1`,
    [flow_id]
  );
  const revision = revRows[0];
  if (!revision || !revision.pdf_base64) {
    throw new AppError('Nicio revizie PDF disponibilă pentru arhivare', 404, 'NO_REVISION');
  }

  const pdfBuffer = Buffer.from(revision.pdf_base64, 'base64');
  const docName   = `${flow_id}_${(flow.doc_name || 'document').replace(/[^\w\-]/g, '_')}.pdf`;

  // 3. Creează archive_job cu status: 'running'
  const jobId = generateId();
  await pool.query(
    `INSERT INTO archive_jobs (id, org_id, flow_id, status, storage_type, started_at)
     VALUES ($1, $2, $3, 'running', 'drive', NOW())`,
    [jobId, org_id, flow_id]
  );

  let driveFileId  = null;
  let webViewLink  = '';

  try {
    // 4. Upload la Drive
    const uploaded = await uploadToDrive(pdfBuffer, docName, 'application/pdf');
    driveFileId = uploaded.id;
    webViewLink = uploaded.webViewLink;

    // 5. Creează document_revision tip 'archived' cu storage Drive
    const archivedRevId = generateId();
    await pool.query(
      `INSERT INTO document_revisions
         (id, flow_id, revision_no, revision_type, storage_type, storage_path, sha256, size_bytes)
       SELECT $1, $2,
         COALESCE((SELECT MAX(revision_no) FROM document_revisions WHERE flow_id=$2), 0) + 1,
         'archived', 'drive', $3, $4, $5`,
      [archivedRevId, flow_id, driveFileId,
       crypto.createHash('sha256').update(pdfBuffer).digest('hex'),
       pdfBuffer.length]
    );

    // 6. UPDATE archive_job: completed
    await pool.query(
      `UPDATE archive_jobs
       SET status='completed', archive_path=$1, completed_at=NOW()
       WHERE id=$2`,
      [driveFileId, jobId]
    );

    // 7. Eliberează pdf_base64 din reviziile inline (economie DB)
    await pool.query(
      `UPDATE document_revisions
       SET pdf_base64=NULL
       WHERE flow_id=$1 AND storage_type='inline' AND pdf_base64 IS NOT NULL`,
      [flow_id]
    );

    // 8. Audit
    await logAuditEvent({
      orgId: org_id, flowId: flow_id,
      eventType: 'flow.archived',
      message:   `Flow arhivat pe Drive: ${driveFileId}`,
      meta:      { driveFileId, webViewLink, jobId },
    }).catch(() => {});

    logger.info({ flow_id, driveFileId, jobId }, 'Flow arhivat cu succes');
    return { archiveJobId: jobId, driveFileId, webViewLink };

  } catch (e) {
    // Marchează job-ul ca failed
    await pool.query(
      `UPDATE archive_jobs SET status='failed', error_message=$1 WHERE id=$2`,
      [e.message?.substring(0, 500) || 'Unknown error', jobId]
    ).catch(() => {});
    throw e;
  }
}

// ── getArchiveStatus ──────────────────────────────────────────────────────────

export async function getArchiveStatus(flow_id) {
  const { rows } = await pool.query(
    `SELECT * FROM archive_jobs WHERE flow_id=$1 ORDER BY started_at DESC LIMIT 1`,
    [flow_id]
  );
  return rows[0] ?? null;
}
