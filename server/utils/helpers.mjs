/**
 * DocFlowAI — Shared helpers
 * newFlowId, buildSignerLink, stripSensitive, stripPdfB64, isSignerTokenExpired
 */

import crypto from 'crypto';

// ── Flow ID ────────────────────────────────────────────────────────────────
function makeFlowId(institutie) {
  const words = (institutie || '').trim().split(/\s+/).filter(Boolean);
  const initials = words.length >= 2
    ? words.slice(0, 4).map(w => w[0].toUpperCase()).join('')
    : (words[0] ? words[0].slice(0, 3).toUpperCase() : 'DOC');
  const rand = crypto.randomBytes(5).toString('hex').toUpperCase();
  return `${initials}_${rand}`;
}

export function newFlowId(institutie) { return makeFlowId(institutie); }

// ── URL helpers ────────────────────────────────────────────────────────────
export function publicBaseUrl(req) {
  const envBase = process.env.PUBLIC_BASE_URL;
  if (envBase) return envBase.replace(/\/$/, '');
  const host = req.get('host');
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  return `${proto}://${host}`;
}

export function buildSignerLink(req, flowId, token) {
  return `${publicBaseUrl(req)}/semdoc-signer.html?flow=${encodeURIComponent(flowId)}&token=${encodeURIComponent(token)}`;
}

// ── Data strip helpers ─────────────────────────────────────────────────────
export function stripPdfB64(data) {
  if (!data || typeof data !== 'object') return data;
  const { pdfB64, signedPdfB64, ...rest } = data;
  return { ...rest, hasPdf: !!pdfB64, hasSignedPdf: !!signedPdfB64 };
}

export function stripSensitive(data, callerSignerToken = null) {
  if (!data || typeof data !== 'object') return data;
  const { pdfB64, signedPdfB64, ...rest } = data;
  return {
    ...rest,
    hasPdf: !!pdfB64,
    hasSignedPdf: !!(signedPdfB64 || (data.storage === 'drive' && data.driveFileLinkFinal)),
    signers: (data.signers || []).map(s => {
      const { token, ...signerRest } = s;
      return callerSignerToken && s.token === callerSignerToken
        ? { ...signerRest, token }
        : signerRest;
    }),
  };
}

// ── Token expiry ───────────────────────────────────────────────────────────
export const SIGNER_TOKEN_EXPIRY_DAYS = 90;

export function isSignerTokenExpired(signer) {
  if (!signer.tokenCreatedAt) return false;
  const created = new Date(signer.tokenCreatedAt).getTime();
  return (Date.now() - created) > SIGNER_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
}
