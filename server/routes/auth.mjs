/**
 * DocFlowAI — Auth routes v3.3.4
 * POST /auth/login, GET /auth/me, POST /auth/refresh, POST /auth/logout
 * SEC-01: JWT stocat în cookie HttpOnly
 * SEC-03: Lazy re-hash PBKDF2 v1→v2 la login reușit
 */

import { Router } from 'express';
import { generateCsrfToken, csrfMiddleware } from '../middleware/csrf.mjs';
import { resolveActor } from '../services/actor-identity.mjs';
import jwt from 'jsonwebtoken';
import {
  JWT_SECRET, JWT_EXPIRES, JWT_REFRESH_GRACE_SEC,
  requireAuth, verifyPassword, hashPassword,
  setAuthCookie, clearAuthCookie, setCsrfCookie,
} from '../middleware/auth.mjs';
import { pool, DB_READY, requireDb, writeAuditEvent } from '../db/index.mjs';
import { logger } from '../middleware/logger.mjs';

const router = Router();

// Helper: parsează JWT_EXPIRES în milisecunde pentru cookie maxAge
function jwtExpiresMs() {
  const e = JWT_EXPIRES;
  if (!e) return 2 * 60 * 60 * 1000;
  const n = parseInt(e);
  if (e.endsWith('d')) return n * 86400000;
  if (e.endsWith('h')) return n * 3600000;
  if (e.endsWith('m')) return n * 60000;
  return 2 * 60 * 60 * 1000;
}

let _checkLoginRate, _recordLoginFail, _clearLoginRate;
export function injectRateLimiter(check, record, clear) {
  _checkLoginRate = check; _recordLoginFail = record; _clearLoginRate = clear;
}

