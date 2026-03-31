/**
 * DocFlowAI — flows/cloud-signing.mjs
 * Semnare cloud: STS OAuth callback/poll, provideri, inițiere sesiune, callback
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

import { getOrgProviders, getOrgProviderConfig, getProvider } from '../../signing/index.mjs';
import { javaPreparePades, javaFinalizePades, hasJavaSigningService } from '../../signing/java-pades-client.mjs';


// ── GET /flows/sts-oauth-callback — callback OAuth2 de la STS IDP ─────────
// STS redirecționează utilizatorul aici după autentificare și selectarea certificatului.
// Query params: code, state, [error], [error_description]
router.get('/flows/sts-oauth-callback', async (req, res) => {
  try {
    if (requireDb(res)) return;
    const { code, state, error } = req.query;

    // Extragem sessionId din state
    // Format single: `${sessionId}___${randomState}`
    // Format bulk:   `BULK_${bulkSessionId}___${randomState}`
    const sessionId = state?.split('___')[0];
    if (!sessionId) {
      return res.redirect(`/semdoc-signer.html?sts_error=${encodeURIComponent('State invalid')}`);
    }

    // b231: detectam sesiune bulk și delegăm
    if (sessionId.startsWith('BULK_')) {
      const bulkSessionId = sessionId.replace('BULK_', '');
      const { processBulkOAuthCallback } = await import('./bulk-signing.mjs');
      return processBulkOAuthCallback(bulkSessionId, req.query, res);
    }

    // Găsim fluxul prin sessionId stocat în signers[i].signingSessionId
    const { rows } = await pool.query(
      `SELECT id AS flow_id FROM flows
       WHERE data->'signers' @> $1::jsonb AND deleted_at IS NULL LIMIT 1`,
      [JSON.stringify([{ signingSessionId: sessionId }])]
    );

    if (!rows.length) {
      logger.warn({ sessionId }, 'STS callback: sesiune negăsită în DB');
      return res.redirect(`/semdoc-signer.html?sts_error=${encodeURIComponent('Sesiune expirată sau inexistentă')}`);
    }

    const flowId = rows[0].flow_id;
    // Folosim getFlowData — face JOIN cu flows_pdfs și returnează pdfB64 corect
    const data = await getFlowData(flowId);
    if (!data) {
      return res.redirect(`/semdoc-signer.html?sts_error=${encodeURIComponent('Flux negăsit')}`);
    }
    const signers = Array.isArray(data.signers) ? data.signers : [];
    const signerIdx = signers.findIndex(s => s.signingSessionId === sessionId);
    if (signerIdx === -1) {
      return res.redirect(`/semdoc-signer.html?sts_error=${encodeURIComponent('Semnatar negăsit')}`);
    }

    const signer = signers[signerIdx];

    // Reconstituim pdfBytes din flux
    const rawPdf = (data.pdfB64 || '').includes(',') ? data.pdfB64.split(',')[1] : (data.pdfB64 || '');
    if (!rawPdf) {
      return res.redirect(`/semdoc-signer.html?flow=${encodeURIComponent(flowId)}&token=${encodeURIComponent(signer.token)}&sts_error=${encodeURIComponent('PDF lipsă')}`);
    }
    const pdfBytes = Buffer.from(rawPdf, 'base64');

    // Reconstituim sesiunea pentru STSCloudProvider
    const session = {
      sessionId,
      flowId,
      signerToken:  signer.token,
      provider:     'sts-cloud',
      providerData: signer.stsProviderData || {},
    };

    const { STSCloudProvider } = await import('../../signing/providers/STSCloudProvider.mjs');
    const provider = new STSCloudProvider();
    const result   = await provider.processOAuthCallback(req.query, session, pdfBytes);

    if (!result.ok) {
      const errMsg = encodeURIComponent(result.message || result.error || 'Eroare STS');
      return res.redirect(`/semdoc-signer.html?flow=${encodeURIComponent(flowId)}&token=${encodeURIComponent(signer.token)}&sts_error=${errMsg}`);
    }

    // Stocăm datele de polling în semnatar
    signers[signerIdx].stsOpId       = result.stsOpId;
    signers[signerIdx].stsToken      = result.accessToken;
    signers[signerIdx].stsSignUrl    = result.signUrl;
    signers[signerIdx].stsPending    = true;
    signers[signerIdx].stsCertPem    = result.certPem || null;
    signers[signerIdx].stsCertChain  = result.certChainPem || []; // CA intermediar(i) pentru path building
    data.signers   = signers;
    data.updatedAt = new Date().toISOString();
    await saveFlow(flowId, data);

    // Redirecționăm înapoi la pagina de semnare cu status pending
    return res.redirect(
      `/semdoc-signer.html?flow=${encodeURIComponent(flowId)}&token=${encodeURIComponent(signer.token)}&sts_pending=1`
    );

  } catch(e) {
    logger.error({ err: e }, 'STS OAuth callback error');
    return res.redirect(`/semdoc-signer.html?sts_error=${encodeURIComponent('Eroare internă server')}`);
  }
});

// ── GET /flows/:flowId/sts-poll — polling status semnătură STS ────────────
// Apelat de frontend la interval de 3 secunde pentru a verifica aprobarea.
router.get('/flows/:flowId/sts-poll', async (req, res) => {
  try {
    if (requireDb(res)) return;
    const { flowId }    = req.params;
    const signerToken   = req.query.token || req.headers['x-signer-token'];
    if (!signerToken) return res.status(400).json({ error: 'token_required' });

    const data    = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });

    const signers = Array.isArray(data.signers) ? data.signers : [];
    const idx     = signers.findIndex(s => s.token === signerToken);
    if (idx === -1) return res.status(400).json({ error: 'invalid_token' });

    const signer = signers[idx];
    if (!signer.stsPending) return res.json({ status: 'not_pending' });

    const { STSCloudProvider } = await import('../../signing/providers/STSCloudProvider.mjs');
    const provider = new STSCloudProvider();
    const pollResult = await provider.pollSignatureResult(
      signer.stsOpId, signer.stsToken, signer.stsSignUrl);

    if (!pollResult.ready) {
      if (pollResult.error) {
        signers[idx].stsPending = false;
        data.signers = signers; await saveFlow(flowId, data);
        return res.json({ status: 'error', message: pollResult.message });
      }
      return res.json({ status: 'waiting', message: pollResult.message });
    }

    // ✅ Semnătura e disponibilă — finalizăm PDF-ul semnat
    logger.info({ flowId, signerEmail: signer.email }, 'STS: semnătură recepționată — finalizăm PAdES');

    let signedPdfB64;
    const padesPdfB64stored = data[`_padesPdf_${idx}`] || '';
    const signedAttrsHex = data[`_signedAttrs_${idx}`] || '';
    const certPem = signer.stsCertPem || '';
    const certChainPem = Array.isArray(signer.stsCertChain) ? signer.stsCertChain : [];

    try {
      if (hasJavaSigningService()) {
        logger.info({ flowId, signerIdx: idx, chainCerts: certChainPem.length },
          'PAdES poll: finalize prin Java signing service');
        if (!padesPdfB64stored) throw new Error(`padesPdf lipsă în data._padesPdf_${idx}`);
        if (!certPem) throw new Error('Certificatul STS lipsește pentru finalizarea Java PAdES');

        const finalizeRes = await javaFinalizePades({
          preparedPdfBase64: padesPdfB64stored,
          fieldName: `sig_${idx + 1}`,
          signByteBase64: pollResult.signByte,
          certificatePem: certPem,
          certificateChainPem: certChainPem,  // CA intermediar(i) din otherCertificates — fix chain building
          useSignedAttributes: true,
          subFilter: 'ETSI.CAdES.detached',
        });

        if (!finalizeRes?.signedPdfBase64) {
          throw new Error('Java signing service nu a returnat signedPdfBase64');
        }

        signedPdfB64 = finalizeRes.signedPdfBase64;
        logger.info({ flowId, signerEmail: signer.email, pdfSize: Buffer.from(signedPdfB64, 'base64').length },
          'PAdES: PDF semnat QES generat prin Java service');
      } else {
        logger.warn({ flowId, signerIdx: idx }, 'PAdES poll: SIGNING_SERVICE_URL lipsește — fallback local');
        const { injectCms } = await import('../../signing/pades.mjs');
        if (!padesPdfB64stored) throw new Error(`padesPdf lipsă în data._padesPdf_${idx}`);
        const padesPdfBuf = Buffer.from(padesPdfB64stored, 'base64');
        const signedAttrsDer = signedAttrsHex ? Buffer.from(signedAttrsHex, 'hex') : null;
        if (!signedAttrsDer) logger.warn({ flowId, signerIdx: idx }, 'signedAttrsDer lipsă — CMS fără signedAttrs');
        if (!certPem) logger.warn({ flowId, signerIdx: idx }, 'PAdES: cert PEM lipsă');
        const signedPdfBuf = await injectCms(padesPdfBuf, pollResult.signByte, certPem, signedAttrsDer);
        signedPdfB64 = signedPdfBuf.toString('base64');
        logger.info({ flowId, signerEmail: signer.email, pdfSize: signedPdfBuf.length },
          'PAdES: PDF semnat QES generat local (fallback)');
      }
    } catch(padesErr) {
      logger.error({ err: padesErr, flowId }, 'PAdES finalize error — fallback la pdfB64 (cu tabel)');
      signedPdfB64 = (data.pdfB64 || '').includes(',') ? data.pdfB64.split(',')[1] : (data.pdfB64 || '');
    } finally {
      delete data[`_padesPdf_${idx}`];
      delete data[`_signedAttrs_${idx}`];
    }

    // Marcăm semnatarul ca semnat
    signers[idx].stsPending      = false;
    signers[idx].status          = 'signed';
    signers[idx].signedAt        = new Date().toISOString();
    signers[idx].pdfUploaded     = true;
    signers[idx].signingProvider = 'sts-cloud';
    // Curățăm datele PAdES temporare (nu mai sunt necesare)
    delete signers[idx].padesB64;
    // padesRange eliminat din arhitectura @signpdf/signpdf
    signers[idx].signatureMetadata = {
      level: 'QES', provider: 'sts-cloud',
      qualifiedCertificate: true,
      padesEmbedded: true,
    };

    data.signedPdfB64        = signedPdfB64;
    data.signedPdfUploadedAt = new Date().toISOString();
    data.signedPdfUploadedBy = signer.email;
    data.updatedAt           = new Date().toISOString();
    if (!Array.isArray(data.events)) data.events = [];
    const _evNow = new Date().toISOString();
    // SIGNED: înregistrăm semnătura (consistent cu local upload flow)
    data.events.push({ at: _evNow, type: 'SIGNED',
      by: signer.email, order: signer.order, provider: 'sts-cloud' });
    data.events.push({ at: _evNow, type: 'SIGNED_PDF_UPLOADED',
      by: signer.email, order: signer.order, provider: 'sts-cloud', via: 'sts-poll' });

    // Avansăm fluxul
    const currentOrder = Number(signer.order) || 0;
    let nextIdx = -1, bestOrder = Infinity;
    for (let i = 0; i < signers.length; i++) {
      const o = Number(signers[i].order) || 0;
      if (signers[i].status !== 'signed' && o > currentOrder && o < bestOrder) {
        bestOrder = o; nextIdx = i;
      }
    }
    if (nextIdx !== -1) signers.forEach((s, i) => {
      if (s.status !== 'signed') s.status = i === nextIdx ? 'current' : 'pending';
    });
    data.signers = signers;

    const allDone = signers.every(s => s.status === 'signed' && s.pdfUploaded);
    if (allDone) {
      data.completed   = true;
      data.completedAt = new Date().toISOString();
      data.events.push({ at: new Date().toISOString(), type: 'FLOW_COMPLETED', by: 'system' });
    }

    await saveFlow(flowId, data);
    // Invalidăm cache-ul Trust Report — semnătura s-a schimbat
    pool.query('DELETE FROM trust_reports WHERE flow_id=$1', [flowId]).catch(() => {});
    writeAuditEvent({ flowId, orgId: data.orgId, eventType: 'SIGNED_PDF_UPLOADED',
      actorEmail: signer.email, payload: { provider: 'sts-cloud', via: 'sts-poll' } });

    res.json({ status: 'signed', completed: allDone, flowId });

    // Notificări async
    setImmediate(async () => {
      try {
        if (allDone && data.initEmail) {
          await _notify({ userEmail: data.initEmail, flowId, type: 'COMPLETED',
            title: 'Document semnat complet',
            message: `Documentul „${data.docName}" a fost semnat de toți semnatarii.`,
            waParams: { docName: data.docName }, urgent: !!(data.urgent) });
          if (_fireWebhook && data.orgId) _fireWebhook(data.orgId, 'flow.completed', data).catch(() => {});
        }
        const nextSigner = signers.find(s => s.status === 'current' && !s.emailSent);
        if (nextSigner?.email) {
          nextSigner.emailSent  = true;
          nextSigner.notifiedAt = new Date().toISOString();
          await saveFlow(flowId, data);
          await _notify({ userEmail: nextSigner.email, flowId, type: 'YOUR_TURN',
            title: 'Document de semnat',
            message: `Este rândul tău să semnezi documentul „${data.docName}".`,
            waParams: { signerName: nextSigner.name, docName: data.docName,
                        signerToken: nextSigner.token, initName: data.initName,
                        initFunctie: data.initFunctie, institutie: data.institutie,
                        compartiment: data.compartiment }, urgent: !!(data.urgent) });
        }
      } catch(e) { logger.error({ err: e, flowId }, 'STS poll notify error'); }
    });

  } catch(e) {
    logger.error({ err: e }, 'STS poll error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── GET /flows/:flowId/signing-providers ──────────────────────────────────
// Returnează providerii activi în org-ul fluxului, pentru dropdown-ul semnatarului.
// Apelat de signer page la deschidere.
router.get('/flows/:flowId/signing-providers', async (req, res) => {
  try {
    if (requireDb(res)) return;
    const signerToken = req.query.token || req.headers['x-signer-token'] || null;
    if (!signerToken) return res.status(403).json({ error: 'forbidden' });
    const data = await getFlowData(req.params.flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    if (!(data.signers || []).some(s => s.token === signerToken))
      return res.status(403).json({ error: 'forbidden' });

    // Obținem org-ul pentru a citi signing_providers_enabled
    let org = null;
    if (data.orgId) {
      const { rows } = await pool.query(
        'SELECT signing_providers_enabled, signing_providers_config FROM organizations WHERE id=$1',
        [data.orgId]
      );
      org = rows[0] || null;
    }

    const providers = getOrgProviders(org);
    // Preferința semnatarului (dacă e logat și are preferred_signing_provider)
    const signer = (data.signers || []).find(s => s.token === signerToken);
    let preferredProvider = null;
    if (signer?.email) {
      const { rows: uRows } = await pool.query(
        'SELECT preferred_signing_provider FROM users WHERE email=$1',
        [signer.email.toLowerCase()]
      );
      preferredProvider = uRows[0]?.preferred_signing_provider || null;
    }

    res.json({
      providers,
      preferred:  preferredProvider,
      flowType:   data.flowType || 'tabel',
      // Dacă există un singur provider (local-upload) — UI poate sări pasul de selecție
      skipSelection: providers.length === 1 && providers[0].id === 'local-upload',
    });
  } catch(e) { logger.error({ err: e }, 'signing-providers error'); res.status(500).json({ error: 'server_error' }); }
});


// ── POST /flows/:flowId/initiate-cloud-signing ────────────────────────────
// Inițiază o sesiune de semnare cu un provider cloud.
// Returnează URL de redirect la provider.
router.post('/flows/:flowId/initiate-cloud-signing', async (req, res) => {
  try {
    if (requireDb(res)) return;
    const { flowId } = req.params;
    const { token: signerToken, providerId } = req.body || {};
    if (!signerToken) return res.status(400).json({ error: 'token_required' });
    if (!providerId)  return res.status(400).json({ error: 'providerId_required' });

    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    if (data.status === 'cancelled') return res.status(409).json({ error: 'flow_cancelled' });

    const signers = Array.isArray(data.signers) ? data.signers : [];
    const idx     = signers.findIndex(s => s.token === signerToken);
    if (idx === -1) return res.status(400).json({ error: 'invalid_token' });
    if (_isSignerTokenExpired(signers[idx])) return res.status(403).json({ error: 'token_expired' });
    if (signers[idx].status !== 'current') return res.status(409).json({ error: 'not_current_signer' });

    // Verificăm că providerul ales e activ în org
    let org = null;
    if (data.orgId) {
      const { rows } = await pool.query(
        'SELECT signing_providers_enabled, signing_providers_config FROM organizations WHERE id=$1',
        [data.orgId]
      );
      org = rows[0] || null;
    }
    const { getOrgProviderConfig, getOrgProvider } = await import('../../signing/index.mjs');
    const provider = getOrgProvider(org, providerId);
    if (provider.id !== providerId) {
      return res.status(400).json({ error: 'provider_not_available',
        message: `Provider-ul "${providerId}" nu este activ în această organizație.` });
    }

    // ARHITECTURA PAdES INCREMENTAL b233:
    // Semnatar 1: pdfB64 original → unlock → preparePadesDoc (desenează cartuș) → injectCms → revision 1
    // Semnatar 2+: signedPdfB64 (conține cartuș + CMS sem.1) → NU unlock → preparePadesDoc
    //              (adaugă doar placeholder, NU redesenează cartușul) → injectCms → revision 2
    //              pdf-lib.save({useObjectStreams:false}) = incremental update = PAdES cu 2 semnături
    const signedCount = signers.filter((s, i) => i < idx && s.status === 'signed').length;
    const isSubsequentSigner = signedCount > 0 && !!data.signedPdfB64;
    const sourcePdfB64 = isSubsequentSigner ? data.signedPdfB64 : (data.pdfB64 || '');
    const rawPdf = sourcePdfB64.includes(',') ? sourcePdfB64.split(',')[1] : sourcePdfB64;
    if (!rawPdf) return res.status(500).json({ error: 'pdf_missing' });
    let pdfBuf = Buffer.from(rawPdf, 'base64');

    // Unlock DOAR pentru semnatar 1 — pe PDF deja semnat (sem.2+) NU facem unlock
    // (pdf-lib re-save pe un PDF cu CMS binar embedded poate corupe semnătura anterioară)
    if (!isSubsequentSigner && _PDFLib && data.flowType !== 'ancore') {
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
      } catch(e) { logger.warn({ err: e }, 'initiate-cloud-signing: unlock error (non-fatal)'); }
    }

    // ── PAdES: pregătim placeholder + hash (Java service dacă e disponibil) ────
    let pdfBufPades;
    let padesPdfB64;
    let documentDigest;
    let signedAttrsDer;
    let signedAttrsHashB64;

    if (hasJavaSigningService()) {
      try {
        logger.info({ flowId, signerIdx: idx, isSubsequentSigner }, 'PAdES initiate: prepare prin Java signing service');
        const prepareRes = await javaPreparePades({
          pdfBase64: pdfBuf.toString('base64'),
          fieldName: `sig_${idx + 1}`,
          signerName: signers[idx]?.name || signers[idx]?.fullName || 'Semnatar',
          signerRole: signers[idx]?.role || signers[idx]?.atribut || 'SEMNATAR',
          reason: 'Semnare DocFlowAI',
          location: 'Romania',
          contactInfo: signers[idx]?.email || '',
          page: 1,
          x: 100,
          y: 100,
          width: 180,
          height: 50,
          useSignedAttributes: true,
          subFilter: 'ETSI.CAdES.detached',
        });

        if (!prepareRes?.preparedPdfBase64 || !prepareRes?.toBeSignedDigestBase64) {
          throw new Error('Java signing service nu a returnat preparedPdfBase64/toBeSignedDigestBase64');
        }

        padesPdfB64 = prepareRes.preparedPdfBase64;
        pdfBufPades = Buffer.from(padesPdfB64, 'base64');
        documentDigest = prepareRes.documentDigestBase64 || null;
        signedAttrsHashB64 = prepareRes.toBeSignedDigestBase64;
        signedAttrsDer = null; // finalizarea se face în Java service

        logger.info({ flowId, signerIdx: idx, hasDocumentDigest: !!documentDigest,
          signedAttrsHashLen: signedAttrsHashB64.length }, 'PAdES: prepare generat prin Java service');
      } catch (javaErr) {
        logger.error({ err: javaErr, flowId, signerIdx: idx }, 'PAdES initiate: Java service a eșuat — fallback local');
        const { preparePadesDoc, calcPadesHash, buildSignedAttrs, calcSignedAttrsHash } =
          await import('../../signing/pades.mjs');
        pdfBufPades     = await preparePadesDoc(pdfBuf, data, idx, { alwaysDrawCartus: !isSubsequentSigner });
        documentDigest  = calcPadesHash(pdfBufPades);
        padesPdfB64     = pdfBufPades.toString('base64');
        signedAttrsDer  = buildSignedAttrs(documentDigest);
        signedAttrsHashB64 = calcSignedAttrsHash(signedAttrsDer);
        logger.info({ flowId, signerIdx: idx, isSubsequentSigner,
          documentDigestLen: documentDigest.length,
          signedAttrsHashLen: signedAttrsHashB64.length }, 'PAdES: placeholder + signedAttrs generate (fallback local)');
      }
    } else {
      const { preparePadesDoc, calcPadesHash, buildSignedAttrs, calcSignedAttrsHash } =
        await import('../../signing/pades.mjs');
      pdfBufPades     = await preparePadesDoc(pdfBuf, data, idx,
        { alwaysDrawCartus: !isSubsequentSigner });
      documentDigest  = calcPadesHash(pdfBufPades);   // SHA256(bytesOutsideContents)
      padesPdfB64     = pdfBufPades.toString('base64');
      signedAttrsDer     = buildSignedAttrs(documentDigest);
      signedAttrsHashB64 = calcSignedAttrsHash(signedAttrsDer);
      logger.info({ flowId, signerIdx: idx, isSubsequentSigner,
        documentDigestLen: documentDigest.length,
        signedAttrsHashLen: signedAttrsHashB64.length }, 'PAdES: placeholder + signedAttrs generate');
    }

    const providerConfig = getOrgProviderConfig(org, providerId);
    logger.info({
      providerId, orgId: data.orgId,
      hasClientId: !!providerConfig.clientId,
      hasKid: !!providerConfig.kid,
      hasPrivateKey: !!providerConfig.privateKeyPem,
      hasRedirectUri: !!providerConfig.redirectUri,
      padesHashLen: signedAttrsHashB64.length,
    }, 'initiate-cloud-signing: PAdES pregătit');
    const appBaseUrl = process.env.PUBLIC_BASE_URL || 'https://app.docflowai.ro';

    const session = await provider.initiateSession({
      flowId, signer: signers[idx], pdfBytes: pdfBufPades,
      flowData: data, config: providerConfig, appBaseUrl,
      ancoreFieldName: signers[idx].ancoreFieldName || null,
      padesHashBase64: signedAttrsHashB64,  // trimitem SHA256(signedAttrs) la STS
    });

    const signingUrl = await provider.getSigningUrl(session);
    if (!signingUrl) {
      return res.status(400).json({ error: 'no_signing_url',
        message: 'Provider-ul nu a returnat URL de semnare.' });
    }

    // Stocăm sessionId + providerData + PAdES metadata per semnatar
    signers[idx].signingSessionId = session.sessionId;
    signers[idx].signingProvider  = providerId;
    if (session.providerData && Object.keys(session.providerData).length > 0) {
      signers[idx].stsProviderData = session.providerData;
    }
    // Stocăm padesPdf și signedAttrsDer (hex) în JSONB
    data[`_padesPdf_${idx}`] = padesPdfB64;
    if (signedAttrsDer) data[`_signedAttrs_${idx}`] = signedAttrsDer.toString('hex');
    signers[idx].padesHashBase64 = documentDigest || null;  // documentDigest stocat pentru referință
    data.signers  = signers;
    data.updatedAt = new Date().toISOString();
    await saveFlow(flowId, data);

    logger.info({ flowId, providerId, signerEmail: signers[idx].email }, 'Cloud signing session inițiată');
    return res.json({ ok: true, signingUrl, sessionId: session.sessionId, provider: provider.id });
  } catch(e) {
    logger.error({ err: e }, 'initiate-cloud-signing error');
    return res.status(500).json({ error: 'server_error' });
  }
});

// ── POST /flows/:flowId/signing-callback ──────────────────────────────────
// Callback de la providerii cloud după semnare (webhook POST).
// Providerul trimite PDF-ul semnat — DocFlowAI îl acceptă și avansează fluxul.
router.post('/flows/:flowId/signing-callback', async (req, res) => {
  try {
    if (requireDb(res)) return;
    const { flowId }   = req.params;
    const providerId   = req.query.provider || req.body?.provider;
    const sessionId    = req.query.session  || req.body?.sessionId;
    if (!providerId) return res.status(400).json({ error: 'provider_required' });

    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    if (data.status === 'cancelled') return res.status(409).json({ error: 'flow_cancelled' });

    // Obținem configurația provider-ului din org
    let orgConfig = {};
    if (data.orgId) {
      const { rows } = await pool.query(
        'SELECT signing_providers_config FROM organizations WHERE id=$1', [data.orgId]
      );
      orgConfig = rows[0]?.signing_providers_config || {};
    }
    const providerConfig = orgConfig[providerId] || {};
    const provider = getProvider(providerId);

    // Raw body pentru verificare HMAC — dacă middleware-ul l-a capturat îl folosim direct,
    // altfel fallback la JSON.stringify (aproximare — corect 99% dacă body e simplu JSON).
    const rawBody     = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
    const sigHeader   = req.headers['x-docflowai-signature'] || req.headers['x-signature'] || '';

    const result = await provider.handleCallback(req.body, rawBody, sigHeader, providerConfig);
    if (!result.ok) {
      logger.warn({ flowId, providerId, error: result.error }, 'signing-callback: provider a returnat eroare');
      return res.status(400).json({ error: result.error || 'callback_failed' });
    }

    // Găsim semnatarul pe baza signerToken din callback
    const signers = Array.isArray(data.signers) ? data.signers : [];
    const idx = signers.findIndex(s => s.token === result.signerToken);
    if (idx === -1) {
      logger.warn({ flowId, providerId, signerToken: result.signerToken }, 'signing-callback: semnatar negăsit');
      return res.status(400).json({ error: 'signer_not_found' });
    }

    // Acceptăm PDF-ul semnat
    const signedPdfB64 = result.signedPdfBytes
      ? result.signedPdfBytes.toString('base64')
      : null;
    if (!signedPdfB64) return res.status(400).json({ error: 'signed_pdf_missing_in_callback' });

    // Stocăm metadata semnăturii per semnatar
    signers[idx].pdfUploaded      = true;
    signers[idx].uploadVerified   = true;
    signers[idx].signingProvider  = providerId;
    signers[idx].signatureMetadata = result.metadata || {};

    if (!Array.isArray(data.signedPdfVersions)) data.signedPdfVersions = [];
    data.signedPdfVersions.push({
      uploadedAt:  new Date().toISOString(),
      uploadedBy:  signers[idx].email || 'callback',
      signerIndex: idx,
      provider:    providerId,
      via:         'cloud-callback',
    });
    data.signedPdfB64          = signedPdfB64;
    data.signedPdfUploadedAt   = new Date().toISOString();
    data.signedPdfUploadedBy   = signers[idx].email || 'callback';
    data.updatedAt             = new Date().toISOString();
    if (!Array.isArray(data.events)) data.events = [];
    data.events.push({ at: new Date().toISOString(), type: 'SIGNED_PDF_UPLOADED',
                       by: signers[idx].email || 'callback', order: signers[idx].order,
                       provider: providerId, via: 'cloud-callback' });

    // Avansăm fluxul (același cod ca upload-signed-pdf)
    const currentOrder = Number(signers[idx]?.order) || 0;
    let nextIdx = -1, bestOrder = Infinity;
    for (let i = 0; i < signers.length; i++) {
      const o = Number(signers[i].order) || 0;
      if (signers[i].status !== 'signed' && o > currentOrder && o < bestOrder) { bestOrder = o; nextIdx = i; }
    }
    if (nextIdx !== -1) signers.forEach((s, i) => { if (s.status !== 'signed') s.status = i === nextIdx ? 'current' : 'pending'; });
    data.signers = signers;
    const allDone = signers.every(s => s.status === 'signed' && s.pdfUploaded);
    if (allDone) { data.completed = true; data.completedAt = new Date().toISOString();
                   data.events.push({ at: new Date().toISOString(), type: 'FLOW_COMPLETED', by: 'system' }); }
    const nextSigner = signers.find(s => s.status === 'current' && !s.emailSent);
    if (nextSigner) { nextSigner.emailSent = true; nextSigner.notifiedAt = new Date().toISOString(); }
    await saveFlow(flowId, data);
    writeAuditEvent({ flowId, orgId: data.orgId, eventType: 'SIGNED_PDF_UPLOADED',
                      actorEmail: signers[idx].email, actorIp: _getIp(req),
                      payload: { provider: providerId, via: 'cloud-callback' } });
    if (allDone) writeAuditEvent({ flowId, orgId: data.orgId, eventType: 'FLOW_COMPLETED',
                                   actorEmail: 'system', payload: { docName: data.docName } });

    res.json({ ok: true, flowId, completed: allDone });

    // Notificări async (identic cu upload-signed-pdf)
    setImmediate(async () => {
      try {
        if (allDone) {
          await pool.query("DELETE FROM notifications WHERE flow_id=$1 AND type IN ('YOUR_TURN','REMINDER')", [flowId]).catch(() => {});
          if (data.initEmail) await _notify({ userEmail: data.initEmail, flowId, type: 'COMPLETED',
            title: 'Document semnat complet', message: `Documentul „${data.docName}" a fost semnat de toți semnatarii.`,
            waParams: { docName: data.docName }, urgent: !!(data.urgent) });
          if (_fireWebhook && data.orgId) _fireWebhook(data.orgId, 'flow.completed', data).catch(() => {});
        }
        if (nextSigner?.email) await _notify({ userEmail: nextSigner.email, flowId, type: 'YOUR_TURN',
          title: 'Document de semnat', message: `Este rândul tău să semnezi documentul „${data.docName}".`,
          waParams: { signerName: nextSigner.name, docName: data.docName, signerToken: nextSigner.token,
                      initName: data.initName, initFunctie: data.initFunctie, institutie: data.institutie,
                      compartiment: data.compartiment }, urgent: !!(data.urgent) });
      } catch(e) { logger.error({ err: e, flowId }, 'signing-callback notify error'); }
    });
  } catch(e) { logger.error({ err: e }, 'signing-callback error'); res.status(500).json({ error: 'server_error' }); }
});



export default router;
