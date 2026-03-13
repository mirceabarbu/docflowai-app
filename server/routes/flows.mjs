/**
 * DocFlowAI — Flows routes v3.2.0
 * FIX: export default mutat la sfarsit
 * FIX: delegate mutat inainte de export default
 * FIX: GET /flows/:flowId — getUserMapForOrg (fara leak multi-tenant)
 * FIX: GET /my-flows — orgId null fallback safe (nu mai dezactiveaza filtrul)
 * FIX: PUT /flows/:flowId — validare structura body
 * FIX: stampFooterOnPdf — latimea textului calculata cu font.widthOfTextAtSize
 * FIX: upload-signed-pdf — limita exprimata in bytes reali (30MB PDF)
 * FIX: reinitiate — re-aplica footer cu noul flowId
 * FIX: notify — notif_email independent de notif_inapp
 * FIX v3.2.2: LIKE injection escape, input length limits, originalPdfB64 pentru reinitiate curat
 */

import { Router } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { AUTH_COOKIE, JWT_SECRET, requireAuth, requireAdmin, sha256Hex, escHtml } from '../middleware/auth.mjs';
import { pool, DB_READY, requireDb, saveFlow, getFlowData, getDefaultOrgId, getUserMapForOrg, writeAuditEvent } from '../db/index.mjs';
import { createRateLimiter } from '../middleware/rateLimiter.mjs';
import { logger } from '../middleware/logger.mjs';

const router = Router();


function getOptionalActor(req) {
  const cookieToken = req.cookies?.[AUTH_COOKIE] || null;
  if (cookieToken) {
    try { return jwt.verify(cookieToken, JWT_SECRET); } catch (e) {}
  }
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    try { return jwt.verify(authHeader.slice(7), JWT_SECRET); } catch (e) {}
  }
  return null;
}

// ── R-03: Rate limitere pentru endpoint-urile de semnare ──────────────────
// sign/refuse/delegate: max 20 req/min per IP — fluxul normal nu necesită mai mult
// upload-signed-pdf:    max 5  req/min per IP — fișiere mari, procesare PDF

// F-05: extrage IP real (ținând cont de reverse proxy Railway/Express trust proxy)
const _getIp = req => req.ip || req.socket?.remoteAddress || null;
const _signRateLimit   = createRateLimiter({ windowMs: 60_000, max: 20, message: 'Prea multe cereri de semnare. Încearcă în 1 minut.' });
const _uploadRateLimit = createRateLimiter({ windowMs: 60_000, max: 5,  message: 'Prea multe upload-uri. Încearcă în 1 minut.' });

let _notify, _wsPush, _PDFLib, _stampFooterOnPdf, _isSignerTokenExpired, _newFlowId, _buildSignerLink, _stripSensitive, _stripPdfB64, _sendSignerEmail;
export function injectFlowDeps(deps) {
  _notify = deps.notify;
  _wsPush = deps.wsPush;
  _PDFLib = deps.PDFLib;
  _stampFooterOnPdf = deps.stampFooterOnPdf;
  _isSignerTokenExpired = deps.isSignerTokenExpired;
  _newFlowId = deps.newFlowId;
  _buildSignerLink = deps.buildSignerLink;
  _stripSensitive = deps.stripSensitive;
  _stripPdfB64 = deps.stripPdfB64;
  _sendSignerEmail = deps.sendSignerEmail;
}

