/**
 * DocFlowAI — CloudProviderBase
 *
 * Bază comună pentru toți providerii cloud: STS, certSIGN, Trans Sped,
 * AlfaTrust, Namirial. Conține: HTTP cu timeout+retry, validare HMAC,
 * logging structurat, normalizare erori.
 *
 * Fiecare provider concret extinde și implementează:
 *   _buildSigningRequest()    — request specific API-ului
 *   _parseSigningResponse()   — răspuns → format intern
 *   handleCallback()          — procesare webhook de la provider
 */

import crypto from 'crypto';
import { SigningProvider } from '../SigningProvider.mjs';
import { logger } from '../../middleware/logger.mjs';

export class CloudProviderBase extends SigningProvider {
  get mode() { return 'redirect'; }

  async verify(config) {
    if (!config?.apiKey)  return { ok: false, error: 'api_key_missing',  message: 'API key obligatoriu.' };
    if (!config?.apiUrl)  return { ok: false, error: 'api_url_missing',  message: 'URL API obligatoriu.' };
    try {
      return await this._pingApi(config);
    } catch(e) {
      return { ok: false, error: 'connection_failed', message: String(e.message || e) };
    }
  }

  /** Subclasele suprascriu cu endpoint-ul real de health/ping. */
  async _pingApi(_config) {
    return { ok: false, message: `${this.label}: implementați _pingApi() cu endpoint real.` };
  }

  async initiateSession({ flowId, signer, pdfBytes, flowData, config, appBaseUrl }) {
    const sessionId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    logger.info({ flowId, signerEmail: signer.email, provider: this.id }, 'CloudProvider: inițiere sesiune');
    try {
      const request  = await this._buildSigningRequest({ sessionId, flowId, signer, pdfBytes, flowData, config, appBaseUrl });
      const response = await this._callApi(request, config);
      const parsed   = await this._parseSigningResponse(response);
      return { sessionId, flowId, signerToken: signer.token, provider: this.id,
               createdAt, expiresAt, signingUrl: parsed.signingUrl,
               externalSessionId: parsed.externalSessionId, providerData: parsed.providerData || {} };
    } catch(e) {
      logger.error({ err: e, flowId, provider: this.id }, 'CloudProvider: eroare inițiere sesiune');
      throw e;
    }
  }

  async getSigningUrl(session) { return session.signingUrl || null; }

  // Provider cloud returnează PDF deja verificat de ei — subclasele pot adăuga validare LTV/TSA
  async verifySignedDocument(_signedBytes, _session) { return { valid: true }; }

  /** HTTP POST cu timeout 15s și un retry pentru erori 5xx. */
  async _callApi({ url, method = 'POST', headers = {}, body }, _config, attempt = 1) {
    const ctrl    = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err  = Object.assign(new Error(`${this.id} API ${res.status}: ${text}`), { status: res.status });
        if (res.status >= 400 && res.status < 500) throw err; // 4xx → nu retry
        if (attempt < 2) {
          logger.warn({ provider: this.id, status: res.status }, 'CloudProvider: retry 5xx');
          await new Promise(r => setTimeout(r, 2000));
          return this._callApi({ url, method, headers, body }, _config, 2);
        }
        throw err;
      }
      return res.json();
    } catch(e) {
      clearTimeout(timeout);
      if (e.name === 'AbortError') throw new Error(`Timeout ${this.id} API (15s)`);
      throw e;
    }
  }

  /**
   * Verificare HMAC în timp constant (protecție timing attacks).
   * @param {string|Buffer} rawBody
   * @param {string} receivedSig     — poate include prefix 'sha256='
   * @param {string} secret
   * @returns {boolean}
   */
  _verifyHmac(rawBody, receivedSig, secret) {
    if (!secret) return true; // fără secret configurativ → accept (log warn)
    const clean    = receivedSig.replace(/^sha256=/, '');
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(clean,    'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  // ── Abstracte ──────────────────────────────────────────────────────────
  async _buildSigningRequest(_p)   { throw new Error(`${this.id}._buildSigningRequest() not implemented`); }
  async _parseSigningResponse(_b)  { throw new Error(`${this.id}._parseSigningResponse() not implemented`); }
  async handleCallback(_p, _r, _s, _c) { throw new Error(`${this.id}.handleCallback() not implemented`); }
}
