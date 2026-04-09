/**
 * server/modules/auth/routes.mjs — Auth API routes (v4)
 * Mounted at /api/auth in app.mjs
 */

import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.mjs';
import { AUTH_COOKIE, setAuthCookie, clearAuthCookie } from '../../middleware/auth.mjs';
import { loginLimiter } from '../../middleware/rateLimiter.mjs';
import {
  login, verifyMfa, setupMfa, confirmMfa, logout,
  changePassword, refreshToken,
} from './service.mjs';

const router = Router();

// ── POST /api/auth/login ──────────────────────────────────────────────────────

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'email_and_password_required' });
    }
    if (typeof password === 'string' && password.length > 200) {
      return res.status(400).json({ error: 'password_too_long', max: 200 });
    }

    const result = await login({ email, password, ip: req.ip });

    if (result.mfa_required) {
      return res.json({ mfa_required: true, mfa_token: result.mfa_token });
    }

    setAuthCookie(res, result.accessToken);
    return res.json({
      ok:                    true,
      email:                 result.user.email,
      role:                  result.user.role,
      orgId:                 result.user.org_id,
      name:                  result.user.name || result.user.nume,
      force_password_change: !!result.user.force_password_change,
    });
  } catch (err) {
    if (err.statusCode === 401) {
      return res.status(401).json({
        error: 'invalid_credentials',
        ...(err.remainSec ? { remainSec: err.remainSec } : {}),
      });
    }
    next(err);
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────

router.post('/logout', async (req, res, next) => {
  try {
    const userId = req.user?.id ?? null;
    if (userId) await logout(userId);
    clearAuthCookie(res);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/refresh ────────────────────────────────────────────────────

router.post('/refresh', async (req, res, next) => {
  try {
    const oldToken = req.cookies?.[AUTH_COOKIE]
      || (req.headers.authorization || '').replace('Bearer ', '');
    if (!oldToken) return res.status(401).json({ error: 'no_token' });

    const newToken = await refreshToken(oldToken);
    setAuthCookie(res, newToken);
    res.json({ ok: true });
  } catch (err) {
    if (err.statusCode === 401) return res.status(401).json({ error: err.message });
    next(err);
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────

router.get('/me', requireAuth, (req, res) => {
  const { id, email, org_id, role, name, ver } = req.user;
  res.json({ id, email, org_id, role, name, ver });
});

// ── POST /api/auth/mfa/setup ──────────────────────────────────────────────────

router.post('/mfa/setup', requireAuth, async (req, res, next) => {
  try {
    const result = await setupMfa(req.user.id);
    res.json(result);
  } catch (err) { next(err); }
});

// ── POST /api/auth/mfa/confirm ────────────────────────────────────────────────

router.post('/mfa/confirm', requireAuth, async (req, res, next) => {
  try {
    await confirmMfa(req.user.id, req.body);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /api/auth/mfa/login ──────────────────────────────────────────────────

router.post('/mfa/login', async (req, res, next) => {
  try {
    const { mfa_token, totp_code } = req.body;
    if (!mfa_token || !totp_code) {
      return res.status(400).json({ error: 'mfa_token_and_code_required' });
    }
    const result = await verifyMfa({ mfa_token, totp_code });
    setAuthCookie(res, result.accessToken);
    res.json({ ok: true, email: result.user.email, role: result.user.role });
  } catch (err) {
    if (err.statusCode === 401) return res.status(401).json({ error: err.message });
    next(err);
  }
});

// ── POST /api/auth/change-password ────────────────────────────────────────────

router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'both_passwords_required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'password_too_short', min: 8 });
    }
    await changePassword(req.user.id, { currentPassword, newPassword });
    clearAuthCookie(res); // force re-login with new password
    res.json({ ok: true });
  } catch (err) {
    if (err.statusCode === 401) return res.status(401).json({ error: err.message });
    next(err);
  }
});

export default router;
