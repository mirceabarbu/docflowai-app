/**
 * DocFlowAI — Auth middleware v3.3.3
 * requireAuth, requireAdmin, hashPassword, verifyPassword, JWT helpers.
 * SEC-01: requireAuth citește cookie HttpOnly auth_token (fallback: Bearer header)
 */

import crypto from 'crypto';
import jwt from 'jsonwebtoken';

if (!process.env.JWT_SECRET) {
  console.error('❌ FATAL: JWT_SECRET nu este setat în variabilele de mediu!');
  process.exit(1);
}
export const JWT_SECRET  = process.env.JWT_SECRET;
export const JWT_EXPIRES = process.env.JWT_EXPIRES || '2h';
// FIX: grace period configurabil via env
export const JWT_REFRESH_GRACE_SEC = parseInt(process.env.JWT_REFRESH_GRACE_SEC || '900');
export const ADMIN_SECRET = process.env.ADMIN_SECRET || null;

// SEC-01: cookie name centralizat — schimbat într-un singur loc dacă e nevoie
export const AUTH_COOKIE = 'auth_token';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha256').toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const check = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha256').toString('hex');
  return check === hash;
}

/**
 * SEC-01: requireAuth — verifică cookie HttpOnly auth_token, cu fallback la Bearer header.
 * Fallback-ul Bearer rămâne activ pentru compatibilitate cu tokenii existenți în tranziție.
 */
export function requireAuth(req, res) {
  // 1. Încearcă cookie-ul HttpOnly (metoda sigură)
  let token = req.cookies?.[AUTH_COOKIE] || null;

  // 2. Fallback: Authorization: Bearer <token> (compatibilitate tranziție)
  if (!token) {
    const auth = req.get('authorization') || '';
    token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  }

  if (!token) { res.status(401).json({ error: 'unauthorized' }); return null; }
  try { return jwt.verify(token, JWT_SECRET); }
  catch(e) { res.status(401).json({ error: 'token_invalid_or_expired' }); return null; }
}

export function requireAdmin(req, res) {
  if (ADMIN_SECRET) {
    const provided = req.get('x-admin-secret');
    if (provided && provided === ADMIN_SECRET) return false;
  }
  const actor = requireAuth(req, res);
  if (!actor) return true;
  if (actor.role !== 'admin') { res.status(403).json({ error: 'forbidden' }); return true; }
  return false;
}

/**
 * SEC-01: setAuthCookie — setează cookie-ul HttpOnly cu JWT.
 * Apelat din auth routes după login/refresh.
 */
export function setAuthCookie(res, token, maxAgeMs) {
  res.cookie(AUTH_COOKIE, token, {
    httpOnly: true,                                   // inaccesibil din JS — previne XSS
    secure: process.env.NODE_ENV !== 'test',          // HTTPS only (Railway = HTTPS)
    sameSite: 'strict',                               // protecție CSRF
    path: '/',
    maxAge: maxAgeMs || (2 * 60 * 60 * 1000),        // default 2h în ms
  });
}

/**
 * SEC-01: clearAuthCookie — șterge cookie-ul de sesiune la logout.
 */
export function clearAuthCookie(res) {
  res.cookie(AUTH_COOKIE, '', {
    httpOnly: true, secure: process.env.NODE_ENV !== 'test',
    sameSite: 'strict', path: '/', maxAge: 0,
  });
}

/**
 * generatePassword — fara plain_password in DB.
 * Parola generata se returneaza caller-ului O SINGURA DATA, nu se stocheaza in clar.
 */
export function generatePassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let p = '';
  for (let i = 0; i < 9; i++) { if (i===3||i===6) p+='-'; p+=chars[crypto.randomInt(chars.length)]; }
  return p;
}

export function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// escHtml — escape HTML pentru emailuri și output — previne HTML injection
// Exportat din middleware pentru reutilizare în toate rutele
export function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
