/**
 * DocFlowAI — gws.mjs (v3.3.2)
 * Google Workspace Directory API — provisioning conturi @docflowai.ro
 *
 * Autentificare: Service Account cu Domain-Wide Delegation
 * Scope necesar: https://www.googleapis.com/auth/admin.directory.user
 *
 * Variabile de mediu necesare:
 *   GWS_SERVICE_ACCOUNT_JSON  — JSON-ul service account (sau base64)
 *   GWS_ADMIN_EMAIL           — emailul adminului Workspace care impersonează (ex: admin@docflowai.ro)
 *   GWS_DOMAIN                — domeniul (default: docflowai.ro)
 */

import { google } from 'googleapis';

const DOMAIN      = process.env.GWS_DOMAIN        || 'docflowai.ro';
const ADMIN_EMAIL = process.env.GWS_ADMIN_EMAIL    || '';
const SA_JSON_RAW = process.env.GWS_SERVICE_ACCOUNT_JSON || '';

// ── Normalizare email ──────────────────────────────────────────────────────
const DIACR_MAP = {
  ă:'a',â:'a',î:'i',ș:'s',ț:'t',ş:'s',ţ:'t',
  Ă:'a',Â:'a',Î:'i',Ș:'s',Ț:'t',Ş:'s',Ţ:'t',
  á:'a',à:'a',ä:'a',å:'a',ã:'a',
  é:'e',è:'e',ê:'e',ë:'e',
  í:'i',ì:'i',ï:'i',
  ó:'o',ò:'o',ö:'o',ô:'o',õ:'o',ø:'o',
  ú:'u',ù:'u',ü:'u',û:'u',
  ñ:'n',ç:'c',ý:'y',
};

/**
 * Normalizează un string pentru a fi folosit ca parte din emailul Workspace.
 * "Mircea-Ionuț" → "mirceaionut"
 */
function normalizePart(str) {
  return String(str || '')
    .split('')
    .map(ch => DIACR_MAP[ch] || ch)
    .join('')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');  // elimină tot în afară de a-z, 0-9
}

/**
 * Generează emailul local (fără @domain) din prenume + nume.
 * "Mircea" + "Barbu" → "mirceabarbu"
 * "Ion-Sorin" + "Popescu-Marinescu" → "ionsorinpopescumarinescu"
 */
export function buildLocalPart(prenume, numeFamilie) {
  const p = normalizePart(prenume);
  const n = normalizePart(numeFamilie);
  if (!p && !n) throw new Error('Prenume și nume lipsă pentru generare email Workspace');
  return p + n;  // pur concatenat, fără punct — ex: "mirceabarbu"
}

// ── Auth client ────────────────────────────────────────────────────────────
let _authClient = null;
let _directory  = null;

function _isConfigured() {
  return !!(SA_JSON_RAW && ADMIN_EMAIL);
}

export function gwsIsConfigured() {
  return _isConfigured();
}

function _getClient() {
  if (_directory) return _directory;
  if (!SA_JSON_RAW) throw new Error('GWS_SERVICE_ACCOUNT_JSON lipsă');
  if (!ADMIN_EMAIL) throw new Error('GWS_ADMIN_EMAIL lipsă');

  let saKey;
  try {
    // Acceptăm JSON raw sau base64
    const raw = SA_JSON_RAW.trim();
    saKey = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
  } catch(e) {
    throw new Error('GWS_SERVICE_ACCOUNT_JSON invalid: ' + e.message);
  }

  const auth = new google.auth.JWT({
    email: saKey.client_email,
    key:   saKey.private_key,
    scopes: ['https://www.googleapis.com/auth/admin.directory.user'],
    subject: ADMIN_EMAIL,  // Domain-Wide Delegation — impersonăm adminul
  });

  _authClient = auth;
  _directory  = google.admin({ version: 'directory_v1', auth });
  return _directory;
}

// ── Verificare existență email ─────────────────────────────────────────────
/**
 * Verifică dacă un utilizator cu emailul dat există deja în Workspace.
 * Returnează true dacă există, false dacă nu, aruncă eroare la alte probleme.
 */
