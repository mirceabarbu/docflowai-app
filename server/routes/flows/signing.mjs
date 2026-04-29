/**
 * DocFlowAI — flows/signing.mjs
 * Semnare: sign, refuse, register-download, upload-signed-pdf, resend, regenerate-token
 */
import { Router, json as expressJson } from 'express';
import { AUTH_COOKIE, JWT_SECRET, requireAuth, requireAdmin, sha256Hex, escHtml, getOptionalActor } from '../../middleware/auth.mjs';
import { pool, DB_READY, requireDb, saveFlow, getFlowData, getDefaultOrgId, getUserMapForOrg, writeAuditEvent } from '../../db/index.mjs';
import { getActiveSigner, getLeaveInfo } from '../../services/user-leave.mjs';
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
    // FEAT-N01: webhook flow.refused (fire-and-forget)
    if (_fireWebhook && data.orgId) setImmediate(() => _fireWebhook(data.orgId, 'flow.refused', { ...data, refusedAt: new Date().toISOString() }).catch(() => {}));
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
    // FIX state machine: marchează DF ca neaprobat când fluxul e refuzat
    try {
      await pool.query(
        `UPDATE formulare_df SET status='neaprobat', updated_at=NOW()
         WHERE flow_id=$1 AND status='transmis_flux'`,
        [flowId]
      );
    } catch(_) { /* non-fatal */ }
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
    const rawPdf = (data.pdfB64 || '').includes(',') ? (data.pdfB64 || '').split(',')[1] : (data.pdfB64 || '');
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
router.post('/flows/:flowId/upload-signed-pdf', _largePdf, async (req, res) => {
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
      // ── ANCORE: P3 — verificare soft câmp AcroForm semnat ────────────────
      // Dacă semnatarul are ancoreFieldName definit, verificăm că acel câmp
      // există în PDF și are o valoare (/V) — adică a fost semnat efectiv.
      // Non-blocking: dacă pdf-lib eșuează tehnic, acceptăm oricum (warn în log).
      const ancoreFieldName = signers[idx].ancoreFieldName || null;
      if (ancoreFieldName && _PDFLib) {
        try {
          const { PDFDocument, PDFName } = _PDFLib;
          const signedBuf = Buffer.from(rawCheck, 'base64');
          const pdfDoc    = await PDFDocument.load(signedBuf, { ignoreEncryption: true });

          // Traversare recursivă câmpuri AcroForm — căutăm câmpul cu numele dat
          let fieldFound  = false;
          let fieldSigned = false;

          const acroFormRef = pdfDoc.catalog.get(PDFName.of('AcroForm'));
          if (acroFormRef) {
            const acroForm  = pdfDoc.context.lookup(acroFormRef);
            const fieldsRef = acroForm?.get?.(PDFName.of('Fields'));
            const topFields = fieldsRef ? pdfDoc.context.lookup(fieldsRef) : null;

            function findField(refs) {
              const arr = Array.isArray(refs) ? refs : (refs?.asArray?.() || []);
              for (const ref of arr) {
                try {
                  const field = pdfDoc.context.lookup(ref);
                  if (!field?.get) continue;
                  // Verificăm Kids recursiv
                  const kidsRef = field.get(PDFName.of('Kids'));
                  if (kidsRef) {
                    const kids = pdfDoc.context.lookup(kidsRef);
                    if (kids?.asArray) { findField(kids.asArray()); continue; }
                  }
                  // Verificăm numele câmpului (T)
                  const nameObj = field.get(PDFName.of('T'));
                  const name    = nameObj ? String(nameObj).replace(/^\//, '').replace(/^\(|\)$/g, '') : null;
                  if (name === ancoreFieldName) {
                    fieldFound = true;
                    // /V prezent și diferit de null/empty → câmpul a fost semnat
                    const vObj = field.get(PDFName.of('V'));
                    fieldSigned = !!(vObj && String(vObj) !== 'null' && String(vObj) !== '/null');
                  }
                } catch(_) {}
              }
            }

            if (topFields?.asArray) findField(topFields.asArray());
          }

          if (fieldFound && !fieldSigned) {
            // Câmpul există dar NU e semnat → respingem cu mesaj clar
            return res.status(422).json({
              error:   'acroform_field_not_signed',
              field:   ancoreFieldName,
              message: `Câmpul de semnătură „${ancoreFieldName}" nu a fost semnat în documentul uploadat. Verificați că ați aplicat semnătura electronică calificată pe câmpul corect.`,
            });
          }

          if (!fieldFound) {
            // Câmpul nu a fost găsit — poate PDF-ul a fost modificat sau e alt format
            // Acceptăm cu warn — nu blocăm fluxul
            logger.warn({ flowId, ancoreFieldName, signerEmail: signers[idx].email },
              'P3: câmpul AcroForm nu a fost găsit în PDF-ul uploadat (non-fatal)');
          }

          // Stocăm metadata verificare pentru audit
          signers[idx].ancoreFieldVerified = fieldFound;
          signers[idx].ancoreFieldSigned   = fieldSigned;
        } catch(verifyErr) {
          // Eroare pdf-lib → non-fatal, acceptăm și loggăm
          logger.warn({ err: verifyErr, flowId, ancoreFieldName },
            'P3: eroare verificare AcroForm (non-fatal — pdf acceptat)');
        }
      }

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
    // BLOC 4.3: auto-redirect dacă noul semnatar curent e în concediu cu delegat
    if (nextIdx !== -1) await _autoRedirectIfOnLeave(flowId, data, signers);
    data.signers = signers;
    const allDone = signers.every(s => s.status === 'signed' && s.pdfUploaded);
    if (allDone) { data.completed = true; data.status = 'completed'; data.completedAt = new Date().toISOString(); /* urgent păstrat intenționat — badge URGENT rămâne vizibil în admin și după finalizare */ data.events.push({ at: new Date().toISOString(), type: 'FLOW_COMPLETED', by: 'system' }); }
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
          // FEAT-N01: webhook flow.completed (fire-and-forget)
          if (_fireWebhook && data.orgId) _fireWebhook(data.orgId, 'flow.completed', data).catch(() => {});
          // ALOP: auto-tranziție dosar la finalizarea fluxului de semnare legat
          try {
            // Marchează DF ca aprobat: status='aprobat' (coloana stocată);
            // câmpul `aprobat` e calculat dinamic din flow_id+status în queries
            await pool.query(
              `UPDATE formulare_df SET status = 'aprobat', updated_at = NOW() WHERE flow_id = $1`,
              [flowId]
            ).catch(() => {});
            const [alopDf, alopOrd] = await Promise.all([
              pool.query(`SELECT id, status FROM alop_instances WHERE df_flow_id=$1 AND cancelled_at IS NULL`, [flowId]),
              pool.query(`SELECT id, status FROM alop_instances WHERE ord_flow_id=$1 AND cancelled_at IS NULL`, [flowId])
            ]);
            if (alopDf.rows[0]) {
              const al = alopDf.rows[0];
              if (['draft','angajare'].includes(al.status)) {
                await pool.query(`UPDATE alop_instances SET status='lichidare', df_completed_at=NOW(), updated_at=NOW() WHERE id=$1`, [al.id]);
                logger.info(`[ALOP] df_flow semnat → lichidare, id=${al.id}`);
              }
            }
            const alopOrdRow = alopOrd.rows[0] || (await pool.query(
              `SELECT a.id, a.status FROM alop_instances a
               JOIN alop_ord_cicluri c ON c.alop_id = a.id
               WHERE c.ord_flow_id = $1 AND a.cancelled_at IS NULL
               LIMIT 1`,
              [flowId]
            )).rows[0];
            if (alopOrdRow && alopOrdRow.status === 'ordonantare') {
              await pool.query(`UPDATE alop_instances SET status='plata', ord_completed_at=NOW(), updated_at=NOW() WHERE id=$1`, [alopOrdRow.id]);
              logger.info(`[ALOP] ord_flow semnat → plata, id=${alopOrdRow.id}`);
            }
          } catch(alopErr) {
            logger.warn({ err: alopErr }, '[ALOP] auto-transition failed (non-fatal)');
          }
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
    const actor = requireAuth(req, res); if (!actor) return;
    const { flowId } = req.params;
    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    // admin: acces global; org_admin: doar fluxuri din propria instituție; inițiator: flux propriu
    const isAdmin = actor.role === 'admin' || (actor.role === 'org_admin' && data.orgId != null && actor.orgId != null && Number(data.orgId) === Number(actor.orgId));
    const isInit = (data.initEmail || '').toLowerCase() === actor.email.toLowerCase();
    if (!isAdmin && !isInit) return res.status(403).json({ error: 'forbidden', message: 'Doar inițiatorul sau un administrator poate retrimite notificarea.' });
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
    const actor = requireAuth(req, res); if (!actor) return;
    const { flowId } = req.params;
    const { signerEmail } = req.body || {};
    if (!signerEmail) return res.status(400).json({ error: 'signerEmail_required' });
    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    // admin: acces global; org_admin: doar fluxuri din propria instituție
    const isAdmin = actor.role === 'admin' || (actor.role === 'org_admin' && data.orgId != null && actor.orgId != null && Number(data.orgId) === Number(actor.orgId));
    if (!isAdmin) return res.status(403).json({ error: 'forbidden', message: 'Doar un administrator poate regenera token-ul.' });
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


// ════════════════════════════════════════════════════════════════════════════
// BLOC 4.3 — Auto-redirect la semnatar în concediu
// Apelat după ce un semnatar a uploadat PDF semnat și fluxul s-a mutat la
// următorul semnatar (status='current'). Verifică dacă noul semnatar curent
// e în concediu și are delegat — dacă DA, transferă slot-ul automat.
// ════════════════════════════════════════════════════════════════════════════
async function _autoRedirectIfOnLeave(flowId, data, signers) {
  try {
    const currentIdx = signers.findIndex(s => s.status === 'current');
    if (currentIdx === -1) return false;
    const cur = signers[currentIdx];

    // Lookup user după email
    const { rows: uRows } = await pool.query(
      'SELECT id FROM users WHERE email=$1',
      [(cur.email || '').toLowerCase()]
    );
    if (!uRows.length) return false;
    const userId = uRows[0].id;

    // Verifică concediu activ + delegat
    const active = await getActiveSigner(userId);
    if (!active || !active.isDelegate) return false;

    // Lookup datele delegatului
    const { rows: dRows } = await pool.query(
      'SELECT id, nume, email, functie FROM users WHERE id=$1',
      [active.userId]
    );
    if (!dRows.length) return false;
    const del = dRows[0];

    // Substituție în slot
    const originalName = cur.name;
    const originalEmail = cur.email;
    cur.name = del.nume || del.email;
    cur.email = del.email;
    cur.functie = del.functie || cur.functie;
    cur.delegatedForUserId = userId;
    cur.delegatedForName = originalName;
    cur.delegatedForEmail = originalEmail;
    cur.token = crypto.randomBytes(16).toString('hex'); // token nou pentru delegat
    cur.tokenCreatedAt = new Date().toISOString();
    cur.emailSent = false;
    cur.notifiedAt = null;
    cur.delegatedFrom = {
      name: originalName,
      email: originalEmail,
      reason: 'auto: utilizator în concediu',
      at: new Date().toISOString(),
      by: 'system',
    };

    data.events = Array.isArray(data.events) ? data.events : [];
    data.events.push({
      at: new Date().toISOString(),
      type: 'AUTO_DELEGATED_LEAVE',
      from: originalEmail,
      to: del.email,
      order: cur.order,
    });

    writeAuditEvent({
      flowId, orgId: data.orgId,
      eventType: 'AUTO_DELEGATED_LEAVE',
      actorEmail: 'system',
      payload: { from: originalEmail, to: del.email, order: cur.order },
    });

    logger.info(`🔁 Auto-delegated flow ${flowId} from ${originalEmail} to ${del.email} (on leave)`);
    return true;
  } catch (e) {
    logger.warn({ err: e, flowId }, '_autoRedirectIfOnLeave failed (non-fatal)');
    return false;
  }
}

export default router;
