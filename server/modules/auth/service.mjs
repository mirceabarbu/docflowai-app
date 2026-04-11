/**
 * server/modules/auth/service.mjs — Authentication business logic (v4)
 */

import jwt from 'jsonwebtoken';
import { TOTP, generateSecret, generateURI } from 'otplib';
import qrcode from 'qrcode';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import util from 'util';

import config from '../../config.mjs';
import { pool } from '../../db/index.mjs';
import { logger } from '../../middleware/logger.mjs';
import { UnauthorizedError, ConflictError } from '../../core/errors.mjs';
import { hashPassword as bcryptHash } from '../../core/hashing.mjs';

const _pbkdf2 = util.promisify(crypto.pbkdf2);

// ── Password verification (supports bcrypt + PBKDF2 v1/v2) ───────────────────

async function _verifyPassword(plain, stored) {
  if (!stored) return { ok: false, needsRehash: false };

  if (stored.startsWith('$2')) {
    // bcrypt
    const ok = await bcrypt.compare(plain, stored);
    return { ok, needsRehash: false };
  }

  if (stored.startsWith('v2:')) {
    // PBKDF2 v2 (600k iterations)
    const rest = stored.slice(3);
    const idx  = rest.indexOf(':');
    if (idx === -1) return { ok: false, needsRehash: false };
    const salt = rest.slice(0, idx), hash = rest.slice(idx + 1);
    const check = (await _pbkdf2(plain, salt, 600_000, 64, 'sha256')).toString('hex');
    return { ok: check === hash, needsRehash: false };
  }

  // PBKDF2 v1 (100k iterations, legacy)
  if (!stored.includes(':')) return { ok: false, needsRehash: false };
  const [salt, hash] = stored.split(':');
  const check = (await _pbkdf2(plain, salt, 100_000, 64, 'sha256')).toString('hex');
  const ok = check === hash;
  return { ok, needsRehash: ok }; // trigger lazy re-hash on success
}

// ── JWT helpers ───────────────────────────────────────────────────────────────

function _signToken(user, expiresIn) {
  return jwt.sign(
    {
      sub:    user.id,
      email:  user.email,
      org_id: user.org_id,
      role:   user.role,
      name:   user.name || user.nume || '',
      ver:    user.token_version ?? 1,
      // Legacy fields kept for NO-TOUCH zone (cloud-signing reads actor.userId etc.)
      userId: user.id,
      orgId:  user.org_id,
      nume:   user.name || user.nume || '',
      tv:     user.token_version ?? 1,
      functie:      user.functie      || '',
      institutie:   user.institutie   || '',
      compartiment: user.compartiment || '',
    },
    config.JWT_SECRET,
    { expiresIn: expiresIn ?? config.JWT_EXPIRES }
  );
}

async function _writeAudit(params) {
  try {
    await pool.query(
      `INSERT INTO audit_log (flow_id, org_id, event_type, actor_email, actor_ip, payload)
       VALUES (NULL, $1, $2, $3, $4, $5)`,
      [params.orgId ?? null, params.eventType, params.actorEmail ?? null,
       params.ip ?? null, JSON.stringify(params.meta ?? {})]
    );
  } catch (e) {
    logger.error({ err: e }, 'auth audit write error');
  }
}

// ── login ─────────────────────────────────────────────────────────────────────

