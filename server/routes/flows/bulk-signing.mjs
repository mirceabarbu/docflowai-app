/**
 * DocFlowAI — flows/bulk-signing.mjs                                b231
 *
 * Semnare în masă — un utilizator semnează N documente cu un singur
 * flux OAuth STS și o singură aprobare email/PUSH.
 *
 * ARHITECTURĂ:
 *   POST /bulk-signing/initiate
 *     → primește [{flowId, signerToken},...], pregătește PAdES per flux,
 *       construiește signedAttrs per flux, inițiază OAuth STS cu PKCE,
 *       returnează { sessionId, signingUrl }
 *
 *   GET  /flows/sts-oauth-callback        (existent — detectează BULK_ prefix în state)
 *     → schimbă code→token, apelează /userinfo, trimite ARRAY de hash-uri la STS,
 *       salvează sesiunea în bulk_signing_sessions, redirect → /bulk-signer.html
 *
 *   GET  /bulk-signing/:sessionId/poll
 *     → apelează STS /api/v1/callback, primește signBytes[], injectează CMS
 *       în fiecare PDF, avansează fiecare flux, returnează status
 *
 *   GET  /bulk-signing/:sessionId/status
 *     → returnează starea curentă a sesiunii (pentru UI)
 */

import { Router }  from 'express';
import crypto       from 'crypto';
import { pool, DB_READY, requireDb, saveFlow, getFlowData, writeAuditEvent }
  from '../../db/index.mjs';
import { logger }  from '../../middleware/logger.mjs';
import { requireAuth } from '../../middleware/auth.mjs';
import { createRateLimiter } from '../../middleware/rateLimiter.mjs';
import { getOrgProviderConfig, getOrgProvider } from '../../signing/index.mjs';

// Deps injectate din flows/index.mjs
let _notify, _fireWebhook, _isSignerTokenExpired;
export function _injectDeps(d) {
  _notify = d.notify;
  _fireWebhook = d.fireWebhook || null;
  _isSignerTokenExpired = d.isSignerTokenExpired;
}

const router = Router();
const _bulkRateLimit = createRateLimiter({ windowMs: 60_000, max: 10,
  message: 'Prea multe cereri bulk. Încearcă în 1 minut.' });

// ── helpers ────────────────────────────────────────────────────────────────
const dns = await import('dns');
dns.setDefaultResultOrder('ipv4first');
const _fetch4 = (url, opts = {}) => fetch(url, opts);

// Recuperam org pentru un flux
async function _getOrg(orgId) {
  if (!orgId) return null;
  const { rows } = await pool.query(
    'SELECT id, signing_providers_enabled, signing_providers_config FROM organizations WHERE id=$1',
    [orgId]
  );
  return rows[0] || null;
}

// Salvam/actualizam sesiunea bulk
async function _saveSession(sessionId, fields) {
  const setClauses = Object.keys(fields).map((k, i) => `${k}=$${i + 2}`).join(', ');
  const values = Object.values(fields);
  await pool.query(
    `UPDATE bulk_signing_sessions SET ${setClauses} WHERE id=$1`,
    [sessionId, ...values]
  );
}

// Cream sesiunea bulk
async function _createSession(data) {
  const { rows } = await pool.query(
    `INSERT INTO bulk_signing_sessions
       (signer_email, org_id, provider_id, status, items, sts_provider_data, expires_at)
     VALUES ($1,$2,$3,'initiated',$4,$5, NOW() + INTERVAL '2 hours')
     RETURNING id`,
    [data.signerEmail, data.orgId || null, data.providerId || 'sts-cloud',
     JSON.stringify(data.items), JSON.stringify(data.stsProviderData || {})]
  );
  return rows[0].id;
}

// Citim sesiunea bulk
async function _getSession(sessionId) {
  const { rows } = await pool.query(
    'SELECT * FROM bulk_signing_sessions WHERE id=$1 AND expires_at > NOW()',
    [sessionId]
  );
  return rows[0] || null;
}

