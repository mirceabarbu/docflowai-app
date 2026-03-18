/**
 * DocFlowAI — LocalUploadProvider
 *
 * Provider implicit: semnatar descarcă PDF → semnează local cu orice aplicație
 * (Adobe Acrobat, Foxit, E-SignEncrypt STS desktop, aplicație certSIGN etc.)
 * → uploadează PDF semnat.
 *
 * Comportamentul ACTUAL al DocFlowAI — extras fără modificări funcționale.
 * Funcționează cu orice certificat calificat indiferent de emitent,
 * deoarece semnarea se face în afara platformei.
 */

import crypto from 'crypto';
import jwt    from 'jsonwebtoken';
import { SigningProvider } from '../SigningProvider.mjs';
import { logger } from '../../middleware/logger.mjs';

export class LocalUploadProvider extends SigningProvider {
  get id()    { return 'local-upload'; }
  get label() { return 'Upload local (orice certificat calificat)'; }
  get mode()  { return 'upload'; }

  async verify(_config) {
    return { ok: true, message: 'Provider local — nu necesită configurație externă.' };
  }

  async initiateSession({ flowId, signer, pdfBytes, flowData, jwtSecret }) {
    const sessionId  = crypto.randomUUID();
    const createdAt  = new Date().toISOString();
    const expiresAt  = new Date(Date.now() + 4 * 3600_000).toISOString();

    // ancore: fără verificare hash — semnarea calificată e în PDF
    if (flowData.flowType === 'ancore') {
      logger.info({ flowId, signerEmail: signer.email }, 'LocalUpload: sesiune ancore');
      return { sessionId, flowId, signerToken: signer.token, provider: this.id,
               createdAt, expiresAt, ancore: true, uploadToken: null, preHash: null };
    }

    // tabel: hash + uploadToken JWT
    const preHash     = sha256Hex(pdfBytes);
    const uploadToken = jwt.sign(
      { flowId, signerToken: signer.token, preHash },
      jwtSecret,
      { expiresIn: '4h' }
    );
    logger.info({ flowId, signerEmail: signer.email }, 'LocalUpload: sesiune tabel (uploadToken emis)');
    return { sessionId, flowId, signerToken: signer.token, provider: this.id,
             createdAt, expiresAt, ancore: false, uploadToken, preHash };
  }

  async getSigningUrl(_session) { return null; }

  async verifySignedDocument(signedBytes, session) {
    if (session.ancore) return { valid: true };
    if (!session.preHash) return { valid: false, error: 'missing_prehash' };
    const uploadedHash = sha256Hex(signedBytes);
    if (uploadedHash === session.preHash) {
      return { valid: false, error: 'pdf_not_signed', uploadedHash,
               message: 'Documentul uploadat este identic cu cel descărcat — nu conține semnătură.' };
    }
    return { valid: true, uploadedHash };
  }

  async handleCallback() {
    return { ok: false, error: 'local_upload_has_no_callback' };
  }
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
