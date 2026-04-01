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

function extractCertCommonName(certPem) {
  try {
    if (!certPem) return '';
    const cert = new crypto.X509Certificate(certPem);
    const m = /(?:^|,)\s*CN=([^,]+)/.exec(cert.subject || '');
    return m?.[1]?.trim() || '';
  } catch {
    return '';
  }
}


import { getOrgProviders, getOrgProviderConfig, getProvider } from '../../signing/index.mjs';
import { javaPreparePades, javaFinalizePades, hasJavaSigningService } from '../../signing/java-pades-client.mjs';


// ── GET /flows/sts-oauth-callback — callback OAuth2 de la STS IDP ─────────
// b236: fluxul restructurat — Java prepare se face AICI, cu cert cunoscut:
//   1. exchangeCodeForToken → access token + cert din /userinfo
//   2. Java prepare CU cert → signedAttrs cu signing-certificate-v2 (RFC 5035)
//   3. submitHashToSTS cu noul hash → STS primește hash corect legat de cert
router.get('/flows/sts-oauth-callback', async (req, res) => {
  try {
    if (requireDb(res)) return;
    const { code, state, error } = req.query;

    const sessionId = state?.split('___')[0];
    if (!sessionId) {
      return res.redirect(`/semdoc-signer.html?sts_error=${encodeURIComponent('State invalid')}`);
    }

    // b231: sesiune bulk — delegăm nemodificat
    if (sessionId.startsWith('BULK_')) {
      const bulkSessionId = sessionId.replace('BULK_', '');
      const { processBulkOAuthCallback } = await import('./bulk-signing.mjs');
      return processBulkOAuthCallback(bulkSessionId, req.query, res);
    }

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
    const data = await getFlowData(flowId);
    if (!data) return res.redirect(`/semdoc-signer.html?sts_error=${encodeURIComponent('Flux negăsit')}`);

    const signers = Array.isArray(data.signers) ? data.signers : [];
    const signerIdx = signers.findIndex(s => s.signingSessionId === sessionId);
    if (signerIdx === -1) return res.redirect(`/semdoc-signer.html?sts_error=${encodeURIComponent('Semnatar negăsit')}`);

    const signer = signers[signerIdx];
    const pd = signer.stsProviderData || {};
    const errRedirect = (msg) =>
      res.redirect(`/semdoc-signer.html?flow=${encodeURIComponent(flowId)}&token=${encodeURIComponent(signer.token)}&sts_error=${encodeURIComponent(msg)}`);

    if (error) return errRedirect(req.query.error_description || error);
    if (!code)  return errRedirect('Cod OAuth lipsă');

    const expectedState = `${sessionId}___${pd.state}`;
    if (state !== expectedState) {
      logger.warn({ state, expectedState }, 'STS: state mismatch');
      return errRedirect('State OAuth invalid');
    }

    const { STSCloudProvider } = await import('../../signing/providers/STSCloudProvider.mjs');
    const provider = new STSCloudProvider();
    const session = { sessionId, flowId, signerToken: signer.token, provider: 'sts-cloud', providerData: pd };

    // ── PASUL 1: code → access token + cert din /userinfo ─────────────────────
    const tokenResult = await provider.exchangeCodeForToken(code, session);
    if (!tokenResult.ok) return errRedirect(tokenResult.message || 'Eroare token STS');
    const { accessToken, certPem, certChainPem } = tokenResult;

    // ── PASUL 2: Java prepare CU cert → signing-certificate-v2 în signedAttrs ──
    // PDF-ul pregătit (unlock aplicat) a fost salvat la initiate în _rawPdf_${signerIdx}
    let padesPdfB64, signedAttrsHashB64;
    const rawPdfB64stored = data[`_rawPdf_${signerIdx}`] || '';
    if (!rawPdfB64stored) {
      logger.warn({ flowId, signerIdx }, 'STS callback: _rawPdf lipsă — folosim pdfB64 curent');
    }
    let sourcePdfB64 = rawPdfB64stored || '';
    if (!sourcePdfB64) {
      const alreadySignedBeforeThisSigner = signers
        .slice(0, signerIdx)
        .some(s => s.status === 'signed');
      sourcePdfB64 = alreadySignedBeforeThisSigner
        ? (data.signedPdfB64 || '')
        : (data.pdfB64 || '');
    }
    const rawPdf = sourcePdfB64.includes(',') ? sourcePdfB64.split(',')[1] : sourcePdfB64;
    if (!rawPdf) return errRedirect('PDF lipsă în flux');

    if (hasJavaSigningService()) {
      try {
        // b243: Java creează câmpul /Sig FRESH în zona de semnătură din cartuș
        // Coordonatele celulei sunt în signer.padesRect (setat la creare flux de stampFooterOnPdf)
        // Fiecare revizie iText conține NUMAI obiectele proprii → sig_1 rămâne validă
        const rect = signer?.padesRect;
        const fieldName = `sig_${signerIdx + 1}`;
        const sigPage = rect?.page || 1;
        const sigX    = typeof rect?.x === 'number' ? rect.x : (30 + (signerIdx % 3) * 190);
        const sigY    = typeof rect?.y === 'number' ? rect.y : (30 + Math.floor(signerIdx / 3) * 70);
        const sigW    = typeof rect?.w === 'number' ? rect.w : 180;
        const sigH2   = typeof rect?.h === 'number' ? rect.h : 50;

        logger.info({ flowId, signerIdx, fieldName, hasRect: !!rect,
          page: sigPage, x: sigX, y: sigY, w: sigW, h: sigH2 },
          'STS callback: Java prepare — câmp NOU în celula cartuș');

        const prepareRes = await javaPreparePades({
          pdfBase64: rawPdf,
          fieldName,
          signerName: extractCertCommonName(certPem) || signer?.name || signer?.fullName || 'Semnatar',
          signerRole: signer?.rol || signer?.role || signer?.atribut || 'SEMNATAR',
          reason: 'Semnare DocFlowAI',
          location: 'Romania',
          contactInfo: signer?.email || '',
          page: sigPage, x: sigX, y: sigY, width: sigW, height: sigH2,
          useSignedAttributes: true,
          subFilter: 'ETSI.CAdES.detached',
          signerCertificatePem: certPem || null,
          signerIndex: signerIdx,
          fieldAlreadyExists: false,  // b243: câmp NOU, nu pre-creat
        });
        if (!prepareRes?.preparedPdfBase64 || !prepareRes?.toBeSignedDigestBase64) {
          throw new Error('Java prepare: câmpuri lipsă în răspuns');
        }
        padesPdfB64        = prepareRes.preparedPdfBase64;
        signedAttrsHashB64 = prepareRes.toBeSignedDigestBase64;
        logger.info({ flowId, signerIdx }, 'STS callback: Java prepare OK');
      } catch (prepErr) {
        logger.error({ err: prepErr, flowId, signerIdx }, 'STS callback: Java prepare eșuat');
        return errRedirect('Eroare pregătire document PAdES');
      }
    } else {
      // Fallback: SIGNING_SERVICE_URL nedisponibil
      // b242: Nu mai folosim preparePadesDoc care redesenează cartușul.
      // Returnam eroare — fără Java service arhitectura multi-semnatar nu poate fi garantată.
      logger.error({ flowId, signerIdx }, 'STS callback: SIGNING_SERVICE_URL lipsește — imposibil fără Java service');
      return errRedirect('Serviciul de semnare nu este disponibil. Contactați administratorul.');
    }

    // PDF pregătit e gata — curățăm rawPdf temporar și salvăm cel nou
    delete data[`_rawPdf_${signerIdx}`];
    data[`_padesPdf_${signerIdx}`] = padesPdfB64;

    // ── PASUL 3: trimitem hash-ul (cu signing-cert-v2) la STS ─────────────────
    const submitResult = await provider.submitHashToSTS(
      signedAttrsHashB64, accessToken, pd, sessionId, data.docName || flowId
    );
    if (!submitResult.ok) return errRedirect(submitResult.message || 'Eroare trimitere hash la STS');

    signers[signerIdx].stsOpId      = submitResult.stsOpId;
    signers[signerIdx].stsToken     = accessToken;
    signers[signerIdx].stsSignUrl   = pd.signUrl;
    signers[signerIdx].stsPending   = true;
    signers[signerIdx].stsCertPem   = certPem || null;
    signers[signerIdx].stsCertChain = certChainPem || [];
    data.signers   = signers;
    data.updatedAt = new Date().toISOString();
    await saveFlow(flowId, data);

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
          certificateChainPem: certChainPem,
          useSignedAttributes: true,
          subFilter: 'ETSI.CAdES.detached',
          tsaUrl: null,  // b236: Java service folosește TSA_URL din config (DigiCert default)
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

    // b236: ARHITECTURA RESTRUCTURATĂ — prepare mutat la OAuth callback (când avem cert)
    // initiate-cloud-signing face DOAR:
    //   1. Unlock PDF (dacă e primul semnatar)
    //   2. Salvează PDF-ul pregătit în _rawPdf_${idx} (fără placeholder PAdES)
    //   3. Construiește sesiunea OAuth PKCE și returnează URL redirect
    // Java prepare + hash STS se fac la OAuth callback după ce avem cert din /userinfo.
    const signedCount = signers.filter((s, i) => i < idx && s.status === 'signed').length;
    const isSubsequentSigner = signedCount > 0;

    if (isSubsequentSigner && !data.signedPdfB64) {
      logger.error({ flowId, signerIdx: idx }, 'initiate-cloud-signing: subsequent signer but signedPdfB64 missing');
      return res.status(409).json({
        error: 'signed_pdf_missing_for_subsequent_signer',
        message: 'PDF-ul semnat anterior lipsește. Fluxul nu poate continua în siguranță.',
      });
    }

    const sourcePdfB64 = isSubsequentSigner
      ? data.signedPdfB64
      : (data.pdfB64 || '');
    const rawPdfStr = sourcePdfB64.includes(',') ? sourcePdfB64.split(',')[1] : sourcePdfB64;
    if (!rawPdfStr) return res.status(500).json({ error: 'pdf_missing' });
    let pdfBuf = Buffer.from(rawPdfStr, 'base64');

    // b242: Unlock ELIMINAT — pdf-lib.save() corupe SigFlags=3 și câmpurile /Sig pre-create
    // stampFooterOnPdf a setat deja SigFlags=3 și a salvat cu useObjectStreams:false
    // Java signExternalContainer face append pur fără re-save pdf-lib
    // NICIO modificare pdf-lib după creare flux

    // Salvăm PDF-ul (unlock aplicat, fără placeholder) — va fi folosit la OAuth callback
    data[`_rawPdf_${idx}`] = pdfBuf.toString('base64');

    const providerConfig = getOrgProviderConfig(org, providerId);
    logger.info({
      providerId, orgId: data.orgId, isSubsequentSigner,
      hasClientId: !!providerConfig.clientId,
      hasKid: !!providerConfig.kid,
      hasPrivateKey: !!providerConfig.privateKeyPem,
      hasRedirectUri: !!providerConfig.redirectUri,
    }, 'initiate-cloud-signing b236: PDF pregătit, construim sesiune OAuth');
    const appBaseUrl = process.env.PUBLIC_BASE_URL || 'https://app.docflowai.ro';

    // initiateSession construiește PKCE + URL OAuth (fără hash — nu îl avem încă)
    const session = await provider.initiateSession({
      flowId, signer: signers[idx], pdfBytes: pdfBuf,
      flowData: data, config: providerConfig, appBaseUrl,
      ancoreFieldName: signers[idx].ancoreFieldName || null,
      padesHashBase64: null,  // b236: hash calculat la OAuth callback după cert
    });

    const signingUrl = await provider.getSigningUrl(session);
    if (!signingUrl) {
      return res.status(400).json({ error: 'no_signing_url',
        message: 'Provider-ul nu a returnat URL de semnare.' });
    }

    signers[idx].signingSessionId = session.sessionId;
    signers[idx].signingProvider  = providerId;
    if (session.providerData && Object.keys(session.providerData).length > 0) {
      signers[idx].stsProviderData = session.providerData;
    }
    data.signers  = signers;
    data.updatedAt = new Date().toISOString();
    await saveFlow(flowId, data);

    logger.info({ flowId, providerId, signerEmail: signers[idx].email }, 'Cloud signing session inițiată (b236)');
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
