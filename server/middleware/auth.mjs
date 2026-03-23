/**
 * DocFlowAI — Auth middleware v3.3.4
 *
 * CHANGES v3.3.4:
 *  SEC-02: ADMIN_SECRET rate limiting (5 req/min/IP) + audit log obligatoriu
 *  SEC-03: PBKDF2 upgrade 100k → 600k iterații (OWASP 2025 compliant)
 *          Hash versionat: hashes vechi ("salt:hash") = 100k (legacy)
 *                          hashes noi  ("v2:salt:hash") = 600k
 *  SEC-04: requireAdmin() scrie în audit_log la fiecare acces via ADMIN_SECRET
 */

import crypto from 'crypto';
import util from 'util';

const _pbkdf2 = util.promisify(crypto.pbkdf2);
import jwt from 'jsonwebtoken';
import { logger } from './logger.mjs';

if (!process.env.JWT_SECRET) {
  logger.error('FATAL: JWT_SECRET nu este setat!');
  process.exit(1);
}

export const JWT_SECRET  = process.env.JWT_SECRET;
export const JWT_EXPIRES = process.env.JWT_EXPIRES || '2h';
export const JWT_REFRESH_GRACE_SEC = parseInt(process.env.JWT_REFRESH_GRACE_SEC || '900');
export const ADMIN_SECRET = process.env.ADMIN_SECRET || null;
export const AUTH_COOKIE = 'auth_token';

// ── SEC-03: ADMIN_SECRET rate limiting — persistent în DB ───────────────────
// Înlocuiește Map in-memory (resetat la restart) cu login_blocks (persistent).
// Funcțiile sunt injectate din index.mjs via injectAdminRateLimiter(),
// același pattern ca injectRateLimiter() pentru login normal.
// Fallback la no-op dacă nu sunt injectate (ex. în teste unde DB nu e disponibil).
let _adminCheckRate   = async () => ({ blocked: false });
let _adminRecordFail  = async () => {};
let _adminClearRate   = async () => {};

export function injectAdminRateLimiter(check, record, clear) {
  _adminCheckRate  = check;
  _adminRecordFail = record;
  _adminClearRate  = clear;
}

// ── Hashing parolă — PBKDF2 cu versionare ──────────────────────────────────
// v1 (legacy):  "salt:hash"    → 100.000 iterații
// v2 (curent):  "v2:salt:hash" → 600.000 iterații (OWASP 2025)
const PBKDF2_ITER_V1 = 100_000;
const PBKDF2_ITER_V2 = 600_000;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await _pbkdf2(password, salt, PBKDF2_ITER_V2, 64, 'sha256')).toString('hex');
  return `v2:${salt}:${hash}`;
}

/**
 * verifyPassword — detectează versiunea și verifică.
 * Returnează { ok: boolean, needsRehash: boolean }
 * needsRehash=true → caller trebuie să re-hasheze parola cu v2 și să salveze în DB.
 */
export async function verifyPassword(password, stored) {
  if (!stored) return { ok: false, needsRehash: false };
  if (stored.startsWith('v2:')) {
    const rest = stored.slice(3);
    const idx = rest.indexOf(':');
    if (idx === -1) return { ok: false, needsRehash: false };
    const salt = rest.slice(0, idx), hash = rest.slice(idx + 1);
    const check = (await _pbkdf2(password, salt, PBKDF2_ITER_V2, 64, 'sha256')).toString('hex');
    return { ok: check === hash, needsRehash: false };
  }
  // hash v1 (legacy) — migrare lazy la v2 la următorul login
  if (!stored.includes(':')) return { ok: false, needsRehash: false };
  const [salt, hash] = stored.split(':');
  const check = (await _pbkdf2(password, salt, PBKDF2_ITER_V1, 64, 'sha256')).toString('hex');
  const ok = check === hash;
  return { ok, needsRehash: ok };
}

export function requireAuth(req, res) {
  let token = req.cookies?.[AUTH_COOKIE] || null;
  if (!token) {
    const auth = req.get('authorization') || '';
    token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  }
  if (!token) { res.status(401).json({ error: 'unauthorized' }); return null; }
  try { return jwt.verify(token, JWT_SECRET); }
  catch(e) { res.status(401).json({ error: 'token_invalid_or_expired' }); return null; }
}

// ── SEC-04: verificare token_version la endpoint-uri post-reset ───────────
// Funcția DB e injectată din index.mjs pentru a evita dependency cycle.
// Apelată explicit în admin.mjs după operații de reset parolă.
let _checkTokenVersion = null;
export function injectTokenVersionChecker(fn) { _checkTokenVersion = fn; }

