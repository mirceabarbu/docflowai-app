/**
 * DocFlowAI — Auth routes v3.3.4
 * POST /auth/login, GET /auth/me, POST /auth/refresh, POST /auth/logout
 * SEC-01: JWT stocat în cookie HttpOnly
 * SEC-03: Lazy re-hash PBKDF2 v1→v2 la login reușit
 */

import { Router } from 'express';
import { generateCsrfToken } from '../middleware/csrf.mjs';
import jwt from 'jsonwebtoken';
import {
  AUTH_COOKIE, JWT_SECRET, JWT_EXPIRES, JWT_REFRESH_GRACE_SEC,
  requireAuth, verifyPassword, hashPassword,
  setAuthCookie, clearAuthCookie,
} from '../middleware/auth.mjs';
import { pool, DB_READY, requireDb } from '../db/index.mjs';
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
    res.cookie('csrf_token', csrfToken, {
      httpOnly: false,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 24 * 60 * 60 * 1000, // 24h — nu mai expira in timpul unei zile de lucru
      path: '/',
    });

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
    res.cookie('csrf_token', token, {
      httpOnly: false, sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 24 * 60 * 60 * 1000, path: '/',
    });
  }
  res.json({ csrfToken: token });
});

// ── GET /auth/me ─────────────────────────────────────────────────────────────
router.get('/auth/me', async (req, res) => {
  const decoded = requireAuth(req, res);
  if (!decoded) return;
  if (!pool || !DB_READY) return res.json(decoded);
  try {
    let row = null;
    if (decoded.userId) {
      const { rows } = await pool.query('SELECT id,email,nume,functie,institutie,compartiment,role,org_id,force_password_change,token_version FROM users WHERE id=$1', [decoded.userId]);
      row = rows[0] || null;
    }
    if (!row && decoded.email) {
      const { rows } = await pool.query('SELECT id,email,nume,functie,institutie,compartiment,role,org_id,force_password_change,token_version FROM users WHERE lower(email)=lower($1)', [decoded.email]);
      row = rows[0] || null;
      if (row) logger.warn({ userId: decoded.userId, email: decoded.email, dbId: row.id }, '[auth/me] User gasit prin email (id mismatch)');
    }
    if (!row) {
      logger.warn({ email: decoded.email }, '[auth/me] User negasit in DB - returnez JWT payload');
      return res.json({
        userId: decoded.userId, email: decoded.email, role: decoded.role,
        orgId: decoded.orgId, nume: decoded.nume, functie: decoded.functie, institutie: decoded.institutie
      });
    }
    // SEC-04: verifică token_version — invalidat la reset parolă
    const dbTvMe = row.token_version ?? 1;
    const jwtTvMe = decoded.tv ?? 1;
    if (jwtTvMe !== dbTvMe) {
      clearAuthCookie(res);
      return res.status(401).json({ error: 'token_revoked', message: 'Sesiunea a fost invalidată. Te rugăm să te autentifici din nou.' });
    }
    res.json({
      userId: row.id, email: row.email, orgId: row.org_id,
      nume: row.nume, functie: row.functie, institutie: row.institutie, compartiment: row.compartiment || '', role: row.role,
      force_password_change: !!row.force_password_change,
    });
  } catch(e) {
    logger.warn({ err: e }, '[auth/me] DB error - folosesc JWT payload');
    res.json(decoded);
  }
});

