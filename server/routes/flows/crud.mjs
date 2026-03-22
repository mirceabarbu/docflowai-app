/**
 * DocFlowAI — flows/crud.mjs
 * CRUD fluxuri: creare, citire, actualizare, ștergere, my-flows
 */
import { Router, json as expressJson } from 'express';
import { AUTH_COOKIE, JWT_SECRET, requireAuth, requireAdmin, sha256Hex, escHtml } from '../../middleware/auth.mjs';
import { pool, DB_READY, requireDb, saveFlow, getFlowData, getDefaultOrgId, getUserMapForOrg, writeAuditEvent } from '../../db/index.mjs';
import { createRateLimiter } from '../../middleware/rateLimiter.mjs';
import { logger } from '../../middleware/logger.mjs';
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

import { emailDelegare, emailSendExtern } from '../../emailTemplates.mjs';
import { getOrgProviders, getOrgProviderConfig, getProvider } from '../../signing/index.mjs';

// ── POST /flows — creare flux ──────────────────────────────────────────────
const createFlow = async (req, res) => {
  try {
    if (requireDb(res)) return;
    // BUG-03 fix: createFlow necesita autentificare — orice utilizator autentificat poate crea fluxuri
    const actor = requireAuth(req, res); if (!actor) return;
    const body = req.body || {};
    const docName = String(body.docName || '').trim();
    const initName = String(body.initName || '').trim();
    const initEmail = String(body.initEmail || '').trim();
    const signers = Array.isArray(body.signers) ? body.signers : [];

    let orgId = null;
    try {
      const ru = await pool.query('SELECT org_id FROM users WHERE email=$1', [initEmail.trim().toLowerCase()]);
      orgId = ru.rows[0]?.org_id || null;
    } catch(e) {}
    if (!orgId) {
      try { orgId = await getDefaultOrgId(); } catch(e) { orgId = null; }
    }

    if (!docName || docName.length < 2) return res.status(400).json({ error: 'docName_required' });
    if (docName.length > 500) return res.status(400).json({ error: 'docName_too_long', max: 500 });
    if (!initName || initName.length < 2) return res.status(400).json({ error: 'initName_required' });
    if (initName.length > 200) return res.status(400).json({ error: 'initName_too_long', max: 200 });
    if (!initEmail || !/^\S+@\S+\.\S+$/.test(initEmail)) return res.status(400).json({ error: 'initEmail_invalid' });
    if (!signers.length) return res.status(400).json({ error: 'signers_required' });
    if (signers.length > 50) return res.status(400).json({ error: 'too_many_signers', max: 50 });

    // FIX v3.2.3: validare dimensiune PDF la creare flux
    if (body.pdfB64 && typeof body.pdfB64 === 'string') {
      const rawPdfCheck = body.pdfB64.includes('base64,') ? body.pdfB64.split('base64,')[1] : body.pdfB64;
      const estimatedPdfBytes = Math.floor(rawPdfCheck.length * 0.75);
      if (estimatedPdfBytes > 50 * 1024 * 1024) return res.status(413).json({ error: 'pdf_too_large_max_50mb', message: 'PDF-ul depășește limita de 50 MB.' });
    }

    for (let i = 0; i < signers.length; i++) {
      const s = signers[i] || {};
      if (!String(s.email || '').trim() || !/^\S+@\S+\.\S+$/.test(String(s.email || '').trim())) return res.status(400).json({ error: 'signer_email_invalid', index: i });
      if (!String(s.name || '').trim() || String(s.name || '').trim().length < 2) return res.status(400).json({ error: 'signer_name_required', index: i });
    }

    // FIX v3.2.3: semnatari duplicați blocați în backend
    const signerEmails = signers.map(s => String(s.email || '').trim().toLowerCase()).filter(Boolean);
    const uniqueEmails = new Set(signerEmails);
    if (uniqueEmails.size !== signerEmails.length) return res.status(400).json({ error: 'duplicate_signer_emails', message: 'Același utilizator nu poate apărea de două ori în lista de semnatari.' });

    const normalizedSigners = signers.map((s, idx) => ({
      order: Number(s.order || idx + 1),
      rol: String(s.rol || s.atribut || '').trim(),
      functie: String(s.functie || '').trim(),
      compartiment: String(s.compartiment || '').trim(),
      name: String(s.name || '').trim(),
      email: String(s.email || '').trim(),
      token: String(s.token || crypto.randomBytes(16).toString('hex')),
      tokenCreatedAt: new Date().toISOString(),
      status: 'pending', signedAt: null, signature: null,
    }));
    normalizedSigners.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
    normalizedSigners.forEach((s, i) => { s.status = i === 0 ? 'current' : 'pending'; });

    const createdAt = body.createdAt || new Date().toISOString();
    let initFunctie = '', initCompartiment = '', initInstitutie = body.institutie || '';
    try {
      const uRes = await pool.query('SELECT functie,compartiment,institutie FROM users WHERE email=$1', [initEmail.toLowerCase()]);
      if (uRes.rows[0]) {
        initFunctie = uRes.rows[0].functie || '';
        initCompartiment = uRes.rows[0].compartiment || '';
        initInstitutie = initInstitutie || uRes.rows[0].institutie || '';
      }
    } catch(e) {}

    const flowId = _newFlowId(initInstitutie);
    let finalPdfB64 = body.pdfB64 ?? null;

    // flowType 'ancore': PDF-ul NU se modifica deloc — nici footer stamp.
    // Formularele oficiale (Formular 17 etc.) pot contine semnaturi de certificare
    // ale autoritatii emitente. Orice modificare (chiar si pdf-lib save) le invalideaza.
    // Campurile de semnatura predefinite (AcroForm) raman intacte.

    if (finalPdfB64 && _stampFooterOnPdf && (body.flowType || 'tabel') !== 'ancore') {
      try {
        finalPdfB64 = await _stampFooterOnPdf(finalPdfB64, {
          flowId, createdAt, initName, initFunctie,
          institutie: initInstitutie, compartiment: initCompartiment,
          flowType: body.flowType || 'tabel'
        });
      } catch(e) { logger.warn({ err: e }, 'Footer la creare error:'); }
    }

    const data = {
      orgId,
      flowId, docName, initName, initEmail,
      initFunctie, institutie: initInstitutie, compartiment: initCompartiment,
      meta: body.meta || {}, flowType: body.flowType || 'tabel',
      urgent: !!(body.urgent),
      originalPdfB64: body.pdfB64 ?? null,  // PDF curat, fără footer — pentru reinitiate
      pdfB64: finalPdfB64,
      signers: normalizedSigners,
      createdAt, updatedAt: new Date().toISOString(),
      events: [{ at: new Date().toISOString(), type: 'FLOW_CREATED', by: initEmail, urgent: !!(body.urgent) }],
    };
    const first = data.signers.find(s => s.status === 'current');
    const initIsSigner = first && first.email.toLowerCase() === initEmail.toLowerCase();
    if (first?.email && !initIsSigner) first.notifiedAt = new Date().toISOString();
    await saveFlow(flowId, data);
    // R-02: audit_log
    writeAuditEvent({ flowId, orgId, eventType: 'FLOW_CREATED', actorIp: _getIp(req), actorEmail: initEmail, payload: { docName: data.docName, signersCount: normalizedSigners.length, urgent: data.urgent } });

    if (first?.email && !initIsSigner) {
      await _notify({ userEmail: first.email, flowId, type: 'YOUR_TURN', title: 'Document de semnat',
        message: `${initName} te-a adăugat ca semnatar pe documentul „${data.docName}". Intră în aplicație pentru a semna.`,
        waParams: { signerName: first.name || first.email, docName: data.docName, signerToken: first.token, initName, initFunctie, institutie: initInstitutie, compartiment: initCompartiment }, urgent: !!(data.urgent) });
    }
    return res.json({ ok: true, flowId, firstSignerEmail: first?.email || null, initIsSigner: !!initIsSigner, signerToken: initIsSigner ? first.token : null });
  } catch(e) { logger.error({ err: e }, 'POST /flows error:'); return res.status(500).json({ error: 'server_error' }); }
};