// ── POST /flows — creare flux ──────────────────────────────────────────────
const createFlow = async (req, res) => {
  try {
    if (requireDb(res)) return;
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

router.post('/flows', createFlow);
router.post('/api/flows', createFlow);

// ── GET /flows/:flowId/signed-pdf ──────────────────────────────────────────
router.get('/flows/:flowId/signed-pdf', async (req, res) => {
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
          const { streamFromDrive } = await import('../drive.mjs');
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
router.get('/flows/:flowId/pdf', async (req, res) => {
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
router.get('/flows/:flowId', getFlowHandler);
router.get('/api/flows/:flowId', getFlowHandler);

// ── PUT /flows/:flowId ─────────────────────────────────────────────────────
// FIX: validare structura body — nu permite suprascrierea completa
router.put('/flows/:flowId', async (req, res) => {
  try {
    if (requireDb(res)) return;
    if (requireAdmin(req, res)) return;
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
    const isAdmin = actor.role === 'admin' || actor.role === 'org_admin';
    const isInit = (data.initEmail || '').toLowerCase() === actor.email.toLowerCase();
    if (!isAdmin && !isInit) return res.status(403).json({ error: 'forbidden', message: 'Doar inițiatorul sau un administrator poate șterge acest flux.' });
    if (!isAdmin) {
      const hasAnySignature = (data.signers || []).some(s => s.status === 'signed' || s.status === 'refused');
      if (hasAnySignature) return res.status(409).json({ error: 'flow_in_progress', message: 'Fluxul nu poate fi șters deoarece cel puțin un semnatar a acționat deja. Contactează un administrator.' });
    }
    await pool.query('DELETE FROM flows WHERE id=$1', [flowId]);
    await pool.query('DELETE FROM notifications WHERE flow_id=$1', [flowId]).catch(() => {});
    logger.info(`🗑 Flow ${flowId} șters de ${actor.email}`);
    return res.json({ ok: true, flowId, deletedBy: actor.email });
  } catch(e) { logger.error({ err: e }, 'DELETE /flows error:'); return res.status(500).json({ error: 'server_error' }); }
});

// ── POST /flows/:flowId/sign ───────────────────────────────────────────────
const signFlow = async (req, res) => {
  try {
    if (requireDb(res)) return;
    const { flowId } = req.params;
    const { token, signature } = req.body || {};
    const sig = typeof signature === 'string' ? signature.trim() : '';
    if (!sig) return res.status(400).json({ error: 'signature_required' });
    // Semnarea din pagina publică de signer se face pe baza tokenului de semnatar,
    // fără sesiune de utilizator logat. Pentru fluxurile inițiate din cont, UI-ul
    // poate trimite în continuare cookie-urile, dar nu le facem obligatorii aici.
    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    if (data.status === 'cancelled') return res.status(409).json({ error: 'flow_cancelled', message: 'Fluxul a fost anulat.' });
    const signers = Array.isArray(data.signers) ? data.signers : [];
    const idx = signers.findIndex(s => s.token === token);
    if (idx === -1) return res.status(400).json({ error: 'invalid_token' });
    if (_isSignerTokenExpired(signers[idx])) return res.status(403).json({ error: 'token_expired', message: 'Link-ul de semnare a expirat (90 zile). Contactează inițiatorul pentru un nou link.' });
    if (signers[idx].status !== 'current') return res.status(409).json({ error: 'not_current_signer' });
    signers[idx].status = 'signed'; signers[idx].signedAt = new Date().toISOString();
    signers[idx].signature = sig; signers[idx].pdfUploaded = false;
    data.signers = signers; data.updatedAt = new Date().toISOString();
    data.events = Array.isArray(data.events) ? data.events : [];
    data.events.push({ at: new Date().toISOString(), type: 'SIGNED', by: signers[idx].email || signers[idx].name || 'unknown', order: signers[idx].order });
    await saveFlow(flowId, data);
    // R-02: audit_log
    writeAuditEvent({ flowId, orgId: data.orgId, eventType: 'SIGNED', actorIp: _getIp(req), actorEmail: signers[idx].email, payload: { signerName: signers[idx].name, order: signers[idx].order } });
    return res.json({ ok: true, flowId, completed: data.signers.every(s => s.status === 'signed'), nextSigner: null, nextLink: null, awaitingUpload: true, flow: _stripPdfB64(data) });
  } catch(e) { return res.status(500).json({ error: 'server_error' }); }
};
router.post('/flows/:flowId/sign', _signRateLimit, signFlow);
router.post('/api/flows/:flowId/sign', _signRateLimit, signFlow);

// ── R-03: Rate limit pe endpoint-urile sensibile ─────────────────────────
// Aplicăm cu router.use înainte de declararea handler-elor inline
router.use('/flows/:flowId/refuse',           _signRateLimit);
router.use('/flows/:flowId/upload-signed-pdf', _uploadRateLimit);
router.use('/flows/:flowId/delegate',          _signRateLimit);

// ── POST /flows/:flowId/refuse ─────────────────────────────────────────────
router.post('/flows/:flowId/refuse', async (req, res) => {
  try {
    if (requireDb(res)) return;
    const { flowId } = req.params;
    const { token, reason } = req.body || {};
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'reason_required' });
    if (String(reason).trim().length > 1000) return res.status(400).json({ error: 'reason_too_long', max: 1000 });
    // Refuzul din pagina publică de signer se face pe baza tokenului de semnatar.
    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    if (data.status === 'cancelled') return res.status(409).json({ error: 'flow_cancelled', message: 'Fluxul a fost anulat.' });
    const signers = Array.isArray(data.signers) ? data.signers : [];
    const idx = signers.findIndex(s => s.token === token);
    if (idx === -1) return res.status(400).json({ error: 'invalid_token' });
    if (_isSignerTokenExpired(signers[idx])) return res.status(403).json({ error: 'token_expired', message: 'Link-ul de semnare a expirat (90 zile).' });
    if (signers[idx].status !== 'current') return res.status(409).json({ error: 'not_current_signer' });
    const refuserName = signers[idx].name || signers[idx].email || 'Semnatar';
    const refuserRol = signers[idx].rol || '';
    const refuseReason = String(reason).trim();
    signers[idx].status = 'refused'; signers[idx].refusedAt = new Date().toISOString(); signers[idx].refuseReason = refuseReason;
    data.signers = signers; data.status = 'refused'; data.refusedAt = new Date().toISOString(); data.updatedAt = new Date().toISOString();
    data.events = Array.isArray(data.events) ? data.events : [];
    data.events.push({ at: new Date().toISOString(), type: 'REFUSED', by: signers[idx].email, reason: refuseReason });
    await saveFlow(flowId, data);
    // R-02: audit_log
    writeAuditEvent({ flowId, orgId: data.orgId, eventType: 'REFUSED', actorIp: _getIp(req), actorEmail: signers[idx].email, payload: { reason: refuseReason, signerName: refuserName, rol: refuserRol } });
    // Issue 5: Sterge notif YOUR_TURN ale celui care a refuzat
    const refuserEmail5 = (signers[idx].email || '').toLowerCase();
    if (refuserEmail5) {
      await pool.query("DELETE FROM notifications WHERE user_email=$1 AND flow_id=$2 AND type IN ('YOUR_TURN','REMINDER')", [refuserEmail5, flowId]).catch(() => {});
    }
    const refuseMsg = `${refuserName}${refuserRol ? ' (' + refuserRol + ')' : ''} a refuzat semnarea documentului „${data.docName}". Motiv: ${refuseReason}`;
    const toNotify = [{ email: data.initEmail }, ...signers.filter((s, i) => i < idx && s.status === 'signed' && s.email).map(s => ({ email: s.email }))];
    const sent = new Set();
    for (const r of toNotify) {
      if (!r.email || sent.has(r.email)) continue;
      sent.add(r.email);
      await _notify({ userEmail: r.email, flowId, type: 'REFUSED', title: '⛔ Document refuzat', message: refuseMsg, waParams: { docName: data.docName, refuserName, reason: refuseReason }, urgent: !!(data.urgent) });
    }
    return res.json({ ok: true, refused: true });
  } catch(e) { logger.error({ err: e }, 'refuse error:'); return res.status(500).json({ error: 'server_error' }); }
});

// ── POST /flows/:flowId/register-download ─────────────────────────────────
router.post('/flows/:flowId/register-download', async (req, res) => {
  try {
    if (requireDb(res)) return;  // FIX v3.3.2: lipsea — pool putea fi null
    const { flowId } = req.params;
    const { signerToken } = req.body || {};
    if (!signerToken) return res.status(400).json({ error: 'missing_params' });
    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    const signer = (data.signers || []).find(s => s.token === signerToken);
    if (!signer) return res.status(403).json({ error: 'invalid_signer_token' });
    if (_isSignerTokenExpired(signer)) return res.status(403).json({ error: 'token_expired' });
    // Semnatar 2+: va descărca signedPdfB64 (cu semnăturile anterioare) — hash calculat pe acela
    const rawSignedPdf = (data.signedPdfB64 || '').includes(',') ? (data.signedPdfB64 || '').split(',')[1] : (data.signedPdfB64 || '');
    const rawPdf = rawSignedPdf || ((data.pdfB64 || '').includes(',') ? (data.pdfB64 || '').split(',')[1] : (data.pdfB64 || ''));
    if (!rawPdf) return res.status(500).json({ error: 'pdf_missing_cannot_issue_token' });

    // Înregistrăm momentul descărcării PDF-ului de semnat
    signer.downloadedAt = new Date().toISOString();
    await saveFlow(flowId, data);

    // flowType 'ancore': PDF-ul nu se atinge si nu se emite uploadToken cu hash.
    // Semnatarul descarca direct, semneaza cu certificat calificat, incarca inapoi fara verificare hash.
    if (data.flowType === 'ancore') {
      return res.json({ uploadToken: null, ancore: true, message: 'Flux cu ancore predefinite — descarca PDF-ul direct si incarca dupa semnare.' });
    }

    // flowType 'tabel': calcul hash + uploadToken pentru verificare integritate
    let pdfBufRD = Buffer.from(rawPdf, 'base64');
    if (_PDFLib) {
      try {
        const { PDFDocument, PDFName, PDFNumber } = _PDFLib;
        const pdfDoc = await PDFDocument.load(pdfBufRD, { ignoreEncryption: true });
        try { delete pdfDoc.context.trailerInfo.Encrypt; } catch(e2) {}
        try { pdfDoc.catalog.delete(PDFName.of('Perms')); } catch(e2) {}
        try { const af = pdfDoc.catalog.get(PDFName.of('AcroForm')); if (af) { const afObj = pdfDoc.context.lookup(af); if (afObj?.set) afObj.set(PDFName.of('SigFlags'), PDFNumber.of(1)); } } catch(e2) {}
        pdfBufRD = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
      } catch(e2) { logger.warn({ err: e2 }, 'register-download unlock error'); }
    }
    const serverPreHash = sha256Hex(pdfBufRD);
    const uploadToken = jwt.sign({ flowId, signerToken, preHash: serverPreHash }, JWT_SECRET, { expiresIn: '4h' });
    // F-05: logăm descărcarea cu IP + hash document original (pentru lanțul de trasabilitate)
    writeAuditEvent({ flowId, orgId: data.orgId, eventType: 'PDF_DOWNLOADED', actorEmail: signer.email, actorIp: _getIp(req), payload: { signerName: signer.name, preHash: serverPreHash } });
    return res.json({ uploadToken });
  } catch(e) { return res.status(500).json({ error: 'server_error' }); }
});

// ── POST /flows/:flowId/upload-signed-pdf ─────────────────────────────────
router.post('/flows/:flowId/upload-signed-pdf', async (req, res) => {
  try {
    if (requireDb(res)) return;
    const { flowId } = req.params;
    const { token, signedPdfB64, signerName, uploadToken } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token_missing' });
    if (!signedPdfB64 || typeof signedPdfB64 !== 'string') return res.status(400).json({ error: 'signedPdfB64_missing' });

    // Limita 30MB PDF real (base64 e ~1.33x mai mare)
    const MAX_PDF_BYTES = 30 * 1024 * 1024;
    const rawCheck = signedPdfB64.includes('base64,') ? signedPdfB64.split('base64,')[1] : signedPdfB64;
    const estimatedBytes = Math.floor(rawCheck.length * 0.75);
    if (estimatedBytes > MAX_PDF_BYTES) return res.status(413).json({ error: 'pdf_too_large_max_30mb', message: 'PDF-ul depășește limita de 30 MB.' });

    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    if (data.status === 'cancelled') return res.status(409).json({ error: 'flow_cancelled', message: 'Fluxul a fost anulat.' });
    const signers = Array.isArray(data.signers) ? data.signers : [];
    const idx = signers.findIndex(s => s.token === token);
    if (idx === -1) return res.status(400).json({ error: 'invalid_token' });
    if (_isSignerTokenExpired(signers[idx])) return res.status(403).json({ error: 'token_expired', message: 'Link-ul de semnare a expirat (90 zile).' });
    if (signers[idx].status !== 'signed') return res.status(409).json({ error: 'signer_not_signed_yet' });

    if (data.flowType === 'ancore') {
      // ── ANCORE: zero verificari pe continutul PDF ────────────────────────
      // Documentul a fost semnat cu certificat calificat local.
      // Nu verificam hash, nu comparam cu originalul, nu modificam nimic.
      // Marcam direct ca uploaded si continuam fluxul.
      signers[idx].pdfUploaded = true;
    } else {
      // ── TABEL: verificare uploadToken + hash integritate ─────────────────
      if (!uploadToken) return res.status(403).json({ error: 'upload_token_missing', message: 'Lipsește tokenul de verificare.' });
      let uploadPayload;
      try { uploadPayload = jwt.verify(uploadToken, JWT_SECRET); }
      catch(jwtErr) { return res.status(403).json({ error: 'upload_token_invalid', message: 'Token de upload invalid sau expirat.' }); }
      if (uploadPayload.flowId !== flowId) return res.status(403).json({ error: 'upload_token_flow_mismatch' });
      if (uploadPayload.signerToken !== token) return res.status(403).json({ error: 'upload_token_signer_mismatch' });
      const uploadedHash = sha256Hex(Buffer.from(rawCheck, 'base64'));
      if (signers[idx].pdfUploaded && signers[idx].uploadedHash === uploadedHash) {
        const allDone = signers.every(s => s.status === 'signed' && s.pdfUploaded);
        return res.json({ ok: true, flowId, completed: allDone, uploadedAt: data.signedPdfUploadedAt, downloadUrl: `/flows/${flowId}/signed-pdf`, idempotent: true });
      }
      if (uploadedHash === uploadPayload.preHash) return res.status(422).json({ error: 'pdf_not_signed', message: 'Documentul uploadat este identic cu cel descărcat — nu conține semnătură.' });
      signers[idx].uploadVerified = true; signers[idx].uploadedHash = uploadedHash; signers[idx].pdfUploaded = true;
    }
    if (!Array.isArray(data.signedPdfVersions)) data.signedPdfVersions = [];
    data.signedPdfVersions.push({ uploadedAt: new Date().toISOString(), uploadedBy: signers[idx].email || signers[idx].name || 'unknown', signerIndex: idx, signerName: signerName || signers[idx].name || '' });
    data.signedPdfB64 = signedPdfB64; data.signedPdfUploadedAt = new Date().toISOString(); data.signedPdfUploadedBy = signers[idx].email || signers[idx].name || 'unknown';
    data.updatedAt = new Date().toISOString();
    data.events = Array.isArray(data.events) ? data.events : [];
    data.events.push({ at: new Date().toISOString(), type: 'SIGNED_PDF_UPLOADED', by: signers[idx].email || signers[idx].name || 'unknown', order: signers[idx].order });
    const currentOrder = Number(signers[idx]?.order) || 0;
    let nextIdx = -1, bestOrder = Infinity;
    for (let i = 0; i < signers.length; i++) { const o = Number(signers[i].order) || 0; if (signers[i].status !== 'signed' && o > currentOrder && o < bestOrder) { bestOrder = o; nextIdx = i; } }
    if (nextIdx !== -1) signers.forEach((s, i) => { if (s.status !== 'signed') s.status = i === nextIdx ? 'current' : 'pending'; });
    data.signers = signers;
    const allDone = signers.every(s => s.status === 'signed' && s.pdfUploaded);
    if (allDone) { data.completed = true; data.completedAt = new Date().toISOString(); data.urgent = false; /* FIX v3.3.2: docName nu mai e alterat — era: data.docName = `${flowId}_${data.docName}` */ data.events.push({ at: new Date().toISOString(), type: 'FLOW_COMPLETED', by: 'system' }); }
    const nextSigner = signers.find(s => s.status === 'current' && !s.emailSent);
    if (nextSigner) { nextSigner.emailSent = true; nextSigner.notifiedAt = new Date().toISOString(); }
    await saveFlow(flowId, data);
    // R-02: audit_log — upload PDF + finalizare flux dacă e cazul
    writeAuditEvent({ flowId, orgId: data.orgId, eventType: 'SIGNED_PDF_UPLOADED', actorIp: _getIp(req), actorEmail: signers[idx].email, payload: { signerName: signers[idx].name, order: signers[idx].order } });
    if (allDone) writeAuditEvent({ flowId, orgId: data.orgId, eventType: 'FLOW_COMPLETED', actorEmail: 'system', payload: { docName: data.docName, completedAt: data.completedAt } });
    logger.info(`📎 Signed PDF uploaded for flow ${flowId} by ${signers[idx].email || signers[idx].name}`);
    res.json({ ok: true, flowId, completed: allDone, uploadedAt: data.signedPdfUploadedAt, downloadUrl: `/flows/${flowId}/signed-pdf`, nextSigner: nextSigner || null });
    setImmediate(async () => {
      try {
        // Issue 5: Sterge notificarile YOUR_TURN ale semnatarului care tocmai a semnat
        const signerEmail5 = (signers[idx].email || '').toLowerCase();
        if (signerEmail5) {
          await pool.query("DELETE FROM notifications WHERE user_email=$1 AND flow_id=$2 AND type IN ('YOUR_TURN','REMINDER')", [signerEmail5, flowId]).catch(() => {});
        }
        if (allDone) {
          // Issue 5: Sterge TOATE notif YOUR_TURN ramase pentru acest flux
          await pool.query("DELETE FROM notifications WHERE flow_id=$1 AND type IN ('YOUR_TURN','REMINDER')", [flowId]).catch(() => {});
          if (data.initEmail) await _notify({ userEmail: data.initEmail, flowId, type: 'COMPLETED', title: 'Document semnat complet', message: `Documentul „${data.docName}" a fost semnat de toți semnatarii.`, waParams: { docName: data.docName }, urgent: !!(data.urgent) });
        }
        if (nextSigner?.email) await _notify({ userEmail: nextSigner.email, flowId, type: 'YOUR_TURN', title: 'Document de semnat', message: `Este rândul tău să semnezi documentul „${data.docName}". Documentul conține semnăturile semnatarilor anteriori.`, waParams: { signerName: nextSigner.name || nextSigner.email, docName: data.docName, signerToken: nextSigner.token, initName: data.initName, initFunctie: data.initFunctie, institutie: data.institutie, compartiment: data.compartiment }, urgent: !!(data.urgent) });
      } catch(notifErr) { logger.error({ err: notifErr, flowId }, 'Notificare async esuat'); }
    });
  } catch(e) { logger.error({ err: e }, 'upload-signed-pdf error:'); return res.status(500).json({ error: 'server_error' }); }
});

// ── POST /flows/:flowId/resend ─────────────────────────────────────────────
router.post('/flows/:flowId/resend', async (req, res) => {
  try {
    if (requireDb(res)) return;
    if (requireAdmin(req, res)) return;
    const { flowId } = req.params;
    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    const current = (data.signers || []).find(s => s.status === 'current');
    if (!current) return res.status(409).json({ error: 'no_current_signer' });
    if (!current.email) return res.status(400).json({ error: 'current_missing_email' });
    await _notify({ userEmail: current.email, flowId, type: 'YOUR_TURN', title: 'Reminder: Document de semnat', message: `Ai un document în așteptare pentru semnare: „${data.docName}". Te rugăm să accesezi aplicația.`, waParams: { signerName: current.name || current.email, docName: data.docName, signerToken: current.token, initName: data.initName, initFunctie: data.initFunctie, institutie: data.institutie, compartiment: data.compartiment }, urgent: !!(data.urgent) });
    return res.json({ ok: true, to: current.email });
  } catch(e) { return res.status(500).json({ error: 'server_error' }); }
});

// ── POST /flows/:flowId/regenerate-token ──────────────────────────────────
router.post('/flows/:flowId/regenerate-token', async (req, res) => {
  try {
    if (requireDb(res)) return;
    if (requireAdmin(req, res)) return;
    const { flowId } = req.params;
    const { signerEmail } = req.body || {};
    if (!signerEmail) return res.status(400).json({ error: 'signerEmail_required' });
    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    const signers = Array.isArray(data.signers) ? data.signers : [];
    const idx = signers.findIndex(s => (s.email || '').toLowerCase() === signerEmail.toLowerCase());
    if (idx === -1) return res.status(404).json({ error: 'signer_not_found' });
    if (signers[idx].status === 'signed') return res.status(409).json({ error: 'already_signed' });
    const newToken = crypto.randomBytes(16).toString('hex');
    signers[idx].token = newToken; signers[idx].tokenCreatedAt = new Date().toISOString();
    data.signers = signers; data.updatedAt = new Date().toISOString();
    data.events = data.events || [];
    data.events.push({ at: new Date().toISOString(), type: 'TOKEN_REGENERATED', by: 'admin', signerEmail, order: signers[idx].order });
    await saveFlow(flowId, data);
    const newLink = _buildSignerLink(req, flowId, newToken);
    await _notify({ userEmail: signers[idx].email, flowId, type: 'YOUR_TURN', title: 'Link de semnare reînnoit', message: `Link-ul tău de semnare pentru documentul „${data.docName}" a fost reînnoit.`, waParams: { signerName: signers[idx].name || signers[idx].email, docName: data.docName, signerToken: newToken, initName: data.initName, initFunctie: data.initFunctie, institutie: data.institutie, compartiment: data.compartiment } });
    logger.info(`🔑 Token regenerat pentru ${signerEmail} pe flow ${flowId}`);
    return res.json({ ok: true, signerEmail, newLink, message: 'Token regenerat și notificare trimisă.' });
  } catch(e) { logger.error({ err: e }, 'regenerate-token error:'); return res.status(500).json({ error: 'server_error' }); }
});

// ── GET /my-flows ─────────────────────────────────────────────────────────
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
      baseWhere = `(data->>'initEmail' = $1 OR EXISTS (SELECT 1 FROM jsonb_array_elements(data->'signers') s WHERE lower(s->>'email') = $1)) AND org_id = $2`;
      params = [email, orgId];
    } else {
      // User fara org (legacy) — vede doar fluxurile proprii fara filtrare org
      baseWhere = `(data->>'initEmail' = $1 OR EXISTS (SELECT 1 FROM jsonb_array_elements(data->'signers') s WHERE lower(s->>'email') = $1))`;
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
      completedAt: d.completedAt || null,
      institutie: d.institutie || '',
      compartiment: d.compartiment || '',
      initEmail: d.initEmail || '',
      initName: d.initName || '',
      flowType: d.flowType || 'tabel',
      status: d.status || 'active',
      urgent: !!(d.urgent),
      signers: (d.signers || []).map(s => { const u = userMap[(s.email || '').toLowerCase()] || {}; return { name: s.name, email: s.email, rol: s.rol, functie: s.functie || u.functie || '', compartiment: s.compartiment || u.compartiment || '', status: s.status, signedAt: s.signedAt, refuseReason: s.refuseReason }; }),
      hasSignedPdf: !!(
        d.signedPdfB64
        || d._signedPdfB64Present
        || d.completed
        || (String(d.status || '').toLowerCase() === 'completed')
        || (d.storage === 'drive' && (d.driveFileLinkFinal || d.driveFileIdFinal))
      ),
      allSigned: !!(d.completed || (d.signers || []).every(s => s.status === 'signed')),
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
          const { streamFromDrive } = await import('../drive.mjs');
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
router.post('/flows/:flowId/reinitiate', async (req, res) => {
  try {
    if (requireDb(res)) return;
    const actor = requireAuth(req, res); if (!actor) return;
    const { flowId } = req.params;
    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    const isAdmin = actor.role === 'admin';
    const isInit = (data.initEmail || '').toLowerCase() === actor.email.toLowerCase();
    if (!isAdmin && !isInit) return res.status(403).json({ error: 'forbidden', message: 'Doar inițiatorul sau un administrator poate reiniția fluxul.' });
    const hasRefused = (data.signers || []).some(s => s.status === 'refused');
    if (!hasRefused) return res.status(409).json({ error: 'no_refused_signer', message: 'Fluxul nu are niciun semnatar care a refuzat.' });
    // Blocăm reinițializarea dacă refuzatorul are rol APROBAT — aprobatorul finalizează procesul
    const refusedSigner = (data.signers || []).find(s => s.status === 'refused');
    if (refusedSigner && (refusedSigner.rol || '').toUpperCase() === 'APROBAT') {
      return res.status(409).json({ error: 'aprobat_refused', message: 'Fluxul a fost refuzat de APROBATOR. Reinițializarea nu este permisă — contactați inițiatorul pentru un flux nou.' });
    }
    const remainingSigners = (data.signers || []).filter(s => s.status !== 'refused').map((s, i) => ({
      ...s,
      token: crypto.randomBytes(16).toString('hex'),
      tokenCreatedAt: new Date().toISOString(),
      status: i === 0 ? 'current' : 'pending',
      signedAt: null, signature: null, pdfUploaded: false, emailSent: false,
    }));
    if (!remainingSigners.length) return res.status(409).json({ error: 'no_signers_remaining', message: 'Nu mai există semnatari după eliminarea celui care a refuzat.' });
    const newFlowId2 = _newFlowId(data.institutie || '');
    const newCreatedAt = new Date().toISOString();
    const newData = {
      ...data,
      flowId: newFlowId2,
      signers: remainingSigners,
      status: 'active',
      completed: false, completedAt: null,
      refusedAt: null,
      createdAt: newCreatedAt,
      updatedAt: newCreatedAt,
      parentFlowId: flowId,
      signedPdfB64: null, signedPdfUploadedAt: null, signedPdfUploadedBy: null, signedPdfVersions: [],
      events: [{ at: newCreatedAt, type: 'FLOW_REINITIATED', by: actor.email, fromFlowId: flowId }],
    };
    // FIX v3.2.2: folosim originalPdfB64 (PDF curat, fără footer) pentru a evita double-stamp.
    // Dacă nu există (fluxuri vechi), cădem pe pdfB64 ca fallback.
    if (_stampFooterOnPdf && (data.flowType || 'tabel') !== 'ancore') {
      const baseForStamp = newData.originalPdfB64 || newData.pdfB64;
      if (baseForStamp) {
        try {
          newData.pdfB64 = await _stampFooterOnPdf(baseForStamp, {
            flowId: newFlowId2, createdAt: newCreatedAt,
            initName: data.initName, initFunctie: data.initFunctie,
            institutie: data.institutie, compartiment: data.compartiment,
            flowType: data.flowType || 'tabel'
          });
        } catch(e) { logger.warn({ err: e }, 'Re-stamp footer on reinitiate error:'); }
      }
    }
    // FIX v3.3.2: primul saveFlow era redundant — mutăm după setarea notifiedAt
    const first = remainingSigners[0];
    if (first) first.notifiedAt = new Date().toISOString();
    await saveFlow(newFlowId2, newData);
    // R-02: audit_log
    writeAuditEvent({ flowId: newFlowId2, orgId: newData.orgId, eventType: 'FLOW_REINITIATED', actorIp: _getIp(req), actorEmail: actor.email, payload: { parentFlowId: flowId, remainingSigners: remainingSigners.length } });
    if (first?.email) {
      await _notify({ userEmail: first.email, flowId: newFlowId2, type: 'YOUR_TURN', title: 'Document de semnat (reinițiat)',
        message: `${data.initName} a reinițiat fluxul de semnare pentru documentul „${data.docName}". Este rândul tău să semnezi.`,
        waParams: { signerName: first.name || first.email, docName: data.docName, signerToken: first.token, initName: data.initName, initFunctie: data.initFunctie, institutie: data.institutie, compartiment: data.compartiment } });
    }
    logger.info(`🔄 Flow ${flowId} reinițiat ca ${newFlowId2} de ${actor.email}`);
    return res.json({ ok: true, newFlowId: newFlowId2, signers: remainingSigners.length });
  } catch(e) { logger.error({ err: e }, 'reinitiate error:'); return res.status(500).json({ error: 'server_error' }); }
});

// ── POST /flows/:flowId/request-review ───────────────────────────────────
router.post('/flows/:flowId/request-review', async (req, res) => {
  try {
    if (requireDb(res)) return;
    const { flowId } = req.params;
    const { token, reason } = req.body || {};
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'reason_required' });
    if (String(reason).trim().length > 1000) return res.status(400).json({ error: 'reason_too_long', max: 1000 });
    // Review din pagina publică de signer trebuie să meargă doar pe baza tokenului de semnatar.
    // Dacă există și sesiune validă (admin / semnatar conectat), o folosim doar pentru verificări suplimentare.
    const actor = getOptionalActor(req);
    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    if (data.completed || data.status === 'refused' || data.status === 'review_requested' || data.status === 'cancelled') {
      return res.status(409).json({ error: 'invalid_flow_state', message: 'Fluxul nu poate fi trimis spre revizuire în starea curentă.' });
    }
    const signers = Array.isArray(data.signers) ? data.signers : [];
    const idx = signers.findIndex(s => s.token === token);
    if (idx === -1) return res.status(400).json({ error: 'invalid_token' });
    if (_isSignerTokenExpired(signers[idx])) return res.status(403).json({ error: 'token_expired', message: 'Link-ul de semnare a expirat (90 zile).' });
    const isAdmin = actor?.role === 'admin';
    const isCurrentSignerActor = !!actor && ((signers[idx].email || '').toLowerCase() === (actor.email || '').toLowerCase());
    if (actor && !isAdmin && !isCurrentSignerActor) return res.status(403).json({ error: 'forbidden', message: 'Doar semnatarul curent sau un admin poate trimite spre revizuire.' });
    if (signers[idx].status !== 'current') return res.status(409).json({ error: 'not_current_signer' });

    const reviewerName = signers[idx].name || signers[idx].email || 'Semnatar';
    const reviewReason = String(reason).trim();

    data.status = 'review_requested';
    data.reviewRequestedAt = new Date().toISOString();
    data.reviewRequestedBy = signers[idx].email;
    data.reviewReason = reviewReason;
    data.updatedAt = new Date().toISOString();
    data.events = Array.isArray(data.events) ? data.events : [];
    data.events.push({ at: new Date().toISOString(), type: 'REVIEW_REQUESTED', by: signers[idx].email, reason: reviewReason });
    await saveFlow(flowId, data);
    // R-02: audit_log
    writeAuditEvent({ flowId, orgId: data.orgId, eventType: 'REVIEW_REQUESTED', actorIp: _getIp(req), actorEmail: signers[idx].email, payload: { reviewerName, reason: reviewReason } });
    // Issue 5: Sterge notif YOUR_TURN ale celui care a cerut revizuire
    const reviewerEmail5 = (signers[idx].email || '').toLowerCase();
    if (reviewerEmail5) {
      await pool.query("DELETE FROM notifications WHERE user_email=$1 AND flow_id=$2 AND type IN ('YOUR_TURN','REMINDER')", [reviewerEmail5, flowId]).catch(() => {});
    }

    const reviewMsg = `${reviewerName} a trimis documentul „${data.docName}" spre revizuire. Motiv: ${reviewReason}`;

    // Notifică inițiatorul
    await _notify({ userEmail: data.initEmail, flowId, type: 'REVIEW_REQUESTED', title: '🔄 Document trimis spre revizuire', message: reviewMsg, waParams: { docName: data.docName, reviewerName, reason: reviewReason }, urgent: !!(data.urgent) });

    // Notifică semnatarii care au semnat deja
    const sent = new Set([data.initEmail?.toLowerCase()]);
    for (let i = 0; i < idx; i++) {
      const s = signers[i];
      if (s.status === 'signed' && s.email && !sent.has(s.email.toLowerCase())) {
        sent.add(s.email.toLowerCase());
        await _notify({ userEmail: s.email, flowId, type: 'REVIEW_REQUESTED', title: '🔄 Document trimis spre revizuire', message: reviewMsg, waParams: { docName: data.docName, reviewerName, reason: reviewReason }, urgent: !!(data.urgent) });
      }
    }
    logger.info(`🔄 Review requested pe flow ${flowId} de ${signers[idx].email}`);
    return res.json({ ok: true, reviewReason, reviewedBy: signers[idx].email });
  } catch(e) { logger.error({ err: e }, 'request-review error:'); return res.status(500).json({ error: 'server_error' }); }
});

// ── POST /flows/:flowId/reinitiate-review ─────────────────────────────────
// Issue 4: Reinitializeaza fluxul IN ACELASI ID — nu creeaza un flow nou
router.post('/flows/:flowId/reinitiate-review', async (req, res) => {
  try {
    if (requireDb(res)) return;
    const actor = requireAuth(req, res); if (!actor) return;
    const { flowId } = req.params;
    const { pdfB64 } = req.body || {};
    if (!pdfB64 || typeof pdfB64 !== 'string') return res.status(400).json({ error: 'pdfB64_required' });

    // FIX v3.2.3: validare dimensiune PDF la reinițiere după revizuire
    const rawPdf = pdfB64.includes(',') ? pdfB64.split(',')[1] : pdfB64;
    const estimatedPdfBytes = Math.floor(rawPdf.length * 0.75);
    if (estimatedPdfBytes > 50 * 1024 * 1024) return res.status(413).json({ error: 'pdf_too_large_max_50mb', message: 'PDF-ul depășește limita de 50 MB.' });

    // Calculăm hash-ul documentului uploadat
    // FIX v3.3.2: sha256Hex pe Buffer (bytes PDF), nu pe string base64
    const uploadedHash = sha256Hex(Buffer.from(rawPdf, 'base64'));

    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });

    const isAdmin = actor.role === 'admin';
    const isInit = (data.initEmail || '').toLowerCase() === actor.email.toLowerCase();
    if (!isAdmin && !isInit) return res.status(403).json({ error: 'forbidden', message: 'Doar inițiatorul poate reiniția după revizuire.' });
    if (data.status !== 'review_requested') return res.status(409).json({ error: 'not_in_review', message: 'Fluxul nu este în starea de revizuire.' });

    // Verificăm că nu se uploadează același document semnat deja
    // FIX v3.3.2: hash calculat consistent pe Buffer, nu pe string base64
    const existingHashes = new Set();
    if (data.pdfB64) { const raw = data.pdfB64.includes(',') ? data.pdfB64.split(',')[1] : data.pdfB64; existingHashes.add(sha256Hex(Buffer.from(raw, 'base64'))); }
    if (data.signedPdfB64) { const raw = data.signedPdfB64.includes(',') ? data.signedPdfB64.split(',')[1] : data.signedPdfB64; existingHashes.add(sha256Hex(Buffer.from(raw, 'base64'))); }
    (data.signedPdfVersions || []).forEach(v => { if (v.hash) existingHashes.add(v.hash); });
    (data.signers || []).forEach(s => { if (s.uploadedHash) existingHashes.add(s.uploadedHash); });
    if (existingHashes.has(uploadedHash)) {
      return res.status(409).json({ error: 'same_document', message: 'Nu poți încărca același document care a fost semnat anterior. Uploadează documentul revizuit.' });
    }

    const now = new Date().toISOString();

    // Salvăm istoricul rundei de revizuire curente
    if (!Array.isArray(data.reviewHistory)) data.reviewHistory = [];
    data.reviewHistory.push({
      round: (data.reviewHistory.length + 1),
      reviewRequestedAt: data.reviewRequestedAt,
      reviewRequestedBy: data.reviewRequestedBy,
      reviewReason: data.reviewReason,
      signers: (data.signers || []).map(s => ({
        email: s.email, name: s.name, rol: s.rol, status: s.status,
        signedAt: s.signedAt || null, refusedAt: s.refusedAt || null, refuseReason: s.refuseReason || null
      })),
      pdfHash: existingHashes.size > 0 ? [...existingHashes][0] : null,
      reinitiatedAt: now, reinitiatedBy: actor.email
    });

    // Aplică footer pe noul PDF (pastrează ACELASI flowId în footer) — doar pentru tabel
    let finalPdfB64 = pdfB64;
    if (finalPdfB64 && _stampFooterOnPdf && (data.flowType || 'tabel') !== 'ancore') {
      try {
        finalPdfB64 = await _stampFooterOnPdf(finalPdfB64, {
          flowId, createdAt: now,
          initName: data.initName, initFunctie: data.initFunctie,
          institutie: data.institutie, compartiment: data.compartiment,
          flowType: data.flowType || 'tabel'
        });
      } catch(e) { logger.warn({ err: e }, 'Re-stamp footer on reinitiate-review error:'); }
    }

    // Resetăm toți semnatarii cu token nou — ACELASI flowId
    const resetSigners = (data.signers || [])
      .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
      .map((s, i) => ({
        ...s,
        token: crypto.randomBytes(16).toString('hex'),
        tokenCreatedAt: now,
        status: i === 0 ? 'current' : 'pending',
        signedAt: null, signature: null, pdfUploaded: false, emailSent: false,
        refuseReason: undefined, refusedAt: undefined, uploadedHash: undefined,
      }));

    // Actualizăm fluxul IN-PLACE — aceleași ID
    data.pdfB64 = finalPdfB64;
    data.signers = resetSigners;
    data.status = 'active';
    data.completed = false; data.completedAt = null;
    data.reviewRequestedAt = null; data.reviewRequestedBy = null; data.reviewReason = null;
    data.updatedAt = now;
    data.signedPdfB64 = null; data.signedPdfUploadedAt = null; data.signedPdfUploadedBy = null;
    data.signedPdfVersions = [];
    // Adaugă evenimentul de reinitiere — FARA să marcheze evenimentele vechi (istoricul rămâne nativ în aceeași listă)
    if (!Array.isArray(data.events)) data.events = [];
    data.events.push({ at: now, type: 'FLOW_REINITIATED_AFTER_REVIEW', by: actor.email, round: data.reviewHistory.length, reviewReason: data.reviewHistory[data.reviewHistory.length - 1]?.reviewReason });

    // Notifică primul semnatar (același flowId)
    const first = resetSigners[0];
    if (first) first.notifiedAt = new Date().toISOString();
    await saveFlow(flowId, data);
    // R-02: audit_log
    writeAuditEvent({ flowId, orgId: data.orgId, eventType: 'FLOW_REINITIATED_AFTER_REVIEW', actorIp: _getIp(req), actorEmail: actor.email, payload: { round: data.reviewHistory.length, docName: data.docName } });

    // Issue 5: Sterge notif REVIEW_REQUESTED existente pentru acest flux
    await pool.query("DELETE FROM notifications WHERE flow_id=$1 AND type='REVIEW_REQUESTED'", [flowId]).catch(() => {});

    if (first?.email) {
      const roundNum = data.reviewHistory.length;
      await _notify({ userEmail: first.email, flowId, type: 'YOUR_TURN',
        title: 'Document revizuit de semnat',
        message: `${data.initName} a revizuit documentul „${data.docName}" și l-a retrimis spre semnare. Este rândul tău.`,
        waParams: { signerName: first.name || first.email, docName: data.docName, signerToken: first.token, initName: data.initName, initFunctie: data.initFunctie, institutie: data.institutie, compartiment: data.compartiment, roundInfo: roundNum > 1 ? `Runda ${roundNum} de semnare după revizuire` : null }
      });
    }

    logger.info(`🔄 Review reinitiate in-place: ${flowId} runda ${data.reviewHistory.length} de ${actor.email}`);
    return res.json({ ok: true, flowId, signers: resetSigners.length, round: data.reviewHistory.length });
  } catch(e) { logger.error({ err: e }, 'reinitiate-review error:'); return res.status(500).json({ error: 'server_error' }); }
});

