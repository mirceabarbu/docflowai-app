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

  NODE_ENV: optional('NODE_ENV', 'development'),
};

// Derived helpers
config.isDev   = config.NODE_ENV === 'development';
config.isProd  = config.NODE_ENV === 'production';

// camelCase aliases used by app.mjs / bootstrap.mjs
config.port          = config.PORT;
config.publicBaseUrl = config.PUBLIC_BASE_URL;
config.corsOrigin    = optional('CORS_ORIGIN', config.PUBLIC_BASE_URL || '*');

export default config;
// Named export for import { config } syntax
export { config };
