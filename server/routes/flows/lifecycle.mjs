/**
 * DocFlowAI — flows/lifecycle.mjs
 * Ciclu de viață: reinitiere, revizuire, delegare, anulare
 */
import { Router, json as expressJson } from 'express';
import { AUTH_COOKIE, JWT_SECRET, requireAuth, requireAdmin, sha256Hex, escHtml, getOptionalActor } from '../../middleware/auth.mjs';
import { pool, DB_READY, requireDb, saveFlow, getFlowData, getDefaultOrgId, getUserMapForOrg, writeAuditEvent } from '../../db/index.mjs';
import { createRateLimiter } from '../../middleware/rateLimiter.mjs';
import { logger } from '../../middleware/logger.mjs';
import { isAdminOrOrgAdmin, actorCanAccessOrg } from '../../services/authz-scope.mjs';
import { undoCompletedFlowLinks } from '../../services/flow-undo.mjs';
import { recordFormularAudit } from '../../db/queries/formulare-audit.mjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { pdfLooksSigned, computeSignerRectsReadOnly } from '../../utils/pdf-signed-placement.mjs';
import { classifySignerEmail } from '../../services/signer-identity.mjs';

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
    const isAdmin = isAdminOrOrgAdmin(actor) && actorCanAccessOrg(actor, data.orgId);
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
      if (baseForStamp && _PDFLib && pdfLooksSigned(baseForStamp)) {
        // PDF pre-semnat: NU rescriem (păstrăm validitatea semnăturii existente),
        // calculăm read-only padesRect pe ultima pagină. Vezi crud.mjs.
        newData.preSignedUpload = true;
        try {
          const _ro = await computeSignerRectsReadOnly(baseForStamp, remainingSigners, _PDFLib, logger);
          (_ro.signerRects || []).forEach((rect, idx) => {
            if (remainingSigners[idx] && rect) remainingSigners[idx].padesRect = rect;
          });
          newData.events.push({ at: newCreatedAt, type: 'PRESIGNED_UPLOAD_DETECTED',
            detail: 'Footer/cartuș omise pentru a păstra validitatea semnăturii existente', placement: _ro.placement });
        } catch(e) { logger.warn({ err: e }, 'computeSignerRectsReadOnly on reinitiate error:'); }
      } else if (baseForStamp) {
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
    const isAdmin = isAdminOrOrgAdmin(actor) && actorCanAccessOrg(actor, data.orgId);
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
    // FIX state machine: marchează DF ca de_revizuit când fluxul intră în review
    try {
      await pool.query(
        `UPDATE formulare_df SET status='de_revizuit', updated_at=NOW()
         WHERE flow_id=$1 AND status='transmis_flux'`,
        [flowId]
      );
    } catch(_) { /* non-fatal */ }
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

    const isAdmin = isAdminOrOrgAdmin(actor) && actorCanAccessOrg(actor, data.orgId);
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
    // PDF pre-semnat: NU rescriem; calculăm read-only padesRect (aplicat pe
    // resetSigners mai jos). Vezi crud.mjs.
    let _reviewPreSigned = false, _reviewPreSignedRects = null, _reviewPreSignedPlacement = null;
    if (finalPdfB64 && _PDFLib && (data.flowType || 'tabel') !== 'ancore' && pdfLooksSigned(finalPdfB64)) {
      _reviewPreSigned = true;
      try {
        const _ro = await computeSignerRectsReadOnly(finalPdfB64, data.signers || [], _PDFLib, logger);
        _reviewPreSignedRects = _ro.signerRects || [];
        _reviewPreSignedPlacement = _ro.placement;
      } catch(e) { logger.warn({ err: e }, 'computeSignerRectsReadOnly on reinitiate-review error:'); }
    } else if (finalPdfB64 && _stampFooterOnPdf && (data.flowType || 'tabel') !== 'ancore') {
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
    // padesRect read-only pentru PDF pre-semnat — aplicat pe ordinea sortată
    if (_reviewPreSigned && _reviewPreSignedRects) {
      _reviewPreSignedRects.forEach((rect, idx) => {
        if (resetSigners[idx] && rect) resetSigners[idx].padesRect = rect;
      });
    }

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
    data.preSignedUpload = _reviewPreSigned;
    if (_reviewPreSigned) {
      data.events.push({ at: now, type: 'PRESIGNED_UPLOAD_DETECTED',
        detail: 'Footer/cartuș omise pentru a păstra validitatea semnăturii existente', placement: _reviewPreSignedPlacement });
    }

    // Notifică primul semnatar (același flowId)
    const first = resetSigners[0];
    if (first) first.notifiedAt = new Date().toISOString();
    await saveFlow(flowId, data);
    // FIX state machine: la reluarea fluxului după revizuire, DF revine la draft
    try {
      await pool.query(
        `UPDATE formulare_df SET status='draft', updated_at=NOW()
         WHERE flow_id=$1 AND status='de_revizuit'`,
        [flowId]
      );
    } catch(_) { /* non-fatal */ }
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
    const isAdmin = isAdminOrOrgAdmin(actor) && actorCanAccessOrg(actor, data.orgId);
    const isCurrentSigner = !!actor && currentSignerEmail === (actor.email || '').toLowerCase();
    if (actor && !isAdmin && !isCurrentSigner) return res.status(403).json({ error: 'forbidden', message: 'Doar semnatarul curent sau un admin poate delega.' });
    if (signers[idx].status !== 'current') return res.status(409).json({ error: 'not_current_signer', message: 'Se poate delega doar semnatarul curent.' });
    // FIX v3.3.3: nu poți delega către tine însuți — comparăm cu actorul logat dacă există, altfel cu semnatarul curent din token.
    if (toEmail.trim().toLowerCase() === ((actor?.email || currentSignerEmail).toLowerCase())) {
      return res.status(400).json({ error: 'self_delegation_not_allowed', message: 'Nu poți delega semnătura către tine însuți.' });
    }

    // SEC-103: nu poți delega către un utilizator intern dezactivat. `unknown` (DB căzut) TRECE —
    // delegarea din UI cere sesiune (sessionGuard a fail-closed deja); `external` (fără cont) TRECE.
    {
      const { cls } = await classifySignerEmail(toEmail);
      if (cls === 'deactivated') {
        return res.status(400).json({
          error: 'delegate_deactivated',
          message: 'Utilizatorul către care delegi este dezactivat.'
        });
      }
    }

    const originalName = signers[idx].name;
    const originalEmail = signers[idx].email;

    let _origFunctie = '';
    try {
      // SEC-102: migrația 067 permite REUTILIZAREA emailului după soft-delete ⇒ fără deleted_at,
      // rows[0] poate fi utilizatorul ȘTERS. lower(email) se aliniază cu users_email_active_uniq.
      const { rows: _ofR } = await pool.query(
        'SELECT functie FROM users WHERE lower(email)=$1 AND deleted_at IS NULL LIMIT 1',
        [originalEmail.toLowerCase()]
      );
      _origFunctie = _ofR[0]?.functie || '';
    } catch (_) { /* non-fatal */ }

    // Cautam datele delegatului in DB
    // SEC-102: migrația 067 permite REUTILIZAREA emailului după soft-delete ⇒ fără deleted_at,
    // rows[0] poate fi utilizatorul ȘTERS. lower(email) se aliniază cu users_email_active_uniq.
    const { rows: delegatDbRows } = await pool.query(
      'SELECT nume, functie, compartiment, institutie FROM users WHERE lower(email)=$1 AND deleted_at IS NULL',
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
      delegatedFrom: { name: originalName, email: originalEmail, functie: _origFunctie, reason: String(reason).trim(), at: new Date().toISOString(), by: actor.email },
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
    const isAdmin = isAdminOrOrgAdmin(actor) && actorCanAccessOrg(actor, data.orgId);
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
    // FIX state machine v3.9.497 (Finding #2 audit Pas 4):
    // La cancel, DF legat (dacă e în transmis_flux) revine la 'completed' — userul
    // poate retrimite același DF. ALOP păstrează df_id (DF rămâne revizia curentă)
    // dar curăță df_flow_id + df_completed_at (fluxul mort nu mai e activ).
    // Asimetric față de refuse (care setează neaprobat + eliberează df_id pentru R0)
    // pentru că cancel nu e rejection, doar "undo putting in flux".
    try {
      const { rows: dfRows } = await pool.query(
        `UPDATE formulare_df SET status='completed', updated_at=NOW()
         WHERE flow_id=$1 AND status='transmis_flux'
         RETURNING id, revizie_nr, parent_df_id`,
        [flowId]
      );
      if (dfRows.length) {
        const cancelledDf = dfRows[0];
        await pool.query(
          `UPDATE alop_instances
           SET df_flow_id=NULL, df_completed_at=NULL, updated_at=NOW()
           WHERE df_id=$1 AND cancelled_at IS NULL`,
          [cancelledDf.id]
        );
        logger.info({ dfId: cancelledDf.id, revizieNr: cancelledDf.revizie_nr, flowId },
          `[ALOP] flow cancelled → DF R${cancelledDf.revizie_nr || 0} revenit la completed, ALOP df_flow_id=NULL`);
      }
    } catch (alopCancelErr) {
      // Non-fatal: cancel-ul fluxului a reușit oricum (data.status='cancelled' salvat).
      logger.error({ err: alopCancelErr, flowId }, '[ALOP] restore on cancel failed (non-fatal)');
    }
    // Simetric DF (fix 9): la cancel, curăță pointerul ORD pe ALOP. ORD nu are status
    // 'transmis_flux' (link-flow ORD setează doar flow_id), deci NU resetăm status formular —
    // doar eliberăm ord_flow_id/ord_completed_at pe ALOP (fluxul mort nu mai e activ).
    // formulare_ord.flow_id rămâne (paritate cu DF, care păstrează formulare_df.flow_id);
    // self-heal #2 din alop.mjs nu re-populează ord_flow_id dintr-un flux 'cancelled' (guard).
    try {
      const { rows: ordRows } = await pool.query(
        `SELECT id FROM formulare_ord WHERE flow_id=$1`,
        [flowId]
      );
      if (ordRows.length) {
        const ordId = ordRows[0].id;
        await pool.query(
          `UPDATE alop_instances
             SET ord_flow_id=NULL, ord_completed_at=NULL, updated_at=NOW()
           WHERE ord_id=$1 AND cancelled_at IS NULL`,
          [ordId]
        );
        logger.info({ ordId, flowId }, '[ALOP] flow cancelled → ord_flow_id=NULL (simetric DF)');
      }
    } catch (ordCancelErr) {
      logger.error({ err: ordCancelErr, flowId }, '[ALOP] ORD restore on cancel failed (non-fatal)');
    }
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

// ── POST /flows/:flowId/admin-cancel ───────────────────────────────────────
// #113a — undo administrativ al unui flux FINALIZAT (ORD/DF semnat greșit, ajuns
// aprobat/neconform). Operație SUPORTATĂ, cu motiv obligatoriu + audit, care înlocuiește
// reparația manuală din 23.07.2026 (recon + script + backup). NU e `cancel`-ul normal:
// acela refuză 409 `already_completed` pe fluxuri finalizate — INTENȚIONAT, și rămâne așa.
// Efect: soft-delete flux (documentul QES NU se distruge, doar se deconectează) +
// desfacere legături DF/ORD↔ALOP (undoCompletedFlowLinks). ALOP ORD revine plata→ordonantare
// (tranziție legitimată de migrația 103). ⛔ NU pentru fluxuri cu plată confirmată — acolo e
// corecție financiară, se face prin ciclu nou („noua lichidare"), nu prin rescrierea istoricului.
router.post('/flows/:flowId/admin-cancel', async (req, res) => {
  try {
    if (requireDb(res)) return;
    const actor = requireAuth(req, res); if (!actor) return;
    const { flowId } = req.params;
    const reason = String((req.body && req.body.reason) || '').trim();
    // Citim rândul DIRECT (nu getFlowData, care filtrează deleted_at IS NULL): un al doilea
    // apel pe un flux deja desfăcut (soft-deleted) trebuie să vadă data.status='cancelled' și
    // să întoarcă 409 already_cancelled — nu 404. `data` e JSONB → obiect JS direct.
    const { rows: flowRows } = await pool.query(`SELECT data FROM flows WHERE id=$1`, [flowId]);
    if (!flowRows.length) return res.status(404).json({ error: 'not_found' });
    const data = flowRows[0].data || {};

    // Gardă 1 — DOAR admin/org_admin cu acces la org. ⛔ NU inițiatorul (operație administrativă).
    if (!(isAdminOrOrgAdmin(actor) && actorCanAccessOrg(actor, data.orgId))) {
      return res.status(403).json({ error: 'forbidden', message: 'Doar un administrator poate desface un flux finalizat.' });
    }
    // Gardă 2 — motiv obligatoriu (min 10 caractere): singura urmă a raționamentului uman.
    if (reason.length < 10) {
      return res.status(400).json({ error: 'reason_required', message: 'Motivul este obligatoriu (minim 10 caractere).' });
    }
    // Gardă 3 — DOAR fluxuri finalizate. Pentru fluxuri în derulare există `cancel`-ul normal.
    if (!data.completed) return res.status(409).json({ error: 'not_completed', message: 'Fluxul nu este finalizat — folosește anularea obișnuită.' });
    // Gardă 4 — idempotență.
    if (data.status === 'cancelled') return res.status(409).json({ error: 'already_cancelled', message: 'Fluxul este deja anulat.' });

    // Gărzi 5+6 — financiare/istorice, dacă fluxul e legat de un ORD (prin ALOP).
    // Încarcă ALOP-ul asociat ORD-ului acestui flux (pe formulare_ord.flow_id sau ord_flow_id).
    const { rows: alopRows } = await pool.query(
      `SELECT a.id, a.plata_confirmed_at, a.plata_suma_efectiva, a.suma_totala_platita
         FROM alop_instances a
         JOIN formulare_ord fo ON fo.id = a.ord_id
        WHERE fo.flow_id = $1 AND a.cancelled_at IS NULL
        LIMIT 1`,
      [flowId]
    );
    const alopFin = alopRows[0] || null;
    if (alopFin) {
      // Gardă 5 — plată confirmată ⇒ corecție financiară, nu curățare de dată. Blocat.
      if (alopFin.plata_confirmed_at != null
          || Number(alopFin.plata_suma_efectiva || 0) > 0
          || Number(alopFin.suma_totala_platita || 0) > 0) {
        return res.status(409).json({ error: 'payment_confirmed', message: 'ALOP-ul are plată confirmată — corecția se face prin ciclu nou, nu prin anulare.' });
      }
      // Gardă 6 — cicluri arhivate ⇒ istoric multi-ORD, nu se rescrie.
      const { rows: cyc } = await pool.query(
        `SELECT 1 FROM alop_ord_cicluri WHERE alop_id=$1 LIMIT 1`,
        [alopFin.id]
      );
      if (cyc.length) return res.status(409).json({ error: 'has_archived_cycles', message: 'ALOP-ul are cicluri arhivate — nu poate fi desfăcut administrativ.' });
    }

    // Efect — o singură tranzacție (model noua-lichidare din alop.mjs).
    const now = new Date().toISOString();
    const client = await pool.connect();
    let undo = { dfId: null, ordId: null, alopId: null, statusChanged: false };
    try {
      await client.query('BEGIN');

      // (a) Flux: marchează cancelled + soft-delete (documentul semnat NU se distruge).
      data.status = 'cancelled';
      data.cancelledAt = now;
      data.cancelledBy = actor.email;
      data.cancelReason = reason.slice(0, 500);
      data.adminCancelled = true;
      data.updatedAt = now;
      if (!Array.isArray(data.events)) data.events = [];
      data.events.push({ at: now, type: 'FLOW_ADMIN_CANCELLED', by: actor.email, reason: data.cancelReason });
      await client.query(`UPDATE flows SET data=$2::jsonb, updated_at=NOW() WHERE id=$1`, [flowId, JSON.stringify(data)]);
      await client.query(`UPDATE flows SET deleted_at=NOW(), deleted_by=$2 WHERE id=$1`, [flowId, actor.email]);

      // (b) Desface legăturile DF/ORD↔ALOP (golește AMBELE pointere ORD — vezi flow-undo.mjs).
      undo = await undoCompletedFlowLinks(client, flowId);

      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error({ err: txErr, flowId }, 'admin-cancel tx error');
      return res.status(500).json({ error: 'server_error' });
    } finally {
      client.release();
    }

    // Audit (best-effort, în afara tranzacției).
    writeAuditEvent({ flowId, orgId: data.orgId, eventType: 'FLOW_ADMIN_CANCELLED', actorIp: _getIp(req), actorEmail: actor.email,
      payload: { reason: data.cancelReason, dfId: undo.dfId, ordId: undo.ordId, alopId: undo.alopId } });
    if (undo.dfId) {
      recordFormularAudit({ orgId: data.orgId, formType: 'df', formId: undo.dfId, actorId: actor.userId, actorEmail: actor.email,
        eventType: 'FLOW_ADMIN_CANCELLED', meta: { flowId, reason: data.cancelReason, alopId: undo.alopId } });
    }
    if (undo.ordId) {
      recordFormularAudit({ orgId: data.orgId, formType: 'ord', formId: undo.ordId, actorId: actor.userId, actorEmail: actor.email,
        eventType: 'FLOW_ADMIN_CANCELLED', meta: { flowId, reason: data.cancelReason, alopId: undo.alopId } });
    }

    // Șterge notificările active pentru fluxul desfăcut.
    await pool.query("DELETE FROM notifications WHERE flow_id=$1 AND type IN ('YOUR_TURN','REMINDER')", [flowId]).catch(() => {});

    logger.info({ flowId, actor: actor.email, ...undo }, '🛠️ Flux FINALIZAT desfăcut administrativ (admin-cancel)');
    return res.json({ ok: true, flowId, cancelledAt: now, ...undo });
  } catch(e) { logger.error({ err: e }, 'admin-cancel flow error:'); return res.status(500).json({ error: 'server_error' }); }
});

// ── F-06: Documente suport ────────────────────────────────────────────────
export default router;
