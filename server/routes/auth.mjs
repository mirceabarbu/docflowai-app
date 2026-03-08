/**
 * DocFlowAI — Auth routes v3.2.0
 * POST /auth/login, GET /auth/me, POST /auth/refresh
 * FIX: grace period configurabil, refresh verifica DB
 */

import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { JWT_SECRET, JWT_EXPIRES, JWT_REFRESH_GRACE_SEC, requireAuth, verifyPassword, hashPassword } from '../middleware/auth.mjs';
import { pool, DB_READY, requireDb } from '../db/index.mjs';

const router = Router();

let _checkLoginRate, _recordLoginFail, _clearLoginRate;
export function injectRateLimiter(check, record, clear) {
  _checkLoginRate = check; _recordLoginFail = record; _clearLoginRate = clear;
}

router.post('/auth/login', async (req, res) => {
  if (requireDb(res)) return;
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email_and_password_required' });
  // FIX v3.2.3: limită lungime parolă — previne DoS via pbkdf2Sync cu input mare
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
    if (!user || !verifyPassword(password, user.password_hash)) {
      await _recordLoginFail(req, email);
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    await _clearLoginRate(req, email);
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role, orgId: user.org_id, nume: user.nume, functie: user.functie, institutie: user.institutie },
      JWT_SECRET, { expiresIn: JWT_EXPIRES }
    );
    return res.json({
      token, email: user.email, role: user.role, orgId: user.org_id,
      nume: user.nume, functie: user.functie, institutie: user.institutie,
      force_password_change: !!user.force_password_change,
    });
  } catch(e) { return res.status(500).json({ error: 'server_error' }); }
});

