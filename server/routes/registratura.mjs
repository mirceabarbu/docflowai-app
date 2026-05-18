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
import { requireAuth } from '../middleware/auth.mjs';
import { pool } from '../db/index.mjs';
import { logger } from '../middleware/logger.mjs';
import { isModuleEnabled } from '../services/entitlements.mjs';

const router = Router();

function _db(res) {
  if (!pool) { res.status(503).json({ error: 'db_unavailable' }); return false; }
  return true;
}

// Status de afișat în registru, derivat din starea curentă a fluxului.
const _STATUS_SQL = `
  CASE
    WHEN f.id IS NULL THEN 'inregistrat'
    WHEN (f.data->>'cancelledAt') IS NOT NULL THEN 'anulat'
    WHEN (f.data->>'refusedAt')   IS NOT NULL THEN 'refuzat'
    WHEN (f.data->>'completed')::boolean IS TRUE THEN 'finalizat'
    ELSE 'in_lucru'
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

    const where = ['r.org_id = $1', "r.registru = 'general'"];
    const params = [orgId];
    if (an)  { params.push(an);          where.push(`r.an = $${params.length}`); }
    if (q)   { params.push(`%${q}%`);    where.push(`(r.obiect ILIKE $${params.length} OR r.numar_format ILIKE $${params.length})`); }

    let statusFilter = '';
    if (status) { params.push(status); statusFilter = `AND (${_STATUS_SQL}) = $${params.length}`; }

    params.push(limit, offset);
    const sql = `
      SELECT r.id, r.numar, r.numar_format, r.data_inreg, r.directie,
             r.obiect, r.expeditor, r.destinatar, r.compartiment, r.flow_id,
             ${_STATUS_SQL} AS status,
             COUNT(*) OVER() AS total_count
        FROM registru_intrari r
        LEFT JOIN flows f ON f.id = r.flow_id
       WHERE ${where.join(' AND ')} ${statusFilter}
       ORDER BY r.an DESC, r.numar DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const { rows } = await pool.query(sql, params);
    const total = rows.length ? Number(rows[0].total_count) : 0;
    res.json({
      total, page, limit,
      items: rows.map(r => ({
        id: r.id, numar: r.numar, numarFormat: r.numar_format,
        data: r.data_inreg, directie: r.directie, obiect: r.obiect,
        expeditor: r.expeditor, destinatar: r.destinatar,
        compartiment: r.compartiment, flowId: r.flow_id, status: r.status,
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
    const where = ['r.org_id = $1', "r.registru = 'general'"];
    const params = [orgId];
    if (an) { params.push(an); where.push(`r.an = $${params.length}`); }
    const { rows } = await pool.query(`
      SELECT r.numar_format, r.data_inreg, r.directie, r.obiect,
             r.expeditor, r.destinatar, r.compartiment,
             ${_STATUS_SQL} AS status
        FROM registru_intrari r
        LEFT JOIN flows f ON f.id = r.flow_id
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

export default router;
