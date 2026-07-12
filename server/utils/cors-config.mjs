/**
 * DocFlowAI — server/utils/cors-config.mjs
 *
 * SEC-P0.4: separă CORS-ul aplicației (credentialed) de CORS-ul landing-ului
 * (fără credențiale, exclusiv pe /api/contact).
 *
 * Anterior, docflowai.ro era adăugat în lista GLOBALĂ cu `credentials: true`, permițându-i
 * să trimită cereri CU COOKIE DE SESIUNE către orice endpoint al aplicației.
 *
 * IMPORTANT: originile landing-ului sunt eliminate ACTIV din lista credentialed, chiar dacă
 * apar (accidental sau istoric) în CORS_ORIGIN / PUBLIC_BASE_URL. „Doar nu le adăugăm" NU e
 * suficient — env-ul de producție le poate conține deja.
 */

import cors from 'cors';

export const LANDING_ORIGINS = Object.freeze([
  'https://docflowai.ro',
  'https://www.docflowai.ro',
]);

export const LANDING_ROUTE = '/api/contact';

const LANDING_SET = new Set(LANDING_ORIGINS);

/** Normalizează la origine canonică ("https://X.ro/" și "https://X.ro" ⇒ același lucru). */
function normalizeOrigin(value) {
  try { return new URL(String(value).trim()).origin; }
  catch { return null; }
}

/**
 * Originile aplicației — singurele care primesc CORS credentialed.
 * Originile landing-ului sunt FILTRATE ACTIV.
 * @returns {string[]|false}  false ⇒ CORS blocat pentru orice origine externă.
 */
export function resolveAppOrigins(env = process.env) {
  const raw = env.CORS_ORIGIN
    ? String(env.CORS_ORIGIN).split(',')
    : (env.PUBLIC_BASE_URL ? [env.PUBLIC_BASE_URL] : []);

  const origins = [...new Set(
    raw.map(normalizeOrigin).filter(Boolean).filter(o => !LANDING_SET.has(o))
  )];

  return origins.length ? origins : false;
}

/** True dacă env-ul conține (greșit) o origine de landing în lista credentialed. */
export function envLeaksLandingOrigin(env = process.env) {
  const raw = [
    ...String(env.CORS_ORIGIN || '').split(','),
    String(env.PUBLIC_BASE_URL || ''),
  ];
  return raw.map(normalizeOrigin).filter(Boolean).some(o => LANDING_SET.has(o));
}

/**
 * Montează ambele politici CORS pe app. Exportat separat ca să fie testabil cu supertest
 * pe un express gol — testul pe `resolveAppOrigins` NU demonstrează ordinea middleware-ului.
 */
export function mountCors(app, env = process.env) {
  const appOrigins  = resolveAppOrigins(env);
  const appCors     = cors({ origin: appOrigins, credentials: true });
  const landingCors = cors({ origin: [...LANDING_ORIGINS], credentials: false, methods: ['POST', 'OPTIONS'] });

  // LANDING_ROUTE primește CORS dedicat FĂRĂ credențiale. Restul primesc CORS credentialed.
  // Ramificarea trebuie făcută AICI: middleware-ul `cors` termină preflight-ul OPTIONS cu 204
  // chiar și când originea nu se potrivește (doar fără header ACAO), deci un CORS montat
  // ulterior pe rută nu ar mai apuca să ruleze.
  app.use((req, res, next) =>
    (req.path === LANDING_ROUTE ? landingCors : appCors)(req, res, next)
  );

  return { appOrigins };
}
