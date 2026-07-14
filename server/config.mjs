/**
 * server/config.mjs — centralized configuration with startup validation.
 * All env vars are read here; the rest of the codebase imports from this module.
 */

const required = (name) => {
  const val = process.env[name];
  if (!val) throw new Error(`[config] Missing required environment variable: ${name}`);
  return val;
};

const optional = (name, defaultValue = undefined) =>
  process.env[name] ?? defaultValue;

const optionalInt = (name, defaultValue) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const n = parseInt(raw, 10);
  if (isNaN(n)) throw new Error(`[config] ${name} must be an integer, got: ${raw}`);
  return n;
};

// ── NODE_ENV: obligatoriu și validat (fail-fast la boot) ─────────────────────
// SEC (incident 13.07.2026): o variabilă care decide dacă rutele de administrare
// sunt publice NU are voie să aibă default. Procesul pornește DOAR dacă NODE_ENV
// e exact una dintre valorile acceptate; orice altceva (lipsă, typo, `Production`)
// oprește procesul înainte să asculte pe port.
export const VALID_NODE_ENVS = ['production', 'staging', 'development', 'test'];

/**
 * validateNodeEnv — validator PUR (fără efecte secundare), importat din teste.
 * Aruncă pentru orice valoare care nu e exact în VALID_NODE_ENVS.
 * Întoarce { nodeEnv, isProd, isDev } la succes.
 *
 * isProd e FAIL-SECURE: orice mediu care NU e explicit `development`/`test`
 * primește comportament de securitate de producție (cookie-uri `Secure` etc.).
 * ⇒ `staging` are `isProd === true`, la fel ca `production`.
 */
export function validateNodeEnv(value) {
  if (!VALID_NODE_ENVS.includes(value)) {
    throw new Error(
      `NODE_ENV invalid (primit: ${JSON.stringify(value)}). ` +
      `Valori acceptate: ${VALID_NODE_ENVS.join(' | ')}.`
    );
  }
  const isDev  = value === 'development';
  const isTest = value === 'test';
  return { nodeEnv: value, isProd: !isDev && !isTest, isDev };
}

// Validarea rulează la IMPORTUL modulului — înainte ca serverul să asculte pe port.
let _envInfo;
try {
  _envInfo = validateNodeEnv(process.env.NODE_ENV);
} catch (_e) {
  process.stderr.write(
    `\nFATAL: NODE_ENV lipsește sau are o valoare invalidă (primit: "${process.env.NODE_ENV}").\n` +
    `Valori acceptate: production | staging | development | test.\n` +
    `Setează variabila în Railway → Variables. Procesul se oprește.\n\n`
  );
  process.exit(1);
}

const config = {
  DATABASE_URL: required('DATABASE_URL'),
  JWT_SECRET: required('JWT_SECRET'),

  JWT_EXPIRES: optional('JWT_EXPIRES', '8h'),
  JWT_REFRESH_GRACE_SEC: optionalInt('JWT_REFRESH_GRACE_SEC', 900),

  PUBLIC_BASE_URL: optional('PUBLIC_BASE_URL', ''),
  PORT: optionalInt('PORT', 3000),

  RESEND_API_KEY: optional('RESEND_API_KEY'),
  MAIL_FROM: optional('MAIL_FROM'),

  SIGNING_SERVICE_URL: optional('SIGNING_SERVICE_URL'),

  GOOGLE_DRIVE_FOLDER_ID: optional('GOOGLE_DRIVE_FOLDER_ID'),
  GOOGLE_SERVICE_ACCOUNT_JSON: optional('GOOGLE_SERVICE_ACCOUNT_JSON'),

  VAPID_PUBLIC_KEY: optional('VAPID_PUBLIC_KEY'),
  VAPID_PRIVATE_KEY: optional('VAPID_PRIVATE_KEY'),
  VAPID_SUBJECT: optional('VAPID_SUBJECT'),

  WA_PHONE_NUMBER_ID: optional('WA_PHONE_NUMBER_ID'),
  WA_ACCESS_TOKEN: optional('WA_ACCESS_TOKEN'),

  OUTREACH_DAILY_LIMIT: optionalInt('OUTREACH_DAILY_LIMIT', 100),

  NODE_ENV: _envInfo.nodeEnv,
};

// Derived helpers — fail-secure (vezi validateNodeEnv): orice mediu ne-dev/test
// e tratat ca producție din perspectiva securității (cookie-uri Secure etc.).
config.isDev   = _envInfo.isDev;
config.isProd  = _envInfo.isProd;

// camelCase aliases used by app.mjs / bootstrap.mjs
config.port          = config.PORT;
config.publicBaseUrl = config.PUBLIC_BASE_URL;
config.corsOrigin    = optional('CORS_ORIGIN', config.PUBLIC_BASE_URL || '*');

export default config;
// Named export for import { config } syntax
export { config };