router.post('/flows', _largePdf, createFlow);
router.post('/api/flows', _largePdf, createFlow);

// ── GET /flows/:flowId/signed-pdf ──────────────────────────────────────────
// Q-05: rate limit citire — previne enumerare token via timing attacks
router.get('/flows/:flowId/signed-pdf', _readRateLimit, async (req, res) => {
  try {
    if (requireDb(res)) return;
    // R-05: acceptăm token și din header X-Signer-Token (alternativă la query string)
    const signerToken = req.query.token || req.headers['x-signer-token'] || null;
    const actor = getOptionalActor(req);
    if (!actor && !signerToken) return res.status(403).json({ error: 'forbidden', message: 'Token de acces obligatoriu.' });
    const data = await getFlowData(req.params.flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    if (!actor && signerToken && !(data.signers || []).some(s => s.token === signerToken)) return res.status(403).json({ error: 'forbidden' });
    const safeName = (data.docName || 'document').replace(/[^\w\-]+/g, '_');
    const b64 = data.signedPdfB64;
    if (!b64 || typeof b64 !== 'string') {
      if (data.storage === 'drive' && data.driveFileIdFinal) {
        try {
          const { streamFromDrive } = await import('../../drive.mjs');
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `attachment; filename="${safeName}_semnat.pdf"`);
          await streamFromDrive(data.driveFileIdFinal, res); return;
        } catch(driveErr) { return res.status(502).json({ error: 'drive_unavailable' }); }
      }
      return res.status(404).json({ error: 'signed_pdf_missing' });
    }
    const raw = b64.includes('base64,') ? b64.split('base64,')[1] : b64;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}_semnat.pdf"`);
    return res.status(200).send(Buffer.from(raw, 'base64'));
  } catch(e) { return res.status(500).json({ error: 'server_error' }); }
});

