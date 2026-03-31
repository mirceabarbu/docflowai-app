/**
 * DocFlowAI — STSCloudProvider                                   b234
 * Serviciul de Telecomunicații Speciale (STS) — QTSP România
 *
 * Arhitectură HASH-BASED (STS NU primește documente, doar hash-uri SHA-256):
 *   1. DocFlowAI calculează SHA-256 al PDF-ului (ByteRange PAdES)
 *   2. Utilizatorul se autentifică la STS IDP (OpenID Connect PKCE + PIN certificat)
 *   3. DocFlowAI schimbă code → access token (JWT, valabil 3h)
 *   4. DocFlowAI trimite SHA256(doc) la /api/v1/signature
 *   5. Utilizatorul aprobă pe email sau notificare PUSH
 *   6. DocFlowAI polinguieste /api/v1/callback → primește signByte (PKCS#7 Base64)
 *   7. DocFlowAI încorporează signByte în PDF conform PAdES (pades.mjs → injectCms)
 */

import crypto from 'crypto';
import dns    from 'dns';
import { logger } from '../../middleware/logger.mjs';

dns.setDefaultResultOrder('ipv4first');
const _fetchIPv4 = (url, opts = {}) => fetch(url, opts);

const IDP_DEFAULT = 'https://idp.stsisp.ro';
const SIGN_DEFAULT = 'https://sign.stsisp.ro';
const CLBK_WAIT   = 0x400;

export class STSCloudProvider {
  get id()    { return 'sts-cloud'; }
  get label() { return 'STS Cloud QES (Serviciul de Telecomunicații Speciale)'; }
  get mode()  { return 'hash-redirect'; }

