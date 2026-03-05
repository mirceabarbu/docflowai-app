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
 */

import { Router } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { JWT_SECRET, requireAuth, requireAdmin, sha256Hex } from '../middleware/auth.mjs';
import { pool, DB_READY, requireDb, saveFlow, getFlowData, getDefaultOrgId, getUserMapForOrg } from '../db/index.mjs';

const router = Router();

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
    if (!initName || initName.length < 2) return res.status(400).json({ error: 'initName_required' });
    if (!initEmail || !/^\S+@\S+\.\S+$/.test(initEmail)) return res.status(400).json({ error: 'initEmail_invalid' });
    if (!signers.length) return res.status(400).json({ error: 'signers_required' });

    for (let i = 0; i < signers.length; i++) {
      const s = signers[i] || {};
      if (!String(s.email || '').trim() || !/^\S+@\S+\.\S+$/.test(String(s.email || '').trim())) return res.status(400).json({ error: 'signer_email_invalid', index: i });
      if (!String(s.name || '').trim() || String(s.name || '').trim().length < 2) return res.status(400).json({ error: 'signer_name_required', index: i });
    }

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

    // flowType 'ancore': PDF-ul NU se modifica deloc la ingest.
    // Footer-ul se aplica mai jos (stampFooterOnPdf) o singura data, inainte de prima semnatura.
    // Campurile de semnatura predefinite (AcroForm) raman intacte.

    if (finalPdfB64 && _stampFooterOnPdf) {
      try {
        finalPdfB64 = await _stampFooterOnPdf(finalPdfB64, {
          flowId, createdAt, initName, initFunctie,
          institutie: initInstitutie, compartiment: initCompartiment,
          flowType: body.flowType || 'tabel'  // ancore => useObjectStreams:false
        });
      } catch(e) { console.warn('Footer la creare error:', e.message); }
    }

    const data = {
      orgId,
      flowId, docName, initName, initEmail,
      initFunctie, institutie: initInstitutie, compartiment: initCompartiment,
      meta: body.meta || {}, flowType: body.flowType || 'tabel',
      pdfB64: finalPdfB64,
      signers: normalizedSigners,
      createdAt, updatedAt: new Date().toISOString(),
      events: [{ at: new Date().toISOString(), type: 'FLOW_CREATED', by: initEmail }],
    };
    await saveFlow(flowId, data);

    const first = data.signers.find(s => s.status === 'current');
    const initIsSigner = first && first.email.toLowerCase() === initEmail.toLowerCase();
    if (first?.email && !initIsSigner) {
      await _notify({ userEmail: first.email, flowId, type: 'YOUR_TURN', title: 'Document de semnat',
        message: `${initName} te-a adăugat ca semnatar pe documentul „${data.docName}". Intră în aplicație pentru a semna.`,
        waParams: { signerName: first.name || first.email, docName: data.docName } });
    }
    return res.json({ ok: true, flowId, firstSignerEmail: first?.email || null, initIsSigner: !!initIsSigner, signerToken: initIsSigner ? first.token : null });
  } catch(e) { console.error('POST /flows error:', e); return res.status(500).json({ error: 'server_error' }); }
};

router.post('/flows', createFlow);
router.post('/api/flows', createFlow);

