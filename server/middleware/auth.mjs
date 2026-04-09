/**
 * DocFlowAI — Auth middleware v4.0.0
 *
 * v4 changes:
 *  - AUTH_COOKIE renamed to 'dfai_token'
 *  - requireAuth: dual-mode — returns actor (2-arg, legacy NO-TOUCH compat)
 *                             or proper Express middleware populating req.user (3-arg)
 *  - requireAdmin: proper Express middleware (role check only)
 *  - All v3 exports preserved for NO-TOUCH zone compatibility
 */

import crypto from 'crypto';
import util from 'util';
import jwt from 'jsonwebtoken';
import { logger } from './logger.mjs';

const _pbkdf2 = util.promisify(crypto.pbkdf2);

if (!process.env.JWT_SECRET) {
  logger.error('FATAL: JWT_SECRET nu este setat!');
  process.exit(1);
}

export const AUTH_COOKIE            = 'dfai_token';
export const JWT_SECRET             = process.env.JWT_SECRET;
export const JWT_EXPIRES            = process.env.JWT_EXPIRES || '8h';
export const JWT_REFRESH_GRACE_SEC  = parseInt(process.env.JWT_REFRESH_GRACE_SEC || '900');
export const ADMIN_SECRET           = process.env.ADMIN_SECRET || null;

// ── PBKDF2 hashing (legacy v3, kept for backward compat) ─────────────────────
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
  if (!stored.includes(':')) return { ok: false, needsRehash: false };
  const [salt, hash] = stored.split(':');
  const check = (await _pbkdf2(password, salt, PBKDF2_ITER_V1, 64, 'sha256')).toString('hex');
  const ok = check === hash;
  return { ok, needsRehash: ok };
}

// ── Token version injection (SEC-04) ─────────────────────────────────────────
let _checkTokenVersion = null;
export function injectTokenVersionChecker(fn) { _checkTokenVersion = fn; }

export async function checkTokenVersionValid(actor, res) {
  if (!_checkTokenVersion || !actor?.userId || actor.tv == null) return true;
  try {
    const dbVersion = await _checkTokenVersion(actor.userId);
    if (dbVersion == null) return true;
    if (Number(actor.tv) !== Number(dbVersion)) {
      res.status(401).json({ error: 'token_revoked', message: 'Sesiunea a expirat. Te rugăm să te autentifici din nou.' });
      return false;
    }
    return true;
  } catch (e) {
    logger.warn({ err: e }, 'checkTokenVersionValid: eroare DB (non-fatal)');
    return true;
  }
}

// ── ADMIN_SECRET rate limiting injection ─────────────────────────────────────
let _adminCheckRate   = async () => ({ blocked: false });
let _adminRecordFail  = async () => {};
let _adminClearRate   = async () => {};

export function injectAdminRateLimiter(check, record, clear) {
  _adminCheckRate  = check;
  _adminRecordFail = record;
  _adminClearRate  = clear;
}

// ── Internal token extractor ──────────────────────────────────────────────────
function _extractToken(req) {
  const cookieToken = req.cookies?.[AUTH_COOKIE] || null;
  if (cookieToken) return cookieToken;
  const auth = req.get('authorization') || '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
}

function _buildUser(payload) {
  // Support both v4 format (sub, org_id, name, ver) and v3 legacy (userId, orgId, nume, tv)
  const id     = payload.sub      ?? payload.userId;
  const orgId  = payload.org_id   ?? payload.orgId;
  const name   = payload.name     ?? payload.nume;
  const ver    = payload.ver      ?? payload.tv;
  return {
    id,     email: payload.email, org_id: orgId,
    role:   payload.role,
    name,   ver,
    // keep original fields for legacy callers (NO-TOUCH zone uses actor.userId etc.)
    userId: id,   orgId,
    nume:   name, tv: ver,
    functie:      payload.functie,
    institutie:   payload.institutie,
    compartiment: payload.compartiment,
  };
}

/**
 * requireAuth — dual-mode:
 *
 *   Legacy (2-arg):   const actor = requireAuth(req, res);  if (!actor) return;
 *   Middleware (3-arg): router.get('/path', requireAuth, handler)  →  req.user populated
 *
 * Populates req.user with { id, email, org_id, role, name, ver, ...legacy fields }.
 */
export function requireAuth(req, res, next) {
  const token = _extractToken(req);
  if (!token) {
    res.status(401).json({ error: 'unauthorized' });
    return next ? undefined : null;
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = _buildUser(payload);
    req.user = user;
    if (next) return next();
    return payload; // legacy: return raw payload for NO-TOUCH callers
  } catch (e) {
    res.status(401).json({ error: 'token_invalid_or_expired' });
    return next ? undefined : null;
  }
}

/**
 * requireAdmin — Express middleware.
 * Expects requireAuth to have run first (req.user populated).
 * Falls back to extracting token itself if req.user is absent.
 * Supports legacy ADMIN_SECRET bypass for backward compat.
 */
export async function requireAdmin(req, res, next) {
  // ADMIN_SECRET bypass (legacy SEC-02)
  if (ADMIN_SECRET) {
    const ip = req.ip || 'unknown';
    const rateCheck = await _adminCheckRate(req, ip);
    if (rateCheck.blocked) {
      return res.status(429).json({ error: 'too_many_attempts', remainSec: rateCheck.remainSec || 300 });
    }
    const provided = req.get('x-admin-secret');
    if (provided) {
      if (provided === ADMIN_SECRET) {
        await _adminClearRate(req, ip);
        _writeAdminSecretAudit(req).catch(() => {});
        logger.warn({ ip, method: req.method, url: req.originalUrl }, 'ADMIN_SECRET bypass utilizat');
        return next();
      }
      await _adminRecordFail(req, ip);
      const recheck = await _adminCheckRate(req, ip);
      if (recheck.blocked) {
        return res.status(429).json({ error: 'too_many_attempts', remainSec: recheck.remainSec || 300 });
      }
      return res.status(403).json({ error: 'forbidden' });
    }
  }

  // Ensure req.user is populated
  if (!req.user) {
    const token = _extractToken(req);
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    try {
      req.user = _buildUser(jwt.verify(token, JWT_SECRET));
    } catch (e) {
      return res.status(401).json({ error: 'token_invalid_or_expired' });
    }
  }

  if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'forbidden' });
  }

  return next();
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
  } catch (_) { /* fire-and-forget */ }
}

export function setAuthCookie(res, token, maxAgeMs) {
  res.cookie(AUTH_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV !== 'test',
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeMs || (8 * 60 * 60 * 1000),
  });
}

export function clearAuthCookie(res) {
  res.cookie(AUTH_COOKIE, '', {
    httpOnly: true, secure: process.env.NODE_ENV !== 'test',
    sameSite: 'lax', path: '/', maxAge: 0,
  });
}

export function generatePassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let p = '';
  for (let i = 0; i < 9; i++) { if (i === 3 || i === 6) p += '-'; p += chars[crypto.randomInt(chars.length)]; }
  return p;
}

export function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * getOptionalActor — returns JWT payload if valid token present, null otherwise.
 * Never throws. Used on public routes where auth is optional.
 */
export function getOptionalActor(req) {
  const token = _extractToken(req);
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch (_) { return null; }
}
