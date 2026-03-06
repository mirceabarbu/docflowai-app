/**
 * DocFlowAI — Admin routes v3.2.1
 * FIX: export default mutat la sfarsit (toate rutele inainte de export)
 * FIX: /admin/flows/audit mutat inainte de export default
 * FIX: /health => versiune 3.2.1
 * NOTE: plain_password pastrat intentionat (migrare viitoare)
 */

import { Router } from 'express';
import { requireAuth, requireAdmin, hashPassword, generatePassword } from '../middleware/auth.mjs';
import { pool, DB_READY, DB_LAST_ERROR, requireDb, saveFlow, getFlowData } from '../db/index.mjs';
import { validatePhone } from '../whatsapp.mjs';
import { sendSignerEmail, verifySmtp } from '../mailer.mjs';
import { archiveFlow, verifyDrive } from '../drive.mjs';
import { verifyWhatsApp, sendWaSignRequest } from '../whatsapp.mjs';

let PDFLibAdmin = null;
try { PDFLibAdmin = await import('pdf-lib'); } catch(e) { console.warn('⚠️ pdf-lib not available for audit PDF export'); }

let _wsClientsSize = () => 0;
export function injectWsSize(fn) { _wsClientsSize = fn; }

const router = Router();

// ── Users ──────────────────────────────────────────────────────────────────
// GET /users — returneaza useri din aceeasi institutie ca utilizatorul logat
// Folosit de initiator pentru dropdown semnatari
router.get('/users', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    // Citim institutia din DB (nu din JWT care poate fi vechi)
    const { rows: selfRows } = await pool.query('SELECT institutie FROM users WHERE email=$1', [actor.email.toLowerCase()]);
    const institutie = (selfRows[0]?.institutie || actor.institutie || '').trim();

    let query, params;
    if (institutie) {
      // Filtreaza pe institutie — userii din aceeasi institutie
      query = 'SELECT id,email,nume,functie,institutie,compartiment,org_id FROM users WHERE institutie=$1 ORDER BY nume ASC';
      params = [institutie];
    } else {
      // User fara institutie (ex: admin global) — vede toti userii din org
      const orgId = actor.orgId || null;
      if (orgId) {
        query = 'SELECT id,email,nume,functie,institutie,compartiment,org_id FROM users WHERE org_id=$1 ORDER BY nume ASC';
        params = [orgId];
      } else {
        query = 'SELECT id,email,nume,functie,institutie,compartiment,org_id FROM users ORDER BY nume ASC';
        params = [];
      }
    }
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

router.get('/admin/users', async (req, res) => {
  if (requireDb(res)) return;
  const user = requireAuth(req, res); if (!user) return;
  if (user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  try {
    // Citim orgId din DB pentru a fi siguri ca avem valoarea corecta (nu din JWT vechi)
    const { rows: selfRows } = await pool.query('SELECT org_id FROM users WHERE email=$1', [user.email.toLowerCase()]);
    const orgId = selfRows[0]?.org_id || null;
    let query, params;
    if (orgId) {
      query = 'SELECT id,email,nume,functie,institutie,compartiment,plain_password,role,phone,notif_inapp,notif_email,notif_whatsapp,created_at,org_id FROM users WHERE org_id=$1 ORDER BY institutie ASC, compartiment ASC, nume ASC';
      params = [orgId];
    } else {
      // Admin fara org (fallback) — vede toti userii
      query = 'SELECT id,email,nume,functie,institutie,compartiment,plain_password,role,phone,notif_inapp,notif_email,notif_whatsapp,created_at,org_id FROM users ORDER BY institutie ASC, compartiment ASC, nume ASC';
      params = [];
    }
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch(e) { console.error('GET /admin/users error:', e); res.status(500).json({ error: 'server_error', detail: e.message }); }
});

router.post('/admin/users', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const { email, password, nume, functie, institutie, compartiment, role, phone, notif_inapp, notif_email, notif_whatsapp } = req.body || {};
  if (!email || !nume) return res.status(400).json({ error: 'email_and_nume_required' });
  const validRole = ['admin', 'user'].includes(role) ? role : 'user';
  const plainPwd = password && password.length >= 4 ? password : generatePassword();
  const phoneValidation = validatePhone((phone || '').trim());
  if (!phoneValidation.valid) return res.status(400).json({ error: 'phone_invalid', message: phoneValidation.error });
  const phoneVal = phoneValidation.normalized || (phone || '').trim();
  const ni = notif_inapp !== false; const ne = !!notif_email; const nw = !!notif_whatsapp;
  try {
    const { rows } = await pool.query(
      'INSERT INTO users (email,password_hash,plain_password,nume,functie,institutie,compartiment,role,phone,notif_inapp,notif_email,notif_whatsapp,org_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id,email,nume,functie,institutie,compartiment,plain_password,role,phone,notif_inapp,notif_email,notif_whatsapp,org_id',
      [email.trim().toLowerCase(), hashPassword(plainPwd), plainPwd, (nume || '').trim(), (functie || '').trim(), (institutie || '').trim(), (compartiment || '').trim(), validRole, phoneVal, ni, ne, nw, actor.orgId || null]
    );
    res.status(201).json(rows[0]);
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'email_exists' });
    res.status(500).json({ error: 'server_error' });
  }
});

