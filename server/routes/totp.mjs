/**
 * DocFlowAI — 2FA TOTP routes (otplib v12+ API)
 *
 * Folosește otplib cu API-ul nou: generateSecret, generateSync, verifySync
 * Compatibil Google Authenticator, Authy, orice app TOTP (RFC 6238 / SHA1)
 *
 * SEC-03 (b175): backup codes stocate ca SHA-256 hash în DB — nu în clar.
 *   La activare: generăm codurile raw, le returnăm utilizatorului O SINGURĂ DATĂ,
 *   salvăm doar hash-urile. La verificare: hash(input) === hash_stocat.
 *   Codurile existente în DB (plaintext) sunt detectate automat prin lungime/format
 *   și tratate cu fallback pentru backward-compat (upgrade lazy la primul login).
 */

import { Router } from 'express';
import { generateSecret, generateSync, verifySync } from 'otplib';
import crypto from 'crypto';
import { requireAuth, JWT_SECRET, AUTH_COOKIE } from '../middleware/auth.mjs';
import { pool, requireDb } from '../db/index.mjs';
import { logger } from '../middleware/logger.mjs';
import jwt from 'jsonwebtoken';

const router = Router();

const ISSUER      = 'DocFlowAI';
const BACKUP_COUNT = 8;
const TOTP_OPTS   = { algorithm: 'sha1', digits: 6, period: 30 };

function makeOtpauthUrl(email, secret) {
  return `otpauth://totp/${encodeURIComponent(ISSUER)}:${encodeURIComponent(email)}`
    + `?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=6&period=30`;
}

function totpGenerate(secret) {
  return generateSync({ secret, ...TOTP_OPTS });
}

function totpVerify(token, secret) {
  try {
    const result = verifySync({ secret, token: String(token).trim(), ...TOTP_OPTS });
    if (result && typeof result === 'object') return result.valid === true;
    return result === true;
  } catch { return false; }
}

function generateBackupCodes() {
  return Array.from({ length: BACKUP_COUNT }, () =>
    crypto.randomBytes(4).toString('hex').toUpperCase()
  );
}

// SEC-03: hash SHA-256 pentru stocare backup codes
function hashBackupCode(code) {
  return crypto.createHash('sha256').update(code.toUpperCase().trim()).digest('hex');
}

// SEC-03: verificare backup code față de lista de hash-uri stocate
// Returnează indexul din array dacă găsit, -1 altfel.
// Backward-compat: dacă hash-ul stocat are lungime 8 (plaintext hex vechi), comparăm direct.
function findBackupCode(inputCode, storedCodes) {
  if (!Array.isArray(storedCodes)) return -1;
  const input = inputCode.toUpperCase().trim();
  const inputHash = hashBackupCode(input);
  return storedCodes.findIndex(stored => {
    if (!stored) return false;
    // Hash nou (64 chars hex SHA-256)
    if (stored.length === 64) return stored === inputHash;
    // Plaintext vechi (8 chars hex uppercase) — fallback backward-compat
    return stored.toUpperCase() === input;
  });
}