// ── POST /auth/refresh ────────────────────────────────────────────────────────
router.post('/auth/refresh', async (req, res) => {
  // SEC-01: citim token-ul din cookie, cu fallback la Authorization header
  let token = req.cookies?.[AUTH_COOKIE] || null;
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
  try {
    if (pool && DB_READY) {
      const { rows } = await pool.query('SELECT id,email,nume,functie,institutie,compartiment,role,org_id,token_version FROM users WHERE id=$1', [decoded.userId]);
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
    }
    const newToken = jwt.sign(
      { userId: decoded.userId, email: decoded.email, role: decoded.role, orgId: decoded.orgId,
        nume: decoded.nume, functie: decoded.functie, institutie: decoded.institutie, compartiment: decoded.compartiment || '',
        tv: decoded.tv ?? 1 }, // SEC-04: propagăm tv la refresh
      JWT_SECRET, { expiresIn: JWT_EXPIRES }
    );
    // SEC-01: noul token în cookie HttpOnly
    setAuthCookie(res, newToken, jwtExpiresMs());
    const csrfTokenRefresh = generateCsrfToken();
    res.cookie('csrf_token', csrfTokenRefresh, {
      httpOnly: false, sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 24 * 60 * 60 * 1000, // 24h
      path: '/',
    });
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
router.post('/auth/change-password', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) return res.status(400).json({ error: 'missing_fields' });
  if (new_password.length < 6) return res.status(400).json({ error: 'password_too_short', message: 'Parola nouă trebuie să aibă minim 6 caractere.' });
  if (new_password.length > 200) return res.status(400).json({ error: 'password_too_long', max: 200 });
  try {
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [actor.userId]);
    if (!rows[0]) return res.status(404).json({ error: 'user_not_found' });
    const verif = await verifyPassword(current_password, rows[0].password_hash);
    if (!verif.ok) return res.status(401).json({ error: 'wrong_password', message: 'Parola curentă este incorectă.' });
    await pool.query('UPDATE users SET password_hash=$1, force_password_change=FALSE WHERE id=$2', [await hashPassword(new_password), actor.userId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

// ── Endpoint-uri debug/recovery — DEZACTIVATE în producție ────────────────────
// Disponibile doar în development (NODE_ENV !== 'production')
if (process.env.NODE_ENV !== 'production') {

// ── GET /auth/debug — diagnostic endpoint (ADMIN ONLY) ───────────────────────
router.get('/auth/debug', async (req, res) => {
  let token = req.cookies?.[AUTH_COOKIE] || null;
  if (!token) {
    const auth = req.get('authorization') || '';
    token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  }
  if (!token) return res.status(400).json({ error: 'no_token' });

  let decoded = null;
  let jwtError = null;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch(e) {
    jwtError = e.message;
    try { decoded = jwt.decode(token); } catch(e2) {}
  }

  if (!decoded || decoded.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden', message: 'Endpoint disponibil doar pentru administratori.' });
  }

  let dbUser = null, dbError = null, dbUserByEmail = null;
  if (decoded?.userId && pool && DB_READY) {
    try {
      const { rows } = await pool.query('SELECT id,email,nume,role,org_id,institutie FROM users WHERE id=$1', [decoded.userId]);
      dbUser = rows[0] || null;
    } catch(e) { dbError = e.message; }
  }
  if (decoded?.email && pool && DB_READY) {
    try {
      const { rows } = await pool.query('SELECT id,email,nume,role,org_id,institutie FROM users WHERE lower(email)=lower($1)', [decoded.email]);
      dbUserByEmail = rows[0] || null;
    } catch(e) {}
  }

  res.json({
    jwt: { valid: !jwtError, error: jwtError, payload: decoded },
    db: { byId: dbUser, byEmail: dbUserByEmail, error: dbError },
    conclusion: {
      jwtRole: decoded?.role,
      dbRole: dbUser?.role || dbUserByEmail?.role,
      willPassAdminCheck: (dbUser?.role || dbUserByEmail?.role || decoded?.role) === 'admin',
    }
  });
});

// ── POST /auth/fix-admin-role ─────────────────────────────────────────────────
router.post('/auth/fix-admin-role', async (req, res) => {
  const { ADMIN_SECRET } = await import('../middleware/auth.mjs');
  const provided = req.get('x-admin-secret') || req.body?.adminSecret;
  if (!ADMIN_SECRET || !provided || provided !== ADMIN_SECRET) {
    return res.status(403).json({ error: 'forbidden', hint: 'Setează ADMIN_SECRET în Railway și trimite header X-Admin-Secret' });
  }
  const { email } = req.body || {};
  const targetEmail = (email || 'admin@docflowai.ro').trim().toLowerCase();
  if (!pool || !DB_READY) return res.status(503).json({ error: 'db_not_ready' });
  try {
    const { rows } = await pool.query(
      "UPDATE users SET role='admin' WHERE lower(email)=$1 RETURNING id,email,role,nume",
      [targetEmail]
    );
    if (!rows.length) return res.status(404).json({ error: 'user_not_found', email: targetEmail });
    res.json({ ok: true, fixed: rows[0], message: `✅ ${rows[0].email} are acum role='admin'` });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

// ── GET /auth/fix-admin?secret=XXX ───────────────────────────────────────────
router.get('/auth/fix-admin', async (req, res) => {
  const { ADMIN_SECRET } = await import('../middleware/auth.mjs');
  const provided = req.query.secret || req.get('x-admin-secret');
  if (!ADMIN_SECRET) {
    return res.status(403).send('<h2>❌ ADMIN_SECRET nu este configurat.</h2>');
  }
  if (!provided || provided !== ADMIN_SECRET) {
    return res.status(403).send('<h2>❌ Secret incorect.</h2>');
  }
  if (!pool || !DB_READY) {
    return res.status(503).send('<h2>❌ Baza de date nu este disponibilă.</h2>');
  }
  try {
    const { rows: allUsers } = await pool.query('SELECT id, email, nume, role FROM users ORDER BY id');
    const { rows: fixed } = await pool.query(
      "UPDATE users SET role='admin' WHERE lower(email)='admin@docflowai.ro' RETURNING id, email, role, nume"
    );
    let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>DocFlowAI — Fix Admin</title>
    <style>body{font-family:sans-serif;background:#0b1020;color:#eaf0ff;padding:32px;max-width:700px;margin:0 auto;}
    h1{color:#7c5cff;} table{width:100%;border-collapse:collapse;margin:16px 0;}
    th,td{padding:8px 12px;text-align:left;border-bottom:1px solid rgba(255,255,255,.1);}
    th{color:#9db0ff;font-size:.8rem;} .ok{color:#2dd4bf;} .bad{color:#ff5050;}
    .box{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:16px;margin:16px 0;}
    </style></head><body><h1>🔧 DocFlowAI — Fix Admin Role</h1>`;
    if (fixed.length > 0) {
      html += `<div class="box"><p class="ok">✅ admin@docflowai.ro → role='admin' CORECTAT.</p>
      <p>Acum te poți <a href="/login" style="color:#7c5cff;">loga</a>.</p></div>`;
    } else {
      const adminUser = allUsers.find(u => u.email.toLowerCase() === 'admin@docflowai.ro');
      if (adminUser) {
        html += `<div class="box"><p class="ok">✅ admin@docflowai.ro există deja cu role='${adminUser.role}'.</p></div>`;
      } else {
        html += `<div class="box"><p class="bad">❌ admin@docflowai.ro nu există în baza de date!</p></div>`;
      }
    }
    html += `<h2>Toți utilizatorii (${allUsers.length})</h2><table>
    <tr><th>ID</th><th>Email</th><th>Nume</th><th>Rol</th></tr>`;
    allUsers.forEach(u => {
      // SEC-05: escaping manual pentru output HTML
      const escV = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      html += `<tr><td>${u.id}</td><td>${escV(u.email)}</td><td>${escV(u.nume||'—')}</td>
      <td class="${u.role==='admin'?'ok':'bad'}">${escV(u.role)}</td></tr>`;
    });
    html += `</table></body></html>`;
    res.send(html);
  } catch(e) {
    res.status(500).send(`<h2>❌ Eroare.</h2>`);
  }
});

} // end development-only routes

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