// ── POST /flows/:flowId/delegate ──────────────────────────────────────────
router.post('/flows/:flowId/delegate', async (req, res) => {
  try {
    if (requireDb(res)) return;
    const actor = getOptionalActor(req);
    const { flowId } = req.params;
    const { fromToken, toEmail, toName, reason } = req.body || {};
    if (!fromToken) return res.status(400).json({ error: 'fromToken_required' });
    if (!toEmail || !/^\S+@\S+\.\S+$/.test(toEmail)) return res.status(400).json({ error: 'toEmail_invalid' });
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'reason_required' });
    if (String(reason).trim().length > 1000) return res.status(400).json({ error: 'reason_too_long', max: 1000 });
    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    if (data.status === 'cancelled') return res.status(409).json({ error: 'flow_cancelled', message: 'Fluxul a fost anulat.' });
    const signers = Array.isArray(data.signers) ? data.signers : [];
    const idx = signers.findIndex(s => s.token === fromToken);  // FIX v3.3.2: linia lipsea — idx era undefined
    if (idx === -1) return res.status(400).json({ error: 'invalid_token' });
    if (_isSignerTokenExpired(signers[idx])) return res.status(403).json({ error: 'token_expired' });
    const currentSignerEmail = (signers[idx].email || '').toLowerCase();
    // FIX v3.3.3: delegarea trebuie să meargă și din link public (fără sesiune), pe baza fromToken.
    // Dacă există actor logat, îl validăm; dacă nu există, permitem doar fluxul token-based.
    const isAdmin = actor?.role === 'admin';
    const isCurrentSigner = !!actor && currentSignerEmail === (actor.email || '').toLowerCase();
    if (actor && !isAdmin && !isCurrentSigner) return res.status(403).json({ error: 'forbidden', message: 'Doar semnatarul curent sau un admin poate delega.' });
    if (signers[idx].status !== 'current') return res.status(409).json({ error: 'not_current_signer', message: 'Se poate delega doar semnatarul curent.' });
    // FIX v3.3.3: nu poți delega către tine însuți — comparăm cu actorul logat dacă există, altfel cu semnatarul curent din token.
    if (toEmail.trim().toLowerCase() === ((actor?.email || currentSignerEmail).toLowerCase())) {
      return res.status(400).json({ error: 'self_delegation_not_allowed', message: 'Nu poți delega semnătura către tine însuți.' });
    }

    const originalName = signers[idx].name;
    const originalEmail = signers[idx].email;

    // Cautam datele delegatului in DB
    const { rows: delegatDbRows } = await pool.query(
      'SELECT nume, functie, compartiment, institutie FROM users WHERE email=$1',
      [toEmail.trim().toLowerCase()]
    );
    const delegatDb = delegatDbRows[0] || {};
    let resolvedName = (toName || '').trim() || delegatDb.nume || toEmail.trim();

    const newToken = crypto.randomBytes(16).toString('hex');
    signers[idx] = {
      ...signers[idx],
      name: resolvedName,
      email: toEmail.trim().toLowerCase(),
      token: newToken,
      tokenCreatedAt: new Date().toISOString(),
      notifiedAt: new Date().toISOString(),
      status: 'current',
      functie: delegatDb.functie || signers[idx].functie || '',
      compartiment: delegatDb.compartiment || signers[idx].compartiment || '',
      institutie: delegatDb.institutie || signers[idx].institutie || '',
      delegatedFrom: { name: originalName, email: originalEmail, reason: String(reason).trim(), at: new Date().toISOString(), by: actor.email },
    };
    data.signers = signers;
    data.updatedAt = new Date().toISOString();
    data.events = Array.isArray(data.events) ? data.events : [];
    data.events.push({ at: new Date().toISOString(), type: 'DELEGATED', from: originalEmail, to: toEmail, reason: String(reason).trim(), by: actor.email });
    await saveFlow(flowId, data);
    // R-02: audit_log
    writeAuditEvent({ flowId, orgId: data.orgId, eventType: 'DELEGATED', actorIp: _getIp(req), actorEmail: actor.email, payload: { from: originalEmail, to: toEmail, reason: String(reason).trim() } });

    // ── Notificare: in-app + WhatsApp conform preferintelor din DB ──
    await _notify({
      userEmail: toEmail, flowId, type: 'YOUR_TURN',
      title: '👥 Ai primit o delegare de semnătură',
      message: `${originalName} ți-a delegat semnarea documentului „${data.docName}". Motiv: ${String(reason).trim()}`,
      waParams: { signerName: resolvedName, docName: data.docName, signerToken: newToken, initName: data.initName, initFunctie: data.initFunctie, institutie: data.institutie, compartiment: data.compartiment }
    });

    // ── Notificare initiator despre delegare ──
    if (data.initEmail && data.initEmail.toLowerCase() !== originalEmail.toLowerCase()) {
      await _notify({
        userEmail: data.initEmail, flowId, type: 'DELEGATED',
        title: '👥 Semnătură delegată',
        message: `${originalName} a delegat semnarea documentului „${data.docName}" către ${resolvedName}. Motiv: ${String(reason).trim()}`,
        waParams: { docName: data.docName }
      });
    }

    // ── Email cu link direct (intotdeauna — delegarea necesita link) ──
    if (_sendSignerEmail) {
      const appUrl = process.env.PUBLIC_BASE_URL || 'https://app.docflowai.ro';
      const signerLink = _buildSignerLink ? _buildSignerLink(req, flowId, newToken) : `${appUrl}/semdoc-signer.html?flow=${flowId}&token=${newToken}`;
      try {
        await _sendSignerEmail({
          to: toEmail,
          subject: `👥 Delegare semnătură — ${data.docName}`,
          html: `
<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;background:#0f1731;color:#eaf0ff;border-radius:16px;padding:36px;">
  <div style="text-align:center;margin-bottom:28px;">
    <div style="display:inline-block;background:linear-gradient(135deg,#7c5cff,#2dd4bf);border-radius:12px;padding:12px 20px;font-size:1.3rem;font-weight:800;">📋 DocFlowAI</div>
  </div>
  <h2 style="margin:0 0 8px;font-size:1.1rem;color:#cdd8ff;">Bună${resolvedName ? ', ' + escHtml(resolvedName) : ''},</h2>
  <p style="color:#9db0ff;margin:0 0 6px;line-height:1.6;">
    <strong style="color:#ffd580;">${escHtml(originalName)}</strong> ți-a delegat semnarea electronică a documentului:
  </p>
  <div style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:16px 20px;margin:16px 0 20px;">
    <div style="font-size:1rem;font-weight:700;color:#eaf0ff;margin-bottom:6px;">📄 ${escHtml(data.docName || flowId)}</div>
    <div style="font-size:.85rem;color:#9db0ff;margin-bottom:4px;">Inițiat de: ${escHtml(data.initName || data.initEmail || '')}</div>
    <div style="font-size:.85rem;color:#ffd580;">Motiv delegare: ${escHtml(String(reason).trim())}</div>
  </div>
  <div style="background:rgba(255,100,100,.08);border:1px solid rgba(255,100,100,.2);border-radius:10px;padding:12px 16px;margin-bottom:20px;font-size:.85rem;color:#ffb3b3;">
    ⚠️ Descarcă documentul, semnează-l cu certificatul tău calificat, apoi încarcă-l înapoi.
  </div>
  <div style="text-align:center;">
    <a href="${signerLink}" style="display:inline-block;background:linear-gradient(135deg,#7c5cff,#2dd4bf);color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:700;font-size:1rem;">✍️ Deschide documentul pentru semnare</a>
  </div>
  <p style="margin-top:20px;font-size:.78rem;color:rgba(255,255,255,.3);text-align:center;">Link valid 90 de zile · DocFlowAI · ${escHtml(data.institutie || '')}</p>
</div>`
        });
      } catch(emailErr) { logger.error({ err: emailErr }, 'Delegare email error'); }
    }

    logger.info(`👥 Delegare ${originalEmail} → ${toEmail} pentru flow ${flowId} de ${actor.email}`);
    return res.json({ ok: true, flowId, from: originalEmail, to: toEmail, delegateName: resolvedName });
  } catch(e) { logger.error({ err: e }, 'delegate error:'); return res.status(500).json({ error: 'server_error' }); }
});

