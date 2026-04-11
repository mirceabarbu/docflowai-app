/**
 * server/modules/verification/service.mjs — Document verification wrapper (v4)
 */

import crypto from 'crypto';

import { pool }           from '../../db/index.mjs';
import { generateId }     from '../../core/ids.mjs';
import { NotFoundError }  from '../../core/errors.mjs';
import { logger }         from '../../middleware/logger.mjs';
import { verifyPdfSignatures }  from '../../services/certificate-verify.mjs';
import { generateTrustReport }  from '../../services/sign-trust-report.mjs';
import { getFlowById }          from '../flows/repository.mjs';

// ── verifyDocument ────────────────────────────────────────────────────────────

/**
 * Verifică semnăturile electronice dintr-un PDF.
 *
 * @param {Buffer} pdfBuffer
 * @returns {Promise<{
 *   valid: boolean,
 *   signatures: Array,
 *   warnings: string[]
 * }>}
 */
export async function verifyDocument(pdfBuffer) {
  const result = await verifyPdfSignatures(pdfBuffer);

  if (result.error === 'no_signatures') {
    return {
      valid:      false,
      signatures: [],
      warnings:   ['Nicio semnătură electronică găsită în document.'],
    };
  }
  if (result.error === 'crypto_unavailable') {
    return {
      valid:      false,
      signatures: [],
      warnings:   ['Motor criptografic indisponibil — verificare imposibilă.'],
    };
  }

  const signatures = (result.signatures || []).map(sig => ({
    signerName:       sig.certificate?.subject?.CN  || 'Necunoscut',
    signerEmail:      sig.certificate?.subject?.serial || null,
    signedAt:         sig.signingTime?.toISOString?.() || null,
    certificateValid: sig.certificate?.isCurrentlyValid ?? null,
    integrityOk:      sig.levels?.L1?.ok ?? null,
    qualified:        sig.isQES ?? false,
    levels:           sig.levels,
    errors:           sig.errors   || [],
    warnings:         sig.warnings || [],
  }));

  const warnings = [];
  if (!result.allValid) warnings.push('Una sau mai multe semnături nu au putut fi validate complet.');
  const hasRevoked = signatures.some(s => s.certificateValid === false);
  if (hasRevoked) warnings.push('Cel puțin un certificat nu este valabil la momentul verificării.');

  return {
    valid:      result.ok === true,
    signatures,
    warnings,
  };
}

// ── generateTrustReportForFlow ────────────────────────────────────────────────

/**
 * Generează raportul de conformitate pentru un flux finalizat.
 *
 * @param {string} flow_id
 * @param {number} org_id
 * @returns {Promise<{ reportId: string, pdfBuffer: Buffer }>}
 */
export async function generateTrustReportForFlow(flow_id, org_id) {
  const flow = await getFlowById(flow_id, org_id);
  if (!flow) throw new NotFoundError('Flow');

  // Obținem PDF-ul semnat (ultima revizie signed_final sau signed_partial)
  let pdfBytes = null;
  const { rows: revRows } = await pool.query(
    `SELECT pdf_base64 FROM document_revisions
     WHERE flow_id=$1 AND revision_type IN ('signed_final','signed_partial')
     ORDER BY revision_no DESC LIMIT 1`,
    [flow_id]
  );
  if (revRows[0]?.pdf_base64) {
    pdfBytes = Buffer.from(revRows[0].pdf_base64, 'base64');
  }

  // Construim flowData în formatul așteptat de generateTrustReport
  const flowData = {
    ...flow,
    flowId:      flow_id,
    docName:     flow.doc_name,
    docType:     flow.doc_type,
    initEmail:   flow.initiator_email,
    initName:    flow.initiator_name,
    signers:     Array.isArray(flow.signers) ? flow.signers : [],
    events:      [],
  };

  const { pdfBytes: reportPdf, report } = await generateTrustReport({
    flowId: flow_id,
    flowData,
    pdfBytes,
    pool,
  });

  // Salvăm raportul ca document_revision
  const revId = generateId();
  await pool.query(
    `INSERT INTO document_revisions
       (id, flow_id, revision_no, revision_type, storage_type, sha256, size_bytes)
     SELECT $1, $2,
       COALESCE((SELECT MAX(revision_no) FROM document_revisions WHERE flow_id=$2), 0) + 1,
       'trust_report', 'inline', $3, $4`,
    [revId, flow_id,
     crypto.createHash('sha256').update(reportPdf).digest('hex'),
     reportPdf.length]
  ).catch(e => logger.warn({ err: e }, 'trust_report revision INSERT failed (non-fatal)'));

  const reportId = `TR_${flow_id}`;
  return { reportId, pdfBuffer: reportPdf };
}