// ── GET /flows/:flowId/signed-pdf ──────────────────────────────────────────
router.get('/flows/:flowId/signed-pdf', async (req, res) => {
  try {
    if (requireDb(res)) return;
    const signerToken = req.query.token;
    let actor = null;
    const authHeader = req.headers['authorization'] || '';
    if (authHeader.startsWith('Bearer ')) { try { actor = jwt.verify(authHeader.slice(7), JWT_SECRET); } catch(e) {} }
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
    const signerToken = req.query.token;
    let actor = null;
    const authHeader = req.headers['authorization'] || '';
    if (authHeader.startsWith('Bearer ')) { try { actor = jwt.verify(authHeader.slice(7), JWT_SECRET); } catch(e) {} }
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
      } catch(e) { console.warn('PDF unlock failed:', e.message); }
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
    const signerToken = req.query.token || null;
    let actor = null;
    const authHeader = req.headers['authorization'] || '';
    if (authHeader.startsWith('Bearer ')) { try { actor = jwt.verify(authHeader.slice(7), JWT_SECRET); } catch(e) {} }
    const data = await getFlowData(req.params.flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    if (!actor && signerToken) {
      if (!(data.signers || []).some(s => s.token === signerToken)) return res.status(403).json({ error: 'forbidden' });
    } else if (!actor) { return res.status(401).json({ error: 'auth_required' }); }

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
    const isAdmin = actor.role === 'admin';
    const isInit = (data.initEmail || '').toLowerCase() === actor.email.toLowerCase();
    if (!isAdmin && !isInit) return res.status(403).json({ error: 'forbidden', message: 'Doar inițiatorul sau un administrator poate șterge acest flux.' });
    if (!isAdmin) {
      const hasAnySignature = (data.signers || []).some(s => s.status === 'signed' || s.status === 'refused');
      if (hasAnySignature) return res.status(409).json({ error: 'flow_in_progress', message: 'Fluxul nu poate fi șters deoarece cel puțin un semnatar a acționat deja. Contactează un administrator.' });
    }
    await pool.query('DELETE FROM flows WHERE id=$1', [flowId]);
    await pool.query('DELETE FROM notifications WHERE flow_id=$1', [flowId]).catch(() => {});
    console.log(`🗑 Flow ${flowId} șters de ${actor.email}`);
    return res.json({ ok: true, flowId, deletedBy: actor.email });
  } catch(e) { console.error('DELETE /flows error:', e); return res.status(500).json({ error: 'server_error' }); }
});

// ── POST /flows/:flowId/sign ───────────────────────────────────────────────
const signFlow = async (req, res) => {
  try {
    if (requireDb(res)) return;
    const { flowId } = req.params;
    const { token, signature } = req.body || {};
    const sig = typeof signature === 'string' ? signature.trim() : '';
    if (!sig) return res.status(400).json({ error: 'signature_required' });
    const authHeader = req.headers['authorization'] || '';
    if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'unauthorized', message: 'Autentificare obligatorie pentru semnare.' });
    let actor;
    try { actor = jwt.verify(authHeader.slice(7), JWT_SECRET); }
    catch(e) { return res.status(401).json({ error: 'token_invalid', message: 'Sesiune expirată. Autentifică-te din nou.' }); }
    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    const signers = Array.isArray(data.signers) ? data.signers : [];
    const idx = signers.findIndex(s => s.token === token);
    if (idx === -1) return res.status(400).json({ error: 'invalid_token' });
    if ((signers[idx].email || '').toLowerCase() !== (actor.email || '').toLowerCase()) return res.status(403).json({ error: 'forbidden', message: 'Nu ești semnatarul acestui slot.' });
    if (_isSignerTokenExpired(signers[idx])) return res.status(403).json({ error: 'token_expired', message: 'Link-ul de semnare a expirat (90 zile). Contactează inițiatorul pentru un nou link.' });
    if (signers[idx].status !== 'current') return res.status(409).json({ error: 'not_current_signer' });
    signers[idx].status = 'signed'; signers[idx].signedAt = new Date().toISOString();
    signers[idx].signature = sig; signers[idx].pdfUploaded = false;
    data.signers = signers; data.updatedAt = new Date().toISOString();
    data.events = Array.isArray(data.events) ? data.events : [];
    data.events.push({ at: new Date().toISOString(), type: 'SIGNED', by: signers[idx].email || signers[idx].name || 'unknown', order: signers[idx].order });
    await saveFlow(flowId, data);
    return res.json({ ok: true, flowId, completed: data.signers.every(s => s.status === 'signed'), nextSigner: null, nextLink: null, awaitingUpload: true, flow: _stripPdfB64(data) });
  } catch(e) { return res.status(500).json({ error: 'server_error' }); }
};
router.post('/flows/:flowId/sign', signFlow);
router.post('/api/flows/:flowId/sign', signFlow);