// ── POST /bulk-signing/initiate ────────────────────────────────────────────
// Body: { flows: [{flowId, signerToken}], providerId }
// Răspuns: { sessionId, signingUrl }
router.post('/bulk-signing/initiate', _bulkRateLimit, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { flows: flowRequests, providerId = 'sts-cloud' } = req.body || {};
    if (!Array.isArray(flowRequests) || flowRequests.length === 0)
      return res.status(400).json({ error: 'flows_required', message: 'Specifică cel puțin un flux.' });
    if (flowRequests.length > 20)
      return res.status(400).json({ error: 'too_many_flows', message: 'Maxim 20 fluxuri per sesiune bulk.' });

    const { preparePadesDoc, calcPadesHash }   = await import('../../signing/pades.mjs');
    const { STSCloudProvider }                  = await import('../../signing/providers/STSCloudProvider.mjs');
    const { PDFDocument, PDFName, PDFNumber }   = await import('pdf-lib');

    // Validam și pregătim fiecare flux
    const items = [];
    let orgId = null;
    let org   = null;

    for (const req2 of flowRequests) {
      const { flowId, signerToken } = req2;
      if (!flowId || !signerToken)
        return res.status(400).json({ error: 'invalid_item', message: `flowId și signerToken obligatorii.` });

      const data = await getFlowData(flowId);
      if (!data)
        return res.status(404).json({ error: 'not_found', message: `Flux ${flowId} negăsit.` });
      if (data.status === 'cancelled')
        return res.status(409).json({ error: 'flow_cancelled', message: `Fluxul ${flowId} e anulat.` });

      const signers = Array.isArray(data.signers) ? data.signers : [];
      const idx = signers.findIndex(s => s.token === signerToken);
      if (idx === -1)
        return res.status(400).json({ error: 'invalid_token', message: `Token invalid pentru ${flowId}.` });
      if (_isSignerTokenExpired && _isSignerTokenExpired(signers[idx]))
        return res.status(403).json({ error: 'token_expired', message: `Token expirat pentru ${flowId}.` });
      if (signers[idx].status !== 'current')
        return res.status(409).json({ error: 'not_current', message: `Nu ești semnatar curent în ${flowId}.` });
      if ((signers[idx].email || '').toLowerCase() !== actor.email.toLowerCase())
        return res.status(403).json({ error: 'forbidden', message: `Token nu corespunde utilizatorului logat.` });

      // Org — folosim prima gasita (trebuie sa fie aceeasi in org)
      if (!orgId && data.orgId) { orgId = data.orgId; org = await _getOrg(orgId); }

      // Citim PDF-ul de semnat (semnat de predecesori sau original)
      // ARHITECTURA PAdES INCREMENTAL b233 (bulk):
      // Semnatar 1: pdfB64 original → unlock → cartuș nou
      // Semnatar 2+: signedPdfB64 → NU unlock → doar placeholder (cartuș existent)
      const signedCount = signers.filter((s, i) => i < idx && s.status === 'signed').length;
      const isSubsequentSigner = signedCount > 0 && !!data.signedPdfB64;
      const sourcePdfB64 = isSubsequentSigner ? data.signedPdfB64 : (data.pdfB64 || '');
      const rawPdf = sourcePdfB64.includes(',') ? sourcePdfB64.split(',')[1] : sourcePdfB64;
      if (!rawPdf)
        return res.status(500).json({ error: 'pdf_missing', message: `PDF lipsă pentru ${flowId}.` });
      let pdfBuf = Buffer.from(rawPdf, 'base64');

      // Unlock DOAR pentru semnatar 1
      if (!isSubsequentSigner && data.flowType !== 'ancore') {
        try {
          const pdfDoc = await PDFDocument.load(pdfBuf, { ignoreEncryption: true });
          try { delete pdfDoc.context.trailerInfo.Encrypt; } catch(e2) {}
          try { pdfDoc.catalog.delete(PDFName.of('Perms')); } catch(e2) {}
          try {
            const af = pdfDoc.catalog.get(PDFName.of('AcroForm'));
            if (af) { const afObj = pdfDoc.context.lookup(af); if (afObj?.set) afObj.set(PDFName.of('SigFlags'), PDFNumber.of(1)); }
          } catch(e2) {}
          pdfBuf = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
        } catch(e) { logger.warn({ err: e, flowId }, 'bulk-initiate: unlock non-fatal'); }
      }

      // Pregătim PAdES placeholder
      const pdfBufPades     = await preparePadesDoc(pdfBuf, data, idx,
        { alwaysDrawCartus: !isSubsequentSigner });
      const padesHashBase64 = calcPadesHash(pdfBufPades);  // SHA256(bytesOutsideContents)
      const padesPdfB64     = pdfBufPades.toString('base64');

      // Stocam PDF-ul cu placeholder în flows_pdfs (migration 043 garantează constraint ok)
      const padesKey = `padesPdf_${idx}`;
      await pool.query(
        `INSERT INTO flows_pdfs (flow_id, key, data, updated_at) VALUES ($1,$2,$3,NOW())
         ON CONFLICT (flow_id, key) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()`,
        [flowId, padesKey, padesPdfB64]
      );
      signers[idx].bulkPadesHashBase64 = padesHashBase64;

      data.signers   = signers;
      data.updatedAt = new Date().toISOString();
      await saveFlow(flowId, data);

      items.push({
        flowId,
        signerToken,
        signerIdx:        idx,
        docName:          data.docName || flowId,
        padesHashBase64,  // SHA256(doc)
        bulkPadesKey:     padesKey,
        status:           'pending',
      });
    }

    // Verificam providerul org
    const provider = getOrgProvider(org, providerId);
    if (provider.id !== providerId)
      return res.status(400).json({ error: 'provider_not_available',
        message: `Provider-ul "${providerId}" nu e activ în organizație.` });
    const providerConfig = getOrgProviderConfig(org, providerId);

    // PKCE + state
    const codeVerifier  = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const state         = crypto.randomBytes(24).toString('base64url');
    const nonce         = crypto.randomBytes(24).toString('base64url');

    const idpUrl      = providerConfig.idpUrl  || 'https://idp.stsisp.ro';
    const signUrl     = providerConfig.apiUrl   || 'https://sign.stsisp.ro';
    const clientId    = providerConfig.clientId;
    const redirectUri = providerConfig.redirectUri ||
      `${process.env.PUBLIC_BASE_URL || 'https://app.docflowai.ro'}/flows/sts-oauth-callback`;

    // Cream sesiunea în DB — state-ul include BULK_ prefix pentru detecție în callback
    const sessionId = (await pool.query(
      `INSERT INTO bulk_signing_sessions
         (signer_email, org_id, provider_id, status, items, sts_provider_data, expires_at)
       VALUES ($1,$2,$3,'initiated',$4,$5, NOW() + INTERVAL '2 hours')
       RETURNING id`,
      [actor.email.toLowerCase(), orgId || null, providerId,
       JSON.stringify(items),
       JSON.stringify({ codeVerifier, codeChallenge, state, nonce,
         idpUrl, signUrl, clientId, kid: providerConfig.kid,
         privateKeyPem: providerConfig.privateKeyPem, redirectUri })]
    )).rows[0].id;

    // URL OAuth cu state = BULK_{sessionId}___{randomState}
    const authParams = new URLSearchParams({
      response_type:         'code',
      client_id:             clientId,
      scope:                 'openid profile',
      state:                 `BULK_${sessionId}___${state}`,
      redirect_uri:          redirectUri,
      nonce,
      code_challenge:        codeChallenge,
      code_challenge_method: 'S256',
    });
    const signingUrl = `${idpUrl}/oauth2/authorize?${authParams.toString()}`;

    logger.info({ sessionId, flowCount: items.length, signerEmail: actor.email },
      'bulk-signing: sesiune inițiată');
    return res.json({ ok: true, sessionId, signingUrl, flowCount: items.length });

  } catch(e) {
    logger.error({ err: e }, 'bulk-signing initiate error');
    return res.status(500).json({ error: 'server_error', message: e.message });
  }
});

