/**
 * DocFlowAI — Auth routes
 * POST /auth/login, GET /auth/me, POST /auth/refresh
 */

import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { JWT_SECRET, JWT_EXPIRES, requireAuth, verifyPassword } from '../middleware/auth.mjs';
import { pool, DB_READY, requireDb } from '../db/index.mjs';

const router = Router();

// Rate limiter helpers (importate din index.mjs via context — injectate la montare)
let _checkLoginRate, _recordLoginFail, _clearLoginRate;
export function injectRateLimiter(check, record, clear) {
  _checkLoginRate = check; _recordLoginFail = record; _clearLoginRate = clear;
}

router.post('/auth/login', async (req, res) => {
  if (requireDb(res)) return;
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email_and_password_required' });
  const rateCheck = await _checkLoginRate(req, email);
  if (rateCheck.blocked) {
    return res.status(429).json({
      error: 'too_many_attempts',
      message: `Prea multe încercări. Încearcă din nou în ${Math.ceil(rateCheck.remainSec/60)} minute.`,
      remainSec: rateCheck.remainSec
    });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email.trim().toLowerCase()]);
    const user = rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      await _recordLoginFail(req, email);
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    await _clearLoginRate(req, email);
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role, orgId: user.org_id, nume: user.nume, functie: user.functie, institutie: user.institutie },
      JWT_SECRET, { expiresIn: JWT_EXPIRES }
    );
    return res.json({ token, email: user.email, role: user.role, orgId: user.org_id, nume: user.nume, functie: user.functie, institutie: user.institutie });
  } catch(e) { return res.status(500).json({ error: 'server_error' }); }
});

router.get('/auth/me', async (req, res) => {
  const decoded = requireAuth(req, res);
  if (!decoded) return;
  if (!pool || !DB_READY) return res.json(decoded);
  try {
    const { rows } = await pool.query('SELECT id,email,nume,functie,institutie,role,org_id FROM users WHERE id=$1', [decoded.userId]);
    if (!rows[0]) return res.status(401).json({ error: 'user_not_found' });
    res.json({ userId: rows[0].id, email: rows[0].email, orgId: rows[0].org_id, nume: rows[0].nume, functie: rows[0].functie, institutie: rows[0].institutie, role: rows[0].role });
  } catch(e) { res.json(decoded); }
});

router.post('/auth/refresh', async (req, res) => {
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!token) return res.status(401).json({ error: 'token_missing' });
  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch(e) {
    if (e.name === 'TokenExpiredError') {
      try {
        decoded = jwt.decode(token);
        const expiredAgo = Date.now() - (decoded.exp * 1000);
        if (expiredAgo > 15 * 60 * 1000) {
          return res.status(401).json({ error: 'token_expired_no_grace', message: 'Sesiunea a expirat. Autentifică-te din nou.' });
        }
      } catch(e2) { return res.status(401).json({ error: 'token_invalid' }); }
    } else { return res.status(401).json({ error: 'token_invalid' }); }
  }
  if (!decoded?.userId) return res.status(401).json({ error: 'token_invalid' });
  try {
    if (pool && DB_READY) {
      const { rows } = await pool.query('SELECT id,email,nume,functie,institutie,role,org_id FROM users WHERE id=$1', [decoded.userId]);
      if (!rows[0]) return res.status(401).json({ error: 'user_not_found' });
      decoded = { userId: rows[0].id, email: rows[0].email, orgId: rows[0].org_id, nume: rows[0].nume, functie: rows[0].functie, institutie: rows[0].institutie, role: rows[0].role };
    }
    const newToken = jwt.sign(
      { userId: decoded.userId, email: decoded.email, role: decoded.role, orgId: decoded.orgId, nume: decoded.nume, functie: decoded.functie, institutie: decoded.institutie },
      JWT_SECRET, { expiresIn: JWT_EXPIRES }
    );
    return res.json({ token: newToken, email: decoded.email, role: decoded.role, orgId: decoded.orgId, nume: decoded.nume, functie: decoded.functie, institutie: decoded.institutie });
  } catch(e) { return res.status(500).json({ error: 'server_error' }); }
});

export default router;