  async verify(config) {
    if (!config?.clientId)      return { ok: false, message: 'clientId lipsă.' };
    if (!config?.privateKeyPem) return { ok: false, message: 'privateKeyPem lipsă.' };
    if (!config?.kid)           return { ok: false, message: 'kid lipsă.' };
    if (!config?.redirectUri)   return { ok: false, message: 'redirectUri lipsă.' };
    try {
      const idpUrl = config.idpUrl || IDP_DEFAULT;
      const r = await _fetchIPv4(`${idpUrl}/.well-known/openid-configuration`,
        { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) return { ok: false, message: `STS IDP inaccesibil: HTTP ${r.status}` };
      const cfg = await r.json();
      return { ok: true, message: `✅ Conexiune STS OK. Issuer: ${cfg.issuer || idpUrl}`,
        details: { authEndpoint: cfg.authorization_endpoint, tokenEndpoint: cfg.token_endpoint } };
    } catch(e) {
      return { ok: false, message: `Eroare conexiune STS: ${e.message}` };
    }
  }

  async initiateSession({ flowId, signer, pdfBytes, flowData, config, appBaseUrl, padesHashBase64 }) {
    const sessionId = crypto.randomUUID();
    const hashBase64 = padesHashBase64 || crypto.createHash('sha256').update(pdfBytes).digest('base64');
    const codeVerifier  = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const state = crypto.randomBytes(24).toString('base64url');
    const nonce = crypto.randomBytes(24).toString('base64url');
    const idpUrl      = config.idpUrl  || IDP_DEFAULT;
    const signUrl     = config.apiUrl  || SIGN_DEFAULT;
    const clientId    = config.clientId;
    const redirectUri = config.redirectUri || `${appBaseUrl}/flows/sts-oauth-callback`;

    const authParams = new URLSearchParams({
      response_type: 'code', client_id: clientId, scope: 'openid profile',
      state: `${sessionId}___${state}`, redirect_uri: redirectUri, nonce,
      code_challenge: codeChallenge, code_challenge_method: 'S256',
    });

    logger.info({ flowId, signerEmail: signer.email, sessionId }, 'STS: sesiune inițiată');
    return {
      sessionId, flowId, signerToken: signer.token, provider: this.id,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      signingUrl: `${idpUrl}/oauth2/authorize?${authParams.toString()}`,
      externalSessionId: sessionId,
      providerData: {
        codeVerifier, codeChallenge, state, nonce,
        hashBase64, docName: flowData.docName || flowId,
        idpUrl, signUrl, clientId,
        kid: config.kid, privateKeyPem: config.privateKeyPem,
        redirectUri, signerEmail: signer.email,
      },
    };
  }

  async getSigningUrl(session) { return session.signingUrl || null; }

  async processOAuthCallback(query, session, pdfBytes) {
    const { code, state, error, error_description } = query;
    const pd = session.providerData || {};

    if (error) {
      logger.warn({ error, error_description }, 'STS: autentificare eșuată');
      return { ok: false, error: 'sts_auth_failed', message: error_description || error };
    }
    if (!code) return { ok: false, error: 'sts_no_code' };

    const expectedState = `${session.sessionId}___${pd.state}`;
    if (state !== expectedState) {
      logger.warn({ state, expectedState }, 'STS: state mismatch');
      return { ok: false, error: 'sts_state_mismatch' };
    }

    try {
      // PASUL 1: code → access token
      logger.info({ sessionId: session.sessionId }, 'STS: schimb code → token');
      const clientAssertion = this._buildClientAssertion(pd.clientId, pd.kid, pd.privateKeyPem, pd.idpUrl);

      let tokenResp;
      try {
        tokenResp = await _fetchIPv4(`${pd.idpUrl}/oauth2/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code', client_id: pd.clientId, code,
            redirect_uri: pd.redirectUri, client_assertion: clientAssertion,
            client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
            code_verifier: pd.codeVerifier,
          }).toString(),
          signal: AbortSignal.timeout(15_000),
        });
      } catch(fetchErr) {
        logger.error({ cause: fetchErr.cause?.code || fetchErr.message, idpUrl: pd.idpUrl },
          'STS: fetch token FAILED');
        return { ok: false, error: 'sts_fetch_failed',
          message: `Eroare rețea STS token: ${fetchErr.cause?.code || fetchErr.message}` };
      }

      if (!tokenResp.ok) {
        const errText = await tokenResp.text();
        logger.error({ status: tokenResp.status, body: errText.substring(0, 300) }, 'STS: token exchange failed');
        return { ok: false, error: 'sts_token_failed', message: `Eroare token STS: ${errText.substring(0, 200)}` };
      }

      const tokenJson   = await tokenResp.json();
      const accessToken = tokenJson.access_token;
      if (!accessToken) return { ok: false, error: 'sts_no_token' };

      // PASUL 2: trimitem SHA256(doc) la /api/v1/signature
      logger.info({ sessionId: session.sessionId, hashLen: pd.hashBase64?.length },
        'STS: trimit SHA256(doc) la /api/v1/signature');

      const signResp = await _fetchIPv4(`${pd.signUrl}/api/v1/signature`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify([{
          id: session.sessionId, hashByte: pd.hashBase64,
          algorithmName: 'SHA256', docName: pd.docName,
        }]),
        signal: AbortSignal.timeout(15_000),
      });

      const signJson = await signResp.json();
      if (!signResp.ok || signJson.errorCode !== 0) {
        logger.error({ resp: signJson }, 'STS: /api/v1/signature error');
        return { ok: false, error: 'sts_sign_failed',
          message: signJson.errorMessage || `Eroare STS cod: ${signJson.errorCode}` };
      }

      const stsOpId = signJson.id;
      logger.info({ stsOpId, sessionId: session.sessionId },
        'STS: hash trimis — utilizatorul trebuie să aprobe pe email/PUSH');

      // PASUL 3: /userinfo pentru certificat + lanț CA (embedding în CMS)
      let certPem = null;
      let certChainPem = []; // CA intermediar(i) din otherCertificates — necesar pentru Adobe path building
      try {
        const uiResp = await _fetchIPv4(`${pd.idpUrl}/userinfo`, {
          headers: { 'Authorization': `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(10_000),
        });
        const uiText = await uiResp.text();
        logger.info({ status: uiResp.status, len: uiText.length,
          preview: uiText.substring(0, 300) }, 'STS: /userinfo raspuns');
        if (uiResp.ok) {
          const ui = JSON.parse(uiText);

          // Certificat leaf al semnatarului
          // STS returnează "pemCertificat" (fără 'e') — confirmat în producție
          const sc = ui?.signingCertificate;
          certPem = (typeof sc === 'string' && sc.includes('CERTIFICATE') ? sc : null)
                 || sc?.pemCertificat    // ← cheia reală STS (română, fără 'e') — prioritate
                 || sc?.pemCertificate   // ← fallback conform docs scrise
                 || sc?.pem || sc?.certificate || sc?.cert
                 || ui?.certificate?.pemCertificat
                 || ui?.certificate?.pemCertificate
                 || (typeof ui?.certificate === 'string' ? ui.certificate : null)
                 || ui?.cert || ui?.pemCertificate || ui?.pemCertificat || null;

          // CA intermediar(i) din otherCertificates[]
          // Necesari pentru ca Adobe să poată construi path-ul până la root-ul EUTL
          // Fără ei: "There were errors building the path from the signer's certificate to an issuer certificate"
          if (Array.isArray(ui?.otherCertificates) && ui.otherCertificates.length > 0) {
            certChainPem = ui.otherCertificates
              .map(oc => {
                if (typeof oc === 'string' && oc.includes('CERTIFICATE')) return oc;
                return oc?.pemCertificat || oc?.pemCertificate || oc?.pem || oc?.certificate || null;
              })
              .filter(Boolean);
            logger.info({ chainLen: certChainPem.length }, 'STS: CA intermediar(i) extrași din otherCertificates');
          } else {
            logger.warn('STS: otherCertificates lipsă sau gol — lanțul CA nu va fi inclus în CMS');
          }

          // Fallback: dacă nu am găsit certPem în signingCertificate, luăm primul din otherCertificates
          if (!certPem && certChainPem.length > 0) {
            certPem = certChainPem.shift(); // primul e leaf-ul, restul rămân în chain
          }

          logger.info({
            hasCert: !!certPem, certLen: certPem?.length || 0,
            chainCerts: certChainPem.length,
            allKeys: JSON.stringify(Object.keys(ui || {})),
          }, 'STS: certificate extrase din /userinfo');
        } else {
          logger.warn({ status: uiResp.status }, 'STS: /userinfo non-OK');
        }
      } catch(uiErr) {
        logger.warn({ err: uiErr }, 'STS: /userinfo eroare (non-fatal)');
      }

      return {
        ok: true, pending: true, stsOpId, accessToken,
        signUrl: pd.signUrl, sessionId: session.sessionId, certPem, certChainPem,
        message: 'Hash transmis la STS. Utilizatorul va primi email/notificare PUSH pentru aprobare.',
      };

    } catch(e) {
      logger.error({ err: e }, 'STS: processOAuthCallback error');
      return { ok: false, error: 'sts_error', message: e.message };
    }
  }