// ── POST /flows/:flowId/cancel ─────────────────────────────────────────────
router.post('/flows/:flowId/cancel', async (req, res) => {
  try {
    if (requireDb(res)) return;
    const actor = requireAuth(req, res); if (!actor) return;
    const { flowId } = req.params;
    const { reason } = req.body || {};
    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    const isAdmin = actor.role === 'admin';
    const isInit = (data.initEmail || '').toLowerCase() === actor.email.toLowerCase();
    if (!isAdmin && !isInit) return res.status(403).json({ error: 'forbidden', message: 'Doar inițiatorul sau un admin poate anula fluxul.' });
    if (data.completed) return res.status(409).json({ error: 'already_completed', message: 'Un flux finalizat nu poate fi anulat.' });
    if (data.status === 'cancelled') return res.status(409).json({ error: 'already_cancelled', message: 'Fluxul este deja anulat.' });
    const now = new Date().toISOString();
    data.status = 'cancelled';
    data.cancelledAt = now;
    data.cancelledBy = actor.email;
    data.cancelReason = reason ? String(reason).trim().slice(0, 500) : null;
    data.updatedAt = now;
    // Marchează semnatarii pending/current ca 'cancelled'
    if (Array.isArray(data.signers)) {
      data.signers = data.signers.map(s =>
        (s.status === 'pending' || s.status === 'current') ? { ...s, status: 'cancelled' } : s
      );
    }
    if (!Array.isArray(data.events)) data.events = [];
    data.events.push({ at: now, type: 'FLOW_CANCELLED', by: actor.email, reason: data.cancelReason });
    await saveFlow(flowId, data);
    // R-02: audit_log
    writeAuditEvent({ flowId, orgId: data.orgId, eventType: 'FLOW_CANCELLED', actorIp: _getIp(req), actorEmail: actor.email, payload: { reason: data.cancelReason } });
    // Șterge notificările YOUR_TURN active pentru acest flux
    await pool.query("DELETE FROM notifications WHERE flow_id=$1 AND type IN ('YOUR_TURN','REMINDER')", [flowId]).catch(() => {});
    // Notifică inițiatorul (dacă admin a anulat) și semnatarii care au semnat deja
    if (isAdmin && data.initEmail) {
      await _notify({ userEmail: data.initEmail, flowId, type: 'REFUSED', title: '🚫 Flux anulat de administrator',
        message: `Fluxul „${data.docName}" a fost anulat de administrator.${data.cancelReason ? ' Motiv: ' + data.cancelReason : ''}`,
        waParams: { docName: data.docName } });
    }
    logger.info(`🚫 Flow ${flowId} anulat de ${actor.email}`);
    return res.json({ ok: true, flowId, cancelledAt: now });
  } catch(e) { logger.error({ err: e }, 'cancel flow error:'); return res.status(500).json({ error: 'server_error' }); }
});