export async function login({ email, password, ip }) {
  const normalEmail = (email || '').toLowerCase().trim();

  const { rows } = await pool.query(
    `SELECT id, email, password_hash, hash_algo, role, org_id, name, nome,
            token_version, mfa_enabled, mfa_secret, totp_enabled, totp_secret,
            force_password_change, login_blocked_until, login_attempts,
            functie, institutie, compartiment, status
     FROM users WHERE lower(email)=$1 AND status='active' LIMIT 1`,
    [normalEmail]
  );

  if (rows.length === 0) {
    await _writeAudit({ eventType: 'auth.login.failed', actorEmail: normalEmail, ip,
      meta: { reason: 'user_not_found' } });
    throw new UnauthorizedError('Credențiale invalide');
  }

  const user = rows[0];

  // Check brute-force block
  if (user.login_blocked_until && new Date(user.login_blocked_until) > new Date()) {
    const remainSec = Math.ceil((new Date(user.login_blocked_until) - Date.now()) / 1000);
    throw Object.assign(new UnauthorizedError('Contul este blocat temporar'), { remainSec });
  }

  const { ok, needsRehash } = await _verifyPassword(password, user.password_hash);

  if (!ok) {
    const attempts = (user.login_attempts || 0) + 1;
    const blocked  = attempts >= 10;
    await pool.query(
      `UPDATE users SET login_attempts=$1,
        login_blocked_until = CASE WHEN $2 THEN NOW() + INTERVAL '15 minutes' ELSE login_blocked_until END,
        updated_at=NOW()
       WHERE id=$3`,
      [attempts, blocked, user.id]
    );
    await _writeAudit({ eventType: 'auth.login.failed', actorEmail: normalEmail, ip,
      orgId: user.org_id, meta: { reason: 'wrong_password', attempts } });
    if (blocked) {
      throw Object.assign(new UnauthorizedError('Cont blocat după 10 încercări'), { remainSec: 900 });
    }
    throw new UnauthorizedError('Credențiale invalide');
  }

  // Lazy PBKDF2 → bcrypt rehash
  if (needsRehash) {
    const newHash = await bcryptHash(password);
    await pool.query(
      `UPDATE users SET password_hash=$1, hash_algo='bcrypt', updated_at=NOW() WHERE id=$2`,
      [newHash, user.id]
    );
  }

  // Reset brute-force counters
  await pool.query(
    `UPDATE users SET login_attempts=0, login_blocked_until=NULL, updated_at=NOW() WHERE id=$1`,
    [user.id]
  );

  await _writeAudit({ eventType: 'auth.login.success', actorEmail: normalEmail, ip, orgId: user.org_id });

  // MFA check (TOTP preferred, fall back to legacy mfa_enabled)
  const mfaRequired = user.totp_enabled || user.mfa_enabled;
  if (mfaRequired) {
    const mfaToken = jwt.sign(
      { sub: user.id, mfa_pending: true },
      config.JWT_SECRET,
      { expiresIn: '5m' }
    );
    return { mfa_required: true, mfa_token: mfaToken };
  }

  return { user: _sanitize(user), accessToken: _signToken(user) };
}

// ── verifyMfa ─────────────────────────────────────────────────────────────────

export async function verifyMfa({ mfa_token, totp_code }) {
  let payload;
  try {
    payload = jwt.verify(mfa_token, config.JWT_SECRET);
  } catch {
    throw new UnauthorizedError('Token MFA invalid sau expirat');
  }
  if (!payload.mfa_pending) throw new UnauthorizedError('Token MFA invalid');

  const { rows } = await pool.query(
    `SELECT * FROM users WHERE id=$1 AND status='active' LIMIT 1`,
    [payload.sub]
  );
  if (!rows[0]) throw new UnauthorizedError('Utilizator negăsit');
  const user = rows[0];

  const secret = user.totp_secret || user.mfa_secret;
  if (!secret) throw new UnauthorizedError('MFA neconfigurat');

  const valid = TOTP.verify({ token: String(totp_code), secret });
  if (!valid) throw new UnauthorizedError('Cod TOTP incorect');

  return { user: _sanitize(user), accessToken: _signToken(user) };
}

// ── setupMfa ──────────────────────────────────────────────────────────────────