// ── POST /auth/login ────────────────────────────────────────────────────────
router.post('/auth/login', async (req, res) => {
  if (requireDb(res)) return;
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email_and_password_required' });
  if (password.length > 200) return res.status(400).json({ error: 'password_too_long', max: 200 });

  // SEC-87.1: rate-limiterul e injectat din index.mjs. Daca injectia nu a rulat (ordine de import
  // schimbata la refactor), apelul arunca TypeError si TOATE loginurile dadeau 500 — o pana totala
  // de autentificare. Fail-open pe rate limiting (disponibilitate > fereastra de brute-force), dar
  // cu logger.error, ca deployment-ul rupt sa fie imediat vizibil.
  if (typeof _checkLoginRate !== 'function') {
    logger.error('SEC: rate-limiterul de login NU este injectat — login permis FARA rate limiting. Verifica injectia din index.mjs.');
  }
  const rateCheck = typeof _checkLoginRate === 'function'
    ? await _checkLoginRate(req, email)
    : { blocked: false };
  if (rateCheck.blocked) {
    return res.status(429).json({
      error: 'too_many_attempts',
      message: `Prea multe încercări. Încearcă din nou în ${Math.ceil(rateCheck.remainSec/60)} minute.`,
      remainSec: rateCheck.remainSec
    });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1 AND deleted_at IS NULL', [email.trim().toLowerCase()]);
    const user = rows[0];

    // verifyPassword returnează { ok, needsRehash } în v3.3.4
    const verification = user ? await verifyPassword(password, user.password_hash) : { ok: false, needsRehash: false };

    if (!user || !verification.ok) {
      await _recordLoginFail(req, email);
      logger.warn({ email: email.toLowerCase(), ip: req.ip }, 'Login failed: credentiale invalide');
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    await _clearLoginRate(req, email);

    // SEC-03: lazy re-hash PBKDF2 v1→v2 (100k→600k iterații)
    if (verification.needsRehash) {
      try {
        const newHash = await hashPassword(password);
        await pool.query(
          "UPDATE users SET password_hash=$1, hash_algo='pbkdf2_v2' WHERE id=$2",
          [newHash, user.id]
        );
        logger.info({ userId: user.id }, 'Lazy re-hash PBKDF2 v1->v2 efectuat cu succes');
      } catch(rehashErr) {
        logger.warn({ err: rehashErr, userId: user.id }, 'Lazy re-hash esuat (non-fatal)');
      }
    }

    const payload = {
      userId: user.id, email: user.email, role: user.role, orgId: user.org_id,
      nume: user.nume, functie: user.functie, institutie: user.institutie, compartiment: user.compartiment || '',
      tv: user.token_version ?? 1, // SEC-04: token version pentru invalidare la reset parolă
    };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    // 2FA: dacă userul are TOTP activat, NU setăm auth_token complet
    // Returnăm pending_token cu flag requires2fa — frontend va cere codul TOTP
    if (user.totp_enabled) {
      const pendingToken = jwt.sign(
        {
          userId: user.id, email: user.email, role: user.role, orgId: user.org_id,
          nume: user.nume, functie: user.functie, institutie: user.institutie,
          compartiment: user.compartiment || '', tv: user.token_version ?? 1,
          requires2fa: true,
        },
        JWT_SECRET,
        { expiresIn: '10m' } // 10 minute să introducă codul
      );
      logger.info({ userId: user.id, email: user.email }, '2FA: login parțial, codul TOTP necesar');
      return res.json({ ok: false, requires2fa: true, pending_token: pendingToken });
    }

    setAuthCookie(res, token, jwtExpiresMs());
    // CSRF: cookie non-HttpOnly citit de frontend si trimis ca header x-csrf-token
    const csrfToken = generateCsrfToken();
    setCsrfCookie(res, csrfToken, 24 * 60 * 60 * 1000); // 24h — nu mai expira in timpul unei zile de lucru

    logger.info({ userId: user.id, email: user.email, role: user.role }, 'Login reusit');

    return res.json({
      ok: true,
      email: user.email, role: user.role, orgId: user.org_id,
      nume: user.nume, functie: user.functie, institutie: user.institutie, compartiment: user.compartiment || '',
      force_password_change: !!user.force_password_change,
    });
  } catch(e) {
    logger.error({ err: e }, 'Login error');
    return res.status(500).json({ error: 'server_error' });
  }
});

// ── GET /auth/csrf-token — emite token CSRF proaspăt ─────────────────────────
// Apelat de frontend la deschiderea paginii pentru a garanta că are un token valid.
// Nu necesită autentificare — setează cookie și returnează token în body.
router.get('/auth/csrf-token', (req, res) => {
  // Reutilizăm token-ul existent dacă există și e valid, altfel generăm unul nou
  const existing = req.cookies?.csrf_token;
  const token = existing || generateCsrfToken();
  if (!existing) {
    setCsrfCookie(res, token, 24 * 60 * 60 * 1000);
  }
  res.json({ csrfToken: token });
});

// ── GET /auth/me ─────────────────────────────────────────────────────────────
router.get('/auth/me', async (req, res) => {
  const decoded = requireAuth(req, res);
  if (!decoded) return;
  const identity = await resolveActor(decoded);
  if (!identity.ok) {
    if (identity.status !== 503) {
      clearAuthCookie(res);
    }
    const status = identity.status === 403 ? 401 : identity.status;
    return res.status(status).json({
      error: identity.error,
      message: identity.message,
    });
  }

  const row = identity.user;
  return res.json({
    userId: row.id, email: row.email, orgId: row.org_id,
    nume: row.nume, functie: row.functie, institutie: row.institutie,
    compartiment: row.compartiment || '', role: row.role,
    force_password_change: !!row.force_password_change,
  });
});

// ── POST /auth/refresh ────────────────────────────────────────────────────────
router.post('/auth/refresh', async (req, res) => {
  // SEC-01: citim token-ul din cookie, cu fallback la Authorization header
  let token = req.cookies?.auth_token || null;
  if (!token) {
    const auth = req.get('authorization') || '';
    token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  }
  if (!token) return res.status(401).json({ error: 'token_missing' });

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch(e) {
    if (e.name === 'TokenExpiredError') {
      try {
        decoded = jwt.decode(token);
        const expiredAgo = Date.now() - (decoded.exp * 1000);
        if (expiredAgo > JWT_REFRESH_GRACE_SEC * 1000) {
          clearAuthCookie(res);
          return res.status(401).json({ error: 'token_expired_no_grace', message: 'Sesiunea a expirat. Autentifică-te din nou.' });
        }
      } catch(e2) { return res.status(401).json({ error: 'token_invalid' }); }
    } else { return res.status(401).json({ error: 'token_invalid' }); }
  }
  if (!decoded?.userId) return res.status(401).json({ error: 'token_invalid' });
  // AUTH-01: fail-closed când DB e indisponibil. Fără DB nu putem valida token_version,
  // deleted_at sau rolul — a semna un token nou (valabil JWT_EXPIRES) din claims vechi ar
  // prelungi o sesiune posibil revocată exact în fereastra de incident. NU ștergem cookie-ul
  // (un incident DB scurt nu trebuie să deconecteze toți userii) și NU folosim token_revoked
  // (frontendul îl tratează ca revocare → redirect la login). `db_unavailable` = eșec temporar,
  // ignorat de notif-widget (nu e în REVOKED_CODES).
  if (!pool || !DB_READY) {
    return res.status(503).json({
      error: 'db_unavailable',
      message: 'Serviciul nu poate valida sesiunea momentan. Reîncearcă în câteva momente.',
    });
  }
  try {
    const { rows } = await pool.query('SELECT id,email,nume,functie,institutie,compartiment,role,org_id,token_version FROM users WHERE id=$1 AND deleted_at IS NULL', [decoded.userId]);
    if (!rows[0]) { clearAuthCookie(res); return res.status(401).json({ error: 'user_not_found' }); }
    // SEC-04: verifică token_version — invalidat la reset parolă
    const dbTv = rows[0].token_version ?? 1;
    const jwtTv = decoded.tv ?? 1;
    if (jwtTv !== dbTv) {
      clearAuthCookie(res);
      return res.status(401).json({ error: 'token_revoked', message: 'Sesiunea a fost invalidată. Te rugăm să te autentifici din nou.' });
    }
    decoded = {
      userId: rows[0].id, email: rows[0].email, orgId: rows[0].org_id,
      nume: rows[0].nume, functie: rows[0].functie, institutie: rows[0].institutie, compartiment: rows[0].compartiment || '', role: rows[0].role,
      tv: dbTv,
    };
    const newToken = jwt.sign(
      { userId: decoded.userId, email: decoded.email, role: decoded.role, orgId: decoded.orgId,
        nume: decoded.nume, functie: decoded.functie, institutie: decoded.institutie, compartiment: decoded.compartiment || '',
        tv: decoded.tv ?? 1 }, // SEC-04: propagăm tv la refresh
      JWT_SECRET, { expiresIn: JWT_EXPIRES }
    );
    // SEC-01: noul token în cookie HttpOnly
    setAuthCookie(res, newToken, jwtExpiresMs());
    const csrfTokenRefresh = generateCsrfToken();
    setCsrfCookie(res, csrfTokenRefresh, 24 * 60 * 60 * 1000); // 24h
    return res.json({
      ok: true,
      csrfToken: csrfTokenRefresh,  // returnat în body — frontend îl citește direct, fără să aștepte cookie
      email: decoded.email, role: decoded.role, orgId: decoded.orgId,
      nume: decoded.nume, functie: decoded.functie, institutie: decoded.institutie, compartiment: decoded.compartiment || '',
    });
  } catch(e) { return res.status(500).json({ error: 'server_error' }); }
});

// ── POST /auth/logout — șterge cookie-ul de sesiune ──────────────────────────
// SEC-01: endpoint nou — invalidează sesiunea pe client prin ștergerea cookie-ului
router.post('/auth/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true, message: 'Sesiune închisă.' });
});

