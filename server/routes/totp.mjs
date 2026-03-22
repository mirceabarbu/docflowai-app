/**
 * DocFlowAI — 2FA TOTP routes
 *
 * Disponibil pentru admin și org_admin.
 * Folosește otplib (RFC 6238) — compatibil Google Authenticator, Authy, etc.
 *
 * Flow activare:
 *   1. POST /auth/totp/setup     → generează secret + QR code URL
 *   2. POST /auth/totp/confirm   → verifică primul cod → activează 2FA
 *   3. POST /auth/totp/disable   → dezactivează 2FA (necesită cod valid sau backup)
 *
 * Flow login cu 2FA:
 *   - POST /auth/login returnează { requires2fa: true } dacă 2FA e activat
 *   - Frontend trimite POST /auth/totp/verify cu codul din aplicație
 *   - La succes: setăm auth_token cookie ca la login normal
 */

import { Router } from 'express';
import { authenticator } from 'otplib';
import crypto from 'crypto';
import { requireAuth, JWT_SECRET, AUTH_COOKIE } from '../middleware/auth.mjs';
import { pool, requireDb } from '../db/index.mjs';
import { logger } from '../middleware/logger.mjs';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';

const router = Router();

// Configurare otplib — window 1 = toleranță ±30s (standard)
authenticator.options = { window: 1 };

const ISSUER = 'DocFlowAI';
const BACKUP_COUNT = 8; // coduri de backup generate

function generateBackupCodes() {
  return Array.from({ length: BACKUP_COUNT }, () =>
    crypto.randomBytes(4).toString('hex').toUpperCase() // ex: A1B2C3D4
  );
}

