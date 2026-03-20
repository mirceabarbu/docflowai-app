/**
 * DocFlowAI — flows/attachments.mjs
 * Documente suport (attachments): upload, list, download, delete
 */
import { Router, json as expressJson } from 'express';
import { AUTH_COOKIE, JWT_SECRET, requireAuth, requireAdmin, sha256Hex, escHtml } from '../middleware/auth.mjs';
import { pool, DB_READY, requireDb, saveFlow, getFlowData, getDefaultOrgId, getUserMapForOrg, writeAuditEvent } from '../db/index.mjs';
import { createRateLimiter } from '../middleware/rateLimiter.mjs';
import { logger } from '../middleware/logger.mjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const _largePdf = expressJson({ limit: '50mb' });
const _getIp = req => req.ip || req.socket?.remoteAddress || null;
const _signRateLimit   = createRateLimiter({ windowMs: 60_000, max: 20, message: 'Prea multe cereri de semnare. Încearcă în 1 minut.' });
const _uploadRateLimit = createRateLimiter({ windowMs: 60_000, max: 5,  message: 'Prea multe upload-uri. Încearcă în 1 minut.' });
const _readRateLimit   = createRateLimiter({ windowMs: 60_000, max: 60, message: 'Prea multe cereri. Încearcă în 1 minut.' });

function getOptionalActor(req) {
  const cookieToken = req.cookies?.[AUTH_COOKIE] || null;
  if (cookieToken) { try { return jwt.verify(cookieToken, JWT_SECRET); } catch (e) {} }
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) { try { return jwt.verify(authHeader.slice(7), JWT_SECRET); } catch (e) {} }
  return null;
}

// Deps injectate din flows/index.mjs
let _notify, _wsPush, _PDFLib, _stampFooterOnPdf, _isSignerTokenExpired;
let _newFlowId, _buildSignerLink, _stripSensitive, _stripPdfB64, _sendSignerEmail, _fireWebhook;
export function _injectDeps(d) {
  _notify = d.notify; _fireWebhook = d.fireWebhook || null; _wsPush = d.wsPush;
  _PDFLib = d.PDFLib; _stampFooterOnPdf = d.stampFooterOnPdf;
  _isSignerTokenExpired = d.isSignerTokenExpired; _newFlowId = d.newFlowId;
  _buildSignerLink = d.buildSignerLink; _stripSensitive = d.stripSensitive;
  _stripPdfB64 = d.stripPdfB64; _sendSignerEmail = d.sendSignerEmail;
}

const router = Router();



// ── F-06: Documente suport ────────────────────────────────────────────────
// Tipuri MIME acceptate: PDF, ZIP, RAR
const ATTACH_ALLOWED_MIME = new Set([
  'application/pdf',
  'application/zip', 'application/x-zip-compressed', 'application/x-zip',
  'application/x-rar-compressed', 'application/vnd.rar', 'application/x-rar',
]);
const ATTACH_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

// POST /flows/:flowId/attachments — încarcă document suport
router.post('/flows/:flowId/attachments', _largePdf, async (req, res) => {
  try {
    if (requireDb(res)) return;
    const actor = requireAuth(req, res); if (!actor) return;
    const { flowId } = req.params;
    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    // Doar inițiatorul sau admin poate atașa documente
    const isInit = (data.initEmail || '').toLowerCase() === actor.email.toLowerCase();
    const isAdmin = actor.role === 'admin' || (actor.role === 'org_admin' && data.orgId != null && actor.orgId != null && Number(data.orgId) === Number(actor.orgId));
    if (!isInit && !isAdmin) return res.status(403).json({ error: 'forbidden' });
    if (data.status === 'cancelled') return res.status(409).json({ error: 'flow_cancelled' });

    const { filename, mimeType, dataB64 } = req.body || {};
    if (!filename || !dataB64) return res.status(400).json({ error: 'filename_and_data_required' });

    // Detectare MIME din extensie dacă nu e furnizat sau e generic
    const ext = (filename.split('.').pop() || '').toLowerCase();
    const mimeByExt = { pdf: 'application/pdf', zip: 'application/zip', rar: 'application/x-rar-compressed' };
    const resolvedMime = (mimeType && ATTACH_ALLOWED_MIME.has(mimeType)) ? mimeType : (mimeByExt[ext] || mimeType || 'application/octet-stream');
    if (!ATTACH_ALLOWED_MIME.has(resolvedMime)) {
      return res.status(400).json({ error: 'invalid_type', message: 'Tipuri acceptate: PDF, ZIP, RAR.' });
    }

    const raw = dataB64.includes(',') ? dataB64.split(',')[1] : dataB64;
    const buf = Buffer.from(raw, 'base64');
    if (buf.length > ATTACH_MAX_BYTES) return res.status(413).json({ error: 'too_large', message: 'Fișierul depășește limita de 10 MB.' });

    const { rows } = await pool.query(
      `INSERT INTO flow_attachments (flow_id, filename, mime_type, size_bytes, data)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, filename, mime_type, size_bytes, uploaded_at`,
      [flowId, filename.slice(0, 255), resolvedMime, buf.length, buf]
    );
    const att = rows[0];
    writeAuditEvent({ flowId, orgId: data.orgId, eventType: 'ATTACHMENT_ADDED', actorIp: _getIp(req), actorEmail: actor.email, payload: { filename: att.filename, size: att.size_bytes } });
    logger.info(`📎 Attachment ${att.id} adăugat la flow ${flowId} de ${actor.email}`);
    return res.status(201).json({ ok: true, id: att.id, filename: att.filename, mimeType: att.mime_type, sizeBytes: att.size_bytes, uploadedAt: att.uploaded_at });
  } catch(e) { logger.error({ err: e }, 'attachment upload error'); return res.status(500).json({ error: 'server_error' }); }
});