// ── GET /flows/:flowId/pdf ─────────────────────────────────────────────────
router.get('/flows/:flowId/pdf', _readRateLimit, async (req, res) => {
  try {
    if (requireDb(res)) return;
    // R-05: acceptăm token și din header X-Signer-Token (alternativă la query string)
    const signerToken = req.query.token || req.headers['x-signer-token'] || null;
    const actor = getOptionalActor(req);
    if (!actor && !signerToken) return res.status(403).json({ error: 'forbidden', message: 'Token de acces obligatoriu.' });
    const data = await getFlowData(req.params.flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    if (!actor && signerToken && !(data.signers || []).some(s => s.token === signerToken)) return res.status(403).json({ error: 'forbidden' });
    const b64 = data.pdfB64;
    if (!b64 || typeof b64 !== 'string') return res.status(404).json({ error: 'pdf_missing' });
    const raw = b64.includes('base64,') ? b64.split('base64,')[1] : b64;
    let pdfBuf = Buffer.from(raw, 'base64');

    if (data.flowType === 'ancore') {
      // PDF-ul se livreaza NEALTERTAT — nici AcroForm, nici Perms, nici hash, nimic.
      // Semnatarul il descarca, il semneaza cu certificat calificat local, il incarca inapoi.
    } else if (_PDFLib) {
      // flowType 'tabel': unlock permisiuni pentru compatibilitate cu aplicatii de semnare
      try {
        const { PDFDocument, PDFName, PDFNumber } = _PDFLib;
        const pdfDoc = await PDFDocument.load(pdfBuf, { ignoreEncryption: true });
        try { delete pdfDoc.context.trailerInfo.Encrypt; } catch(e2) {}
        try { pdfDoc.catalog.delete(PDFName.of('Perms')); } catch(e2) {}
        try {
          const af = pdfDoc.catalog.get(PDFName.of('AcroForm'));
          if (af) { const afObj = pdfDoc.context.lookup(af); if (afObj?.set) afObj.set(PDFName.of('SigFlags'), PDFNumber.of(1)); }
        } catch(e2) {}
        pdfBuf = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
      } catch(e) { logger.warn({ err: e }, 'PDF unlock failed:'); }
    }

    // uploadToken: doar pentru flowType 'tabel' — ancore nu folosesc verificare hash
    if (signerToken && data.flowType !== 'ancore') {
      const signer = (data.signers || []).find(s => s.token === signerToken);
      if (signer) {
        const preHash = sha256Hex(pdfBuf);
        const uploadToken = jwt.sign({ flowId: req.params.flowId, signerToken, preHash }, JWT_SECRET, { expiresIn: '4h' });
        res.setHeader('X-Docflow-Prehash', preHash);
        res.setHeader('X-Docflow-UploadToken', uploadToken);
        res.setHeader('Access-Control-Expose-Headers', 'X-Docflow-Prehash, X-Docflow-UploadToken');
      }
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${(data.docName || 'document').replace(/[^\w\-]+/g, '_')}.pdf"`);
    return res.status(200).send(pdfBuf);
  } catch(e) { return res.status(500).json({ error: 'server_error' }); }
});

// ── GET /flows/:flowId ─────────────────────────────────────────────────────
const getFlowHandler = async (req, res) => {
  try {
    if (requireDb(res)) return;
    // R-05: acceptăm token și din header X-Signer-Token (alternativă la query string)
    const signerToken = req.query.token || req.headers['x-signer-token'] || null;
    const actor = getOptionalActor(req);
    const data = await getFlowData(req.params.flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    if (!actor && signerToken) {
      if (!(data.signers || []).some(s => s.token === signerToken)) return res.status(403).json({ error: 'forbidden' });
    } else if (!actor) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    // FIX: getUserMapForOrg — nu leak-uieste useri intre organizatii
    const orgId = actor?.orgId || data?.orgId || null;
    const uMap = await getUserMapForOrg(orgId);

    const initUser = uMap[(data.initEmail || '').toLowerCase()] || {};
    const enriched = {
      ...data,
      institutie: data.institutie || initUser.institutie || (data.signers || []).map(s => uMap[(s.email || '').toLowerCase()]?.institutie).find(Boolean) || '',
      compartiment: data.compartiment || initUser.compartiment || '',
      signers: (data.signers || []).map(s => { const u = uMap[(s.email || '').toLowerCase()] || {}; return { ...s, functie: s.functie || u.functie || '', compartiment: s.compartiment || u.compartiment || '', institutie: s.institutie || u.institutie || '' }; })
    };
    return res.json(_stripSensitive(enriched, signerToken));
  } catch(e) { return res.status(500).json({ error: 'server_error' }); }
};
router.get('/flows/:flowId', _readRateLimit, getFlowHandler);
router.get('/api/flows/:flowId', _readRateLimit, getFlowHandler);

// ── PUT /flows/:flowId ─────────────────────────────────────────────────────
// FIX: validare structura body — nu permite suprascrierea completa
router.put('/flows/:flowId', _largePdf, async (req, res) => {
  try {
    if (requireDb(res)) return;
    if (await requireAdmin(req, res)) return;
    const { flowId } = req.params;
    const existing = await getFlowData(flowId);
    if (!existing) return res.status(404).json({ error: 'not_found' });
    const next = req.body || {};

    // Validare: nu permitem stergerea campurilor critice
    if (!next.signers || !Array.isArray(next.signers) || !next.signers.length) {
      return res.status(400).json({ error: 'signers_required_in_body', message: 'Câmpul signers este obligatoriu pentru PUT /flows/:flowId.' });
    }
    if (!next.docName || !next.initEmail) {
      return res.status(400).json({ error: 'docName_and_initEmail_required' });
    }
    // Pastreaza campurile imutabile
    next.flowId = flowId;
    next.orgId = existing.orgId;
    next.createdAt = existing.createdAt;
    next.updatedAt = new Date().toISOString();
    await saveFlow(flowId, next);
    return res.json({ ok: true });
  } catch(e) { return res.status(500).json({ error: 'server_error' }); }
});

// ── DELETE /flows/:flowId ──────────────────────────────────────────────────
router.delete('/flows/:flowId', async (req, res) => {
  try {
    if (requireDb(res)) return;
    const actor = requireAuth(req, res); if (!actor) return;
    const { flowId } = req.params;
    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    const isAdmin = actor.role === 'admin' || (actor.role === 'org_admin' && data.orgId != null && actor.orgId != null && Number(data.orgId) === Number(actor.orgId));
    const isInit = (data.initEmail || '').toLowerCase() === actor.email.toLowerCase();
    if (!isAdmin && !isInit) return res.status(403).json({ error: 'forbidden', message: 'Doar inițiatorul sau un administrator poate șterge acest flux.' });
    if (!isAdmin) {
      const hasAnySignature = (data.signers || []).some(s => s.status === 'signed' || s.status === 'refused');
      if (hasAnySignature) return res.status(409).json({ error: 'flow_in_progress', message: 'Fluxul nu poate fi șters deoarece cel puțin un semnatar a acționat deja. Contactează un administrator.' });
    }
    // Soft delete — nu stergem fizic, marcam deleted_at + deleted_by
    // Permite audit complet si recuperare de urgenta de catre super-admin
    const now = new Date().toISOString();
    await pool.query(
      'UPDATE flows SET deleted_at=$1, deleted_by=$2 WHERE id=$3',
      [now, actor.email, flowId]
    );
    await pool.query('DELETE FROM notifications WHERE flow_id=$1', [flowId]).catch(() => {});
    logger.info(`🗑 Flow ${flowId} marcat ca sters (soft) de ${actor.email}`);
    return res.json({ ok: true, flowId, deletedBy: actor.email, deletedAt: now });
  } catch(e) { logger.error({ err: e }, 'DELETE /flows error:'); return res.status(500).json({ error: 'server_error' }); }
});


router.get('/my-flows', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const email = actor.email.toLowerCase();
    // FIX: orgId null nu dezactiveaza filtrul multi-tenant
    const orgId = actor.orgId || null;
    const page = Math.max(1, parseInt(req.query.page || '1'));
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50')));
    const offset = (page - 1) * limit;
    const statusFilter = (req.query.status || 'all').toLowerCase();
    const search = (req.query.search || '').trim().toLowerCase();

    // FIX v3.2.2: escape caractere speciale LIKE pentru a preveni pattern injection
    const escapedSearch = search.replace(/[%_\\]/g, '\\$&');

    // FIX: filtru org_id strict — fara "OR $2 = 0"
    let baseWhere, params;
    if (orgId) {
      baseWhere = `(data->>'initEmail' = $1 OR EXISTS (SELECT 1 FROM jsonb_array_elements(data->'signers') s WHERE lower(s->>'email') = $1)) AND org_id = $2 AND deleted_at IS NULL`;
      params = [email, orgId];
    } else {
      // User fara org (legacy) — vede doar fluxurile proprii fara filtrare org
      baseWhere = `(data->>'initEmail' = $1 OR EXISTS (SELECT 1 FROM jsonb_array_elements(data->'signers') s WHERE lower(s->>'email') = $1)) AND deleted_at IS NULL`;
      params = [email];
    }

    let statusWhere = '';
    if (statusFilter === 'pending') statusWhere = " AND (data->>'completed') IS DISTINCT FROM 'true' AND (data->>'status') IS DISTINCT FROM 'refused' AND (data->>'status') IS DISTINCT FROM 'cancelled'";
    else if (statusFilter === 'completed') statusWhere = " AND (data->>'completed') = 'true'";
    else if (statusFilter === 'refused') statusWhere = " AND (data->>'status') = 'refused'";
    else if (statusFilter === 'cancelled') statusWhere = " AND (data->>'status') = 'cancelled'";
    let searchWhere = '';
    if (search) {
      params.push(`%${escapedSearch}%`);
      searchWhere = ` AND (
        lower(data->>'docName') LIKE $${params.length} ESCAPE '\\'
        OR lower(data->>'initName') LIKE $${params.length} ESCAPE '\\'
        OR lower(data->>'initEmail') LIKE $${params.length} ESCAPE '\\'
        OR lower(data->>'flowId') LIKE $${params.length} ESCAPE '\\'
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(data->'signers') s
          WHERE lower(coalesce(s->>'email','')) LIKE $${params.length} ESCAPE '\\'
             OR lower(coalesce(s->>'name','')) LIKE $${params.length} ESCAPE '\\'
        )
      )`;
    }
    const whereClause = baseWhere + statusWhere + searchWhere;
    const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM flows WHERE ${whereClause}`, params);
    const total = parseInt(countRows[0].count); const pages = Math.ceil(total / limit) || 1;
    const { rows } = await pool.query(`SELECT id,data,created_at,updated_at FROM flows WHERE ${whereClause} ORDER BY updated_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset]);

    // FIX: getUserMapForOrg — fara leak intre organizatii
    const userMap = await getUserMapForOrg(orgId);
    const myFlows = rows.map(r => r.data).filter(Boolean).map(d => ({
      flowId: d.flowId, docName: d.docName || '—', initName: d.initName, initEmail: d.initEmail,
      createdAt: d.createdAt, updatedAt: d.updatedAt,
      completedAt:  d.completedAt  || null,
      refusedAt:    d.refusedAt    || null,  // nivel flux — pentru pasul Final
      cancelledAt:  d.cancelledAt  || null,  // nivel flux — fallback semnatari anulați
      cancelledBy:  d.cancelledBy  || null,
      institutie: d.institutie || '',
      compartiment: d.compartiment || '',
      initEmail: d.initEmail || '',
      initName: d.initName || '',
      flowType: d.flowType || 'tabel', // FIX: flowType lipsea → badge afișa mereu 'Tabel'
      status: d.status || 'active',
      urgent: !!(d.urgent),
      signers: (d.signers || []).map(s => { const u = userMap[(s.email || '').toLowerCase()] || {}; return { name: s.name, email: s.email, rol: s.rol, functie: s.functie || u.functie || '', compartiment: s.compartiment || u.compartiment || '', status: s.status, signedAt: s.signedAt, refusedAt: s.refusedAt || null, notifiedAt: s.notifiedAt || null, refuseReason: s.refuseReason }; }),
      hasSignedPdf: !!(
        d.signedPdfB64
        || d._signedPdfB64Present
        || d.completed
        || (String(d.status || '').toLowerCase() === 'completed')
        || (d.storage === 'drive' && (d.driveFileLinkFinal || d.driveFileIdFinal))
      ),
      allSigned: !!(d.completed || (d.signers || []).every(s => s.status === 'signed')),
      reinitiatedAs: d.reinitiatedAs || null, // prezent dacă fluxul a fost reinițializat — blochează al doilea Reinițiază
      parentFlowId: d.parentFlowId || null,
    }));
    res.json({ flows: myFlows, total, page, limit, pages });
  } catch(e) { logger.error({ err: e }, 'my-flows error:'); res.status(500).json({ error: 'server_error' }); }
});