// ── F-06: Documente suport ────────────────────────────────────────────────
// Tipuri MIME acceptate: PDF, ZIP, RAR
const ATTACH_ALLOWED_MIME = new Set([
  'application/pdf',
  'application/zip', 'application/x-zip-compressed', 'application/x-zip',
  'application/x-rar-compressed', 'application/vnd.rar', 'application/x-rar',
]);
const ATTACH_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

// POST /flows/:flowId/attachments — încarcă document suport
router.post('/flows/:flowId/attachments', async (req, res) => {
  try {
    if (requireDb(res)) return;
    const actor = requireAuth(req, res); if (!actor) return;
    const { flowId } = req.params;
    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    // Doar inițiatorul sau admin poate atașa documente
    const isInit = (data.initEmail || '').toLowerCase() === actor.email.toLowerCase();
    const isAdmin = actor.role === 'admin' || actor.role === 'org_admin';
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
    const isAdmin = actor.role === 'admin' || actor.role === 'org_admin';
    if (!isInit && !isAdmin) return res.status(403).json({ error: 'forbidden' });
    const { rowCount } = await pool.query('DELETE FROM flow_attachments WHERE id=$1 AND flow_id=$2', [parseInt(attId), flowId]);
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    return res.json({ ok: true });
  } catch(e) { return res.status(500).json({ error: 'server_error' }); }
});


