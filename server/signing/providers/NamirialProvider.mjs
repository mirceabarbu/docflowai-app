/**
 * DocFlowAI — NamirialProvider
 * Namirial — TSP european cu prezență în România
 * STATUS: SCHELET — implementare după obținerea API credentials Namirial.
 * Contact: https://www.namirial.ro / https://eSignAnyWhere API
 */
import { CloudProviderBase } from './CloudProviderBase.mjs';
import { logger } from '../../middleware/logger.mjs';
export class NamirialProvider extends CloudProviderBase {
  get id()    { return 'namirial'; }
  get label() { return 'Namirial eSignAnyWhere QES'; }
  async _pingApi(config) {
    // Namirial are API public documentat (eSignAnyWhere REST API)
    // TODO: GET ${config.apiUrl}/v6.0/session cu API key în header
    return { ok: false, message: 'Namirial: necesită API credentials. TODO: implementează cu eSignAnyWhere REST API.' };
  }
  async _buildSigningRequest({ sessionId, flowId, signer, pdfBytes, flowData, config, appBaseUrl }) {
    // Namirial eSignAnyWhere are documentație publică completă
    // TODO: implementează conform https://developers.esignanywhere.net/
    return {
      url: `${config.apiUrl}/v6.0/envelope/create`,
      headers: { 'Authorization': config.apiKey },
      body: {
        // TODO: structura eSignAnyWhere Envelope
        name: flowData.docName,
        signer: { email: signer.email, name: signer.name },
        callbackUrl: `${appBaseUrl}/flows/${flowId}/signing-callback?provider=namirial&session=${sessionId}`,
      },
    };
  }
  async _parseSigningResponse(body) {
    // TODO: adaptează la răspunsul eSignAnyWhere real
    return { signingUrl: body.signingLink || body.signUrl, externalSessionId: body.envelopeId || body.id };
  }
  async handleCallback(payload, rawBody, signatureHeader, config) {
    if (config.webhookSecret && !this._verifyHmac(rawBody, signatureHeader, config.webhookSecret)) {
      return { ok: false, error: 'invalid_hmac_signature' };
    }
    logger.warn({ provider: this.id }, 'handleCallback() TODO: Namirial eSignAnyWhere');
    return { ok: false, error: 'not_implemented' };
  }
}
