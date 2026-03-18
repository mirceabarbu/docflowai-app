/**
 * DocFlowAI — AlfaTrustProvider
 * AlfaTrust / AlfaSign — TSP România
 * STATUS: SCHELET — implementare după obținerea API credentials AlfaTrust.
 * Contact: https://www.alfatrust.ro
 */
import { CloudProviderBase } from './CloudProviderBase.mjs';
import { logger } from '../../middleware/logger.mjs';
export class AlfaTrustProvider extends CloudProviderBase {
  get id()    { return 'alfatrust'; }
  get label() { return 'AlfaTrust / AlfaSign QES'; }
  async _pingApi(config) {
    return { ok: false, message: 'AlfaTrust: necesită API credentials. TODO: implementează _pingApi().' };
  }
  async _buildSigningRequest({ sessionId, flowId, signer, pdfBytes, flowData, config, appBaseUrl }) {
    return {
      url: `${config.apiUrl}/signing/create`,
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
      body: { sessionId, signerEmail: signer.email, documentName: flowData.docName,
              callbackUrl: `${appBaseUrl}/flows/${flowId}/signing-callback?provider=alfatrust&session=${sessionId}` },
    };
  }
  async _parseSigningResponse(body) {
    return { signingUrl: body.signingUrl || body.redirectUrl, externalSessionId: body.sessionId || body.id };
  }
  async handleCallback(payload, rawBody, signatureHeader, config) {
    if (config.webhookSecret && !this._verifyHmac(rawBody, signatureHeader, config.webhookSecret)) {
      return { ok: false, error: 'invalid_hmac_signature' };
    }
    logger.warn({ provider: this.id }, 'handleCallback() TODO: AlfaTrust');
    return { ok: false, error: 'not_implemented' };
  }
}