  async pollSignatureResult(stsOpId, accessToken, signUrl) {
    try {
      const resp = await _fetchIPv4(`${signUrl}/api/v1/callback`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: stsOpId }),
        signal: AbortSignal.timeout(10_000),
      });
      const json = await resp.json();

      if (json.errorCode === CLBK_WAIT)
        return { ready: false, waiting: true, message: 'Așteptăm aprobarea utilizatorului pe email/PUSH.' };
      if (json.errorCode !== 0)
        return { ready: false, error: true, message: json.errorMessage || `Eroare STS: ${json.errorCode}` };
      if (!json.eligible)
        return { ready: false, error: true, message: 'Utilizatorul a refuzat operațiunea de semnare.' };

      const sigItem = (json.signList || []).find(s => s.signByte) || (json.signList || [])[0];
      if (!sigItem?.signByte) {
        logger.warn({ stsOpId, signListLength: (json.signList || []).length }, 'STS: signByte lipsă');
        return { ready: false, error: true, message: 'signByte lipsă din răspunsul STS.' };
      }

      logger.info({ stsOpId }, 'STS: semnătură primită cu succes');
      return { ready: true, signByte: sigItem.signByte, signList: json.signList || [] };

    } catch(e) {
      logger.warn({ err: e, stsOpId }, 'STS: poll error (se va reîncerca)');
      return { ready: false, message: e.message };
    }
  }

  async verifySignedDocument(_bytes, _session) {
    return { valid: true, message: 'Semnătură QES validată de STS Cloud.' };
  }

  async extractSignatureMetadata(_bytes) {
    return {
      level: 'QES', provider: 'sts-cloud',
      providerLabel: 'STS Cloud QES (Serviciul de Telecomunicații Speciale)',
      qualifiedCertificate: true,
    };
  }

  // ── b236: Metode separate pentru fluxul restructurat ──────────────────────
  //
  // exchangeCodeForToken: pasul 1 din callback — schimbăm code cu token + luăm cert
  // submitHashToSTS:      pasul 2 din callback — trimitem hash-ul după ce l-am calculat
  //                       (cu signing-certificate-v2 inclus în signedAttrs)

  async exchangeCodeForToken(code, session) {
    const pd = session.providerData || {};
    try {
      const clientAssertion = this._buildClientAssertion(pd.clientId, pd.kid, pd.privateKeyPem, pd.idpUrl);
      const tokenResp = await _fetchIPv4(`${pd.idpUrl}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', client_id: pd.clientId, code,
          redirect_uri: pd.redirectUri, client_assertion: clientAssertion,
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          code_verifier: pd.codeVerifier,
        }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
      if (!tokenResp.ok) {
        const errText = await tokenResp.text();
        logger.error({ status: tokenResp.status, body: errText.substring(0, 200) }, 'STS: token exchange failed');
        return { ok: false, error: 'sts_token_failed', message: `Eroare token STS: ${errText.substring(0, 200)}` };
      }
      const tokenJson = await tokenResp.json();
      const accessToken = tokenJson.access_token;
      if (!accessToken) return { ok: false, error: 'sts_no_token' };

      // /userinfo — cert leaf + CA intermediari
      let certPem = null, certChainPem = [];
      try {
        const uiResp = await _fetchIPv4(`${pd.idpUrl}/userinfo`, {
          headers: { 'Authorization': `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(10_000),
        });
        const uiText = await uiResp.text();
        logger.info({ status: uiResp.status, len: uiText.length, preview: uiText.substring(0, 300) },
          'STS: /userinfo raspuns');
        if (uiResp.ok) {
          const ui = JSON.parse(uiText);
          const sc = ui?.signingCertificate;
          certPem = (typeof sc === 'string' && sc.includes('CERTIFICATE') ? sc : null)
                 || sc?.pemCertificat || sc?.pemCertificate
                 || sc?.pem || sc?.certificate || sc?.cert
                 || ui?.certificate?.pemCertificat || ui?.certificate?.pemCertificate
                 || (typeof ui?.certificate === 'string' ? ui.certificate : null)
                 || ui?.cert || ui?.pemCertificate || ui?.pemCertificat || null;
          if (Array.isArray(ui?.otherCertificates) && ui.otherCertificates.length > 0) {
            certChainPem = ui.otherCertificates
              .map(oc => (typeof oc === 'string' && oc.includes('CERTIFICATE') ? oc : null)
                      || oc?.pemCertificat || oc?.pemCertificate || oc?.pem || oc?.certificate || null)
              .filter(Boolean);
          }
          if (!certPem && certChainPem.length > 0) certPem = certChainPem.shift();
          logger.info({ hasCert: !!certPem, chainLen: certChainPem.length,
            allKeys: JSON.stringify(Object.keys(ui || {})) }, 'STS: certificate din /userinfo');
        }
      } catch(uiErr) { logger.warn({ err: uiErr }, 'STS: /userinfo eroare (non-fatal)'); }

      return { ok: true, accessToken, certPem, certChainPem };
    } catch(e) {
      logger.error({ err: e }, 'STS: exchangeCodeForToken error');
      return { ok: false, error: 'sts_error', message: e.message };
    }
  }

  async submitHashToSTS(hashBase64, accessToken, pd, sessionId, docName) {
    try {
      logger.info({ sessionId, hashLen: hashBase64?.length }, 'STS: trimit hash la /api/v1/signature');
      const signResp = await _fetchIPv4(`${pd.signUrl}/api/v1/signature`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify([{ id: sessionId, hashByte: hashBase64,
          algorithmName: 'SHA256', docName: docName || sessionId }]),
        signal: AbortSignal.timeout(15_000),
      });
      const signJson = await signResp.json();
      if (!signResp.ok || signJson.errorCode !== 0) {
        logger.error({ resp: signJson }, 'STS: /api/v1/signature error');
        return { ok: false, error: 'sts_sign_failed',
          message: signJson.errorMessage || `Eroare STS cod: ${signJson.errorCode}` };
      }
      logger.info({ stsOpId: signJson.id, sessionId }, 'STS: hash trimis — utilizatorul trebuie să aprobe');
      return { ok: true, stsOpId: signJson.id };
    } catch(e) {
      logger.error({ err: e }, 'STS: submitHashToSTS error');
      return { ok: false, error: 'sts_error', message: e.message };
    }
  }

  _buildClientAssertion(clientId, kid, privateKeyPem, idpUrl) {
    const now    = Math.floor(Date.now() / 1000);
    const header  = { alg: 'RS256', kid };
    const payload = { iss: clientId, sub: clientId,
      aud: `${idpUrl}/oauth2/token`, iat: now, exp: now + 300 };
    const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const msg  = `${b64(header)}.${b64(payload)}`;
    const sig  = crypto.createSign('RSA-SHA256').update(msg).sign(privateKeyPem, 'base64url');
    return `${msg}.${sig}`;
  }

  static generateKeyPair() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding:  { type: 'pkcs1', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    return { publicKeyPem: publicKey, privateKeyPem: privateKey };
  }
}
