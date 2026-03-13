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

// ── SEC-02: ADMIN_SECRET rate limiting ─────────────────────────────────────
const ADMIN_RL_MAX    = 5;
const ADMIN_RL_WIN_MS = 60_000;
const ADMIN_RL_BLK_MS = 5 * 60_000;
const _adminAttempts = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of _adminAttempts) {
    if ((e.blockedUntil && e.blockedUntil < now) ||
        (!e.blockedUntil && e.firstAt < now - ADMIN_RL_WIN_MS * 2))
      _adminAttempts.delete(ip);
  }
}, 10 * 60_000).unref();

function _adminRlBlocked(ip) {
  const now = Date.now();
  const e = _adminAttempts.get(ip);
  if (!e) return false;
  if (e.blockedUntil && e.blockedUntil > now) return e.blockedUntil;
  return false;
}

function _adminRlFail(ip) {
  const now = Date.now();
  let e = _adminAttempts.get(ip);
  if (!e || e.firstAt < now - ADMIN_RL_WIN_MS) e = { count: 0, firstAt: now, blockedUntil: null };
  e = { ...e, count: e.count + 1 };
  if (e.count >= ADMIN_RL_MAX) {
    e.blockedUntil = now + ADMIN_RL_BLK_MS;
    logger.warn({ ip, count: e.count }, 'ADMIN_SECRET: IP blocat 5 min dupa prea multe incercari');
  }
  _adminAttempts.set(ip, e);
  return e;
}

// ── Hashing parolă — PBKDF2 cu versionare ──────────────────────────────────
// v1 (legacy):  "salt:hash"    → 100.000 iterații
// v2 (curent):  "v2:salt:hash" → 600.000 iterații (OWASP 2025)
const PBKDF2_ITER_V1 = 100_000;
const PBKDF2_ITER_V2 = 600_000;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITER_V2, 64, 'sha256').toString('hex');
  return `v2:${salt}:${hash}`;
}

/**
 * verifyPassword — detectează versiunea și verifică.
 * Returnează { ok: boolean, needsRehash: boolean }
 * needsRehash=true → caller trebuie să re-hasheze parola cu v2 și să salveze în DB.
 */
export function verifyPassword(password, stored) {
  if (!stored) return { ok: false, needsRehash: false };
  if (stored.startsWith('v2:')) {
    const rest = stored.slice(3);
    const idx = rest.indexOf(':');
    if (idx === -1) return { ok: false, needsRehash: false };
    const salt = rest.slice(0, idx), hash = rest.slice(idx + 1);
    const check = crypto.pbkdf2Sync(password, salt, PBKDF2_ITER_V2, 64, 'sha256').toString('hex');
    return { ok: check === hash, needsRehash: false };
  }
  // hash v1 (legacy)
  if (!stored.includes(':')) return { ok: false, needsRehash: false };
  const [salt, hash] = stored.split(':');
  const check = crypto.pbkdf2Sync(password, salt, PBKDF2_ITER_V1, 64, 'sha256').toString('hex');
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

/**
 * requireAdmin — verifică rol admin.
 * SEC-02: ADMIN_SECRET cu rate limiting + audit log.
 * Returnează true dacă accesul e respins, false dacă e permis.
 */
export function requireAdmin(req, res) {
  if (ADMIN_SECRET) {
    const ip = req.ip || 'unknown';
    const blockedUntil = _adminRlBlocked(ip);
    if (blockedUntil) {
      const remainSec = Math.ceil((blockedUntil - Date.now()) / 1000);
      res.status(429).json({ error: 'too_many_attempts', remainSec });
      return true;
    }
    const provided = req.get('x-admin-secret');
    if (provided) {
      if (provided === ADMIN_SECRET) {
        _adminAttempts.delete(ip); // reset on success
        _writeAdminSecretAudit(req).catch(() => {});
        logger.warn({ ip, method: req.method, url: req.originalUrl }, 'ADMIN_SECRET bypass utilizat');
        return false;
      }
      const entry = _adminRlFail(ip);
      logger.warn({ ip, attempt: entry.count, url: req.originalUrl }, 'ADMIN_SECRET: secret incorect');
      if (entry.blockedUntil) {
        res.status(429).json({ error: 'too_many_attempts', remainSec: Math.ceil(ADMIN_RL_BLK_MS / 1000) });
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
