/**
 * server/db/queries/documents.mjs — document revision queries.
 */

import { getOne, getMany } from '../index.mjs';
import { generateId } from '../../core/ids.mjs';
import { sha256Hex } from '../../core/hashing.mjs';

export async function createRevision({
  flowId, revisionType, pdfBase64, storagePath,
  storageType = 'inline', createdById,
}) {
  const id = generateId();
  const sha = pdfBase64 ? sha256Hex(Buffer.from(pdfBase64, 'base64')) : null;
  const sizeBytes = pdfBase64 ? Buffer.byteLength(pdfBase64, 'base64') : null;

  // Determine next revision_no
  const prev = await getOne(
    'SELECT MAX(revision_no) AS max_no FROM document_revisions WHERE flow_id=$1',
    [flowId]
  );
  const revisionNo = (prev?.max_no ?? 0) + 1;

  return getOne(
    `INSERT INTO document_revisions
       (id, flow_id, revision_no, revision_type, storage_type, storage_path,
        pdf_base64, sha256, size_bytes, created_by_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [id, flowId, revisionNo, revisionType, storageType,
     storagePath ?? null, pdfBase64 ?? null, sha, sizeBytes, createdById ?? null]
  );
}

export async function getLatestRevision(flowId) {
  return getOne(
    `SELECT * FROM document_revisions
     WHERE flow_id=$1 ORDER BY revision_no DESC LIMIT 1`,
    [flowId]
  );
}

export async function listRevisions(flowId) {
  return getMany(
    `SELECT id, flow_id, revision_no, revision_type, storage_type,
            sha256, size_bytes, created_by_id, created_at
     FROM document_revisions WHERE flow_id=$1 ORDER BY revision_no DESC`,
    [flowId]
  );
}

export async function getRevisionById(id) {
  return getOne('SELECT * FROM document_revisions WHERE id=$1', [id]);
}
