import { pool, getFlowData } from '../db/index.mjs';

export function approxB64Bytes(v) {
  if (!v || typeof v !== 'string') return 0;
  const b64 = v.includes(',') ? v.split(',', 2)[1] : v;
  return Math.round((b64 || '').length * 0.75);
}

export async function getFlowPdfBytesMap(flowIds = []) {
  if (!flowIds.length) return new Map();
  const { rows } = await pool.query(
    `SELECT flow_id, COALESCE(SUM(CEIL(LENGTH(data) * 0.75)), 0)::bigint AS bytes
       FROM flows_pdfs
      WHERE flow_id = ANY($1)
      GROUP BY flow_id`,
    [flowIds]
  );
  return new Map(rows.map(r => [r.flow_id, Number(r.bytes) || 0]));
}

export function getLegacyFlowBytes(d = {}) {
  return approxB64Bytes(d.pdfB64) + approxB64Bytes(d.signedPdfB64) + approxB64Bytes(d.originalPdfB64);
}

export function flowHasFinalPdf(data = {}) {
  return !!(
    data.signedPdfB64
    || data._signedPdfB64Present
    || (data.storage === 'drive' && (data.driveFileIdFinal || data.driveFileLinkFinal))
  );
}

export function isFlowSuccessfullyCompleted(data = {}) {
  const status = String(data.status || '').toLowerCase();
  const signers = Array.isArray(data.signers) ? data.signers : [];
  const hasRefused = signers.some(s => s.status === 'refused') || status === 'refused';
  const isCancelled = status === 'cancelled';
  const isReview = status === 'review_requested';
  const allSigned = signers.length > 0 && signers.every(s => s.status === 'signed');
  return !hasRefused && !isCancelled && !isReview && !!(data.completed || allSigned || status === 'completed');
}

export function getFlowDisplayState(data = {}) {
  const status = String(data.status || '').toLowerCase();
  const signers = Array.isArray(data.signers) ? data.signers : [];
  const hasRefused = signers.some(s => s.status === 'refused') || status === 'refused';
  const isCancelled = status === 'cancelled';
  const isReviewRequested = status === 'review_requested';
  const successFinal = isFlowSuccessfullyCompleted(data);
  const hasFinalPdf = flowHasFinalPdf(data);
  return {
    hasRefused,
    isCancelled,
    isReviewRequested,
    successFinal,
    hasFinalPdf,
    canDownloadFinalPdf: successFinal && hasFinalPdf,
    isProcessingFinalPdf: successFinal && !hasFinalPdf,
  };
}

export async function getDownloadableFinalFlow(flowId) {
  const data = await getFlowData(flowId);
  if (!data) return { data: null, state: null };
  return { data, state: getFlowDisplayState(data) };
}
