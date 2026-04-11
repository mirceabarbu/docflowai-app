/**
 * server/routes/alop.mjs
 *
 * ALOP — Angajament Legal / Ordonanțare de Plată
 * Orchestrator peste DF + ORD existente: leagă un Document de Fundamentare
 * cu o Ordonanțare de Plată și fluxurile lor de semnare.
 *
 * Toate rutele folosesc pattern-ul v3:
 *   const actor = requireAuth(req, res); if (!actor) return;
 *   actor.orgId / actor.userId
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.mjs';
import { csrfMiddleware } from '../middleware/csrf.mjs';
import { pool } from '../db/index.mjs';
import { logger } from '../middleware/logger.mjs';

const router = Router();
const _csrf  = csrfMiddleware;

function requireDb(res) {
  if (!pool) { res.status(503).json({ error: 'db_unavailable' }); return true; }
  return false;
}

// ── GET /api/alop/stats — trebuie montat ÎNAINTE de /:id ────────────────────
router.get('/api/alop/stats', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::int                                              AS total,
        COUNT(*) FILTER (WHERE status='completed')::int           AS completate,
        COUNT(*) FILTER (WHERE status IN
          ('df_in_progress','df_signed','ord_in_progress','ord_signed'))::int
                                                                   AS in_progres,
        COUNT(*) FILTER (WHERE status='draft')::int               AS draft
      FROM alop_instances
      WHERE org_id=$1 AND cancelled_at IS NULL
    `, [actor.orgId]);
    res.json(rows[0]);
  } catch (e) {
    logger.error({ err: e }, 'alop stats error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── GET /api/alop — lista ALOP pentru org ───────────────────────────────────
router.get('/api/alop', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const params = [actor.orgId];
    let where = 'a.org_id = $1 AND a.cancelled_at IS NULL';
    if (status) {
      params.push(status);
      where += ` AND a.status = $${params.length}`;
    }

    const { rows } = await pool.query(`
      SELECT
        a.id, a.status, a.titlu, a.compartiment, a.valoare_totala,
        a.df_id, a.ord_id, a.df_flow_id, a.ord_flow_id,
        a.created_at, a.updated_at,
        u.nume   AS creator_name,
        u.email  AS creator_email,
        df.nr_unic_inreg AS df_nr,
        df.status        AS df_status,
        fo.status        AS ord_status
      FROM alop_instances a
      LEFT JOIN users        u  ON u.id  = a.created_by
      LEFT JOIN formulare_df df ON df.id = a.df_id
      LEFT JOIN formulare_ord fo ON fo.id = a.ord_id
      WHERE ${where}
      ORDER BY a.updated_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, Number(limit), offset]);

    const { rows: cnt } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM alop_instances a WHERE ${where}`,
      params
    );

    res.json({
      alop:  rows,
      total: cnt[0].count,
      page:  Number(page),
      pages: Math.ceil(cnt[0].count / Number(limit)),
    });
  } catch (e) {
    logger.error({ err: e }, 'alop list error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── POST /api/alop — creare ALOP nou ────────────────────────────────────────
router.post('/api/alop', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { titlu, compartiment, valoare_totala, notes } = req.body;
    const { rows } = await pool.query(`
      INSERT INTO alop_instances
        (org_id, created_by, titlu, compartiment, valoare_totala, notes)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [
      actor.orgId,
      actor.userId,
      titlu       || 'ALOP nou',
      compartiment || '',
      valoare_totala || null,
      notes          || '',
    ]);
    res.status(201).json({ alop: rows[0] });
  } catch (e) {
    logger.error({ err: e }, 'alop create error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── GET /api/alop/:id — detalii ALOP ────────────────────────────────────────
router.get('/api/alop/:id', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows } = await pool.query(`
      SELECT
        a.*,
        u.nume   AS creator_name,
        df.nr_unic_inreg              AS df_nr,
        df.status                     AS df_status,
        df.valoare_totala             AS df_valoare,
        df.compartiment_specialitate  AS df_compartiment,
        fo.status                     AS ord_status,
        fo.beneficiar                 AS ord_beneficiar,
        fo.valoare_totala             AS ord_valoare,
        f1.id AS df_flow_exists,
        f2.id AS ord_flow_exists
      FROM alop_instances a
      LEFT JOIN users        u  ON u.id   = a.created_by
      LEFT JOIN formulare_df df ON df.id  = a.df_id
      LEFT JOIN formulare_ord fo ON fo.id = a.ord_id
      LEFT JOIN flows f1 ON f1.id = a.df_flow_id
      LEFT JOIN flows f2 ON f2.id = a.ord_flow_id
      WHERE a.id = $1
        AND a.org_id = $2
        AND a.cancelled_at IS NULL
    `, [req.params.id, actor.orgId]);

    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ alop: rows[0] });
  } catch (e) {
    logger.error({ err: e }, 'alop get error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── POST /api/alop/:id/link-df ───────────────────────────────────────────────
router.post('/api/alop/:id/link-df', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { df_id } = req.body;
    if (!df_id) return res.status(400).json({ error: 'df_id obligatoriu' });

    const { rows: dfRows } = await pool.query(
      'SELECT id, status FROM formulare_df WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL',
      [df_id, actor.orgId]
    );
    if (!dfRows[0]) return res.status(404).json({ error: 'df_not_found' });

    const { rows } = await pool.query(`
      UPDATE alop_instances
      SET df_id=$1, status='df_in_progress', updated_at=NOW()
      WHERE id=$2 AND org_id=$3
      RETURNING *
    `, [df_id, req.params.id, actor.orgId]);

    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ alop: rows[0] });
  } catch (e) {
    logger.error({ err: e }, 'alop link-df error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── POST /api/alop/:id/link-df-flow ─────────────────────────────────────────
router.post('/api/alop/:id/link-df-flow', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { flow_id } = req.body;
    if (!flow_id) return res.status(400).json({ error: 'flow_id obligatoriu' });

    const { rows } = await pool.query(`
      UPDATE alop_instances
      SET df_flow_id=$1, status='df_signed', updated_at=NOW()
      WHERE id=$2 AND org_id=$3
      RETURNING *
    `, [flow_id, req.params.id, actor.orgId]);

    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ alop: rows[0] });
  } catch (e) {
    logger.error({ err: e }, 'alop link-df-flow error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── POST /api/alop/:id/link-ord ─────────────────────────────────────────────
router.post('/api/alop/:id/link-ord', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { ord_id } = req.body;
    if (!ord_id) return res.status(400).json({ error: 'ord_id obligatoriu' });

    const { rows: ordRows } = await pool.query(
      'SELECT id FROM formulare_ord WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL',
      [ord_id, actor.orgId]
    );
    if (!ordRows[0]) return res.status(404).json({ error: 'ord_not_found' });

    const { rows } = await pool.query(`
      UPDATE alop_instances
      SET ord_id=$1, status='ord_in_progress', updated_at=NOW()
      WHERE id=$2 AND org_id=$3
      RETURNING *
    `, [ord_id, req.params.id, actor.orgId]);

    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ alop: rows[0] });
  } catch (e) {
    logger.error({ err: e }, 'alop link-ord error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── POST /api/alop/:id/link-ord-flow ────────────────────────────────────────
router.post('/api/alop/:id/link-ord-flow', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { flow_id } = req.body;
    if (!flow_id) return res.status(400).json({ error: 'flow_id obligatoriu' });

    const { rows } = await pool.query(`
      UPDATE alop_instances
      SET ord_flow_id=$1, status='ord_signed', updated_at=NOW()
      WHERE id=$2 AND org_id=$3
      RETURNING *
    `, [flow_id, req.params.id, actor.orgId]);

    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ alop: rows[0] });
  } catch (e) {
    logger.error({ err: e }, 'alop link-ord-flow error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── POST /api/alop/:id/complete ─────────────────────────────────────────────
router.post('/api/alop/:id/complete', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows } = await pool.query(`
      UPDATE alop_instances
      SET status='completed', completed_at=NOW(), updated_at=NOW()
      WHERE id=$1 AND org_id=$2
        AND df_id IS NOT NULL AND ord_id IS NOT NULL
      RETURNING *
    `, [req.params.id, actor.orgId]);

    if (!rows[0]) return res.status(400).json({
      error: 'ALOP necesită DF și ORD completate',
    });
    res.json({ alop: rows[0] });
  } catch (e) {
    logger.error({ err: e }, 'alop complete error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── POST /api/alop/:id/cancel ───────────────────────────────────────────────
router.post('/api/alop/:id/cancel', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows } = await pool.query(`
      UPDATE alop_instances
      SET status='cancelled', cancelled_at=NOW(), updated_at=NOW()
      WHERE id=$1 AND org_id=$2
      RETURNING *
    `, [req.params.id, actor.orgId]);

    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ alop: rows[0] });
  } catch (e) {
    logger.error({ err: e }, 'alop cancel error');
    res.status(500).json({ error: 'server_error' });
  }
});

export default router;