// ── Procesare bulk callback — apelat din /flows/sts-oauth-callback ─────────
// Exportat pentru a fi utilizat din cloud-signing.mjs
export async function processBulkOAuthCallback(sessionId, query, res) {
  try {
    const session = await _getSession(sessionId);
    if (!session)
      return res.redirect(`/bulk-signer.html?session=${sessionId}&sts_error=${encodeURIComponent('Sesiune expirată')}`);

    const pd      = session.sts_provider_data || {};
    const { code, state: incomingState, error } = query;

    if (error)
      return res.redirect(`/bulk-signer.html?session=${sessionId}&sts_error=${encodeURIComponent(error)}`);
    if (!code)
      return res.redirect(`/bulk-signer.html?session=${sessionId}&sts_error=${encodeURIComponent('Cod OAuth lipsă')}`);

    // Validam state
    const expectedState = `BULK_${sessionId}___${pd.state}`;
    if (incomingState !== expectedState) {
      logger.warn({ sessionId, incomingState, expectedState }, 'bulk-signing: state mismatch');
      return res.redirect(`/bulk-signer.html?session=${sessionId}&sts_error=${encodeURIComponent('State invalid')}`);
    }

    const { STSCloudProvider } = await import('../../signing/providers/STSCloudProvider.mjs');
    const provider = new STSCloudProvider();

    // PASUL 1: code → token
    const clientAssertion = provider._buildClientAssertion(
      pd.clientId, pd.kid, pd.privateKeyPem, pd.idpUrl);
    const tokenResp = await _fetch4(`${pd.idpUrl}/oauth2/token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:            'authorization_code',
        client_id:             pd.clientId,
        code,
        redirect_uri:          pd.redirectUri,
        client_assertion:      clientAssertion,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        code_verifier:         pd.codeVerifier,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!tokenResp.ok) {
      const errText = await tokenResp.text();
      logger.error({ status: tokenResp.status, body: errText.substring(0,300) }, 'bulk STS: token exchange failed');
      return res.redirect(`/bulk-signer.html?session=${sessionId}&sts_error=${encodeURIComponent('Eroare token STS')}`);
    }
    const tokenJson  = await tokenResp.json();
    const accessToken = tokenJson.access_token;
    if (!accessToken)
      return res.redirect(`/bulk-signer.html?session=${sessionId}&sts_error=${encodeURIComponent('Token STS lipsă')}`);

    // PASUL 2: /userinfo pentru certificat (necesar înainte de signedAttrs)
    let certPem = null;
    try {
      const uiResp = await _fetch4(`${pd.idpUrl}/userinfo`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (uiResp.ok) {
        const ui = await uiResp.json();
        certPem = ui?.signingCertificate?.pemCertificate
               || ui?.certificate?.pemCertificate
               || ui?.cert || ui?.pemCertificate || null;
        if (!certPem && Array.isArray(ui?.otherCertificates))
          certPem = ui.otherCertificates[0]?.pemCertificate || null;
        logger.info({ hasCert: !!certPem }, 'bulk STS: cert din /userinfo');
      }
    } catch(e) { logger.warn({ err: e }, 'bulk STS: /userinfo non-fatal'); }

    // PASUL 3: colectam hash-urile SHA256(doc) per flux — trimise direct la STS
    // (identic cu single signing — fara signedAttrs, STS semneaza documentDigest direct)
    const items = Array.isArray(session.items) ? session.items : [];
    const signatureRequests = [];

    for (const item of items) {
      signatureRequests.push({
        id:            item.flowId,   // STS returneaza acest id in signList[].id
        hashByte:      item.padesHashBase64,  // SHA256(bytesOutsideContents)
        algorithmName: 'SHA256',
        docName:       item.docName,
      });
    }

    logger.info({ count: signatureRequests.length, sessionId },
      'bulk STS: trimit array de hash-uri la /api/v1/signature');

    // PASUL 4: trimitem TOATE hash-urile într-un singur request
    const signResp = await _fetch4(`${pd.signUrl}/api/v1/signature`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(signatureRequests),
      signal:  AbortSignal.timeout(15_000),
    });
    const signJson = await signResp.json();
    if (!signResp.ok || signJson.errorCode !== 0) {
      logger.error({ resp: signJson }, 'bulk STS: /api/v1/signature error');
      await _saveSession(sessionId, { status: 'error',
        error_message: signJson.errorMessage || `Eroare STS: ${signJson.errorCode}` });
      return res.redirect(`/bulk-signer.html?session=${sessionId}&sts_error=${encodeURIComponent(signJson.errorMessage || 'Eroare la trimiterea hash-urilor')}`);
    }

    const stsOpId = signJson.id;
    logger.info({ stsOpId, sessionId, count: items.length },
      'bulk STS: hash-uri trimise — așteptăm aprobarea pe email/PUSH');

    // Salvam sesiunea actualizata
    await pool.query(
      `UPDATE bulk_signing_sessions
       SET status='signing_pending', items=$1, sts_op_id=$2, sts_token=$3,
           sts_sign_url=$4, sts_cert_pem=$5
       WHERE id=$6`,
      [JSON.stringify(items), stsOpId, accessToken, pd.signUrl, certPem || null, sessionId]
    );

    return res.redirect(`/bulk-signer.html?session=${sessionId}&sts_pending=1`);

  } catch(e) {
    logger.error({ err: e, sessionId }, 'bulk-signing OAuth callback error');
    return res.redirect(`/bulk-signer.html?session=${sessionId}&sts_error=${encodeURIComponent('Eroare internă server')}`);
  }
}

// ── GET /bulk-signing/:sessionId/status ───────────────────────────────────
router.get('/bulk-signing/:sessionId/status', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const session = await _getSession(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'not_found' });
    if (session.signer_email !== actor.email.toLowerCase())
      return res.status(403).json({ error: 'forbidden' });

    const items = Array.isArray(session.items) ? session.items : [];
    const done  = items.filter(i => i.status === 'signed').length;
    const errors = items.filter(i => i.status === 'error').length;
    return res.json({
      sessionId:  session.id,
      status:     session.status,
      flowCount:  items.length,
      signed:     done,
      errors,
      errorMessage: session.error_message || null,
      items: items.map(i => ({ flowId: i.flowId, docName: i.docName, status: i.status, error: i.error || null })),
    });
  } catch(e) {
    logger.error({ err: e }, 'bulk-signing status error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── GET /bulk-signing/:sessionId/poll ─────────────────────────────────────
// Apelat la fiecare 3s de bulk-signer.html până la completare.
router.get('/bulk-signing/:sessionId/poll', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const session = await _getSession(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'not_found' });
    if (session.signer_email !== actor.email.toLowerCase())
      return res.status(403).json({ error: 'forbidden' });

    if (session.status === 'completed') {
      const _items = Array.isArray(session.items) ? session.items : [];
      const _signed = _items.filter(i => i.status === 'signed').length;
      const _errors = _items.filter(i => i.status === 'error').length;
      return res.json({
        status: 'completed',
        items: _items,
        signed: _signed,
        errors: _errors,
        total: _items.length,
        flowCount: _items.length,
      });
    }
    if (session.status === 'error')
      return res.json({ status: 'error', message: session.error_message });
    if (session.status !== 'signing_pending')
      return res.json({ status: session.status });

    const { STSCloudProvider } = await import('../../signing/providers/STSCloudProvider.mjs');
    const provider = new STSCloudProvider();

    // Poll STS /api/v1/callback
    const pollResult = await provider.pollSignatureResult(
      session.sts_op_id, session.sts_token, session.sts_sign_url
    );

    if (!pollResult.ready) {
      if (pollResult.error) {
        await _saveSession(req.params.sessionId,
          { status: 'error', error_message: pollResult.message || 'Eroare STS polling' });
        return res.json({ status: 'error', message: pollResult.message });
      }
      return res.json({ status: 'waiting', message: pollResult.message });
    }

    // ✅ STS a returnat semnăturile — signList[] cu câte un element per flux trimis
    logger.info({ sessionId: req.params.sessionId, signListLen: (pollResult.signList||[]).length },
      'bulk STS: semnături primite — injectăm CMS în fiecare PDF');

    const { injectCms } = await import('../../signing/pades.mjs');
    const items = Array.isArray(session.items) ? session.items : [];

    // FIX b233: STS returneaza signList[].id = UUID propriu (diferit de item.flowId trimis de noi)
    // Nu putem face map dupa id — luam signByte in ordinea in care am trimis hash-urile.
    // Documentatia STS: "Luăm primul element cu signByte prezent" per solicitare.
    // Pentru bulk: am trimis N hash-uri -> signList are N elemente in aceeasi ordine.
    const signList = pollResult.signList || [];
    logger.info({ signListLen: signList.length, itemsLen: items.length,
      signListIds: signList.map(s=>s.id).slice(0,5) }, 'bulk STS: signList primit');

    const now = new Date().toISOString();
    let allCompleted = true;

    for (const item of items) {
      if (item.status === 'signed') continue;  // deja procesat

      // Luam signByte in ordinea indexului — STS returneaza in aceeasi ordine cu request-ul
      const itemIdx = items.indexOf(item);
      const sigItem = signList[itemIdx];
      const signByte = sigItem?.signByte
        // Fallback: cauta primul semn cu signByte daca ordinea e diferita
        || signList.find(s => s.signByte && !items.slice(0, itemIdx).some((_,i) => signList[i]?.signByte === s.signByte))?.signByte
        || null;
      if (!signByte) {
        item.status = 'error';
        item.error  = `signByte lipsă (sigItem=${JSON.stringify(sigItem)}, idx=${itemIdx})`;
        allCompleted = false;
        logger.warn({ flowId: item.flowId, itemIdx, sigItem }, 'bulk: signByte lipsă');
        continue;
      }

      try {
        // Citim PDF-ul cu placeholder din flows_pdfs
        const { rows: _padesRows } = await pool.query(
          'SELECT data FROM flows_pdfs WHERE flow_id=$1 AND key=$2',
          [item.flowId, item.bulkPadesKey || `padesPdf_${item.signerIdx}`]
        );
        const padesPdfBuf = _padesRows[0]?.data ? Buffer.from(_padesRows[0].data, 'base64') : null;
        if (!padesPdfBuf)
          throw new Error(`PAdES PDF placeholder lipsă în flows_pdfs (key=${item.bulkPadesKey})`);

        const signedPdfBuf = await injectCms(padesPdfBuf, signByte,
          session.sts_cert_pem || null);
        const signedPdfB64 = signedPdfBuf.toString('base64');

        // Curatam placeholder temporar
        // Ștergem placeholder-ul din flows_pdfs
        await pool.query('DELETE FROM flows_pdfs WHERE flow_id=$1 AND key=$2',
          [item.flowId, item.bulkPadesKey || `padesPdf_${item.signerIdx}`]);

        // Actualizam fluxul
        const data    = await getFlowData(item.flowId);
        const signers = Array.isArray(data.signers) ? data.signers : [];
        const idx     = item.signerIdx;

        // Stergem datele temporare bulk din semnatar
        delete signers[idx].bulkPadesHashBase64;
        delete signers[idx].bulkPadesKey;

        signers[idx].status          = 'signed';
        signers[idx].signedAt        = now;
        signers[idx].pdfUploaded     = true;
        signers[idx].signingProvider = 'sts-cloud';
        signers[idx].signatureMetadata = {
          level: 'QES', provider: 'sts-cloud',
          qualifiedCertificate: true, padesEmbedded: true, bulkSigning: true,
        };

        // Avansam fluxul la urmatorul semnatar
        const currentOrder = Number(signers[idx].order) || 0;
        let nextIdx = -1, bestOrder = Infinity;
        for (let i = 0; i < signers.length; i++) {
          const o = Number(signers[i].order) || 0;
          if (signers[i].status !== 'signed' && o > currentOrder && o < bestOrder) {
            bestOrder = o; nextIdx = i;
          }
        }
        if (nextIdx !== -1) {
          signers.forEach((s, i) => {
            if (s.status !== 'signed') s.status = i === nextIdx ? 'current' : 'pending';
          });
        }

        const allDone = signers.every(s => s.status === 'signed' && s.pdfUploaded);

        if (!Array.isArray(data.events)) data.events = [];
        data.events.push({ at: now, type: 'SIGNED', by: signers[idx].email,
          order: signers[idx].order, provider: 'sts-cloud', via: 'bulk-signing' });
        data.events.push({ at: now, type: 'SIGNED_PDF_UPLOADED', by: signers[idx].email,
          order: signers[idx].order, provider: 'sts-cloud', via: 'bulk-signing' });

        data.signers             = signers;
        data.signedPdfB64        = signedPdfB64;
        data.signedPdfUploadedAt = now;
        data.signedPdfUploadedBy = signers[idx].email;
        data.updatedAt           = now;
        if (allDone) {
          data.completed   = true;
          data.completedAt = now;
          data.events.push({ at: now, type: 'FLOW_COMPLETED', by: 'system' });
        }

        await saveFlow(item.flowId, data);
        writeAuditEvent({ flowId: item.flowId, orgId: data.orgId,
          eventType: 'SIGNED_PDF_UPLOADED',
          actorEmail: signers[idx].email,
          payload: { provider: 'sts-cloud', via: 'bulk-signing' } });

        item.status = 'signed';
        logger.info({ flowId: item.flowId }, 'bulk: PDF semnat OK');

        // Notificari async
        setImmediate(async () => {
          try {
            if (allDone && data.initEmail && _notify) {
              await _notify({ userEmail: data.initEmail, flowId: item.flowId,
                type: 'COMPLETED', title: 'Document semnat complet',
                message: `Documentul „${data.docName}" a fost semnat de toți semnatarii.`,
                waParams: { docName: data.docName }, urgent: !!(data.urgent) });
              if (_fireWebhook && data.orgId)
                _fireWebhook(data.orgId, 'flow.completed', data).catch(() => {});
            }
            const nextSigner = signers.find(s => s.status === 'current' && !s.emailSent);
            if (nextSigner?.email && _notify) {
              nextSigner.emailSent  = true;
              nextSigner.notifiedAt = now;
              await saveFlow(item.flowId, data);
              await _notify({ userEmail: nextSigner.email, flowId: item.flowId,
                type: 'YOUR_TURN', title: 'Document de semnat',
                message: `Este rândul tău să semnezi documentul „${data.docName}".`,
                waParams: { signerName: nextSigner.name, docName: data.docName,
                  signerToken: nextSigner.token, initName: data.initName,
                  initFunctie: data.initFunctie, institutie: data.institutie,
                  compartiment: data.compartiment }, urgent: !!(data.urgent) });
            }
          } catch(e) { logger.error({ err: e, flowId: item.flowId }, 'bulk notify error'); }
        });

      } catch(injectErr) {
        logger.error({ err: injectErr, flowId: item.flowId }, 'bulk: inject CMS error');
        item.status = 'error';
        item.error  = injectErr.message;
        allCompleted = false;
      }
    }

    const finalStatus = items.every(i => i.status === 'signed')
      ? 'completed'
      : items.every(i => i.status !== 'pending') ? 'completed' : 'signing_pending';

    await pool.query(
      `UPDATE bulk_signing_sessions SET status=$1, items=$2, completed_at=$3 WHERE id=$4`,
      [finalStatus, JSON.stringify(items),
       finalStatus === 'completed' ? now : null, req.params.sessionId]
    );

    const signed = items.filter(i => i.status === 'signed').length;
    const errors = items.filter(i => i.status === 'error').length;
    return res.json({
      status: finalStatus, signed, errors, total: items.length,
      items: items.map(i => ({ flowId: i.flowId, docName: i.docName,
        status: i.status, error: i.error || null })),
    });

  } catch(e) {
    logger.error({ err: e }, 'bulk-signing poll error');
    res.status(500).json({ error: 'server_error' });
  }
});

export default router;
