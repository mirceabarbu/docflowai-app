/**
 * DocFlowAI — CSRF Protection middleware
 *
 * Strategie: Double Submit Cookie
 * - La login: generăm token random → cookie csrf_token (non-HttpOnly)
 * - Frontend: citește cookie și trimite ca header x-csrf-token
 * - Middleware: compară header cu cookie — dacă nu coincid → 403
 *
 * Notă: auth_token este deja sameSite:strict — CSRF e defense-in-depth.
 * Aplicat selectiv pe rute admin critice, nu pe tot.
 */

import crypto from 'crypto';

export function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * csrfToken — generates a random token, sets it as cookie 'csrf_token'
 * (SameSite=Strict, non-HttpOnly so JS can read it) and on req.csrfToken.
 */
export function csrfToken(req, res, next) {
  const token = crypto.randomBytes(32).toString('hex');
  req.csrfToken = token;
  res.cookie('csrf_token', token, {
    httpOnly: false,
    sameSite: 'strict',
    secure: process.env.NODE_ENV !== 'test',
    path: '/',
  });
  next();
}

/**
 * Middleware CSRF — aplică doar pe rute unde e montat explicit.
 * Permite trecerea dacă req vine din același origin (sameSite:strict pe auth_token
 * garantează deja că requesturile cross-site nu au cookie — dublu check).
 */
/**
 * csrfProtect — Double Submit Cookie validation.
 * Compares 'x-csrf-token' header with 'csrf_token' cookie.
 * Skips GET / HEAD / OPTIONS.
 */
export function csrfProtect(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const headerToken = req.headers['x-csrf-token'];
  const cookieToken = req.cookies?.csrf_token;

  if (!headerToken || !cookieToken || headerToken !== cookieToken) {
    return res.status(403).json({
      error: 'csrf_invalid',
      message: 'Token CSRF lipsă sau invalid. Reîncărcați pagina.',
    });
  }

  next();
}

/** csrfMiddleware — alias for csrfProtect, kept for backward compat. */
export function csrfMiddleware(req, res, next) {
  return csrfProtect(req, res, next);
}