// ── POST /flows/:flowId/refuse ─────────────────────────────────────────────
router.post('/flows/:flowId/refuse', async (req, res) => {
  try {
    if (requireDb(res)) return;
    const { flowId } = req.params;
    const { token, reason } = req.body || {};
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'reason_required' });
    const authHeader = req.headers['authorization'] || '';
    if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'unauthorized', message: 'Autentificare obligatorie.' });
    let actorRefuse;
    try { actorRefuse = jwt.verify(authHeader.slice(7), JWT_SECRET); }
    catch(e) { return res.status(401).json({ error: 'token_invalid', message: 'Sesiune expirată. Autentifică-te din nou.' }); }
    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    const signers = Array.isArray(data.signers) ? data.signers : [];
    const idx = signers.findIndex(s => s.token === token);
    if (idx === -1) return res.status(400).json({ error: 'invalid_token' });
    if ((signers[idx].email || '').toLowerCase() !== (actorRefuse.email || '').toLowerCase()) return res.status(403).json({ error: 'forbidden', message: 'Nu ești semnatarul acestui slot.' });
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
    const refuseMsg = `${refuserName}${refuserRol ? ' (' + refuserRol + ')' : ''} a refuzat semnarea documentului „${data.docName}". Motiv: ${refuseReason}`;
    const toNotify = [{ email: data.initEmail }, ...signers.filter((s, i) => i < idx && s.status === 'signed' && s.email).map(s => ({ email: s.email }))];
    const sent = new Set();
    for (const r of toNotify) {
      if (!r.email || sent.has(r.email)) continue;
      sent.add(r.email);
      await _notify({ userEmail: r.email, flowId, type: 'REFUSED', title: '⛔ Document refuzat', message: refuseMsg, waParams: { docName: data.docName, refuserName, reason: refuseReason } });
    }
    return res.json({ ok: true, refused: true });
  } catch(e) { console.error('refuse error:', e); return res.status(500).json({ error: 'server_error' }); }
});