async function _emailExists(localPart) {
  const dir = _getClient();
  const fullEmail = `${localPart}@${DOMAIN}`;
  try {
    await dir.users.get({ userKey: fullEmail });
    return true;  // 200 = există
  } catch(e) {
    if (e.code === 404) return false;
    throw e;  // 403, 500 etc. — propagăm
  }
}

/**
 * Găsește un local part disponibil, cu fallback numeric.
 * "mirceabarbu" → "mirceabarbu" dacă liber
 *               → "mirceabarbu2" dacă ocupat
 *               → "mirceabarbu3" etc. până la max 20
 */
export async function findAvailableEmail(prenume, numeFamilie) {
  const base = buildLocalPart(prenume, numeFamilie);
  if (!base) throw new Error('Nu s-a putut genera un email valid din numele furnizat');

  if (!(await _emailExists(base))) return `${base}@${DOMAIN}`;

  for (let i = 2; i <= 20; i++) {
    const candidate = `${base}${i}`;
    if (!(await _emailExists(candidate))) return `${candidate}@${DOMAIN}`;
  }
  throw new Error(`Nu s-a găsit un email disponibil pentru ${base}@${DOMAIN} după 20 încercări`);
}

// ── Creare user ────────────────────────────────────────────────────────────
/**
 * Provisionează un cont Google Workspace.
 *
 * @param {object} opts
 * @param {string} opts.prenume
 * @param {string} opts.numeFamilie
 * @param {string} opts.gwsEmail          — emailul complet deja validat (din findAvailableEmail)
 * @param {string} opts.tempPassword       — parolă temporară generată de DocFlowAI
 * @param {boolean} opts.forcePasswordChange — dacă forțează schimbarea la prima logare
 * @param {string} [opts.personalEmail]    — email personal adăugat ca alias de recuperare (opțional)
 * @param {string} [opts.phone]            — telefon (opțional)
 * @param {string} [opts.functie]          — titlu job (opțional)
 * @param {string} [opts.institutie]       — organizație (opțional)
 * @returns {Promise<{ok:boolean, gwsEmail:string, gwsId:string}>}
 */
export async function provisionGwsUser({ prenume, numeFamilie, gwsEmail, tempPassword, forcePasswordChange = true, personalEmail, phone, functie, institutie }) {
  const dir = _getClient();

  const [localPart] = gwsEmail.split('@');

  const userResource = {
    primaryEmail: gwsEmail,
    name: {
      givenName:  normalizePart(prenume)  || prenume,
      familyName: normalizePart(numeFamilie) || numeFamilie,
    },
    password: tempPassword,
    changePasswordAtNextLogin: !!forcePasswordChange,
    orgUnitPath: '/',
  };

  // Câmpuri opționale
  if (phone) {
    userResource.phones = [{ value: phone, type: 'work', primary: true }];
  }
  if (functie) {
    userResource.organizations = [{ title: functie, name: institutie || DOMAIN, primary: true }];
  }
  if (personalEmail) {
    userResource.recoveryEmail = personalEmail.trim().toLowerCase();
    userResource.emails = [
      { address: gwsEmail, type: 'work', primary: true },
      { address: personalEmail.trim().toLowerCase(), type: 'home' },
    ];
  }

  const response = await dir.users.insert({ requestBody: userResource });
  const created  = response.data;

  return {
    ok:       true,
    gwsEmail: created.primaryEmail,
    gwsId:    created.id,
  };
}

// ── Verificare configurare ────────────────────────────────────────────────
/**
 * Testează conectivitatea — încearcă să listeze 1 user din domeniu.
 */
export async function verifyGws() {
  if (!_isConfigured()) {
    return { ok: false, reason: 'not_configured', message: 'GWS_SERVICE_ACCOUNT_JSON sau GWS_ADMIN_EMAIL lipsesc din variabilele de mediu.' };
  }
  try {
    const dir = _getClient();
    await dir.users.list({ domain: DOMAIN, maxResults: 1 });
    return { ok: true, domain: DOMAIN, adminEmail: ADMIN_EMAIL };
  } catch(e) {
    return { ok: false, reason: 'api_error', message: e.message, code: e.code };
  }
}