router.post('/flows/:flowId/send-email', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { flowId } = req.params;
    const { to, subject, bodyText } = req.body || {};
    const includeAttachment = true;  // întotdeauna atașăm PDF-ul semnat
    const includeLink = true;        // întotdeauna includem referința Flow ID

    // Validare
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim()))
      return res.status(400).json({ error: 'invalid_email', message: 'Adresă de email invalidă.' });
    if (!subject || !subject.trim())
      return res.status(400).json({ error: 'subject_required', message: 'Subiectul este obligatoriu.' });

    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    if (!data.completed && data.status !== 'completed')
      return res.status(409).json({ error: 'not_completed', message: 'Documentul nu este finalizat.' });

    // Preluăm datele expeditorului din DB (funcție, institutie, compartiment)
    const { rows: senderRows } = await pool.query(
      'SELECT nume, functie, institutie, compartiment, email FROM users WHERE email=$1',
      [actor.email.toLowerCase()]
    );
    const sender = senderRows[0] || {};
    const senderName  = sender.nume  || actor.email;
    const senderTitle = [sender.functie, sender.compartiment, sender.institutie].filter(Boolean).join(' · ');

    // PDF semnat
    const pdfB64 = data.signedPdfB64 || data.pdfB64 || null;
    if (includeAttachment && !pdfB64)
      return res.status(409).json({ error: 'no_pdf', message: 'PDF-ul semnat nu este disponibil.' });

    // Semnatari — pentru tabelul din mail
    const signers = (data.signers || []).map(s => ({
      name: s.name || s.email,
      rol: s.rol || '',
      signedAt: s.signedAt || null,
      status: s.signed ? 'semnat' : (s.refused ? 'refuzat' : 'în așteptare'),
    }));

    const statusColor = (st) => st === 'semnat' ? '#1a7a4a' : st === 'refuzat' ? '#b03030' : '#7c5cff';
    const statusBg    = (st) => st === 'semnat' ? '#d4f5e5' : st === 'refuzat' ? '#fde8e8' : '#ede8ff';
    const signersTable = signers.map(s => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #dde4f5;color:#1a2340;font-weight:500;">${s.name}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #dde4f5;color:#3d5299;font-weight:600;">${s.rol}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #dde4f5;">
          <span style="background:${statusBg(s.status)};color:${statusColor(s.status)};padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;">${s.status.toUpperCase()}</span>
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #dde4f5;color:#5a6a9a;font-size:12px;">${s.signedAt ? new Date(s.signedAt).toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest' }) : '—'}</td>
      </tr>`).join('');

    // Corp mesaj — text negru pe fundal alb, newline -> <br>
    const customBody = bodyText
      ? `<p style="margin:0 0 24px;line-height:1.8;color:#1a1a1a;font-size:14px;white-space:pre-line;">${bodyText.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>')}</p>`
      : '';

    // Secțiune "Document disponibil în platformă" — fond cald albastru deschis
    const linkSection = `
      <div style="margin:20px 0;padding:16px 20px;background:#f0f4ff;border:1px solid #c5d0f0;border-radius:10px;border-left:4px solid #7c5cff;">
        <p style="margin:0 0 6px;font-size:11px;color:#5a6a9a;text-transform:uppercase;letter-spacing:.6px;font-weight:700;">Document disponibil în platformă</p>
        <p style="margin:0;font-size:13px;color:#1a2340;">Flow ID: <strong style="color:#7c5cff;">${flowId}</strong> · Platformă: <strong>DocFlowAI</strong></p>
      </div>`;

    const html = `<!DOCTYPE html>
<html lang="ro"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f7fc;font-family:'Segoe UI',Arial,sans-serif;color:#1a1a1a;">
  <div style="max-width:620px;margin:0 auto;padding:32px 16px;">

    <!-- Header gradient — table layout (no flex/gap, email client compatibility) -->
    <div style="background:linear-gradient(135deg,#7c5cff,#2dd4bf);border-radius:14px 14px 0 0;padding:24px 32px;">
      <table role="presentation" style="width:100%;border-collapse:collapse;"><tr>
        <td style="width:52px;vertical-align:middle;">
          <div style="width:40px;height:40px;background:rgba(255,255,255,.2);border-radius:10px;text-align:center;line-height:40px;font-size:20px;">&#128203;</div>
        </td>
        <td style="vertical-align:middle;padding-left:12px;">
          <div style="font-size:11px;color:rgba(255,255,255,.85);text-transform:uppercase;letter-spacing:.8px;font-weight:600;margin-bottom:4px;">Document semnat electronic</div>
          <div style="font-size:17px;font-weight:700;color:#fff;">${data.docName || flowId}</div>
        </td>
      </tr></table>
    </div>

    <!-- Info card -->
    <div style="background:#fff;border:1px solid #dde4f5;border-top:none;border-radius:0 0 14px 14px;padding:20px 32px 24px;margin-bottom:20px;">
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr><td style="padding:4px 0;color:#5a6a9a;width:140px;font-weight:600;">Instituție</td><td style="color:#1a1a1a;">${data.institutie || '—'}</td></tr>
        <tr><td style="padding:4px 0;color:#5a6a9a;font-weight:600;">Compartiment</td><td style="color:#1a1a1a;">${data.compartiment || '—'}</td></tr>
        <tr><td style="padding:4px 0;color:#5a6a9a;font-weight:600;">Finalizat la</td><td style="color:#1a7a4a;font-weight:600;">${data.completedAt ? new Date(data.completedAt).toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest' }) : '—'}</td></tr>
        <tr><td style="padding:4px 0;color:#5a6a9a;font-weight:600;">Flow ID</td><td style="color:#7c5cff;font-family:monospace;font-size:12px;">${flowId}</td></tr>
      </table>
    </div>

    <!-- Corp personalizat (text negru) -->
    <div style="background:#fff;border:1px solid #dde4f5;border-radius:10px;padding:20px 24px;margin-bottom:20px;">
      ${customBody || '<p style="margin:0;color:#1a1a1a;font-size:14px;">Vă transmitem atașat documentul semnat electronic.</p>'}
    </div>

    <!-- Document disponibil în platformă -->
    ${linkSection}

    <!-- Footer -->
    <div style="border-top:1px solid #dde4f5;padding-top:16px;margin-top:4px;text-align:center;">
      <p style="margin:0 0 4px;font-size:12px;color:#5a6a9a;">Trimis prin <strong>DocFlowAI</strong> · noreply@docflowai.ro</p>
    </div>

  </div>
</body></html>`;

    // Construim payload Resend
    const { sendSignerEmail } = await import('../mailer.mjs');
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const MAIL_FROM = process.env.MAIL_FROM || 'DocFlowAI <noreply@docflowai.ro>';

    if (!RESEND_API_KEY) return res.status(503).json({ error: 'mail_not_configured', message: 'Email-ul nu este configurat pe server.' });

    const payload = { from: MAIL_FROM, to: to.trim(), subject: subject.trim(), html };
    if (includeAttachment && pdfB64) {
      const pdfName = `${(data.docName || flowId).replace(/[^a-zA-Z0-9_\-\.]/g, '_')}_semnat.pdf`;
      // Strip data URL prefix dacă există (Resend necesită base64 curat)
      const cleanPdfB64 = pdfB64.includes(',') ? pdfB64.split(',')[1] : pdfB64;
      payload.attachments = [{ filename: pdfName, content: cleanPdfB64 }];
    }

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      logger.error({ err: j }, `send-email FAILED to ${to}`);
      return res.status(502).json({ error: 'send_failed', message: j?.message || 'Eroare la trimiterea emailului.' });
    }

    // Audit log
    const now = new Date().toISOString();
    if (!Array.isArray(data.events)) data.events = [];
    data.events.push({ at: now, type: 'EMAIL_SENT', by: actor.email, to: to.trim(), subject: subject.trim() });
    await saveFlow(flowId, data);
    writeAuditEvent({ flowId, orgId: data.orgId, eventType: 'EMAIL_SENT', actorIp: _getIp(req), actorEmail: actor.email, payload: { to: to.trim(), subject: subject.trim(), resendId: j.id } });

    logger.info(`📧 Flow ${flowId} trimis extern către ${to} de ${actor.email}`);
    return res.json({ ok: true, resendId: j.id });
  } catch(e) { logger.error({ err: e }, 'send-email error'); return res.status(500).json({ error: 'server_error', message: String(e.message) }); }
});

export default router;
