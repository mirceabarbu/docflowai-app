/**
 * server/routes/registratura.mjs — Registratură Faza 1 (read-only)
 *
 * GET /api/registratura/intrari      — listă paginată registru (org-scoped)
 * GET /api/registratura/export.csv   — export CSV (audit)
 * GET /api/me/can-registratura       — gating server-driven { can: bool }
 *
 * Auth: cookie JWT (requireAuth helper-mode). Org isolation pe actor.orgId.
 * Status afișat = derivat la citire din flows (anulat/refuzat/finalizat reflectat
 * automat, fără hook pe lifecycle).
 */

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requireAuth } from '../middleware/auth.mjs';
import { csrfMiddleware } from '../middleware/csrf.mjs';
import { pool, writeAuditEvent } from '../db/index.mjs';
import { logger } from '../middleware/logger.mjs';
import { isModuleEnabled } from '../services/entitlements.mjs';
import { allocateNumber } from '../services/registratura.mjs';

const router = Router();
const _csrf = csrfMiddleware;

// Termene legale implicite per registru (zile calendaristice).
const TERMEN_REGISTRU = { petitii: 30, '544': 10, intrare: null, general: null };

// Tranziții lifecycle valide pentru documente intrate.
const TRANZITII = {
  inregistrat: ['repartizat', 'clasat'],
  repartizat:  ['in_lucru', 'clasat'],
  in_lucru:    ['solutionat', 'clasat'],
  solutionat:  [],
  clasat:      [],
};

function _db(res) {
  if (!pool) { res.status(503).json({ error: 'db_unavailable' }); return false; }
  return true;
}

// Documente emise (directie='iesire'): status derivat din flux (ca Faza 1).
// Documente intrate (directie='intrare'): status stocat, override 'solutionat'
// dacă fluxul-răspuns legat e finalizat (derivat, fără hook pe lifecycle).
const _STATUS_SQL = `
  CASE
    WHEN r.directie = 'iesire' THEN
      CASE
        WHEN f.id IS NULL THEN 'inregistrat'
        WHEN (f.data->>'cancelledAt') IS NOT NULL THEN 'anulat'
        WHEN (f.data->>'refusedAt')   IS NOT NULL THEN 'refuzat'
        WHEN (f.data->>'completed')::boolean IS TRUE THEN 'finalizat'
        ELSE 'in_lucru'
      END
    ELSE
      CASE
        WHEN fr.id IS NOT NULL
             AND (fr.data->>'completed')::boolean IS TRUE THEN 'solutionat'
        ELSE COALESCE(r.status, 'inregistrat')
      END
  END
`;

router.get('/api/me/can-registratura', async (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;
  try {
    const can = await isModuleEnabled(pool, {
      moduleKey: 'registratura',
      userId: actor.id || actor.userId,
      orgId: actor.orgId,
    });
    res.json({ can: !!can });
  } catch (e) {
    logger.warn({ err: e }, 'can-registratura eșuat');
    res.json({ can: false });
  }
});