router.put('/admin/users/:id', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const targetId = parseInt(req.params.id);
  if (isNaN(targetId)) return res.status(400).json({ error: 'invalid_id' });
  const { email, nume, functie, institutie, compartiment, password, role, phone, notif_inapp, notif_email, notif_whatsapp } = req.body || {};
  const updates = [], vals = []; let i = 1;
  if (email) { updates.push(`email=$${i++}`); vals.push(email.trim().toLowerCase()); }
  if (nume !== undefined) { updates.push(`nume=$${i++}`); vals.push((nume || '').trim()); }
  if (functie !== undefined) { updates.push(`functie=$${i++}`); vals.push((functie || '').trim()); }
  if (institutie !== undefined) { updates.push(`institutie=$${i++}`); vals.push((institutie || '').trim()); }
  if (compartiment !== undefined) { updates.push(`compartiment=$${i++}`); vals.push((compartiment || '').trim()); }
  if (role && ['admin', 'user'].includes(role)) { updates.push(`role=$${i++}`); vals.push(role); }
  if (phone !== undefined) {
    const pv = validatePhone((phone || '').trim());
    if (!pv.valid) return res.status(400).json({ error: 'phone_invalid', message: pv.error });
    updates.push(`phone=$${i++}`); vals.push(pv.normalized || (phone || '').trim());
  }
  if (notif_inapp !== undefined) { updates.push(`notif_inapp=$${i++}`); vals.push(!!notif_inapp); }
  if (notif_email !== undefined) { updates.push(`notif_email=$${i++}`); vals.push(!!notif_email); }
  if (notif_whatsapp !== undefined) { updates.push(`notif_whatsapp=$${i++}`); vals.push(!!notif_whatsapp); }
  let newPlainPwd = null;
  if (password && password.length >= 4) {
    updates.push(`password_hash=$${i++}`); vals.push(hashPassword(password));
    updates.push(`plain_password=$${i++}`); vals.push(password);
    newPlainPwd = password;
  }
  if (!updates.length) return res.status(400).json({ error: 'nothing_to_update' });
  vals.push(targetId);
  try {
    const { rows } = await pool.query(
      `UPDATE users SET ${updates.join(',')} WHERE id=$${i} RETURNING id,email,nume,functie,institutie,compartiment,plain_password,role,phone,notif_inapp,notif_email,notif_whatsapp,org_id`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'user_not_found' });
    return res.json(rows[0]);
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'email_exists' });
    return res.status(500).json({ error: 'server_error' });
  }
});