router.get('/auth/me', async (req, res) => {
  const decoded = requireAuth(req, res);
  if (!decoded) return;
  if (!pool || !DB_READY) return res.json(decoded);
  try {
    // Cautam mai intai dupa ID (cel mai rapid)
    let row = null;
    if (decoded.userId) {
      const { rows } = await pool.query('SELECT id,email,nume,functie,institutie,role,org_id,force_password_change FROM users WHERE id=$1', [decoded.userId]);
      row = rows[0] || null;
    }
    // Fallback: cauta dupa email (in caz de reset DB cu IDs noi)
    if (!row && decoded.email) {
      const { rows } = await pool.query('SELECT id,email,nume,functie,institutie,role,org_id,force_password_change FROM users WHERE lower(email)=lower($1)', [decoded.email]);
      row = rows[0] || null;
      if (row) console.warn(`[auth/me] User id=${decoded.userId} not found, found by email=${decoded.email} (id=${row.id})`);
    }
    if (!row) {
      // JWT valid dar user nu există deloc în DB — trust JWT payload
      console.warn(`[auth/me] User email=${decoded.email} not in DB — returning JWT payload`);
      return res.json({
        userId: decoded.userId, email: decoded.email, role: decoded.role,
        orgId: decoded.orgId, nume: decoded.nume, functie: decoded.functie, institutie: decoded.institutie
      });
    }
    res.json({
      userId: row.id, email: row.email, orgId: row.org_id,
      nume: row.nume, functie: row.functie, institutie: row.institutie, role: row.role,
      force_password_change: !!row.force_password_change,
    });
  } catch(e) {
    console.warn('[auth/me] DB error — using JWT payload:', e.message);
    // La eroare DB, trustam JWT-ul (are role din momentul login-ului)
    res.json(decoded);
  }
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
        // FIX: grace period din constanta configurabila
        if (expiredAgo > JWT_REFRESH_GRACE_SEC * 1000) {
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


// ── POST /auth/change-password — schimbare parolă de către utilizatorul logat ──
router.post('/auth/change-password', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) return res.status(400).json({ error: 'missing_fields' });
  if (new_password.length < 6) return res.status(400).json({ error: 'password_too_short', message: 'Parola nouă trebuie să aibă minim 6 caractere.' });
  try {
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [actor.userId]);
    if (!rows[0]) return res.status(404).json({ error: 'user_not_found' });
    if (!verifyPassword(current_password, rows[0].password_hash)) return res.status(401).json({ error: 'wrong_password', message: 'Parola curentă este incorectă.' });
    await pool.query('UPDATE users SET password_hash=$1, force_password_change=FALSE WHERE id=$2', [hashPassword(new_password), actor.userId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

// ── GET /auth/debug — diagnostic endpoint (ADMIN ONLY) ────────────────────
// FIX v3.2.2: necesită autentificare admin — nu mai e accesibil oricărui user autentificat
router.get('/auth/debug', async (req, res) => {
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!token) return res.status(400).json({ error: 'no_token', hint: 'Adaugă header Authorization: Bearer <token>' });

  let decoded = null;
  let jwtError = null;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch(e) {
    jwtError = e.message;
    try { decoded = jwt.decode(token); } catch(e2) {}
  }

  // FIX: verificare rol admin înainte de a returna informații sensibile
  if (!decoded || decoded.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden', message: 'Endpoint disponibil doar pentru administratori.' });
  }

  let dbUser = null;
  let dbError = null;
  if (decoded?.userId && pool && DB_READY) {
    try {
      const { rows } = await pool.query('SELECT id,email,nume,role,org_id,institutie FROM users WHERE id=$1', [decoded.userId]);
      dbUser = rows[0] || null;
    } catch(e) { dbError = e.message; }
  }

  // Also check by email
  let dbUserByEmail = null;
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

// ── POST /auth/fix-admin-role — repară rolul admin fără autentificare ─────
// Necesită header X-Admin-Secret setat în env. Folosit pentru debug/recovery.
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
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /auth/fix-admin?secret=XXX — fix rapid via browser ────────────────
// Accesibil direct din browser: /auth/fix-admin?secret=<ADMIN_SECRET>
// Dacă ADMIN_SECRET nu e setat în env → dezactivat (403).
router.get('/auth/fix-admin', async (req, res) => {
  const { ADMIN_SECRET } = await import('../middleware/auth.mjs');
  const provided = req.query.secret || req.get('x-admin-secret');
  if (!ADMIN_SECRET) {
    return res.status(403).send('<h2>❌ ADMIN_SECRET nu este configurat în variabilele de mediu Railway.</h2><p>Setează ADMIN_SECRET în Railway Variables, repornește, apoi accesează din nou.</p>');
  }
  if (!provided || provided !== ADMIN_SECRET) {
    return res.status(403).send('<h2>❌ Secret incorect.</h2><p>Accesează: <code>/auth/fix-admin?secret=PAROLA_TA_ADMIN_SECRET</code></p>');
  }
  if (!pool || !DB_READY) {
    return res.status(503).send('<h2>❌ Baza de date nu este disponibilă.</h2>');
  }
  try {
    // Listează toți userii
    const { rows: allUsers } = await pool.query('SELECT id, email, nume, role FROM users ORDER BY id');
    
    // Fixează admin@docflowai.ro
    const { rows: fixed } = await pool.query(
      "UPDATE users SET role='admin' WHERE lower(email)='admin@docflowai.ro' RETURNING id, email, role, nume"
    );

    let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>DocFlowAI — Fix Admin</title>
    <style>body{font-family:sans-serif;background:#0b1020;color:#eaf0ff;padding:32px;max-width:700px;margin:0 auto;}
    h1{color:#7c5cff;} table{width:100%;border-collapse:collapse;margin:16px 0;}
    th,td{padding:8px 12px;text-align:left;border-bottom:1px solid rgba(255,255,255,.1);}
    th{color:#9db0ff;font-size:.8rem;} .ok{color:#2dd4bf;} .bad{color:#ff5050;}
    .box{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:16px;margin:16px 0;}
    </style></head><body>
    <h1>🔧 DocFlowAI — Fix Admin Role</h1>`;

    if (fixed.length > 0) {
      html += `<div class="box"><p class="ok">✅ admin@docflowai.ro → role='admin' CORECTAT.</p>
      <p>Acum te poți <a href="/login" style="color:#7c5cff;">loga</a>.</p></div>`;
    } else {
      const adminUser = allUsers.find(u => u.email.toLowerCase() === 'admin@docflowai.ro');
      if (adminUser) {
        html += `<div class="box"><p class="ok">✅ admin@docflowai.ro există deja cu role='${adminUser.role}'.</p>
        <p>Dacă tot nu poți accesa pagina de admin, problema e în altă parte.</p></div>`;
      } else {
        html += `<div class="box"><p class="bad">❌ admin@docflowai.ro nu există în baza de date!</p>
        <p>Setează ADMIN_INIT_PASSWORD în Railway și repornește serverul pentru a crea contul.</p></div>`;
      }
    }

    html += `<h2>Toți utilizatorii (${allUsers.length})</h2><table>
    <tr><th>ID</th><th>Email</th><th>Nume</th><th>Rol</th></tr>`;
    allUsers.forEach(u => {
      html += `<tr><td>${u.id}</td><td>${u.email}</td><td>${u.nume||'—'}</td>
      <td class="${u.role==='admin'?'ok':'bad'}">${u.role}</td></tr>`;
    });
    html += `</table></body></html>`;

    res.send(html);
  } catch(e) {
    res.status(500).send(`<h2>❌ Eroare: ${e.message}</h2>`);
  }
});
// ── GET /auth/verify-email/:token — activare cont prin link email ──────────
// R-06: Userilor creați de admin li se trimite un link de verificare.
// Dacă email_verified=TRUE deja (admin a bifat skip_verification), răspunde cu ok.
router.get('/auth/verify-email/:token', async (req, res) => {
  const { token } = req.params;
  if (!token || token.length < 32) {
    return res.status(400).send('<h2>❌ Token invalid sau expirat.</h2>');
  }
  if (!pool || !DB_READY) {
    return res.status(503).send('<h2>❌ Serviciul nu este disponibil momentan. Încearcă din nou.</h2>');
  }
  try {
    // Token valid 72 ore de la trimitere
    const { rows } = await pool.query(
      `SELECT id, email, email_verified, verification_sent_at FROM users
       WHERE verification_token = $1 LIMIT 1`,
      [token]
    );
    if (!rows.length) {
      return res.status(404).send(`
        <div style="font-family:sans-serif;max-width:480px;margin:60px auto;text-align:center;background:#0f1731;color:#eaf0ff;padding:40px;border-radius:16px;">
          <h2 style="color:#ff5050;">❌ Link invalid sau deja utilizat</h2>
          <p>Tokenul de verificare nu a fost găsit. Este posibil să fi expirat sau să fi fost deja folosit.</p>
          <p>Contactează administratorul pentru un nou link.</p>
        </div>`);
    }
    const user = rows[0];
    if (user.email_verified) {
      return res.send(`
        <div style="font-family:sans-serif;max-width:480px;margin:60px auto;text-align:center;background:#0f1731;color:#eaf0ff;padding:40px;border-radius:16px;">
          <h2 style="color:#2dd4bf;">✅ Email deja verificat</h2>
          <p>Adresa <strong>${user.email}</strong> este deja confirmată. Poți accesa aplicația.</p>
          <a href="/login" style="display:inline-block;margin-top:20px;background:#7c5cff;color:#fff;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:700;">Mergi la login</a>
        </div>`);
    }
    // Verificăm expirarea (72 ore)
    const sentAt = user.verification_sent_at ? new Date(user.verification_sent_at).getTime() : 0;
    if (sentAt && Date.now() - sentAt > 72 * 3600_000) {
      return res.status(410).send(`
        <div style="font-family:sans-serif;max-width:480px;margin:60px auto;text-align:center;background:#0f1731;color:#eaf0ff;padding:40px;border-radius:16px;">
          <h2 style="color:#ff5050;">⏰ Link expirat</h2>
          <p>Link-ul de verificare a expirat (72 ore). Contactează administratorul pentru un nou link de verificare.</p>
        </div>`);
    }
    // Marchează emailul ca verificat și șterge tokenul
    await pool.query(
      `UPDATE users SET email_verified=TRUE, verification_token=NULL, verification_sent_at=NULL WHERE id=$1`,
      [user.id]
    );
    console.log(`✅ R-06: Email verificat pentru ${user.email}`);
    return res.send(`
      <div style="font-family:sans-serif;max-width:480px;margin:60px auto;text-align:center;background:#0f1731;color:#eaf0ff;padding:40px;border-radius:16px;">
        <h2 style="color:#2dd4bf;">✅ Email confirmat!</h2>
        <p>Adresa <strong>${user.email}</strong> a fost verificată cu succes. Contul tău DocFlowAI este acum activ.</p>
        <a href="/login" style="display:inline-block;margin-top:20px;background:#7c5cff;color:#fff;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:700;">Mergi la login</a>
      </div>`);
  } catch(e) {
    console.error('verify-email error:', e);
    return res.status(500).send('<h2>❌ Eroare internă. Încearcă din nou.</h2>');
  }
});

export default router;
