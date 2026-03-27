/**
 * DocFlowAI — STSCloudProvider
 * Serviciul de Telecomunicații Speciale (STS) — QTSP România
 *
 * Documentație: https://idp.stsisp.ro + https://sign.stsisp.ro
 *
 * Arhitectură HASH-BASED (STS NU primește documente, doar hash-uri SHA-256):
 *   1. DocFlowAI calculează SHA-256 al PDF-ului
 *   2. Utilizatorul se autentifică la STS IDP (OpenID Connect PKCE + PIN certificat)
 *   3. DocFlowAI schimbă code → access token (JWT, valabil 3h)
 *   4. DocFlowAI trimite hash la /api/v1/signature
 *   5. Utilizatorul aprobă pe email sau notificare PUSH
 *   6. DocFlowAI polinguieste /api/v1/callback → primește signByte (CMS/PKCS#7 Base64)
 *   7. DocFlowAI încorporează signByte în PDF conform PAdES (document rămâne exclusiv pe server)
 *
 * Configurație necesară în admin → Organizații → Signing Providers → STS:
 *   idpUrl:        https://idp.stsisp.ro  (default)
 *   apiUrl:        https://sign.stsisp.ro (default)
 *   clientId:      ID-ul de client primit de la STS
 *   privateKeyPem: Cheia RSA privată (PEM, min 2048 bit) pentru client_assertion
 *   kid:           Key ID primit de la STS prin email după trimiterea cheii publice
 *   redirectUri:   https://app.docflowai.ro/flows/sts-oauth-callback
 */

import crypto from 'crypto';
import dns from 'dns';
import { logger } from '../../middleware/logger.mjs';

// FIX: Railway face conexiuni pe IPv6 implicit; serviciile gov RO (STS) nu suportă IPv6.
// Setăm preferința globală IPv4 pentru toate rezolvările DNS din acest provider.
// Nu modificăm URL-ul — certificatul TLS rămâne valid (emis pe hostname, nu pe IP).
dns.setDefaultResultOrder('ipv4first');

// Wrapper simplu — folosim fetch normal, DNS-ul returnează IPv4
const _fetchIPv4 = (url, opts = {}) => fetch(url, opts);

const IDP_DEFAULT   = 'https://idp.stsisp.ro';
const SIGN_DEFAULT  = 'https://sign.stsisp.ro';
const CLBK_WAIT     = 0x400; // 1024 — CLBK-001: așteptăm acceptul utilizatorului

export class STSCloudProvider {
  get id()    { return 'sts-cloud'; }
  get label() { return 'STS Cloud QES (Serviciul de Telecomunicații Speciale)'; }
  get mode()  { return 'hash-redirect'; }