router.post('/admin/users/:id/reset-password', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const newPwd = generatePassword();
  try {
    // Updatam si plain_password pentru workflow admin
    await pool.query('UPDATE users SET password_hash=$1, plain_password=$2 WHERE id=$3', [hashPassword(newPwd), newPwd, parseInt(req.params.id)]);
    res.json({ plain_password: newPwd });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

router.delete('/admin/users/:id', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const targetId = parseInt(req.params.id);
  if (actor.userId === targetId) return res.status(400).json({ error: 'cannot_delete_self' });
  try {
    await pool.query('DELETE FROM users WHERE id=$1', [targetId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

router.post('/admin/users/:id/send-credentials', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const targetId = parseInt(req.params.id);
  try {
    // Citim plain_password din DB (pastrat intentionat pentru workflow admin)
    const { rows } = await pool.query('SELECT email,nume,functie,plain_password FROM users WHERE id=$1', [targetId]);
    const u = rows[0];
    if (!u) return res.status(404).json({ error: 'user_not_found' });
    if (!u.plain_password) return res.status(400).json({ error: 'no_password_available' });
    const appUrl = process.env.PUBLIC_BASE_URL || 'https://app.docflowai.ro';
    await sendSignerEmail({
      to: u.email, subject: 'Cont DocFlowAI — credențiale de acces',
      html: `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;background:#0f1731;color:#eaf0ff;border-radius:16px;padding:36px;">
        <div style="text-align:center;margin-bottom:28px;"><div style="display:inline-block;background:linear-gradient(135deg,#7c5cff,#2dd4bf);border-radius:12px;padding:12px 20px;font-size:1.3rem;font-weight:800;">📋 DocFlowAI</div></div>
        <h2 style="margin:0 0 8px;font-size:1.1rem;color:#cdd8ff;">Bună${u.nume ? ', ' + u.nume : ''},</h2>
        <p style="color:#9db0ff;margin:0 0 24px;line-height:1.6;">Contul tău în <strong style="color:#eaf0ff;">DocFlowAI</strong> a fost creat.</p>
        <div style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:20px 24px;margin-bottom:24px;">
          <div style="margin-bottom:14px;"><span style="color:#9db0ff;font-size:.82rem;display:block;margin-bottom:4px;">EMAIL</span><strong>${u.email}</strong></div>
          <div><span style="color:#9db0ff;font-size:.82rem;display:block;margin-bottom:4px;">PAROLĂ</span><strong style="color:#ffd580;font-family:monospace;">${u.plain_password}</strong></div>
        </div>
        <div style="text-align:center;margin-top:28px;"><a href="${appUrl}/login" style="background:linear-gradient(135deg,#7c5cff,#2dd4bf);color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;">Accesează aplicația</a></div>
      </div>`
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// ── Flows admin ────────────────────────────────────────────────────────────
// ── GET /admin/flows/clean-preview — preview fluxuri ce vor fi șterse ─────
router.get('/admin/flows/clean-preview', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  try {
    const days = parseInt(req.query.days || '30');
    const filterInst = (req.query.institutie || '').trim();
    const filterDept = (req.query.compartiment || '').trim();
    const all = req.query.all === 'true';

    const { rows: userRows } = await pool.query('SELECT email,institutie,compartiment FROM users');
    const userMap = {}; userRows.forEach(u => { userMap[u.email.toLowerCase()] = u; });

    let rows;
    if (all) {
      const { rows: r } = await pool.query('SELECT id,data,created_at FROM flows ORDER BY created_at DESC');
      rows = r;
    } else {
      const { rows: r } = await pool.query(
        "SELECT id,data,created_at FROM flows WHERE created_at < NOW() - ($1 || ' days')::INTERVAL ORDER BY created_at DESC",
        [days]
      );
      rows = r;
    }

    const eligible = rows.filter(r => {
      const d = r.data || {};
      const u = userMap[(d.initEmail || '').toLowerCase()] || {};
      if (filterInst && (u.institutie || d.institutie || '') !== filterInst) return false;
      if (filterDept && (u.compartiment || d.compartiment || '') !== filterDept) return false;
      return true;
    });

    const totalBytes = eligible.reduce((acc, r) => {
      const d = r.data || {};
      return acc + (d.pdfB64 ? Math.round(d.pdfB64.length * 0.75) : 0) + (d.signedPdfB64 ? Math.round(d.signedPdfB64.length * 0.75) : 0);
    }, 0);

    return res.json({
      count: eligible.length,
      totalMB: Math.round(totalBytes / 1024 / 1024 * 100) / 100,
      flows: eligible.slice(0, 200).map(r => {  // max 200 in preview
        const d = r.data || {};
        const u = userMap[(d.initEmail || '').toLowerCase()] || {};
        const status = d.completed ? 'finalizat' : d.status === 'refused' ? 'refuzat' : d.status === 'review_requested' ? 'revizuire' : d.storage === 'drive' ? 'arhivat' : 'activ';
        return {
          flowId: d.flowId, docName: d.docName || '—',
          initEmail: d.initEmail || '—', initName: d.initName || '—',
          createdAt: d.createdAt || r.created_at, status,
          storage: d.storage || 'db',
          sizeMB: Math.round(((d.pdfB64?.length||0) + (d.signedPdfB64?.length||0)) * 0.75 / 1024 / 1024 * 100) / 100,
          institutie: u.institutie || d.institutie || '',
          compartiment: u.compartiment || d.compartiment || '',
        };
      })
    });
  } catch(e) { return res.status(500).json({ error: String(e.message || e) }); }
});


router.post('/admin/flows/clean', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const { olderThanDays, all, institutie, compartiment } = req.body || {};
  try {
    let result;
    if (!institutie && !compartiment) {
      if (all) result = await pool.query('DELETE FROM flows');
      else result = await pool.query("DELETE FROM flows WHERE created_at < NOW() - ($1 || ' days')::INTERVAL", [parseInt(olderThanDays) || 30]);
      return res.json({ ok: true, deleted: result.rowCount });
    }
    const { rows: userRows } = await pool.query('SELECT email,institutie,compartiment FROM users');
    const userMap = {}; userRows.forEach(u => { userMap[u.email.toLowerCase()] = u; });
    const { rows } = await pool.query(
      all ? 'SELECT id,data FROM flows' : "SELECT id,data FROM flows WHERE created_at < NOW() - ($1 || ' days')::INTERVAL",
      all ? [] : [parseInt(olderThanDays) || 30]
    );
    const idsToDelete = rows.filter(r => {
      const d = r.data || {}; const u = userMap[(d.initEmail || '').toLowerCase()] || {};
      if (institutie && (u.institutie || d.institutie || '') !== institutie) return false;
      if (compartiment && (u.compartiment || d.compartiment || '') !== compartiment) return false;
      return true;
    }).map(r => r.id);
    if (!idsToDelete.length) return res.json({ ok: true, deleted: 0 });
    result = await pool.query('DELETE FROM flows WHERE id = ANY($1)', [idsToDelete]);
    return res.json({ ok: true, deleted: result.rowCount });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

router.get('/admin/flows/archive-preview', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  try {
    const days = parseInt(req.query.days || '30');
    const filterInst = (req.query.institutie || '').trim();
    const filterDept = (req.query.compartiment || '').trim();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { rows } = await pool.query('SELECT id,data,created_at FROM flows WHERE created_at < $1 ORDER BY created_at ASC', [cutoff]);
    const { rows: userRows } = await pool.query('SELECT email,institutie,compartiment FROM users');
    const userMap = {}; userRows.forEach(u => { userMap[u.email.toLowerCase()] = u; });
    const eligible = rows.filter(r => {
      const d = r.data; if (!d) return false;
      const done = d.completed || (d.signers || []).every(s => s.status === 'signed');
      const refused = (d.signers || []).some(s => s.status === 'refused') || d.status === 'refused';
      const archived = d.storage === 'drive';
      if (archived) return false;
      if (!(done || refused)) return false;
      const u = userMap[(d.initEmail || '').toLowerCase()] || {};
      if (filterInst && (u.institutie || d.institutie || '') !== filterInst) return false;
      if (filterDept && (u.compartiment || d.compartiment || '') !== filterDept) return false;
      return true;
    });
    const totalBytes = eligible.reduce((acc, r) => {
      const d = r.data;
      return acc + (d.pdfB64 ? Math.round(d.pdfB64.length * 0.75) : 0) + (d.signedPdfB64 ? Math.round(d.signedPdfB64.length * 0.75) : 0);
    }, 0);
    return res.json({
      count: eligible.length, totalMB: Math.round(totalBytes / 1024 / 1024 * 100) / 100,
      flows: eligible.map(r => {
        const u = userMap[(r.data.initEmail || '').toLowerCase()] || {};
        return { flowId: r.data.flowId, docName: r.data.docName, createdAt: r.data.createdAt || r.created_at,
          status: r.data.completed ? 'finalizat' : (r.data.signers || []).some(s => s.status === 'refused') ? 'refuzat' : 'necunoscut',
          sizeMB: Math.round(((r.data.pdfB64?.length || 0) + (r.data.signedPdfB64?.length || 0)) * 0.75 / 1024 / 1024 * 100) / 100,
          institutie: u.institutie || r.data.institutie || '', compartiment: u.compartiment || r.data.compartiment || '' };
      })
    });
  } catch(e) { return res.status(500).json({ error: String(e.message || e) }); }
});

router.post('/admin/flows/archive', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  try {
    const { flowIds, batchIndex = 0 } = req.body || {};
    if (!Array.isArray(flowIds) || !flowIds.length) return res.status(400).json({ error: 'flowIds_required' });
    const BATCH_SIZE = 10;
    const start = batchIndex * BATCH_SIZE;
    const batch = flowIds.slice(start, start + BATCH_SIZE);
    const hasMore = start + BATCH_SIZE < flowIds.length;
    const results = [];
    for (const flowId of batch) {
      let driveResult = null;
      try {
        const data = await getFlowData(flowId);
        if (!data) { results.push({ flowId, ok: false, error: 'not_found' }); continue; }
        // Skip deja arhivate
        if (data.storage === 'drive') { results.push({ flowId, ok: true, skipped: true }); continue; }
        // Skip daca nu are niciun PDF (flux gol/corupt) — marcam arhivat direct
        if (!data.pdfB64 && !data.signedPdfB64) {
          data.storage = 'drive'; data.archivedAt = new Date().toISOString();
          await saveFlow(flowId, data);
          results.push({ flowId, ok: true, warning: 'No PDF available — marked archived without Drive upload' });
          continue;
        }
        driveResult = await archiveFlow(data);
        data.pdfB64 = null; data.signedPdfB64 = null; data.storage = 'drive';
        data.archivedAt = new Date().toISOString();
        data.driveFileIdFinal = driveResult.driveFileIdFinal || null;
        data.driveFileIdOriginal = driveResult.driveFileIdOriginal || null;
        data.driveFileIdAudit = driveResult.driveFileIdAudit || null;
        data.driveFolderId = driveResult.driveFolderId || null;
        data.driveFileLinkFinal = driveResult.driveFileLinkFinal || null;
        data.driveFileLinkOriginal = driveResult.driveFileLinkOriginal || null;
        await saveFlow(flowId, data);
        results.push({ flowId, ok: true });
        console.log(`📦 Archived flow ${flowId} to Drive`);
      } catch(e) {
        console.error(`📦 Archive error ${flowId}:`, e.message);
        // Daca Drive upload a reusit dar saveFlow a esuat, marcam oricum cu Drive IDs
        if (driveResult) {
          try {
            const data2 = await getFlowData(flowId);
            if (data2 && data2.storage !== 'drive') {
              data2.storage = 'drive'; data2.archivedAt = new Date().toISOString();
              data2.pdfB64 = null; data2.signedPdfB64 = null;
              Object.assign(data2, driveResult);
              await saveFlow(flowId, data2);
              results.push({ flowId, ok: true, warning: 'Drive OK, DB save retry reusit: ' + e.message });
              continue;
            }
          } catch(e2) { console.error(`Archive retry save error ${flowId}:`, e2.message); }
        }
        results.push({ flowId, ok: false, error: String(e.message || e) });
      }
    }
    return res.json({ ok: true, results, hasMore, nextBatchIndex: batchIndex + 1, totalProcessed: start + batch.length, total: flowIds.length });
  } catch(e) { return res.status(500).json({ error: String(e.message || e) }); }
});

router.post('/admin/db/vacuum', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  try {
    await pool.query('VACUUM ANALYZE flows');
    const sizeR = await pool.query('SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size');
    return res.json({ ok: true, message: 'VACUUM ANALYZE flows executat.', dbSize: sizeR.rows[0].db_size });
  } catch(e) { return res.status(500).json({ error: String(e.message || e) }); }
});

router.get('/admin/drive/verify', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  try { res.json(await verifyDrive()); } catch(e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.get('/admin/flows/list', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  try {
    const page = Math.max(1, parseInt(req.query.page || '1'));
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50')));
    const offset = (page - 1) * limit;
    const statusFilter = (req.query.status || 'all').toLowerCase();
    const instFilter = (req.query.institutie || '').trim();
    const deptFilter = (req.query.compartiment || '').trim();
    const search = (req.query.search || '').trim().toLowerCase();
    const conditions = ['1=1']; const params = [];
    if (statusFilter === 'pending') conditions.push("(data->>'completed') IS DISTINCT FROM 'true' AND (data->>'status') IS DISTINCT FROM 'refused'");
    else if (statusFilter === 'completed') conditions.push("(data->>'completed') = 'true'");
    else if (statusFilter === 'refused') conditions.push("(data->>'status') = 'refused'");
    if (search) { params.push(`%${search}%`); conditions.push(`(lower(data->>'docName') LIKE $${params.length} OR lower(data->>'initName') LIKE $${params.length} OR lower(data->>'initEmail') LIKE $${params.length})`); }
    if (instFilter) { params.push(instFilter); conditions.push(`(data->>'institutie' = $${params.length} OR EXISTS (SELECT 1 FROM users u WHERE lower(u.email)=lower(data->>'initEmail') AND u.institutie=$${params.length}))`); }
    if (deptFilter) { params.push(deptFilter); conditions.push(`(data->>'compartiment' = $${params.length} OR EXISTS (SELECT 1 FROM users u WHERE lower(u.email)=lower(data->>'initEmail') AND u.compartiment=$${params.length}))`); }
    const whereClause = conditions.join(' AND ');
    const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM flows WHERE ${whereClause}`, params);
    const total = parseInt(countRows[0].count); const pages = Math.ceil(total / limit) || 1;
    const { rows } = await pool.query(`SELECT id,data,created_at FROM flows WHERE ${whereClause} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset]);
    const { rows: userRows } = await pool.query('SELECT email,institutie,compartiment FROM users');
    const userMap = {}; userRows.forEach(u => { userMap[u.email.toLowerCase()] = u; });
    const flows = rows.map(r => {
      const d = r.data || {}; const initEmail = (d.initEmail || '').toLowerCase(); const u = userMap[initEmail] || {};
      return { flowId: d.flowId, docName: d.docName, initEmail: d.initEmail, initName: d.initName,
        status: d.status || 'active', completed: !!(d.completed || (d.signers || []).every(s => s.status === 'signed')),
        storage: d.storage || 'db', createdAt: d.createdAt || r.created_at,
        institutie: u.institutie || d.institutie || '', compartiment: u.compartiment || d.compartiment || '',
        signers: (d.signers || []).map(s => ({ name: s.name, email: s.email, rol: s.rol, status: s.status, tokenCreatedAt: s.tokenCreatedAt || null })) };
    });
    return res.json({ flows, total, page, limit, pages });
  } catch(e) { return res.status(500).json({ error: String(e.message || e) }); }
});

// ── Utility endpoints ──────────────────────────────────────────────────────
router.get('/wa-test', async (req, res) => {
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  res.status((await verifyWhatsApp()).ok ? 200 : 500).json(await verifyWhatsApp());
});

router.post('/wa-test', async (req, res) => {
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const { to } = req.body || {};
  if (!to) return res.status(400).json({ error: 'to (phone) missing' });
  const r = await sendWaSignRequest({ phone: to, signerName: 'Test', docName: 'Document test DocFlowAI' });
  res.status(r.ok ? 200 : 500).json(r);
});

router.get('/smtp-test', async (req, res) => {
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const r = await verifySmtp(); res.status(r.ok ? 200 : 500).json(r);
});

router.post('/smtp-test', async (req, res) => {
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const { to } = req.body || {}; if (!to) return res.status(400).json({ error: 'to missing' });
  try {
    const v = await verifySmtp(); if (!v.ok) return res.status(500).json({ error: 'smtp_not_ready', detail: v });
    await sendSignerEmail({ to, subject: 'Test SMTP DocFlowAI', html: '<p>SMTP funcționează! ✅</p>' });
    res.json({ ok: true, to });
  } catch(e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.get('/health', async (req, res) => {
  const base = { ok: true, service: 'DocFlowAI', version: '3.2.2', dbReady: DB_READY, dbLastError: DB_LAST_ERROR, wsClients: _wsClientsSize(), ts: new Date().toISOString() };
  if (!pool || !DB_READY) return res.json(base);
  try {
    const [flowsR, usersR, notifsR, archR] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM flows'), pool.query('SELECT COUNT(*) FROM users'),
      pool.query('SELECT COUNT(*) FROM notifications WHERE read=FALSE'),
      pool.query("SELECT COUNT(*) FROM flows WHERE data->>'storage'='drive'"),
    ]);
    const sizeR = await pool.query('SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size, pg_database_size(current_database()) AS db_bytes');
    return res.json({ ...base, stats: { flows: parseInt(flowsR.rows[0].count), flowsArchived: parseInt(archR.rows[0].count), users: parseInt(usersR.rows[0].count), unreadNotifications: parseInt(notifsR.rows[0].count), dbSize: sizeR.rows[0].db_size, dbBytes: parseInt(sizeR.rows[0].db_bytes) } });
  } catch(e) { return res.json({ ...base, statsError: e.message }); }
});

// Alias explicit cu auth pentru admin stats
router.get('/admin/stats', async (req, res) => {
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  if (!pool || !DB_READY) return res.json({ ok: false, error: 'db_not_ready' });
  try {
    const [flowsR, usersR, notifsR, archR] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM flows'), pool.query('SELECT COUNT(*) FROM users'),
      pool.query('SELECT COUNT(*) FROM notifications WHERE read=FALSE'),
      pool.query("SELECT COUNT(*) FROM flows WHERE data->>'storage'='drive'"),
    ]);
    const sizeR = await pool.query('SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size, pg_database_size(current_database()) AS db_bytes');
    return res.json({ ok: true, stats: { flows: parseInt(flowsR.rows[0].count), flowsArchived: parseInt(archR.rows[0].count), users: parseInt(usersR.rows[0].count), unreadNotifications: parseInt(notifsR.rows[0].count), dbSize: sizeR.rows[0].db_size, dbBytes: parseInt(sizeR.rows[0].db_bytes) } });
  } catch(e) { return res.status(500).json({ error: e.message }); }
});

// ── GET /admin/flows/:flowId/audit — export audit log ─────────────────────
// FIX: mutat INAINTE de export default
router.get('/admin/flows/:flowId/audit', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  try {
    const { flowId } = req.params;
    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    const format = (req.query.format || 'json').toLowerCase();
    const audit = {
      flowId: data.flowId, docName: data.docName,
      initName: data.initName, initEmail: data.initEmail,
      institutie: data.institutie || '', compartiment: data.compartiment || '',
      createdAt: data.createdAt, updatedAt: data.updatedAt,
      completed: !!data.completed, completedAt: data.completedAt || null,
      status: data.status || 'active', storage: data.storage || 'db',
      urgent: !!(data.urgent),
      parentFlowId: data.parentFlowId || null,
      reviewReason: data.reviewReason || null,
      reviewHistory: Array.isArray(data.reviewHistory) ? data.reviewHistory : [],
      signers: (data.signers || []).map(s => ({
        order: s.order, name: s.name, email: s.email, rol: s.rol,
        functie: s.functie || '', compartiment: s.compartiment || '',
        status: s.status, signedAt: s.signedAt || null,
        refuseReason: s.refuseReason || null, refusedAt: s.refusedAt || null,
        pdfUploaded: !!s.pdfUploaded, uploadedHash: s.uploadedHash || null,
        delegatedFrom: s.delegatedFrom || null, tokenCreatedAt: s.tokenCreatedAt || null,
      })),
      events: Array.isArray(data.events) ? data.events : [],
      signedPdfVersions: Array.isArray(data.signedPdfVersions) ? data.signedPdfVersions : [],
    };
    if (format === 'csv') {
      const lines = ['timestamp,type,by,channel,details'];
      for (const e of audit.events) {
        const details = JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !['at','type'].includes(k)))).replace(/"/g, '""');
        lines.push(`"${e.at}","${e.type}","${e.by || ''}","${e.channel || ''}","${details}"`);
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="audit_${flowId}.csv"`);
      return res.send(lines.join('\n'));
    }
    if (format === 'txt') {
      let txt = `=== AUDIT LOG DocFlowAI ===\n`;
      txt += `Flow: ${audit.flowId}\nDocument: ${audit.docName}\nInitiator: ${audit.initName} <${audit.initEmail}>\n`;
      txt += `Institutie: ${audit.institutie}\nCompartiment: ${audit.compartiment}\n`;
      txt += `Creat: ${audit.createdAt}\nStatus: ${audit.status}${audit.completedAt ? '\nFinalizat: ' + audit.completedAt : ''}\n\n`;
      txt += `--- SEMNATARI ---\n`;
      for (const s of audit.signers) {
        txt += `${s.order}. ${s.name} <${s.email}> [${s.rol}] — ${s.status.toUpperCase()}`;
        if (s.signedAt) txt += ` la ${s.signedAt}`;
        if (s.refuseReason) txt += ` — REFUZ: ${s.refuseReason}`;
        if (s.delegatedFrom) txt += ` — DELEGAT de ${s.delegatedFrom.email}`;
        txt += '\n';
      }
      txt += `\n--- EVENIMENTE (${audit.events.length}) ---\n`;
      for (const e of audit.events) {
        txt += `[${e.at}] ${e.type}${e.by ? ' BY ' + e.by : ''}${e.channel ? ' via ' + e.channel : ''}${e.reason ? ' REASON: ' + e.reason : ''}\n`;
      }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="audit_${flowId}.txt"`);
      return res.send(txt);
    }
    if (format === 'pdf') {
      if (!PDFLibAdmin) return res.status(503).json({ error: 'pdf_lib_not_available' });
      const { PDFDocument, rgb, StandardFonts } = PDFLibAdmin;
      const diacr = {'ă':'a','â':'a','î':'i','ș':'s','ț':'t','Ă':'A','Â':'A','Î':'I','Ș':'S','Ț':'T','ş':'s','ţ':'t','Ş':'S','Ţ':'T'};
      const ro = t => String(t || '').split('').map(ch => diacr[ch] || ch).join('');
      // Format date cu timezone Romania
      const fmtDate = iso => iso ? new Date(iso).toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest' }) : '—';
      const pdfDoc = await PDFDocument.create();
      const fontB = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      const fontR = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const PAGE_W = 595, PAGE_H = 842, MARGIN = 50;
      let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
      let y = PAGE_H - MARGIN;
      const LINE_H = 13, SECTION_GAP = 10;
      const newPage = () => { page = pdfDoc.addPage([PAGE_W, PAGE_H]); y = PAGE_H - MARGIN; };
      const ensureSpace = (needed) => { if (y < MARGIN + needed) newPage(); };
      const drawText = (text, x, size, font, color) => {
        ensureSpace(size + 6);
        page.drawText(ro(text), { x, y, size, font: font || fontR, color: color || rgb(0.2,0.2,0.2), maxWidth: PAGE_W - x - MARGIN });
        y -= size + 6;
      };
      const drawLine = () => {
        ensureSpace(8);
        page.drawLine({ start:{x:MARGIN,y:y+4}, end:{x:PAGE_W-MARGIN,y:y+4}, thickness:0.5, color:rgb(0.75,0.75,0.75) });
        y -= 8;
      };
      page.drawRectangle({ x:0, y:PAGE_H-70, width:PAGE_W, height:70, color:rgb(0.1,0.1,0.25) });
      page.drawText('AUDIT LOG', { x:MARGIN, y:PAGE_H-35, size:20, font:fontB, color:rgb(1,1,1) });
      page.drawText(ro('DocFlowAI — document de trasabilitate'), { x:MARGIN, y:PAGE_H-52, size:9, font:fontR, color:rgb(0.7,0.8,1) });
      page.drawText(ro(`Generat: ${fmtDate(new Date().toISOString())}`), { x:PAGE_W-200, y:PAGE_H-35, size:9, font:fontR, color:rgb(0.7,0.8,1) });
      // URGENT badge in header
      if (audit.urgent) {
        page.drawRectangle({ x:PAGE_W-130, y:PAGE_H-58, width:100, height:18, color:rgb(0.85,0.1,0.1) });
        page.drawText('🚨 URGENT', { x:PAGE_W-125, y:PAGE_H-50, size:10, font:fontB, color:rgb(1,1,1) });
      }
      y = PAGE_H - 85;
      drawText('INFORMATII FLUX', MARGIN, 11, fontB, rgb(0.15,0.15,0.6));
      drawLine();
      const infoRows = [
        ['Flow ID:', audit.flowId], ['Document:', (audit.urgent ? '🚨 [URGENT] ' : '') + audit.docName],
        ['Initiator:', `${audit.initName} <${audit.initEmail}>`],
        ['Institutie:', audit.institutie || '—'], ['Compartiment:', audit.compartiment || '—'],
        ['Creat:', fmtDate(audit.createdAt)],
        ['Status:', audit.status + (audit.completed ? ' (FINALIZAT)' : '') + (audit.completedAt ? ' la ' + fmtDate(audit.completedAt) : '') + (audit.urgent ? ' — URGENT' : '')],
      ];
      for (const [lbl, val] of infoRows) {
        ensureSpace(18);
        page.drawText(ro(lbl), { x:MARGIN, y, size:9, font:fontB, color:rgb(0.3,0.3,0.3) });
        page.drawText(ro(String(val||'—')), { x:MARGIN+100, y, size:9, font:fontR, color:rgb(0.15,0.15,0.15), maxWidth:PAGE_W-MARGIN-110 });
        y -= 16;
      }
      y -= SECTION_GAP;
      drawText('SEMNATARI', MARGIN, 11, fontB, rgb(0.15,0.15,0.6));
      drawLine();
      for (const s of audit.signers) {
        ensureSpace(60);
        const statusColor = s.status==='signed' ? rgb(0,0.5,0.3) : s.status==='refused' ? rgb(0.7,0.1,0.1) : rgb(0.4,0.4,0.4);
        page.drawText(ro(`${s.order}. ${s.name} — ${s.rol}`), { x:MARGIN, y, size:9, font:fontB, color:rgb(0.1,0.1,0.1), maxWidth:300 });
        page.drawText(ro(s.status.toUpperCase()), { x:PAGE_W-MARGIN-80, y, size:9, font:fontB, color:statusColor });
        y -= 15;
        page.drawText(ro(s.email), { x:MARGIN+12, y, size:8, font:fontR, color:rgb(0.4,0.4,0.4) });
        if (s.functie) page.drawText(ro(s.functie), { x:MARGIN+220, y, size:8, font:fontR, color:rgb(0.5,0.5,0.5) });
        y -= 13;
        if (s.signedAt) { page.drawText(ro(`Semnat: ${fmtDate(s.signedAt)}`), { x:MARGIN+12, y, size:8, font:fontR, color:rgb(0,0.4,0.2) }); y -= 13; }
        if (s.refuseReason) { page.drawText(ro(`Refuz: ${s.refuseReason}`), { x:MARGIN+12, y, size:8, font:fontR, color:rgb(0.7,0.1,0.1), maxWidth:PAGE_W-MARGIN-30 }); y -= 13; }
        if (s.delegatedFrom) { page.drawText(ro(`Delegat de: ${s.delegatedFrom.email} — ${s.delegatedFrom.reason}`), { x:MARGIN+12, y, size:8, font:fontR, color:rgb(0.4,0.2,0.6), maxWidth:PAGE_W-MARGIN-30 }); y -= 13; }
        y -= 6;
      }
      y -= SECTION_GAP;
      // Issue 3: Calcul timp de procesare per semnatar — pentru ORICE actiune (semnat/refuzat/revizuire)
      const timeRows = [];
      const allEvents = audit.events || [];
      for (let i = 0; i < audit.signers.length; i++) {
        const s = audit.signers[i];
        // Gasim momentul in care semnatarul a primit sarcina:
        // - pentru primul semnatar: la crearea fluxului sau primul FLOW_REINITIATED_AFTER_REVIEW
        // - pentru ceilalti: evenimentul SIGNED_PDF_UPLOADED al predecesorului (sau FLOW_CREATED/reinitiate)
        let sentAt = null;
        if (i === 0) {
          // Cel mai recent eveniment de reinitiere sau creare
          const reinitiateEvs = allEvents.filter(e => e.type === 'FLOW_REINITIATED_AFTER_REVIEW' && !e._inheritedFrom);
          sentAt = reinitiateEvs.length ? reinitiateEvs[reinitiateEvs.length - 1].at : audit.createdAt;
        } else {
          // Cand predecesorul (order mai mic) a uploadat PDF-ul semnat
          const prevOrder = Number(audit.signers[i-1]?.order) || 0;
          const uploadEv = allEvents.filter(e => e.type === 'SIGNED_PDF_UPLOADED' && !e._inheritedFrom && (Number(e.order) === prevOrder || (Number(e.order) === 0 && i === 1)));
          sentAt = uploadEv.length ? uploadEv[uploadEv.length - 1].at : null;
          if (!sentAt) {
            // Fallback: cand predecesorul a semnat
            sentAt = audit.signers[i-1]?.signedAt || null;
          }
        }
        // Determinam momentul actiunii si tipul actiunii
        let actionAt = null, actionLabel = null;
        if (s.signedAt) { actionAt = s.signedAt; actionLabel = 'semnat'; }
        else if (s.refusedAt) { actionAt = s.refusedAt; actionLabel = 'refuzat'; }
        else {
          // Cerere de revizuire
          const reviewEv = allEvents.find(e => e.type === 'REVIEW_REQUESTED' && e.by === s.email && !e._inheritedFrom);
          if (reviewEv) { actionAt = reviewEv.at; actionLabel = 'trimis spre revizuire'; }
        }
        if (sentAt && actionAt) {
          const diffMs = Math.max(0, new Date(actionAt) - new Date(sentAt));
          const diffD = Math.floor(diffMs / 86400000);
          const diffH = Math.floor((diffMs % 86400000) / 3600000);
          const diffM = Math.floor((diffMs % 3600000) / 60000);
          const durStr = diffD > 0 ? `${diffD}z ${diffH}h ${diffM}min` : diffH > 0 ? `${diffH}h ${diffM}min` : `${diffM}min`;
          timeRows.push(`${s.order}. ${ro(s.name||s.email)} [${ro(s.rol||'')}]: ${actionLabel} in ${durStr} de la primire`);
        } else if (!actionAt) {
          timeRows.push(`${s.order}. ${ro(s.name||s.email)} [${ro(s.rol||'')}]: in asteptare`);
        }
      }
      if (timeRows.length) {
        drawText('TIMPI DE PROCESARE', MARGIN, 11, fontB, rgb(0.15,0.15,0.6));
        drawLine();
        for (const t of timeRows) {
          ensureSpace(16);
          page.drawText(ro(t), { x:MARGIN, y, size:8, font:fontR, color:rgb(0.3,0.3,0.3), maxWidth:PAGE_W-MARGIN*2 });
          y -= 13;
        }
        y -= SECTION_GAP;
      }
      drawText(`JURNAL EVENIMENTE (${audit.events.length})`, MARGIN, 11, fontB, rgb(0.15,0.15,0.6));
      drawLine();
      if (audit.parentFlowId) {
        ensureSpace(14);
        page.drawText(ro(`[Flux parinte: ${audit.parentFlowId}]`), { x:MARGIN, y, size:7.5, font:fontR, color:rgb(0.4,0.2,0.6) });
        y -= 12;
      }
      const inheritedEvs = audit.events.filter(e => e._inheritedFrom);
      const currentEvs = audit.events.filter(e => !e._inheritedFrom);
      const renderEvent = (e, dimmed) => {
        const detail = [e.by ? `by:${e.by}` : '', e.channel ? `via:${e.channel}` : '', e.reason ? `motiv:${e.reason}` : '', e.to ? `to:${e.to}` : ''].filter(Boolean).join('  ');
        const neededH = detail ? 26 : 14;
        ensureSpace(neededH + 4);
        const ts = e.at ? fmtDate(e.at) : '';
        const tsWidth = 115, typeWidth = 160;
        const dimColor = dimmed ? rgb(0.6,0.6,0.6) : rgb(0.5,0.5,0.5);
        const typeColor = dimmed ? rgb(0.5,0.5,0.65) : rgb(0.2,0.2,0.5);
        page.drawText(ro(`[${ts}]`), { x:MARGIN, y, size:7.5, font:fontR, color:dimColor });
        page.drawText(ro(e.type||''), { x:MARGIN+tsWidth, y, size:7.5, font:fontB, color:typeColor });
        if (detail) {
          page.drawText(ro(detail), { x:MARGIN+tsWidth+typeWidth, y, size:7.5, font:fontR, color:dimColor, maxWidth:PAGE_W-MARGIN-(tsWidth+typeWidth)-MARGIN });
        }
        y -= LINE_H;
      };
      if (inheritedEvs.length) {
        ensureSpace(14);
        page.drawText(ro('---- FLUX PARINTE ----'), { x:MARGIN, y, size:7.5, font:fontB, color:rgb(0.4,0.2,0.6) }); y -= 12;
        for (const e of inheritedEvs) renderEvent(e, true);
        ensureSpace(14);
        page.drawText(ro('---- FLUX CURENT ----'), { x:MARGIN, y, size:7.5, font:fontB, color:rgb(0.1,0.4,0.4) }); y -= 12;
      }
      for (const e of currentEvs) renderEvent(e, false);
      const pageCount = pdfDoc.getPageCount();
      for (let i = 0; i < pageCount; i++) {
        const pg = pdfDoc.getPage(i);
        pg.drawLine({ start:{x:MARGIN,y:30}, end:{x:PAGE_W-MARGIN,y:30}, thickness:0.4, color:rgb(0.8,0.8,0.8) });
        pg.drawText(ro(`DocFlowAI — Audit Log — ${audit.flowId}`), { x:MARGIN, y:18, size:7, font:fontR, color:rgb(0.6,0.6,0.6) });
        pg.drawText(ro(`Pagina ${i+1} din ${pageCount}`), { x:PAGE_W-MARGIN-60, y:18, size:7, font:fontR, color:rgb(0.6,0.6,0.6) });
      }
      const pdfBytes = await pdfDoc.save();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="audit_${flowId}.pdf"`);
      return res.send(Buffer.from(pdfBytes));
    }
    res.json(audit);
  } catch(e) { return res.status(500).json({ error: String(e.message || e) }); }
});

// ── GET /admin/flows/audit-export — export bulk audit ─────────────────────
router.get('/admin/flows/audit-export', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  try {
    const days = parseInt(req.query.days || '30');
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { rows } = await pool.query('SELECT data FROM flows WHERE created_at > $1 ORDER BY created_at DESC LIMIT 1000', [cutoff]);
    const lines = ['flowId,docName,initEmail,createdAt,status,signersCount,eventsCount,completedAt'];
    for (const r of rows) {
      const d = r.data || {};
      const status = d.completed ? 'completed' : (d.status === 'refused' ? 'refused' : 'active');
      lines.push(`"${d.flowId}","${(d.docName || '').replace(/"/g, '""')}","${d.initEmail}","${d.createdAt}","${status}","${(d.signers || []).length}","${(d.events || []).length}","${d.completedAt || ''}"`);
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit_export_${new Date().toISOString().slice(0,10)}.csv"`);
    return res.send(lines.join('\n'));
  } catch(e) { return res.status(500).json({ error: String(e.message || e) }); }
});

// FIX: export default DUPA toate rutele

// ── GET /admin/user-activity — raport activitate per utilizator ────────────
router.get('/admin/user-activity', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  try {
    const from = req.query.from ? new Date(req.query.from).toISOString() : new Date(Date.now() - 30*24*3600*1000).toISOString();
    const to   = req.query.to   ? new Date(new Date(req.query.to).getTime() + 86399999).toISOString() : new Date().toISOString();
    const emailFilter    = (req.query.email    || '').toLowerCase().trim();
    const instFilter     = (req.query.institutie    || '').trim();
    const deptFilter     = (req.query.compartiment  || '').trim();
    const nameFilter     = (req.query.name     || '').toLowerCase().trim();

    // Toti utilizatorii din sistem
    const { rows: userRows } = await pool.query('SELECT email, nume, functie, institutie, compartiment, role FROM users ORDER BY nume');

    // Selectăm DOAR câmpurile necesare din JSONB, fără PDF-uri (pdfB64/signedPdfB64 pot fi sute de MB)
    const { rows: flowRows } = await pool.query(
      `SELECT
         data->>'flowId'   AS "flowId",
         data->>'docName'  AS "docName",
         data->'events'    AS events
       FROM flows
       WHERE created_at <= $1
       ORDER BY created_at DESC
       LIMIT 10000`,
      [to]
    );

    // EVENT_TYPES → eticheta romana
    const OP_LABELS = {
      FLOW_CREATED: 'Inițiat',
      SIGNED_PDF_UPLOADED: 'Semnat',
      REFUSED: 'Refuzat',
      REVIEW_REQUESTED: 'Trimis spre revizuire',
      FLOW_REINITIATED_AFTER_REVIEW: 'Reinițiat după revizuire',
      REINITIATED_AFTER_REVIEW: 'Reinitiere marcată',
      FLOW_COMPLETED: 'Finalizat',
      DELEGATE: 'Delegare semnătură',
      YOUR_TURN: 'Notificat',
    };

    // Construim raport per user
    const activity = {}; // email -> { ops: [], counts: {} }
    const initUsers = new Set();

    for (const fr of flowRows) {
      const flowId  = fr.flowId  || '?';
      const docName = fr.docName || '?';
      const events  = Array.isArray(fr.events) ? fr.events : [];

      for (const ev of events) {
        if (!ev.at) continue;
        if (ev.at < from || ev.at > to) continue;
        const byEmail = (ev.by || '').toLowerCase();
        if (!byEmail) continue;
        if (emailFilter && byEmail !== emailFilter) continue;

        const opType = ev.type || 'EVENT';
        const label = OP_LABELS[opType] || opType;

        if (!activity[byEmail]) activity[byEmail] = { ops: [], counts: {} };
        activity[byEmail].counts[opType] = (activity[byEmail].counts[opType] || 0) + 1;
        activity[byEmail].ops.push({ at: ev.at, type: opType, label, flowId, docName, reason: ev.reason || ev.reviewReason || '' });
      }
    }

    // Sortăm ops descrescator
    for (const email of Object.keys(activity)) {
      activity[email].ops.sort((a, b) => b.at.localeCompare(a.at));
    }

    // Compunem rezultatul cu toate filtrele
    const result = userRows
      .filter(u => {
        if (emailFilter && u.email.toLowerCase() !== emailFilter) return false;
        if (instFilter && (u.institutie || '') !== instFilter) return false;
        if (deptFilter && (u.compartiment || '') !== deptFilter) return false;
        if (nameFilter && !(u.nume || '').toLowerCase().includes(nameFilter)) return false;
        return true;
      })
      .map(u => {
        const email = u.email.toLowerCase();
        const act = activity[email] || { ops: [], counts: {} };
        return {
          email: u.email, name: u.nume || u.email, functie: u.functie || '', institutie: u.institutie,
          compartiment: u.compartiment, role: u.role,
          totalOps: act.ops.length, counts: act.counts, ops: act.ops,
        };
      });

    return res.json({ ok: true, from, to, users: result });
  } catch(e) { console.error('user-activity error:', e); return res.status(500).json({ error: String(e.message || e) }); }
});

export default router;