router.get('/api/registratura/intrari', async (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;
  if (!_db(res)) return;
  try {
    const orgId  = actor.orgId;
    const an     = req.query.an ? parseInt(req.query.an, 10) : null;
    const q      = String(req.query.q || '').trim();
    const status = String(req.query.status || '').trim();
    const page   = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit  = Math.min(100, Math.max(10, parseInt(req.query.limit || '50', 10)));
    const offset = (page - 1) * limit;

    const where = ['r.org_id = $1'];
    const params = [orgId];
    const directie = String(req.query.directie || '').trim();
    const registru = String(req.query.registru || '').trim();
    if (directie) { params.push(directie); where.push(`r.directie = $${params.length}`); }
    if (registru) { params.push(registru); where.push(`r.registru = $${params.length}`); }
    if (an)  { params.push(an);          where.push(`r.an = $${params.length}`); }
    if (q)   { params.push(`%${q}%`);    where.push(`(r.obiect ILIKE $${params.length} OR r.numar_format ILIKE $${params.length})`); }

    let statusFilter = '';
    if (status) { params.push(status); statusFilter = `AND (${_STATUS_SQL}) = $${params.length}`; }

    params.push(limit, offset);
    const sql = `
      SELECT r.id, r.numar, r.numar_format, r.data_inreg, r.directie, r.registru,
             r.obiect, r.expeditor, r.destinatar, r.compartiment, r.flow_id,
             r.termen_at, r.mod_primire, r.repartizat_la, r.status AS status_raw,
             r.raspuns_flow_id,
             ${_STATUS_SQL} AS status,
             COUNT(*) OVER() AS total_count
        FROM registru_intrari r
        LEFT JOIN flows f  ON f.id  = r.flow_id
        LEFT JOIN flows fr ON fr.id = r.raspuns_flow_id
       WHERE ${where.join(' AND ')} ${statusFilter}
       ORDER BY r.an DESC, r.numar DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const { rows } = await pool.query(sql, params);
    const total = rows.length ? Number(rows[0].total_count) : 0;
    res.json({
      total, page, limit,
      items: rows.map(r => ({
        id: r.id, numar: r.numar, numarFormat: r.numar_format,
        data: r.data_inreg, directie: r.directie, registru: r.registru,
        obiect: r.obiect, expeditor: r.expeditor, destinatar: r.destinatar,
        compartiment: r.compartiment, flowId: r.flow_id, status: r.status,
        statusRaw: r.status_raw,
        termenAt: r.termen_at, modPrimire: r.mod_primire,
        repartizatLa: r.repartizat_la, raspunsFlowId: r.raspuns_flow_id,
      })),
    });
  } catch (e) {
    logger.error({ err: e }, 'registratura: listare eșuată');
    res.status(500).json({ error: 'internal' });
  }
});

router.get('/api/registratura/export.csv', async (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;
  if (!_db(res)) return;
  try {
    const orgId = actor.orgId;
    const an    = req.query.an ? parseInt(req.query.an, 10) : null;
    const directie = String(req.query.directie || '').trim();
    const registru = String(req.query.registru || '').trim();
    const where = ['r.org_id = $1'];
    const params = [orgId];
    if (directie) { params.push(directie); where.push(`r.directie = $${params.length}`); }
    if (registru) { params.push(registru); where.push(`r.registru = $${params.length}`); }
    if (an) { params.push(an); where.push(`r.an = $${params.length}`); }
    const { rows } = await pool.query(`
      SELECT r.numar_format, r.data_inreg, r.directie, r.registru, r.obiect,
             r.expeditor, r.destinatar, r.compartiment, r.termen_at,
             ${_STATUS_SQL} AS status
        FROM registru_intrari r
        LEFT JOIN flows f  ON f.id  = r.flow_id
        LEFT JOIN flows fr ON fr.id = r.raspuns_flow_id
       WHERE ${where.join(' AND ')}
       ORDER BY r.an DESC, r.numar DESC`, params);
    const esc = (v) => {
      const s = String(v == null ? '' : v);
      return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const head = ['Nr inregistrare','Data','Directie','Obiect','Expeditor','Destinatar','Compartiment','Status'];
    const lines = [head.join(';')];
    for (const r of rows) {
      lines.push([
        r.numar_format,
        new Date(r.data_inreg).toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest' }),
        r.directie, r.obiect, r.expeditor, r.destinatar, r.compartiment || '', r.status,
      ].map(esc).join(';'));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="registru_${an || 'all'}.csv"`);
    res.send('﻿' + lines.join('\n'));
  } catch (e) {
    logger.error({ err: e }, 'registratura: export CSV eșuat');
    res.status(500).json({ error: 'internal' });
  }
});

router.post('/api/registratura/intrari', _csrf, async (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;
  if (!_db(res)) return;
  try {
    const can = await isModuleEnabled(pool, {
      moduleKey: 'registratura', userId: actor.id || actor.userId, orgId: actor.orgId,
    });
    if (!can) return res.status(403).json({ error: 'module_disabled' });

    const b = req.body || {};
    const registru = ['intrare', 'petitii', '544'].includes(String(b.registru))
      ? String(b.registru) : 'intrare';
    const obiect = String(b.obiect || '').trim();
    if (!obiect) return res.status(400).json({ error: 'obiect_required' });

    const reg = await allocateNumber({
      orgId: actor.orgId,
      sursaId: randomUUID(),
      sursaTip: 'manual',
      registru,
      directie: 'intrare',
      status: 'inregistrat',
      obiect,
      expeditor: String(b.expeditor || '').trim(),
      compartiment: b.compartiment || null,
      modPrimire: b.modPrimire || null,
      nrDocExpeditor: b.nrDocExpeditor || null,
      dataDocExpeditor: b.dataDocExpeditor || null,
      termenZile: TERMEN_REGISTRU[registru] ?? null,
      createdBy: actor.id || actor.userId || null,
    });
    if (!reg) return res.status(500).json({ error: 'alocare_esuata' });

    await writeAuditEvent({
      orgId: actor.orgId, eventType: 'registratura_intrare_creata',
      actorEmail: actor.email, payload: { registru, numar: reg.numarFormat, obiect },
    }).catch(() => {});
    res.json({ ok: true, numar: reg.numar, numarFormat: reg.numarFormat,
               data: reg.data, an: reg.an, registru });
  } catch (e) {
    logger.error({ err: e }, 'registratura: creare intrare eșuată');
    res.status(500).json({ error: 'internal' });
  }
});

