/**
 * DocFlowAI — serializarea publică a fluxului (DTO)
 *
 * #159 (P0, audit extern v3.9.814). Sesiunea de semnare cloud persistă în
 * `signers[].stsProviderData` material criptografic al INSTITUȚIEI (cheia privată
 * PEM, `codeVerifier` PKCE, `state`/`nonce`, `clientId`, `kid`), iar în
 * `signers[].stsToken` access tokenul OAuth. Obiectul fluxului este citit și de
 * semnatarul EXTERN, pe bază de token opac — nu de sesiune autentificată. Deci
 * orice câmp lăsat în DTO părăsește serverul.
 *
 * Acesta este SINGURUL loc care decide ce iese. Funcțiile erau definite inline în
 * `server/index.mjs`, unde nu puteau fi testate fără să pornească serverul — exact
 * motivul pentru care scurgerea a trecut neobservată.
 *
 * ⚠️ Reparația de aici etanșează IEȘIREA. Oprirea persistenței (zona NO-TOUCH)
 * este o decizie separată. Până atunci, materialul rămâne în DB și se purjează
 * printr-un pas SQL manual.
 */

/** Câmpuri de sesiune cloud care nu au voie să iasă — nici la nivel de semnatar,
 *  nici la nivel de flux. */
export const SIGNER_SECRET_KEYS = Object.freeze(['stsProviderData', 'stsToken']);

/** Nume de chei care nu au voie să apară NICĂIERI în DTO-ul public, la nicio
 *  adâncime. Consumat de testul de regresie — dacă cineva adaugă mâine un câmp
 *  nou cu unul dintre aceste nume, testul cade înainte de deploy. */
export const FORBIDDEN_DTO_KEYS = Object.freeze([
  'privateKeyPem', 'privateKey', 'codeVerifier', 'codeChallenge',
  'clientSecret', 'clientAssertion', 'accessToken', 'refreshToken',
  'stsToken', 'stsProviderData',
]);

/** Elimină secretele de la nivelul fluxului: câmpurile `_rawPdf_<idx>` (PDF-ul
 *  brut pregătit pentru semnare, salvat temporar la inițierea sesiunii) și orice
 *  cheie din SIGNER_SECRET_KEYS ajunsă din greșeală la rădăcină. */
function _dropFlowSecrets(rest) {
  const out = { ...rest };
  for (const k of Object.keys(out)) {
    if (k.startsWith('_rawPdf_') || SIGNER_SECRET_KEYS.includes(k)) delete out[k];
  }
  return out;
}

/** Elimină secretele de sesiune de pe un semnatar. NU atinge `token` — decizia
 *  despre token aparține apelantului. */
function _dropSignerSecrets(s) {
  if (!s || typeof s !== 'object') return s;
  const out = { ...s };
  for (const k of SIGNER_SECRET_KEYS) delete out[k];
  return out;
}

/**
 * Variantă „ușoară": scoate doar PDF-urile (+ secretele). Păstrează tokenurile
 * semnatarilor — apelantul trebuie să știe ce face.
 */
export function stripPdfB64(data) {
  if (!data || typeof data !== 'object') return data;
  const { pdfB64, signedPdfB64, ...rest } = data;
  const out = { ..._dropFlowSecrets(rest), hasPdf: !!pdfB64, hasSignedPdf: !!signedPdfB64 };
  if (Array.isArray(data.signers)) out.signers = data.signers.map(_dropSignerSecrets);
  return out;
}

/**
 * Serializatorul public al fluxului. Scoate PDF-urile, secretele de sesiune cloud
 * și tokenurile semnatarilor — cu excepția tokenului apelantului însuși, de care
 * ecranul de semnare are nevoie.
 */
export function stripSensitive(data, callerSignerToken = null) {
  if (!data || typeof data !== 'object') return data;
  const { pdfB64, signedPdfB64, ...rest } = data;
  return {
    ..._dropFlowSecrets(rest),
    hasPdf: !!pdfB64,
    hasSignedPdf: !!(signedPdfB64 || (data.storage === 'drive' && (data.driveFileLinkFinal || data.driveFileIdFinal))),
    signers: (data.signers || []).map(s => {
      const { token, ...signerRest } = _dropSignerSecrets(s) || {};
      return callerSignerToken && s?.token === callerSignerToken
        ? { ...signerRest, token }
        : signerRest;
    }),
  };
}