// ── POST /auth/change-password — schimbare parolă de către utilizatorul logat ──
// v3.9.502 (A-4 P1): adăugare CSRF — endpoint sensibil (schimbare parolă) lipsea
// protecție anti-CSRF. Vector real pentru attacker care cunoaște email targetului.
router.post('/auth/change-password', csrfMiddleware, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) return res.status(400).json({ error: 'missing_fields' });
  // Minim 10 caractere (era 6). 10, nu 12: generatePassword() produce `xxx-xxx-xxx` = 11 caractere;
  // un minim de 12 ar invalida parolele generate de admin. Fără reguli de compoziție (NIST 800-63B).
  if (new_password.length < 10) return res.status(400).json({ error: 'password_too_short', message: 'Parola nouă trebuie să aibă minim 10 caractere.' });
  if (new_password.length > 200) return res.status(400).json({ error: 'password_too_long', max: 200 });
  try {
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [actor.userId]);
    if (!rows[0]) return res.status(404).json({ error: 'user_not_found' });
    const verif = await verifyPassword(current_password, rows[0].password_hash);
    if (!verif.ok) return res.status(401).json({ error: 'wrong_password', message: 'Parola curentă este incorectă.' });
    // Bump token_version → invalidează TOATE celelalte sesiuni (ex. atacator cu cookie furat).
    // RETURNING dă noul tv, cu care re-emitem cookie-ul sesiunii CURENTE mai jos — altfel
    // utilizatorul care tocmai și-a schimbat parola ar fi deconectat instant de propriul
    // sessionGuard (tokenul lui ar avea tv-ul vechi). Efect: sesiunea curentă supraviețuiește,
    // toate celelalte mor.
    const upd = await pool.query(
      'UPDATE users SET password_hash=$1, force_password_change=FALSE, token_version=COALESCE(token_version,1)+1 WHERE id=$2 RETURNING token_version',
      [await hashPassword(new_password), actor.userId]
    );
    const newTv = upd.rows[0]?.token_version ?? ((actor.tv ?? 1) + 1);
    const newToken = jwt.sign(
      { userId: actor.userId, email: actor.email, role: actor.role, orgId: actor.orgId,
        nume: actor.nume, functie: actor.functie, institutie: actor.institutie,
        compartiment: actor.compartiment || '', tv: newTv },
      JWT_SECRET, { expiresIn: JWT_EXPIRES }
    );
    setAuthCookie(res, newToken, jwtExpiresMs());
    // Emitem și un CSRF nou, ca perechea auth/csrf să rămână consistentă (ca la /auth/refresh).
    const csrfToken = generateCsrfToken();
    setCsrfCookie(res, csrfToken, 24 * 60 * 60 * 1000);
    writeAuditEvent({
      flowId: null, orgId: actor.orgId || null,
      eventType: 'PASSWORD_CHANGED',
      actorEmail: actor.email || null,
      actorIp: req.ip || null,
      payload: { self: true },
    }).catch(() => {});
    res.json({ ok: true, csrfToken });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