// ── POST /flows/:flowId/register-download ─────────────────────────────────
router.post('/flows/:flowId/register-download', async (req, res) => {
  try {
    const { flowId } = req.params;
    const { signerToken } = req.body || {};
    if (!signerToken) return res.status(400).json({ error: 'missing_params' });
    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    const signer = (data.signers || []).find(s => s.token === signerToken);
    if (!signer) return res.status(403).json({ error: 'invalid_signer_token' });
    if (_isSignerTokenExpired(signer)) return res.status(403).json({ error: 'token_expired' });
    const rawPdf = (data.pdfB64 || '').includes(',') ? (data.pdfB64 || '').split(',')[1] : (data.pdfB64 || '');
    if (!rawPdf) return res.status(500).json({ error: 'pdf_missing_cannot_issue_token' });

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
      } catch(e2) { console.warn('register-download unlock error:', e2.message); }
    }
    const serverPreHash = sha256Hex(pdfBufRD);
    const uploadToken = jwt.sign({ flowId, signerToken, preHash: serverPreHash }, JWT_SECRET, { expiresIn: '4h' });
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
    if (allDone) { data.completed = true; data.completedAt = new Date().toISOString(); data.docName = `${flowId}_${data.docName}`; data.events.push({ at: new Date().toISOString(), type: 'FLOW_COMPLETED', by: 'system' }); }
    const nextSigner = signers.find(s => s.status === 'current' && !s.emailSent);
    if (nextSigner) nextSigner.emailSent = true;
    await saveFlow(flowId, data);
    console.log(`📎 Signed PDF uploaded for flow ${flowId} by ${signers[idx].email || signers[idx].name}`);
    res.json({ ok: true, flowId, completed: allDone, uploadedAt: data.signedPdfUploadedAt, downloadUrl: `/flows/${flowId}/signed-pdf`, nextSigner: nextSigner || null });
    setImmediate(async () => {
      try {
        if (allDone && data.initEmail) await _notify({ userEmail: data.initEmail, flowId, type: 'COMPLETED', title: '✅ Document semnat complet', message: `Documentul „${data.docName}" a fost semnat de toți semnatarii.`, waParams: { docName: data.docName } });
        if (nextSigner?.email) await _notify({ userEmail: nextSigner.email, flowId, type: 'YOUR_TURN', title: 'Document de semnat', message: `Este rândul tău să semnezi documentul „${data.docName}". Documentul conține semnăturile semnatarilor anteriori.`, waParams: { signerName: nextSigner.name || nextSigner.email, docName: data.docName } });
      } catch(notifErr) { console.error(`❌ Notificare async eșuată pentru flow ${flowId}:`, notifErr.message); }
    });
  } catch(e) { console.error('upload-signed-pdf error:', e); return res.status(500).json({ error: 'server_error' }); }
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
    await _notify({ userEmail: current.email, flowId, type: 'YOUR_TURN', title: 'Reminder: Document de semnat', message: `Ai un document în așteptare pentru semnare: „${data.docName}". Te rugăm să accesezi aplicația.`, waParams: { signerName: current.name || current.email, docName: data.docName } });
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
    await _notify({ userEmail: signers[idx].email, flowId, type: 'YOUR_TURN', title: 'Link de semnare reînnoit', message: `Link-ul tău de semnare pentru documentul „${data.docName}" a fost reînnoit.`, waParams: { signerName: signers[idx].name || signers[idx].email, docName: data.docName } });
    console.log(`🔑 Token regenerat pentru ${signerEmail} pe flow ${flowId}`);
    return res.json({ ok: true, signerEmail, newLink, message: 'Token regenerat și notificare trimisă.' });
  } catch(e) { console.error('regenerate-token error:', e); return res.status(500).json({ error: 'server_error' }); }
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
    if (statusFilter === 'pending') statusWhere = " AND (data->>'completed') IS DISTINCT FROM 'true' AND (data->>'status') IS DISTINCT FROM 'refused'";
    else if (statusFilter === 'completed') statusWhere = " AND (data->>'completed') = 'true'";
    else if (statusFilter === 'refused') statusWhere = " AND (data->>'status') = 'refused'";
    let searchWhere = '';
    if (search) { params.push(`%${search}%`); searchWhere = ` AND (lower(data->>'docName') LIKE $${params.length} OR lower(data->>'initName') LIKE $${params.length})`; }
    const whereClause = baseWhere + statusWhere + searchWhere;
    const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM flows WHERE ${whereClause}`, params);
    const total = parseInt(countRows[0].count); const pages = Math.ceil(total / limit) || 1;
    const { rows } = await pool.query(`SELECT id,data,created_at,updated_at FROM flows WHERE ${whereClause} ORDER BY updated_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset]);

    // FIX: getUserMapForOrg — fara leak intre organizatii
    const userMap = await getUserMapForOrg(orgId);
    const myFlows = rows.map(r => r.data).filter(Boolean).map(d => ({
      flowId: d.flowId, docName: d.docName || '—', initName: d.initName, initEmail: d.initEmail,
      createdAt: d.createdAt, updatedAt: d.updatedAt,
      signers: (d.signers || []).map(s => { const u = userMap[(s.email || '').toLowerCase()] || {}; return { name: s.name, email: s.email, rol: s.rol, functie: s.functie || u.functie || '', compartiment: s.compartiment || u.compartiment || '', status: s.status, signedAt: s.signedAt, refuseReason: s.refuseReason }; }),
      hasSignedPdf: !!(d.signedPdfB64 || (d.storage === 'drive' && d.driveFileLinkFinal)),
      allSigned: (d.signers || []).every(s => s.status === 'signed'),
    }));
    res.json({ flows: myFlows, total, page, limit, pages });
  } catch(e) { console.error('my-flows error:', e); res.status(500).json({ error: 'server_error' }); }
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
    // FIX: re-aplica footer cu noul flowId pe PDF-ul original
    if (newData.pdfB64 && _stampFooterOnPdf) {
      try {
        newData.pdfB64 = await _stampFooterOnPdf(newData.pdfB64, {
          flowId: newFlowId2, createdAt: newCreatedAt,
          initName: data.initName, initFunctie: data.initFunctie,
          institutie: data.institutie, compartiment: data.compartiment,
          flowType: data.flowType || 'tabel'  // ancore => useObjectStreams:false
        });
      } catch(e) { console.warn('Re-stamp footer on reinitiate error:', e.message); }
    }
    await saveFlow(newFlowId2, newData);
    const first = remainingSigners[0];
    if (first?.email) {
      await _notify({ userEmail: first.email, flowId: newFlowId2, type: 'YOUR_TURN', title: 'Document de semnat (reinițiat)',
        message: `${data.initName} a reinițiat fluxul de semnare pentru documentul „${data.docName}". Este rândul tău să semnezi.`,
        waParams: { signerName: first.name || first.email, docName: data.docName } });
    }
    console.log(`🔄 Flow ${flowId} reinițiat ca ${newFlowId2} de ${actor.email}`);
    return res.json({ ok: true, newFlowId: newFlowId2, signers: remainingSigners.length });
  } catch(e) { console.error('reinitiate error:', e); return res.status(500).json({ error: 'server_error' }); }
});

