/**
 * DocFlowAI — CertSignProvider
 * certSIGN / Paperless — TSP privat România, API public disponibil
 * STATUS: SCHELET — implementare după obținerea API credentials certSIGN.
 * Contact: https://certsign.ro / https://paperless.certsign.ro
 */
import { CloudProviderBase } from './CloudProviderBase.mjs';
import { logger } from '../../middleware/logger.mjs';
export class CertSignProvider extends CloudProviderBase {
  get id()    { return 'certsign'; }
  get label() { return 'certSIGN / Paperless QES'; }
  async _pingApi(config) {
    // TODO: endpoint health certSIGN
    return { ok: false, message: 'certSIGN: necesită API credentials. TODO: implementează _pingApi().' };
  }
  async _buildSigningRequest({ sessionId, flowId, signer, pdfBytes, flowData, config, appBaseUrl, ancoreFieldName }) {
    // TODO: structura API certSIGN (Paperless API docs)
    return {
      url: `${config.apiUrl}/api/sign/initiate`,
      headers: { 'X-API-Key': config.apiKey },
      body: { sessionId, signerEmail: signer.email, documentName: flowData.docName,
              callbackUrl: `${appBaseUrl}/flows/${flowId}/signing-callback?provider=certsign&session=${sessionId}`,
              ...(ancoreFieldName ? { signatureFieldName: ancoreFieldName } : {}) },
    };
  }
  async _parseSigningResponse(body) {
    return { signingUrl: body.signUrl || body.redirectUrl, externalSessionId: body.transactionId || body.id };
  }
  async handleCallback(payload, rawBody, signatureHeader, config) {
    if (config.webhookSecret && !this._verifyHmac(rawBody, signatureHeader, config.webhookSecret)) {
      return { ok: false, error: 'invalid_hmac_signature' };
    }
    logger.warn({ provider: this.id }, 'handleCallback() TODO: implementează după documentație certSIGN');
    return { ok: false, error: 'not_implemented' };
  }
}