// ── POST /auth/totp/setup ─────────────────────────────────────────────────────
router.post('/auth/totp/setup', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin' && actor.role !== 'org_admin')
    return res.status(403).json({ error: 'forbidden', message: 'Disponibil doar pentru administratori.' });

  try {
    const { rows } = await pool.query('SELECT totp_enabled FROM users WHERE id=$1', [actor.userId]);
    if (rows[0]?.totp_enabled)
      return res.status(409).json({ error: 'already_enabled', message: '2FA este deja activat.' });

    const secret = generateSecret(20);
    await pool.query('UPDATE users SET totp_secret=$1, totp_enabled=false WHERE id=$2', [secret, actor.userId]);

    const otpauthUrl = makeOtpauthUrl(actor.email, secret);
    logger.info({ userId: actor.userId }, '2FA TOTP: setup initiat');

    res.json({ ok: true, secret, otpauthUrl, issuer: ISSUER });
  } catch(e) {
    logger.error({ err: e }, 'totp/setup error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── POST /auth/totp/confirm ───────────────────────────────────────────────────
router.post('/auth/totp/confirm', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;

  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code_required' });

  try {
    const { rows } = await pool.query(
      'SELECT totp_secret, totp_enabled FROM users WHERE id=$1', [actor.userId]
    );
    const user = rows[0];
    if (!user?.totp_secret)
      return res.status(400).json({ error: 'setup_required', message: 'Rulați mai întâi /auth/totp/setup.' });
    if (user.totp_enabled)
      return res.status(409).json({ error: 'already_enabled' });

    if (!totpVerify(code, user.totp_secret))
      return res.status(400).json({ error: 'invalid_code', message: 'Cod incorect. Verificați că ora dispozitivului este sincronizată.' });

    // SEC-03: generăm coduri raw, salvăm hash-urile, returnăm raw O SINGURĂ DATĂ
    const rawCodes = generateBackupCodes();
    const hashedCodes = rawCodes.map(hashBackupCode);
    await pool.query('UPDATE users SET totp_enabled=true, totp_backup_codes=$1 WHERE id=$2',
      [hashedCodes, actor.userId]);

    logger.info({ userId: actor.userId }, '2FA TOTP: activat (backup codes hashed)');
    res.json({ ok: true, message: '2FA activat cu succes.', backupCodes: rawCodes });
  } catch(e) {
    logger.error({ err: e }, 'totp/confirm error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── POST /auth/totp/disable ───────────────────────────────────────────────────
router.post('/auth/totp/disable', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;

  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code_required' });

  try {
    const { rows } = await pool.query(
      'SELECT totp_secret, totp_enabled, totp_backup_codes FROM users WHERE id=$1', [actor.userId]
    );
    const user = rows[0];
    if (!user?.totp_enabled)
      return res.status(400).json({ error: 'not_enabled' });

    const codeStr  = String(code).trim().toUpperCase();
    const totpOk   = totpVerify(codeStr, user.totp_secret);
    // SEC-03: folosim findBackupCode cu suport backward-compat
    const backupIdx = totpOk ? -1 : findBackupCode(codeStr, user.totp_backup_codes || []);

    if (!totpOk && backupIdx === -1)
      return res.status(400).json({ error: 'invalid_code', message: 'Cod incorect.' });

    await pool.query(
      'UPDATE users SET totp_enabled=false, totp_secret=NULL, totp_backup_codes=NULL WHERE id=$1',
      [actor.userId]
    );
    logger.info({ userId: actor.userId, via: totpOk ? 'totp' : 'backup' }, '2FA TOTP: dezactivat');
    res.json({ ok: true, message: '2FA dezactivat.' });
  } catch(e) {
    logger.error({ err: e }, 'totp/disable error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── POST /auth/totp/verify — a doua etapă la login ───────────────────────────
router.post('/auth/totp/verify', async (req, res) => {
  if (requireDb(res)) return;

  const { pending_token, code } = req.body || {};
  if (!pending_token || !code)
    return res.status(400).json({ error: 'missing_params' });

  try {
    let payload;
    try { payload = jwt.verify(pending_token, JWT_SECRET); }
    catch { return res.status(401).json({ error: 'invalid_pending_token', message: 'Token expirat. Relogați-vă.' }); }

    if (!payload.requires2fa)
      return res.status(400).json({ error: 'not_2fa_token' });

    const { rows } = await pool.query(
      'SELECT id,email,role,org_id,totp_secret,totp_enabled,totp_backup_codes,token_version,nume,functie,institutie,compartiment FROM users WHERE id=$1',
      [payload.userId]
    );
    const user = rows[0];
    if (!user || !user.totp_enabled)
      return res.status(400).json({ error: 'totp_not_enabled' });

    const codeStr  = String(code).trim().toUpperCase();
    const totpOk   = totpVerify(codeStr, user.totp_secret);
    // SEC-03: verificare cu hash + backward-compat pentru coduri vechi plaintext
    const backups   = user.totp_backup_codes || [];
    const backupIdx = totpOk ? -1 : findBackupCode(codeStr, backups);

    if (!totpOk && backupIdx === -1)
      return res.status(400).json({ error: 'invalid_code', message: 'Cod incorect.' });

    // Consumam backup code dacă a fost folosit
    if (!totpOk && backupIdx !== -1) {
      const remaining = backups.filter((_, i) => i !== backupIdx);
      await pool.query('UPDATE users SET totp_backup_codes=$1 WHERE id=$2', [remaining, user.id]);
      logger.warn({ userId: user.id, codesLeft: remaining.length }, '2FA: backup code folosit');
    }

    const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';
    const fullToken = jwt.sign(
      {
        userId: user.id, email: user.email, role: user.role, orgId: user.org_id,
        tv: user.token_version ?? 1, nume: user.nume, functie: user.functie,
        institutie: user.institutie, compartiment: user.compartiment || '',
      },
      JWT_SECRET, { expiresIn: JWT_EXPIRES }
    );

    const maxAgeMs = 8 * 60 * 60 * 1000;
    res.cookie(AUTH_COOKIE, fullToken, {
      httpOnly: true, sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: maxAgeMs, path: '/',
    });
    const csrfToken = crypto.randomBytes(32).toString('hex');
    res.cookie('csrf_token', csrfToken, {
      httpOnly: false, sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: maxAgeMs, path: '/',
    });

    logger.info({ userId: user.id, via: totpOk ? 'totp' : 'backup' }, '2FA: login verificat');
    res.json({ ok: true, email: user.email, role: user.role });
  } catch(e) {
    logger.error({ err: e }, 'totp/verify error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── GET /auth/totp/status ─────────────────────────────────────────────────────
router.get('/auth/totp/status', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows } = await pool.query(
      'SELECT totp_enabled, totp_backup_codes FROM users WHERE id=$1', [actor.userId]
    );
    res.json({
      ok: true,
      enabled: !!rows[0]?.totp_enabled,
      backupCodesRemaining: (rows[0]?.totp_backup_codes || []).length,
    });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

export default router;
