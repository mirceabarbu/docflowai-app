/**
 * DocFlowAI — STSCloudProvider
 * STS (Serviciul de Telecomunicații Speciale) — TSP oficial România
 * STATUS: SCHELET — implementare completă după obținerea documentației API STS.
 * Contact: https://www.sts.ro / sectiunea servicii TSP calificat
 */
import { CloudProviderBase } from './CloudProviderBase.mjs';
import { logger } from '../../middleware/logger.mjs';
export class STSCloudProvider extends CloudProviderBase {
  get id()    { return 'sts-cloud'; }
  get label() { return 'STS Cloud QES (Serviciul de Telecomunicații Speciale)'; }
  async _pingApi(config) {
    // TODO: GET ${config.apiUrl}/health cu Bearer ${config.apiKey}
    return { ok: false, message: 'STS Cloud: necesită documentație API STS. TODO: implementează _pingApi().' };
  }
  async _buildSigningRequest({ sessionId, flowId, signer, pdfBytes, flowData, config, appBaseUrl }) {
    // TODO: structura exactă din documentația API STS
    // STS poate accepta: hash SHA-256 al documentului SAU PDF întreg — de confirmat
    return {
      url: `${config.apiUrl}/signing/initiate`,
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
      body: {
        // TODO: adaptează la API STS real
        sessionId,
        documentName:  flowData.docName,
        signerEmail:   signer.email,
        callbackUrl:   `${appBaseUrl}/flows/${flowId}/signing-callback?provider=sts-cloud&session=${sessionId}`,
      },
    };
  }
  async _parseSigningResponse(body) {
    // TODO: adaptează la răspunsul real STS
    return { signingUrl: body.redirectUrl || body.url, externalSessionId: body.sessionId || body.id };
  }
  async handleCallback(payload, rawBody, signatureHeader, config) {
    if (config.webhookSecret && !this._verifyHmac(rawBody, signatureHeader, config.webhookSecret)) {
      return { ok: false, error: 'invalid_hmac_signature' };
    }
    // TODO: extrage PDF semnat din payload STS
    logger.warn({ provider: this.id }, 'handleCallback() TODO: implementează după documentație STS');
    return { ok: false, error: 'not_implemented' };
  }
}