// GET /flows/:flowId/attachments — lista documente suport
router.get('/flows/:flowId/attachments', async (req, res) => {
  try {
    if (requireDb(res)) return;
    const signerToken = req.query.token || null;
    const actor = getOptionalActor(req);
    if (!actor && !signerToken) return res.status(403).json({ error: 'forbidden' });
    const { flowId } = req.params;
    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    if (!actor && signerToken && !(data.signers || []).some(s => s.token === signerToken))
      return res.status(403).json({ error: 'forbidden' });
    const { rows } = await pool.query(
      `SELECT id, filename, mime_type, size_bytes, drive_file_id, drive_file_link, uploaded_at
       FROM flow_attachments WHERE flow_id=$1 ORDER BY uploaded_at ASC`,
      [flowId]
    );
    return res.json({ attachments: rows.map(r => ({ id: r.id, filename: r.filename, mimeType: r.mime_type, sizeBytes: r.size_bytes, driveFileId: r.drive_file_id, driveFileLink: r.drive_file_link, uploadedAt: r.uploaded_at })) });
  } catch(e) { return res.status(500).json({ error: 'server_error' }); }
});

// GET /flows/:flowId/attachments/:attId — descarcă document suport
router.get('/flows/:flowId/attachments/:attId', async (req, res) => {
  try {
    if (requireDb(res)) return;
    const signerToken = req.query.token || null;
    const actor = getOptionalActor(req);
    if (!actor && !signerToken) return res.status(403).json({ error: 'forbidden' });
    const { flowId, attId } = req.params;
    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    if (!actor && signerToken && !(data.signers || []).some(s => s.token === signerToken))
      return res.status(403).json({ error: 'forbidden' });
    const { rows } = await pool.query(
      'SELECT filename, mime_type, data FROM flow_attachments WHERE id=$1 AND flow_id=$2',
      [parseInt(attId), flowId]
    );
    if (!rows.length) return res.status(404).json({ error: 'attachment_not_found' });
    const att = rows[0];
    const safeName = att.filename.replace(/[^\w\-\.]/g, '_');
    res.setHeader('Content-Type', att.mime_type);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    return res.status(200).send(att.data);
  } catch(e) { return res.status(500).json({ error: 'server_error' }); }
});

// DELETE /flows/:flowId/attachments/:attId — șterge document suport (inițiator/admin)
router.delete('/flows/:flowId/attachments/:attId', async (req, res) => {
  try {
    if (requireDb(res)) return;
    const actor = requireAuth(req, res); if (!actor) return;
    const { flowId, attId } = req.params;
    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    const isInit = (data.initEmail || '').toLowerCase() === actor.email.toLowerCase();
    const isAdmin = actor.role === 'admin' || (actor.role === 'org_admin' && data.orgId != null && actor.orgId != null && Number(data.orgId) === Number(actor.orgId));
    if (!isInit && !isAdmin) return res.status(403).json({ error: 'forbidden' });
    const { rowCount } = await pool.query('DELETE FROM flow_attachments WHERE id=$1 AND flow_id=$2', [parseInt(attId), flowId]);
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    return res.json({ ok: true });
  } catch(e) { return res.status(500).json({ error: 'server_error' }); }
});




export default router;