// ── GET /auth/verify-email/:token ─────────────────────────────────────────────
router.get('/auth/verify-email/:token', async (req, res) => {
  const { token } = req.params;
  if (!token || token.length < 32) {
    return res.status(400).send('<h2>❌ Token invalid sau expirat.</h2>');
  }
  if (!pool || !DB_READY) {
    return res.status(503).send('<h2>❌ Serviciul nu este disponibil momentan.</h2>');
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, email, email_verified, verification_sent_at FROM users WHERE verification_token = $1 LIMIT 1`,
      [token]
    );
    if (!rows.length) {
      return res.status(404).send(`
        <div style="font-family:sans-serif;max-width:480px;margin:60px auto;text-align:center;background:#0f1731;color:#eaf0ff;padding:40px;border-radius:16px;">
          <h2 style="color:#ff5050;">❌ Link invalid sau deja utilizat</h2>
          <p>Tokenul de verificare nu a fost găsit. Contactează administratorul pentru un nou link.</p>
        </div>`);
    }
    const user = rows[0];
    if (user.email_verified) {
      return res.send(`
        <div style="font-family:sans-serif;max-width:480px;margin:60px auto;text-align:center;background:#0f1731;color:#eaf0ff;padding:40px;border-radius:16px;">
          <h2 style="color:#2dd4bf;">✅ Email deja verificat</h2>
          <p>Poți accesa aplicația.</p>
          <a href="/login" style="display:inline-block;margin-top:20px;background:#7c5cff;color:#fff;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:700;">Mergi la login</a>
        </div>`);
    }
    const sentAt = user.verification_sent_at ? new Date(user.verification_sent_at).getTime() : 0;
    if (sentAt && Date.now() - sentAt > 72 * 3600_000) {
      return res.status(410).send(`
        <div style="font-family:sans-serif;max-width:480px;margin:60px auto;text-align:center;background:#0f1731;color:#eaf0ff;padding:40px;border-radius:16px;">
          <h2 style="color:#ff5050;">⏰ Link expirat</h2>
          <p>Link-ul a expirat (72 ore). Contactează administratorul pentru un nou link.</p>
        </div>`);
    }
    await pool.query(
      `UPDATE users SET email_verified=TRUE, verification_token=NULL, verification_sent_at=NULL WHERE id=$1`,
      [user.id]
    );
    logger.info(`✅ R-06: Email verificat pentru ${user.email}`);
    return res.send(`
      <div style="font-family:sans-serif;max-width:480px;margin:60px auto;text-align:center;background:#0f1731;color:#eaf0ff;padding:40px;border-radius:16px;">
        <h2 style="color:#2dd4bf;">✅ Email confirmat!</h2>
        <p>Contul tău DocFlowAI este acum activ.</p>
        <a href="/login" style="display:inline-block;margin-top:20px;background:#7c5cff;color:#fff;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:700;">Mergi la login</a>
      </div>`);
  } catch(e) {
    logger.error({ err: e }, 'verify-email error');
    return res.status(500).send('<h2>❌ Eroare internă.</h2>');
  }
});

export default router;
