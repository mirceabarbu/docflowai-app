/**
 * DocFlowAI — Auth middleware v3.2.0
 * requireAuth, requireAdmin, hashPassword, verifyPassword, JWT helpers.
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

export function requireAuth(req, res) {
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
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
 * FIX: generatePassword — fara plain_password in DB.
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