router.post('/api/registratura/intrari/:id/status', _csrf, async (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;
  if (!_db(res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    const next = String((req.body || {}).status || '').trim();
    const cur = await pool.query(
      `SELECT status, directie FROM registru_intrari
        WHERE id=$1 AND org_id=$2 LIMIT 1`, [id, actor.orgId]);
    if (!cur.rows.length) return res.status(404).json({ error: 'not_found' });
    if (cur.rows[0].directie !== 'intrare')
      return res.status(400).json({ error: 'doar_intrari' });
    const from = cur.rows[0].status || 'inregistrat';
    if (!(TRANZITII[from] || []).includes(next))
      return res.status(400).json({ error: 'tranzitie_invalida', from, next });

    const sets = ['status = $1'];
    const vals = [next];
    if (next === 'repartizat') {
      vals.push(String((req.body || {}).repartizatLa || '').trim() || null);
      sets.push(`repartizat_la = $${vals.length}`, `repartizat_at = NOW()`);
    }
    if (next === 'solutionat') sets.push(`solutionat_at = NOW()`);
    if (next === 'clasat')     sets.push(`clasat_at = NOW()`);
    vals.push(id, actor.orgId);
    await pool.query(
      `UPDATE registru_intrari SET ${sets.join(', ')}
        WHERE id=$${vals.length - 1} AND org_id=$${vals.length}`, vals);

    await writeAuditEvent({
      orgId: actor.orgId, eventType: 'registratura_intrare_status',
      actorEmail: actor.email, payload: { id, from, to: next },
    }).catch(() => {});
    res.json({ ok: true, status: next });
  } catch (e) {
    logger.error({ err: e }, 'registratura: schimbare status eșuată');
    res.status(500).json({ error: 'internal' });
  }
});

router.post('/api/registratura/intrari/:id/leaga-raspuns', _csrf, async (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;
  if (!_db(res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    const flowId = String((req.body || {}).flowId || '').trim();
    if (!flowId) return res.status(400).json({ error: 'flowId_required' });
    const fl = await pool.query(
      `SELECT id FROM flows WHERE id=$1 AND org_id=$2 LIMIT 1`,
      [flowId, actor.orgId]);
    if (!fl.rows.length) return res.status(404).json({ error: 'flux_inexistent' });
    const upd = await pool.query(
      `UPDATE registru_intrari SET raspuns_flow_id=$1
        WHERE id=$2 AND org_id=$3 AND directie='intrare'
        RETURNING id`, [flowId, id, actor.orgId]);
    if (!upd.rows.length) return res.status(404).json({ error: 'not_found' });
    await writeAuditEvent({
      orgId: actor.orgId, flowId, eventType: 'registratura_legatura_raspuns',
      actorEmail: actor.email, payload: { intrareId: id, flowId },
    }).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'registratura: legare răspuns eșuată');
    res.status(500).json({ error: 'internal' });
  }
});

router.post('/api/registratura/intrari/:id/atasament', _csrf, async (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;
  if (!_db(res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const raw = String(b.fileB64 || '');
    const clean = raw.includes(',') ? raw.split(',')[1] : raw;
    if (!clean) return res.status(400).json({ error: 'file_required' });
    const buf = Buffer.from(clean, 'base64');
    if (buf.length > 15 * 1024 * 1024)
      return res.status(413).json({ error: 'too_large' });
    const own = await pool.query(
      `SELECT id FROM registru_intrari WHERE id=$1 AND org_id=$2 LIMIT 1`,
      [id, actor.orgId]);
    if (!own.rows.length) return res.status(404).json({ error: 'not_found' });
    await pool.query(
      `INSERT INTO registru_atasamente
         (intrare_id, org_id, filename, mime_type, size_bytes, data, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, actor.orgId, String(b.filename || 'scan.pdf'),
       String(b.mimeType || 'application/pdf'), buf.length, buf,
       actor.id || actor.userId || null]);
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'registratura: upload atașament eșuat');
    res.status(500).json({ error: 'internal' });
  }
});

router.get('/api/registratura/intrari/:id/atasamente', async (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;
  if (!_db(res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    const { rows } = await pool.query(
      `SELECT id, filename, mime_type, size_bytes, uploaded_at
         FROM registru_atasamente
        WHERE intrare_id=$1 AND org_id=$2 AND deleted_at IS NULL
        ORDER BY uploaded_at DESC`, [id, actor.orgId]);
    res.json({ items: rows });
  } catch (e) {
    logger.error({ err: e }, 'registratura: listă atașamente eșuată');
    res.status(500).json({ error: 'internal' });
  }
});

router.get('/api/registratura/atasament/:attId', async (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;
  if (!_db(res)) return;
  try {
    const { rows } = await pool.query(
      `SELECT filename, mime_type, data FROM registru_atasamente
        WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL LIMIT 1`,
      [req.params.attId, actor.orgId]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.setHeader('Content-Type', rows[0].mime_type || 'application/pdf');
    res.setHeader('Content-Disposition',
      `inline; filename="${encodeURIComponent(rows[0].filename)}"`);
    res.send(rows[0].data);
  } catch (e) {
    logger.error({ err: e }, 'registratura: download atașament eșuat');
    res.status(500).json({ error: 'internal' });
  }
});

export default router;