// ── POST /auth/totp/setup — generează secret TOTP + URL pentru QR ────────────
router.post('/auth/totp/setup', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;

  // Doar admin și org_admin pot activa 2FA
  if (actor.role !== 'admin' && actor.role !== 'org_admin')
    return res.status(403).json({ error: 'forbidden', message: 'Disponibil doar pentru administratori.' });

  try {
    // Verificam daca nu are deja 2FA activat
    const { rows } = await pool.query(
      'SELECT totp_enabled FROM users WHERE id=$1', [actor.userId]
    );
    if (rows[0]?.totp_enabled)
      return res.status(409).json({ error: 'already_enabled', message: '2FA este deja activat. Dezactivează-l mai întâi.' });

    // Generăm secret nou
    const secret = authenticator.generateSecret(20); // 20 bytes = 160 bits

    // Salvăm secret-ul (neconfirmat încă — totp_enabled rămâne false)
    await pool.query(
      'UPDATE users SET totp_secret=$1, totp_enabled=false WHERE id=$2',
      [secret, actor.userId]
    );

    // URL pentru QR code — compatibil orice app TOTP
    const otpauthUrl = authenticator.keyuri(actor.email, ISSUER, secret);

    logger.info({ userId: actor.userId, email: actor.email }, '2FA TOTP: setup inițiat');

    res.json({
      ok: true,
      secret,          // afișat ca text pentru introducere manuală
      otpauthUrl,      // folosit pentru generare QR pe frontend
      issuer: ISSUER,
    });
  } catch(e) {
    logger.error({ err: e }, 'totp/setup error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── POST /auth/totp/confirm — confirmă activarea cu primul cod ───────────────
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

    // Verificam codul
    const isValid = authenticator.verify({ token: String(code).trim(), secret: user.totp_secret });
    if (!isValid)
      return res.status(400).json({ error: 'invalid_code', message: 'Cod incorect. Verificați că ora dispozitivului este sincronizată.' });

    // Generăm coduri de backup
    const backupCodes = generateBackupCodes();

    // Activăm 2FA
    await pool.query(
      'UPDATE users SET totp_enabled=true, totp_backup_codes=$1 WHERE id=$2',
      [backupCodes, actor.userId]
    );

    logger.info({ userId: actor.userId, email: actor.email }, '2FA TOTP: activat cu succes');

    res.json({
      ok: true,
      message: '2FA activat cu succes.',
      backupCodes, // afișate o singură dată — utilizatorul trebuie să le salveze
    });
  } catch(e) {
    logger.error({ err: e }, 'totp/confirm error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── POST /auth/totp/disable — dezactivează 2FA ───────────────────────────────
router.post('/auth/totp/disable', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;

  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code_required', message: 'Introduceți codul TOTP sau un cod de backup.' });

  try {
    const { rows } = await pool.query(
      'SELECT totp_secret, totp_enabled, totp_backup_codes FROM users WHERE id=$1', [actor.userId]
    );
    const user = rows[0];
    if (!user?.totp_enabled)
      return res.status(400).json({ error: 'not_enabled', message: '2FA nu este activat.' });

    // Verificăm codul TOTP sau codul de backup
    const codeStr = String(code).trim().toUpperCase();
    const totpValid = authenticator.verify({ token: codeStr, secret: user.totp_secret });
    const backupCodes = user.totp_backup_codes || [];
    const backupIdx   = backupCodes.indexOf(codeStr);
    const backupValid = backupIdx !== -1;

    if (!totpValid && !backupValid)
      return res.status(400).json({ error: 'invalid_code', message: 'Cod incorect.' });

    // Dezactivăm
    await pool.query(
      'UPDATE users SET totp_enabled=false, totp_secret=NULL, totp_backup_codes=NULL WHERE id=$1',
      [actor.userId]
    );

    logger.info({ userId: actor.userId, email: actor.email, via: totpValid ? 'totp' : 'backup' }, '2FA TOTP: dezactivat');

    res.json({ ok: true, message: '2FA dezactivat cu succes.' });
  } catch(e) {
    logger.error({ err: e }, 'totp/disable error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── POST /auth/totp/verify — verificare cod la login (a doua etapă) ──────────
// Preia un pending_token (JWT cu flag requires2fa) și codul TOTP
// Returnează auth_token complet dacă codul e valid
router.post('/auth/totp/verify', async (req, res) => {
  if (requireDb(res)) return;

  const { pending_token, code } = req.body || {};
  if (!pending_token || !code)
    return res.status(400).json({ error: 'missing_params' });

  try {
    // Verificăm pending_token
    let payload;
    try {
      payload = jwt.verify(pending_token, JWT_SECRET);
    } catch(e) {
      return res.status(401).json({ error: 'invalid_pending_token', message: 'Token expirat. Relogați-vă.' });
    }

    if (!payload.requires2fa)
      return res.status(400).json({ error: 'not_2fa_token' });

    // Citim user din DB
    const { rows } = await pool.query(
      'SELECT id, email, role, org_id, totp_secret, totp_enabled, totp_backup_codes, token_version FROM users WHERE id=$1',
      [payload.userId]
    );
    const user = rows[0];
    if (!user || !user.totp_enabled)
      return res.status(400).json({ error: 'totp_not_enabled' });

    // Verificăm codul TOTP sau backup
    const codeStr   = String(code).trim().toUpperCase();
    const totpValid = authenticator.verify({ token: codeStr, secret: user.totp_secret });
    const backupCodes = user.totp_backup_codes || [];
    const backupIdx   = backupCodes.indexOf(codeStr);
    const backupValid = backupIdx !== -1;

    if (!totpValid && !backupValid)
      return res.status(400).json({ error: 'invalid_code', message: 'Cod incorect.' });

    // Dacă a folosit un backup code — îl consumăm (one-time use)
    if (backupValid) {
      const remaining = backupCodes.filter((_, i) => i !== backupIdx);
      await pool.query('UPDATE users SET totp_backup_codes=$1 WHERE id=$2', [remaining, user.id]);
      logger.warn({ userId: user.id, codesLeft: remaining.length }, '2FA: backup code folosit');
    }

    // Emitem JWT complet (fără flag requires2fa)
    const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';
    const fullToken = jwt.sign(
      {
        userId: user.id, email: user.email, role: user.role,
        orgId: user.org_id, tv: user.token_version ?? 1,
        // Re-includem payload complet din pending_token
        nume: payload.nume, functie: payload.functie,
        institutie: payload.institutie, compartiment: payload.compartiment,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );

    const maxAgeMs = 8 * 60 * 60 * 1000;
    res.cookie(AUTH_COOKIE, fullToken, {
      httpOnly: true, sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: maxAgeMs, path: '/',
    });

    // Regeneram CSRF token
    const csrfToken = crypto.randomBytes(32).toString('hex');
    res.cookie('csrf_token', csrfToken, {
      httpOnly: false, sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: maxAgeMs, path: '/',
    });

    logger.info({ userId: user.id, email: user.email, via: totpValid ? 'totp' : 'backup' }, '2FA TOTP: login verificat');

    res.json({
      ok: true,
      email: user.email, role: user.role,
      message: '2FA verificat cu succes.',
    });
  } catch(e) {
    logger.error({ err: e }, 'totp/verify error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── GET /auth/totp/status — starea 2FA pentru userul curent ─────────────────
router.get('/auth/totp/status', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;

  try {
    const { rows } = await pool.query(
      'SELECT totp_enabled, totp_backup_codes FROM users WHERE id=$1', [actor.userId]
    );
    const user = rows[0];
    res.json({
      ok: true,
      enabled: !!user?.totp_enabled,
      backupCodesRemaining: (user?.totp_backup_codes || []).length,
    });
  } catch(e) {
    res.status(500).json({ error: 'server_error' });
  }
});

export default router;