// ── GET /my-flows/:flowId/download ─────────────────────────────────────────
router.get('/my-flows/:flowId/download', async (req, res) => {
  if (requireDb(res)) return;
  const qToken = req.query.token;
  let actor = null;
  if (qToken) { try { actor = jwt.verify(qToken, JWT_SECRET); } catch(e) {} }
  if (!actor) actor = requireAuth(req, res);
  if (!actor) return;
  try {
    const { rows } = await pool.query('SELECT data FROM flows WHERE id=$1', [req.params.flowId]);
    const d = rows[0]?.data;
    if (!d) return res.status(404).json({ error: 'not_found' });
    const email = actor.email.toLowerCase();
    const isInit = (d.initEmail || '').toLowerCase() === email;
    const isSigner = (d.signers || []).some(s => (s.email || '').toLowerCase() === email);
    if (!isInit && !isSigner) return res.status(403).json({ error: 'forbidden' });
    if (!d.signedPdfB64) {
      if (d.storage === 'drive' && d.driveFileIdFinal) {
        try {
          const { streamFromDrive } = await import('../../drive.mjs');
          const safeName2 = (d.docName || 'document').replace(/[^\w\-]+/g, '_');
          res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="${safeName2}_semnat.pdf"`);
          await streamFromDrive(d.driveFileIdFinal, res); return;
        } catch(driveErr) { return res.status(502).json({ error: 'drive_unavailable' }); }
      }
      return res.status(404).json({ error: 'no_signed_pdf' });
    }
    const buf = Buffer.from(d.signedPdfB64.split(',')[1] || d.signedPdfB64, 'base64');
    const safeName = (d.docName || 'document').replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="${safeName}_semnat.pdf"`);
    res.send(buf);
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

// ── POST /flows/:flowId/reinitiate ─────────────────────────────────────────


export default router;