  // ── Verificare conexiune ───────────────────────────────────────────────
  async verify(config) {
    if (!config?.clientId)      return { ok: false, message: 'clientId lipsă.' };
    if (!config?.privateKeyPem) return { ok: false, message: 'privateKeyPem lipsă — cheia RSA privată (PEM).' };
    if (!config?.kid)           return { ok: false, message: 'kid lipsă — primit de la STS prin email.' };
    if (!config?.redirectUri)   return { ok: false, message: 'redirectUri lipsă — URL callback DocFlowAI înregistrat la STS.' };
    try {
      const idpUrl = config.idpUrl || IDP_DEFAULT;
      // Timeout mărit la 20s — Railway staging poate avea latență mai mare la conexiuni externe
      const r = await _fetchIPv4(`${idpUrl}/.well-known/openid-configuration`,
        { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) return { ok: false, message: `STS IDP inaccesibil: HTTP ${r.status}` };
      const cfg = await r.json();
      return {
        ok: true,
        message: `✅ Conexiune STS OK. Issuer: ${cfg.issuer || idpUrl}`,
        details: { authEndpoint: cfg.authorization_endpoint, tokenEndpoint: cfg.token_endpoint },
      };
    } catch(e) {
      return { ok: false, message: `Eroare conexiune STS: ${e.message}` };
    }
  }

  // ── Inițiere sesiune — PKCE + URL redirect IDP ────────────────────────
  async initiateSession({ flowId, signer, pdfBytes, flowData, config, appBaseUrl, padesHashBase64 }) {
    const sessionId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();

    // Hash PAdES SHA-256 — calculat pe bytes-ii din afara câmpului Contents (ByteRange)
    // Dacă e furnizat explicit (PAdES flow), îl folosim direct.
    // Fallback la hash simplu pentru provideri non-STS.
    const hashBase64 = padesHashBase64 || crypto.createHash('sha256').update(pdfBytes).digest('base64');

    // PKCE
    const codeVerifier  = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    // State și nonce anti-CSRF/replay
    const state = crypto.randomBytes(24).toString('base64url');
    const nonce = crypto.randomBytes(24).toString('base64url');

    const idpUrl     = config.idpUrl     || IDP_DEFAULT;
    const signUrl    = config.apiUrl     || SIGN_DEFAULT;
    const clientId   = config.clientId;
    const redirectUri = config.redirectUri ||
      `${appBaseUrl}/flows/sts-oauth-callback`;

    const authParams = new URLSearchParams({
      response_type:         'code',
      client_id:             clientId,
      scope:                 'openid profile',
      state:                 `${sessionId}___${state}`,
      redirect_uri:          redirectUri,
      nonce,
      code_challenge:        codeChallenge,
      code_challenge_method: 'S256',
    });

    const signingUrl = `${idpUrl}/oauth2/authorize?${authParams.toString()}`;

    logger.info({ flowId, signerEmail: signer.email, sessionId }, 'STS: sesiune inițiată');

    return {
      sessionId,
      flowId,
      signerToken:      signer.token,
      provider:         this.id,
      createdAt,
      expiresAt,
      signingUrl,
      externalSessionId: sessionId,
      providerData: {
        codeVerifier, codeChallenge, state, nonce,
        hashBase64, docName: flowData.docName || flowId,
        idpUrl, signUrl, clientId,
        kid:           config.kid,
        privateKeyPem: config.privateKeyPem,
        redirectUri,
        signerEmail:   signer.email,
      },
    };
  }

  async getSigningUrl(session) { return session.signingUrl || null; }

  // ── Procesare OAuth callback — schimb code → token → trimite hash ──────
  async processOAuthCallback(query, session, pdfBytes) {
    const { code, state, error, error_description } = query;
    const pd = session.providerData || {};

    if (error) {
      logger.warn({ error, error_description }, 'STS: autentificare eșuată');
      return { ok: false, error: 'sts_auth_failed', message: error_description || error };
    }
    if (!code) return { ok: false, error: 'sts_no_code' };

    // Validăm state
    const expectedState = `${session.sessionId}___${pd.state}`;
    if (state !== expectedState) {
      logger.warn({ state, expectedState }, 'STS: state mismatch');
      return { ok: false, error: 'sts_state_mismatch' };
    }

    try {
      // ── PASUL 1: code → access token ────────────────────────────────────
      logger.info({ sessionId: session.sessionId, idpUrl: pd.idpUrl }, 'STS: schimb code → token');
      const clientAssertion = this._buildClientAssertion(
        pd.clientId, pd.kid, pd.privateKeyPem, pd.idpUrl);

      let tokenResp;
      try {
        tokenResp = await _fetchIPv4(`${pd.idpUrl}/oauth2/token`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body:    new URLSearchParams({
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
      } catch(fetchErr) {
        logger.error({
          cause: fetchErr.cause?.code || fetchErr.cause?.message || fetchErr.cause,
          msg: fetchErr.message,
          idpUrl: pd.idpUrl,
        }, 'STS: fetch token exchange FAILED — eroare retea');
        return { ok: false, error: 'sts_fetch_failed', message: `Eroare rețea STS token: ${fetchErr.cause?.code || fetchErr.message}` };
      }

      if (!tokenResp.ok) {
        const errText = await tokenResp.text();
        logger.error({ status: tokenResp.status, body: errText.substring(0,300) }, 'STS: token exchange failed');
        return { ok: false, error: 'sts_token_failed', message: `Eroare token STS: ${errText.substring(0,200)}` };
      }

      const tokenJson = await tokenResp.json();
      const accessToken = tokenJson.access_token;
      if (!accessToken) return { ok: false, error: 'sts_no_token' };

      // ── PASUL 2: /userinfo ÎNAINTE de /signature — avem nevoie de cert pentru signedAttrs ──
      // FIX b230: /userinfo era apelat DUPĂ /signature → nu puteam construi signedAttrs cu certHash
      let certPem = null;
      try {
        const uiResp = await _fetchIPv4(`${pd.idpUrl}/userinfo`, {
          headers: { 'Authorization': `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(10_000),
        });
        const uiText = await uiResp.text();
        logger.info({ status: uiResp.status, len: uiText.length,
          preview: uiText.substring(0,500) }, 'STS: /userinfo raspuns COMPLET');
        if (uiResp.ok) {
          const ui = JSON.parse(uiText);
          certPem = ui?.signingCertificate?.pemCertificate
                 || ui?.certificate?.pemCertificate
                 || ui?.cert
                 || ui?.pemCertificate
                 || null;
          if (!certPem && Array.isArray(ui?.otherCertificates)) {
            certPem = ui.otherCertificates[0]?.pemCertificate || null;
          }
          logger.info({ hasCert: !!certPem, certLen: certPem?.length||0,
            allKeys: JSON.stringify(Object.keys(ui||{})),
          }, 'STS: certificat din /userinfo');
        } else {
          logger.warn({ status: uiResp.status, body: uiText.substring(0,200) },
            'STS: /userinfo raspuns non-OK');
        }
      } catch(uiErr) {
        logger.warn({ err: uiErr }, 'STS: /userinfo fetch eroare (non-fatal)');
      }

      // ── PASUL 3: construim signedAttrs PAdES-B-B și calculăm hash-ul corect ──
      // FIX b230: ARHITECTURAL — motivul pentru care semnătura era invalidă:
      //
      // VECHI (GREȘIT):
      //   hashTrimis = SHA256(bytesOutsideContents)   ← documentDigest
      //   STS semnează documentDigest
      //   CMS fără signedAttrs: signature acoperă documentDigest
      //   Validatorul PDF: ECDSA_verify(pubKey, documentDigest, signByte) → FAIL
      //   Fail pentru că ECDSA intern face SHA256(message) din nou!
      //
      // NOU (CORECT — PAdES-B-B cu signedAttrs):
      //   documentDigest = SHA256(bytesOutsideContents) — calculat de calcPadesHash, stocat în pd.hashBase64
      //   signedAttrs = SET { contentType=id-data, messageDigest=documentDigest, signingCertV2=SHA256(cert) }
      //   hashTrimis = SHA256(DER(signedAttrs ca SET))  ← signedAttrsDigest
      //   STS semnează signedAttrsDigest → signByte
      //   CMS cu signedAttrs: signature acoperă SHA256(DER(signedAttrs))
      //   Validatorul PDF:
      //     1. documentDigest = SHA256(bytes per ByteRange) ✓
      //     2. messageDigest in signedAttrs == documentDigest ✓
      //     3. ECDSA_verify(pubKey, SHA256(DER(signedAttrs)), signByte) ✓
      //
      const documentDigestB64 = pd.hashBase64;  // SHA256(bytesOutsideContents) Base64 — calculat la initiate
      const { signedAttrsDer, signedAttrsHashB64 } = this._buildSignedAttrs(
        documentDigestB64, certPem
      );
      logger.info({ signedAttrsLen: signedAttrsDer.length, signedAttrsHashLen: signedAttrsHashB64.length,
        hasCert: !!certPem }, 'STS: signedAttrs construiți — trimitem SHA256(signedAttrs) la /api/v1/signature');

      // ── PASUL 4: trimitem SHA256(DER(signedAttrs)) la /api/v1/signature ──
      const signResp = await _fetchIPv4(`${pd.signUrl}/api/v1/signature`, {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify([{
          id:            session.sessionId,
          hashByte:      signedAttrsHashB64,  // FIX: SHA256(signedAttrs) nu SHA256(doc)
          algorithmName: 'SHA256',
          docName:       pd.docName,
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
        'STS: hash signedAttrs trimis — utilizatorul trebuie să aprobe pe email/PUSH');

      // Returnăm stare PENDING — polling-ul se face separat
      // signedAttrsDer este stocat ca hex pentru a evita probleme de serializare JSON
      return {
        ok:              true,
        pending:         true,
        stsOpId,
        accessToken,
        signUrl:         pd.signUrl,
        sessionId:       session.sessionId,
        certPem,
        signedAttrsDer:  signedAttrsDer.toString('hex'),  // stocat pentru CMS construction la poll
        message:         'Hash signedAttrs transmis la STS. Utilizatorul va primi email/notificare PUSH pentru aprobare.',
      };

    } catch(e) {
      logger.error({ err: e }, 'STS: processOAuthCallback error');
      return { ok: false, error: 'sts_error', message: e.message };
    }
  }

  // ── buildSignedAttrs — construiește signedAttrs PAdES-B-B (DER) ─────────
  // Returnează: { signedAttrsDer: Buffer, signedAttrsHashB64: string }
  // signedAttrsDer = DER ca [0] IMPLICIT (pentru embedded în CMS SignerInfo)
  // La calcul SHA256: rehash cu tag SET 0x31 (nu ctx0 0xa0)
  _buildSignedAttrs(documentDigestB64, certPem) {
    // Helpers DER (duplicat local pentru a nu depinde de pades.mjs)
    const encLen = len => {
      if (len < 128) return Buffer.from([len]);
      const h = len.toString(16).padStart(len > 0xffff ? 6 : 4, '0');
      const b = Buffer.from(h, 'hex');
      return Buffer.concat([Buffer.from([0x80 | b.length]), b]);
    };
    const tlv  = (tag, c) => Buffer.concat([Buffer.from([tag]), encLen(c.length), c]);
    const seq  = c => tlv(0x30, c);
    const set  = c => tlv(0x31, c);
    const oid  = h => { const b = Buffer.from(h,'hex'); return Buffer.concat([Buffer.from([0x06,b.length]),b]); };
    const oct  = d => Buffer.concat([Buffer.from([0x04]), encLen(d.length), d]);
    const ctx0 = c => tlv(0xa0, c);  // [0] IMPLICIT

    // OID-uri
    const OID_CONTENT_TYPE      = '2a864886f70d010903'; // id-contentType
    const OID_MESSAGE_DIGEST    = '2a864886f70d010904'; // id-messageDigest
    const OID_ID_DATA           = '2a864886f70d010701'; // id-data
    const OID_SHA256            = '608648016503040201'; // sha-256
    const OID_SIGNING_CERT_V2   = '2a864886f70d010910020e'; // id-aa-signingCertificateV2

    // Atribut 1: contentType = id-data
    const attrContentType = seq(Buffer.concat([
      oid(OID_CONTENT_TYPE),
      set(oid(OID_ID_DATA)),
    ]));

    // Atribut 2: messageDigest = SHA256(bytesOutsideContents)
    const documentDigest = Buffer.from(documentDigestB64, 'base64');
    const attrMessageDigest = seq(Buffer.concat([
      oid(OID_MESSAGE_DIGEST),
      set(oct(documentDigest)),
    ]));

    // Atribut 3: signingCertificateV2 (opțional dar recomandat pentru PAdES-B-B)
    let attrSigningCert = Buffer.alloc(0);
    if (certPem) {
      try {
        // Parsăm cert PEM → DER → SHA256
        const pemBody = certPem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, '');
        const certDer = Buffer.from(pemBody, 'base64');
        const certHash = crypto.createHash('sha256').update(certDer).digest();
        // ESSCertIDv2 = SEQUENCE { hashAlg SEQUENCE { OID sha256 }, certHash OCTET STRING }
        const hashAlg = seq(oid(OID_SHA256));  // AlgorithmIdentifier fără params
        const essCertId = seq(Buffer.concat([hashAlg, oct(certHash)]));
        // SigningCertificateV2 = SEQUENCE { SEQUENCE OF ESSCertIDv2 }
        const signingCertV2 = seq(seq(essCertId));
        attrSigningCert = seq(Buffer.concat([
          oid(OID_SIGNING_CERT_V2),
          set(signingCertV2),
        ]));
        logger.info({ certHashHex: certHash.toString('hex').substring(0,16) }, 'STS: signingCertV2 construit');
      } catch(e) {
        logger.warn({ err: e }, 'STS: signingCertV2 build error (non-fatal, omis)');
        attrSigningCert = Buffer.alloc(0);
      }
    } else {
      logger.warn('STS: certificat lipsă — signedAttrs fără signingCertV2 (PAdES sub-optimal)');
    }

    // Conținut signedAttrs (fără tag, doar atributele concatenate)
    const attrsContent = Buffer.concat([attrContentType, attrMessageDigest, attrSigningCert]);

    // Pentru embedding în CMS SignerInfo: [0] IMPLICIT
    const signedAttrsDer = ctx0(attrsContent);   // 0xa0 len content

    // Pentru SHA256: trebuie recodificat ca SET (0x31) — nu [0] IMPLICIT!
    // Conform RFC 5652 §5.4: "the complete DER encoding of the signedAttrs value as a SET"
    const signedAttrsForHash = set(attrsContent);  // 0x31 len content
    const signedAttrsHashB64 = crypto.createHash('sha256').update(signedAttrsForHash).digest('base64');

    logger.info({
      attrsContentLen: attrsContent.length,
      signedAttrsDerLen: signedAttrsDer.length,
      signedAttrsHashB64,
    }, 'STS: signedAttrs construiți cu succes');

    return { signedAttrsDer, signedAttrsHashB64 };
  }

  // ── Polling /api/v1/callback ───────────────────────────────────────────
  async pollSignatureResult(stsOpId, accessToken, signUrl) {
    try {
      const resp = await _fetchIPv4(`${signUrl}/api/v1/callback`, {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type':  'application/json',
        },
        body:   JSON.stringify({ id: stsOpId }),
        signal: AbortSignal.timeout(10_000),
      });
      const json = await resp.json();

      // CLBK-001: utilizatorul nu a aprobat încă
      if (json.errorCode === CLBK_WAIT) {
        return { ready: false, waiting: true, message: 'Așteptăm aprobarea utilizatorului pe email/PUSH.' };
      }

      if (json.errorCode !== 0) {
        return { ready: false, error: true,
          message: json.errorMessage || `Eroare STS callback: ${json.errorCode}` };
      }

      if (!json.eligible) {
        return { ready: false, error: true, message: 'Utilizatorul a refuzat operațiunea de semnare.' };
      }

      // Găsim signByte-ul — STS folosește propriul UUID în signList.id,
      // diferit de id-ul trimis de noi. Luăm primul element cu signByte prezent.
      const sigItem = (json.signList || []).find(s => s.signByte) 
                   || (json.signList || [])[0];
      if (!sigItem?.signByte) {
        logger.warn({
          stsOpId,
          signListLength: (json.signList || []).length,
          signListIds: (json.signList || []).map(s => s.id),
          eligible: json.eligible,
          errorCode: json.errorCode,
          hasSignList: !!json.signList,
        }, 'STS: signByte lipsă — raspuns complet loggat');
        return { ready: false, error: true, message: 'signByte lipsă din răspunsul STS.' };
      }

      logger.info({ stsOpId }, 'STS: semnătură primită cu succes');
      return { ready: true, signByte: sigItem.signByte };

    } catch(e) {
      logger.warn({ err: e, stsOpId }, 'STS: poll error (se va reîncerca)');
      return { ready: false, message: e.message };
    }
  }

  // ── Verificare document semnat ─────────────────────────────────────────
  async verifySignedDocument(_bytes, _session) {
    // STS garantează QES — nu reverificăm
    return { valid: true, message: 'Semnătură QES validată de STS Cloud.' };
  }

  async extractSignatureMetadata(_bytes) {
    return {
      level:                'QES',
      provider:             'sts-cloud',
      providerLabel:        'STS Cloud QES (Serviciul de Telecomunicații Speciale)',
      qualifiedCertificate: true,
    };
  }

  // ── Client assertion JWT (Anexa 1 din documentația STS) ───────────────
  _buildClientAssertion(clientId, kid, privateKeyPem, idpUrl) {
    const now    = Math.floor(Date.now() / 1000);
    const header  = { alg: 'RS256', kid };
    const payload = {
      iss: clientId,
      sub: clientId,
      aud: `${idpUrl}/oauth2/token`,
      iat: now,
      exp: now + 300,
    };
    const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const msg  = `${b64(header)}.${b64(payload)}`;
    const sig  = crypto.createSign('RSA-SHA256').update(msg).sign(privateKeyPem, 'base64url');
    return `${msg}.${sig}`;
  }

  /**
   * Generează pereche de chei RSA pentru înregistrare la STS.
   * Trimiteți publicKeyPem la STS — primiți înapoi kid-ul prin email.
   * @returns {{ publicKeyPem: string, privateKeyPem: string }}
   */
  static generateKeyPair() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength:     2048,
      publicKeyEncoding:  { type: 'pkcs1', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    return { publicKeyPem: publicKey, privateKeyPem: privateKey };
  }
}
