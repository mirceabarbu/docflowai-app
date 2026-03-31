/**
 * DocFlowAI — flows/lifecycle.mjs
 * Ciclu de viață: reinitiere, revizuire, delegare, anulare
 */
import { Router, json as expressJson } from 'express';
import { AUTH_COOKIE, JWT_SECRET, requireAuth, requireAdmin, sha256Hex, escHtml, getOptionalActor } from '../../middleware/auth.mjs';
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
import { emailDelegare } from '../../emailTemplates.mjs';



// ── POST /flows/:flowId/reinitiate ─────────────────────────────────────────
router.post('/flows/:flowId/reinitiate', async (req, res) => {
  try {
    if (requireDb(res)) return;
    const actor = requireAuth(req, res); if (!actor) return;
    const { flowId } = req.params;
    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    const isAdmin = actor.role === 'admin' || (actor.role === 'org_admin' && data.orgId != null && actor.orgId != null && Number(data.orgId) === Number(actor.orgId));
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
            flowType: data.flowType || 'tabel',
            preventRewriteIfSigned: true,
          });
        } catch(e) { logger.warn({ err: e }, 'Re-stamp footer on reinitiate error:'); }
      }
    }
    // FIX v3.3.2: primul saveFlow era redundant — mutăm după setarea notifiedAt
    const first = remainingSigners[0];
    if (first) first.notifiedAt = new Date().toISOString();
    await saveFlow(newFlowId2, newData);
    // FIX: Marchează fluxul original cu reinitiatedAs — previne reinițializare dublă
    data.reinitiatedAs = newFlowId2;
    data.updatedAt = new Date().toISOString();
    await saveFlow(flowId, data);
    // Copiere atașamente (documente suport) din fluxul original
    try {
      const attRows = await pool.query(
        `SELECT filename, mime_type, size_bytes, data FROM flow_attachments WHERE flow_id = $1`,
        [flowId]
      );
      for (const att of attRows.rows) {
        await pool.query(
          `INSERT INTO flow_attachments (flow_id, filename, mime_type, size_bytes, data) VALUES ($1, $2, $3, $4, $5)`,
          [newFlowId2, att.filename, att.mime_type, att.size_bytes, att.data]
        );
      }
      if (attRows.rows.length) logger.info(`📎 Copiate ${attRows.rows.length} atașamente din ${flowId} → ${newFlowId2}`);
    } catch(e) { logger.warn({ err: e }, 'reinitiate: copy attachments error'); }
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
    const isAdmin = actor?.role === 'admin' || (actor?.role === 'org_admin' && Number(data.orgId) === Number(actor?.orgId));
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
router.post('/flows/:flowId/reinitiate-review', _largePdf, async (req, res) => {
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

    const isAdmin = actor.role === 'admin' || (actor.role === 'org_admin' && data.orgId != null && actor.orgId != null && Number(data.orgId) === Number(actor.orgId));
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
          flowType: data.flowType || 'tabel',
          preventRewriteIfSigned: true,
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
    const isAdmin = actor?.role === 'admin' || (actor?.role === 'org_admin' && Number(data.orgId) === Number(actor?.orgId));
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
          ...emailDelegare({ signerLink, resolvedName, originalName, docName: data.docName, flowId, initName: data.initName, initEmail: data.initEmail, reason, institutie: data.institutie }),
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
    const isAdmin = actor.role === 'admin' || (actor.role === 'org_admin' && data.orgId != null && actor.orgId != null && Number(data.orgId) === Number(actor.orgId));
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
    // FEAT-N01: webhook flow.cancelled (fire-and-forget)
    if (_fireWebhook && data.orgId) setImmediate(() => _fireWebhook(data.orgId, 'flow.cancelled', data).catch(() => {}));
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
export default router;
