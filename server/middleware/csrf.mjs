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
 * Middleware CSRF — aplică doar pe rute unde e montat explicit.
 * Permite trecerea dacă req vine din același origin (sameSite:strict pe auth_token
 * garantează deja că requesturile cross-site nu au cookie — dublu check).
 */
export function csrfMiddleware(req, res, next) {
  // Skip pentru GET/HEAD/OPTIONS — nu modifică stare
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const headerToken = req.headers['x-csrf-token'];
  const cookieToken = req.cookies?.csrf_token;

  if (!headerToken || !cookieToken || headerToken !== cookieToken) {
    return res.status(403).json({
      error: 'csrf_invalid',
      message: 'Token CSRF lipsă sau invalid. Reîncărcați pagina.'
    });
  }

  next();
}