/**
 * Verifică că token-ul JWT al actorului logat corespunde cu token_version din DB.
 * Apelat în endpoint-urile care cer invalidare imediată (reset-password, disable user).
 * Returnează true dacă tokenul e valid, false (și trimite 401) dacă e invalidat.
 */
export async function checkTokenVersionValid(actor, res) {
  if (!_checkTokenVersion || !actor?.userId || actor.tv == null) return true; // no-op dacă nu e injectat
  try {
    const dbVersion = await _checkTokenVersion(actor.userId);
    if (dbVersion == null) return true; // user nou fără coloană — backward compat
    if (Number(actor.tv) !== Number(dbVersion)) {
      res.status(401).json({ error: 'token_revoked', message: 'Sesiunea a expirat. Te rugăm să te autentifici din nou.' });
      return false;
    }
    return true;
  } catch(e) {
    logger.warn({ err: e }, 'checkTokenVersionValid: eroare DB (non-fatal, permitem)');
    return true; // fail-open — nu blocăm utilizatorul la erori DB tranzitorii
  }
}

/**
 * requireAdmin — verifică rol admin.
 * SEC-02: ADMIN_SECRET cu rate limiting + audit log.
 * Returnează true dacă accesul e respins, false dacă e permis.
 */
export async function requireAdmin(req, res) {
  if (ADMIN_SECRET) {
    const ip = req.ip || 'unknown';
    // SEC-03: rate check persistent în DB (via funcții injectate din index.mjs)
    const rateCheck = await _adminCheckRate(req, ip);
    if (rateCheck.blocked) {
      res.status(429).json({ error: 'too_many_attempts', remainSec: rateCheck.remainSec || 300 });
      return true;
    }
    const provided = req.get('x-admin-secret');
    if (provided) {
      if (provided === ADMIN_SECRET) {
        await _adminClearRate(req, ip);
        _writeAdminSecretAudit(req).catch(() => {});
        logger.warn({ ip, method: req.method, url: req.originalUrl }, 'ADMIN_SECRET bypass utilizat');
        return false;
      }
      await _adminRecordFail(req, ip);
      logger.warn({ ip, url: req.originalUrl }, 'ADMIN_SECRET: secret incorect');
      // Re-verificăm după înregistrare pentru a returna remainSec corect
      const recheckAfterFail = await _adminCheckRate(req, ip);
      if (recheckAfterFail.blocked) {
        res.status(429).json({ error: 'too_many_attempts', remainSec: recheckAfterFail.remainSec || 300 });
      } else {
        res.status(403).json({ error: 'forbidden' });
      }
      return true;
    }
  }
  const actor = requireAuth(req, res);
  if (!actor) return true;
  if (actor.role !== 'admin') { res.status(403).json({ error: 'forbidden' }); return true; }
  return false;
}

async function _writeAdminSecretAudit(req) {
  try {
    const { writeAuditEvent } = await import('../db/index.mjs');
    await writeAuditEvent({
      flowId: null, orgId: null,
      eventType: 'ADMIN_SECRET_ACCESS',
      actorEmail: 'system/admin-secret',
      actorIp: req.ip || null,
      payload: { method: req.method, url: req.originalUrl },
    });
  } catch(_) { /* fire-and-forget */ }
}

export function setAuthCookie(res, token, maxAgeMs) {
  res.cookie(AUTH_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV !== 'test',
    sameSite: 'strict',
    path: '/',
    maxAge: maxAgeMs || (2 * 60 * 60 * 1000),
  });
}

export function clearAuthCookie(res) {
  res.cookie(AUTH_COOKIE, '', {
    httpOnly: true, secure: process.env.NODE_ENV !== 'test',
    sameSite: 'strict', path: '/', maxAge: 0,
  });
}

export function generatePassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let p = '';
  for (let i = 0; i < 9; i++) { if (i===3||i===6) p+='-'; p+=chars[crypto.randomInt(chars.length)]; }
  return p;
}

export function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// BUG-04: getOptionalActor extras din 4 module flows/ în auth.mjs — single source of truth.
// Returnează payload JWT dacă există token valid (cookie sau Bearer), altfel null.
// Nu trimite eroare — folosit pe rute publice unde autentificarea e opțională.
export function getOptionalActor(req) {
  const cookieToken = req.cookies?.[AUTH_COOKIE] || null;
  if (cookieToken) { try { return jwt.verify(cookieToken, JWT_SECRET); } catch (_) {} }
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) { try { return jwt.verify(authHeader.slice(7), JWT_SECRET); } catch (_) {} }
  return null;
}
