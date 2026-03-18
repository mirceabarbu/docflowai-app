/**
 * DocFlowAI — TransSpedProvider
 * Trans Sped — TSP România
 * STATUS: SCHELET — implementare după obținerea API credentials Trans Sped.
 * Contact: https://www.transsped.ro
 */
import { CloudProviderBase } from './CloudProviderBase.mjs';
import { logger } from '../../middleware/logger.mjs';
export class TransSpedProvider extends CloudProviderBase {
  get id()    { return 'transsped'; }
  get label() { return 'Trans Sped QES'; }
  async _pingApi(config) {
    return { ok: false, message: 'Trans Sped: necesită API credentials. TODO: implementează _pingApi().' };
  }
  async _buildSigningRequest({ sessionId, flowId, signer, pdfBytes, flowData, config, appBaseUrl }) {
    return {
      url: `${config.apiUrl}/sign/session`,
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
      body: { sessionId, signerEmail: signer.email, documentName: flowData.docName,
              callbackUrl: `${appBaseUrl}/flows/${flowId}/signing-callback?provider=transsped&session=${sessionId}` },
    };
  }
  async _parseSigningResponse(body) {
    return { signingUrl: body.signingUrl || body.url, externalSessionId: body.sessionId || body.id };
  }
  async handleCallback(payload, rawBody, signatureHeader, config) {
    if (config.webhookSecret && !this._verifyHmac(rawBody, signatureHeader, config.webhookSecret)) {
      return { ok: false, error: 'invalid_hmac_signature' };
    }
    logger.warn({ provider: this.id }, 'handleCallback() TODO: Trans Sped');
    return { ok: false, error: 'not_implemented' };
  }
}
