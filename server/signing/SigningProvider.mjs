/**
 * DocFlowAI — SigningProvider (interfață abstractă)
 *
 * Arhitectură corectă:
 *   - Providerii sunt configurați la nivel de ORGANIZAȚIE (ce e disponibil)
 *   - Semnatarul ALEGE providerul la momentul semnării (ce folosește personal)
 *   - Metadata semnăturii se stochează per semnatar în data.signers[i]
 *
 * Provideri planificați (toți extind această clasă):
 *   LocalUploadProvider    — download → semnează local → upload (implicit)
 *   STSCloudProvider       — STS API cloud QES
 *   CertSignProvider       — certSIGN / Paperless API
 *   TransSpedProvider      — Trans Sped API
 *   AlfaTrustProvider      — AlfaTrust / AlfaSign API
 *   NamirialProvider       — Namirial API
 *   EUDIWalletProvider     — eIDAS 2.0 EUDI Wallet (viitor)
 *
 * Flow tehnic:
 *   1. Semnatarul deschide pagina de semnare
 *   2. UI afișează providerii activi în org → semnatarul alege
 *   3. provider.initiateSession() → sesiune + URL redirect (sau null pentru local)
 *   4a. [local]  → semnatar descarcă, semnează, uploadează → upload-signed-pdf
 *   4b. [cloud]  → redirect la provider → callback → /flows/:id/signing-callback
 *   5. provider.verifySignedDocument() → validare
 *   6. provider.extractSignatureMetadata() → metadata QES stocată per semnatar
 *   7. Fluxul avansează normal (notificări, audit, next signer)
 */

export class SigningProvider {
  /** @returns {string} ex: 'local-upload', 'sts-cloud', 'certsign' */
  get id() { throw new Error(`${this.constructor.name}.id not implemented`); }

  /** @returns {string} Nume afișat în UI semnatar */
  get label() { throw new Error(`${this.constructor.name}.label not implemented`); }

  /**
   * Tipul de interacțiune:
   *   'upload'   — semnatar descarcă + semnează local + uploadează
   *   'redirect' — redirect la provider cloud pentru semnare
   * @returns {'upload'|'redirect'}
   */
  get mode() { throw new Error(`${this.constructor.name}.mode not implemented`); }

  /**
   * Verifică dacă provider-ul este operațional cu configurația dată.
   * Apelat la salvarea configurației din admin panel.
   *
   * @param {object} config — configurația din signing_providers_config[this.id]
   * @returns {Promise<{ok: boolean, message?: string, details?: object}>}
   */
  async verify(config) {
    throw new Error(`${this.constructor.name}.verify() not implemented`);
  }

  /**
   * Inițiază sesiunea de semnare.
   * Apelat când semnatarul a ales providerul și apasă "Continuă".
   *
   * @param {object} p
   * @param {string} p.flowId
   * @param {object} p.signer        — signer object din data.signers[]
   * @param {Buffer} p.pdfBytes      — PDF-ul de semnat (deja procesat: unlock, footer)
   * @param {object} p.flowData      — date complete flux (docName, institutie etc.)
   * @param {object} p.config        — config specifică acestui provider din org
   * @param {string} p.jwtSecret     — pentru emitere uploadToken (local only)
   * @param {string} p.appBaseUrl    — ex: https://app.docflowai.ro
   * @param {string|null} p.ancoreFieldName — câmpul AcroForm al semnătarului (flowType='ancore')
   *                                          null pentru flowType='tabel' sau dacă nu e specificat
   * @returns {Promise<SigningSession>}
   */
  async initiateSession(p) {
    throw new Error(`${this.constructor.name}.initiateSession() not implemented`);
  }

  /**
   * URL de redirect pentru provideri cloud. null pentru local.
   * @param {SigningSession} session
   * @returns {Promise<string|null>}
   */
  async getSigningUrl(session) { return null; }

  /**
   * Verifică documentul semnat înainte de a-l accepta în flux.
   * @param {Buffer} signedBytes
   * @param {SigningSession} session
   * @returns {Promise<VerifyResult>}
   */
  async verifySignedDocument(signedBytes, session) {
    throw new Error(`${this.constructor.name}.verifySignedDocument() not implemented`);
  }

  /**
   * Extrage metadata semnăturii (nivel QES, certificat, timestamp TSA).
   * Returnează {} dacă provider-ul nu poate extrage (non-fatal).
   * @param {Buffer} signedBytes
   * @returns {Promise<SignatureMetadata>}
   */
  async extractSignatureMetadata(signedBytes) { return {}; }

  /**
   * Procesează callback-ul/webhook-ul de la provider (doar mode: 'redirect').
   * @param {object} payload        — body webhook
   * @param {string} rawBody        — body brut string (pentru verificare HMAC)
   * @param {string} signatureHeader — header de semnătură
   * @param {object} config
   * @returns {Promise<CallbackResult>}
   */
  async handleCallback(payload, rawBody, signatureHeader, config) {
    throw new Error(`${this.constructor.name}.handleCallback() not implemented`);
  }
}

/**
 * @typedef {object} SigningSession
 * @property {string}  sessionId
 * @property {string}  flowId
 * @property {string}  signerToken
 * @property {string}  provider          — provider id
 * @property {string}  createdAt
 * @property {string}  expiresAt
 * @property {boolean} [ancore]           — true dacă flowType='ancore' (fără hash)
 * @property {string}  [uploadToken]      — JWT hash token (local only)
 * @property {string}  [preHash]          — SHA-256 al PDF-ului (local only)
 * @property {string}  [signingUrl]       — URL redirect (cloud only)
 * @property {string}  [externalSessionId] — ID sesiune la provider (cloud only)
 */

/**
 * @typedef {object} VerifyResult
 * @property {boolean} valid
 * @property {string}  [uploadedHash]
 * @property {string}  [error]
 * @property {string}  [message]
 */

/**
 * @typedef {object} SignatureMetadata
 * @property {string}  [level]               — 'QES'|'AdES'|'SES'
 * @property {string}  [provider]
 * @property {string}  [providerLabel]
 * @property {string}  [signerCertificate]   — DN din certificat
 * @property {string}  [signedAt]            — timestamp TSA ISO
 * @property {boolean} [qualifiedCertificate]
 * @property {string}  [serialNumber]        — serial certificat
 */

/**
 * @typedef {object} CallbackResult
 * @property {boolean} ok
 * @property {Buffer}  [signedPdfBytes]
 * @property {string}  [signerToken]          — pentru identificare în DocFlowAI
 * @property {SignatureMetadata} [metadata]
 * @property {string}  [error]
 */