// ── POST /flows/:flowId/delegate ──────────────────────────────────────────
router.post('/flows/:flowId/delegate', async (req, res) => {
  try {
    if (requireDb(res)) return;
    const actor = requireAuth(req, res); if (!actor) return;
    const { flowId } = req.params;
    const { fromToken, toEmail, toName, reason } = req.body || {};
    if (!fromToken) return res.status(400).json({ error: 'fromToken_required' });
    if (!toEmail || !/^\S+@\S+\.\S+$/.test(toEmail)) return res.status(400).json({ error: 'toEmail_invalid' });
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'reason_required' });
    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    const signers = Array.isArray(data.signers) ? data.signers : [];
    const idx = signers.findIndex(s => s.token === fromToken);
    if (idx === -1) return res.status(400).json({ error: 'invalid_token' });
    const isAdmin = actor.role === 'admin';
    const isCurrentSigner = (signers[idx].email || '').toLowerCase() === (actor.email || '').toLowerCase();
    if (!isAdmin && !isCurrentSigner) return res.status(403).json({ error: 'forbidden', message: 'Doar semnatarul curent sau un admin poate delega.' });
    if (signers[idx].status !== 'current') return res.status(409).json({ error: 'not_current_signer', message: 'Se poate delega doar semnatarul curent.' });
    if (_isSignerTokenExpired(signers[idx])) return res.status(403).json({ error: 'token_expired' });

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

    // ── Notificare: in-app + WhatsApp conform preferintelor din DB ──
    await _notify({
      userEmail: toEmail, flowId, type: 'YOUR_TURN',
      title: '👥 Ai primit o delegare de semnătură',
      message: `${originalName} ți-a delegat semnarea documentului „${data.docName}". Motiv: ${String(reason).trim()}`,
      waParams: { signerName: resolvedName, docName: data.docName }
    });

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
  <h2 style="margin:0 0 8px;font-size:1.1rem;color:#cdd8ff;">Bună${resolvedName ? ', ' + resolvedName : ''},</h2>
  <p style="color:#9db0ff;margin:0 0 6px;line-height:1.6;">
    <strong style="color:#ffd580;">${originalName}</strong> ți-a delegat semnarea electronică a documentului:
  </p>
  <div style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:16px 20px;margin:16px 0 20px;">
    <div style="font-size:1rem;font-weight:700;color:#eaf0ff;margin-bottom:6px;">📄 ${data.docName || flowId}</div>
    <div style="font-size:.85rem;color:#9db0ff;margin-bottom:4px;">Inițiat de: ${data.initName || data.initEmail || ''}</div>
    <div style="font-size:.85rem;color:#ffd580;">Motiv delegare: ${String(reason).trim()}</div>
  </div>
  <div style="background:rgba(255,100,100,.08);border:1px solid rgba(255,100,100,.2);border-radius:10px;padding:12px 16px;margin-bottom:20px;font-size:.85rem;color:#ffb3b3;">
    ⚠️ Descarcă documentul, semnează-l cu certificatul tău calificat, apoi încarcă-l înapoi.
  </div>
  <div style="text-align:center;">
    <a href="${signerLink}" style="display:inline-block;background:linear-gradient(135deg,#7c5cff,#2dd4bf);color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:700;font-size:1rem;">✍️ Deschide documentul pentru semnare</a>
  </div>
  <p style="margin-top:20px;font-size:.78rem;color:rgba(255,255,255,.3);text-align:center;">Link valid 90 de zile · DocFlowAI · ${data.institutie || ''}</p>
</div>`
        });
      } catch(emailErr) { console.error('Delegare email error:', emailErr.message); }
    }

    console.log(`👥 Delegare ${originalEmail} → ${toEmail} pentru flow ${flowId} de ${actor.email}`);
    return res.json({ ok: true, flowId, from: originalEmail, to: toEmail, delegateName: resolvedName });
  } catch(e) { console.error('delegate error:', e); return res.status(500).json({ error: 'server_error' }); }
});
export default router;