export async function setupMfa(userId) {
  const { rows } = await pool.query(
    'SELECT email FROM users WHERE id=$1 LIMIT 1',
    [userId]
  );
  if (!rows[0]) throw new UnauthorizedError('Utilizator negăsit');

  const secret      = generateSecret();
  const otpauthUrl  = generateURI({ label: rows[0].email, issuer: 'DocFlowAI', secret, type: 'totp' });
  const qrCodeDataUrl = await qrcode.toDataURL(otpauthUrl);

  // Store secret temporarily (not yet active — confirmMfa activates it)
  await pool.query(
    `UPDATE users SET totp_secret=$1, updated_at=NOW() WHERE id=$2`,
    [secret, userId]
  );

  return { secret, qrCodeDataUrl };
}

// ── confirmMfa ────────────────────────────────────────────────────────────────

export async function confirmMfa(userId, { totp_code }) {
  const { rows } = await pool.query(
    'SELECT totp_secret FROM users WHERE id=$1 LIMIT 1',
    [userId]
  );
  const secret = rows[0]?.totp_secret;
  if (!secret) throw new ConflictError('Rulați setup MFA mai întâi');

  const valid = TOTP.verify({ token: String(totp_code), secret });
  if (!valid) throw new UnauthorizedError('Cod TOTP incorect');

  await pool.query(
    `UPDATE users SET totp_enabled=TRUE, mfa_enabled=TRUE, updated_at=NOW() WHERE id=$1`,
    [userId]
  );
  await _writeAudit({ eventType: 'auth.mfa.enabled', orgId: null, meta: { userId } });
}

// ── logout ────────────────────────────────────────────────────────────────────

export async function logout(userId) {
  await _writeAudit({ eventType: 'auth.logout', meta: { userId } });
}

// ── changePassword ────────────────────────────────────────────────────────────

export async function changePassword(userId, { currentPassword, newPassword }) {
  const { rows } = await pool.query(
    'SELECT id, org_id, email, password_hash, token_version FROM users WHERE id=$1 LIMIT 1',
    [userId]
  );
  if (!rows[0]) throw new UnauthorizedError('Utilizator negăsit');
  const user = rows[0];

  const { ok } = await _verifyPassword(currentPassword, user.password_hash);
  if (!ok) throw new UnauthorizedError('Parola curentă incorectă');

  const newHash = await bcryptHash(newPassword);
  await pool.query(
    `UPDATE users SET password_hash=$1, hash_algo='bcrypt',
       token_version = token_version + 1,
       force_password_change=FALSE, updated_at=NOW()
     WHERE id=$2`,
    [newHash, userId]
  );

  await _writeAudit({ eventType: 'auth.password.changed', actorEmail: user.email,
    orgId: user.org_id, meta: { userId } });
}

// ── refreshToken ──────────────────────────────────────────────────────────────

export async function refreshToken(oldToken) {
  let payload;
  try {
    payload = jwt.verify(oldToken, config.JWT_SECRET, { ignoreExpiration: true });
  } catch {
    throw new UnauthorizedError('Token invalid');
  }

  // Grace period check
  const expiresAt = (payload.exp ?? 0) * 1000;
  const graceMs   = config.JWT_REFRESH_GRACE_SEC * 1000;
  if (Date.now() > expiresAt + graceMs) {
    throw new UnauthorizedError('Token expirat — grace period depășit');
  }

  const userId = payload.sub ?? payload.userId;
  const { rows } = await pool.query(
    'SELECT id, email, org_id, role, name, token_version, status FROM users WHERE id=$1 LIMIT 1',
    [userId]
  );
  if (!rows[0] || rows[0].status !== 'active') throw new UnauthorizedError('Utilizator inactiv');

  const user = rows[0];
  const ver  = payload.ver ?? payload.tv ?? 1;
  if (Number(ver) !== Number(user.token_version)) {
    throw new UnauthorizedError('Token revocat');
  }

  return _signToken(user);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _sanitize(user) {
  const { password_hash, mfa_secret, totp_secret, totp_backup_codes, ...safe } = user;
  return safe;
}
