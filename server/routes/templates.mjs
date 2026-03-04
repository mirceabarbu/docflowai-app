/**
 * DocFlowAI — Templates routes
 * GET /api/templates, POST /api/templates,
 * PUT /api/templates/:id, DELETE /api/templates/:id
 */

import { Router } from 'express';
import { pool, requireDb } from '../db/index.mjs';
import { requireAuth } from '../middleware/auth.mjs';

const router = Router();

// ── GET /api/templates ─────────────────────────────────────────────────────
router.get('/api/templates', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows: uRows } = await pool.query(
      'SELECT institutie FROM users WHERE email=$1',
      [actor.email.toLowerCase()]
    );
    const institutie = uRows[0]?.institutie || '';
    const { rows } = await pool.query(
      `SELECT * FROM templates
       WHERE user_email=$1 OR (shared=TRUE AND institutie=$2 AND institutie!='')
       ORDER BY user_email=$1 DESC, name ASC`,
      [actor.email.toLowerCase(), institutie]
    );
    res.json(rows.map(t => ({ ...t, isOwner: t.user_email === actor.email.toLowerCase() })));
  } catch(e) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ── POST /api/templates ────────────────────────────────────────────────────
router.post('/api/templates', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const { name, signers, shared } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name_required' });
  if (!Array.isArray(signers) || signers.length === 0)
    return res.status(400).json({ error: 'signers_required' });
  try {
    const { rows: uRows } = await pool.query(
      'SELECT institutie FROM users WHERE email=$1',
      [actor.email.toLowerCase()]
    );
    const institutie = uRows[0]?.institutie || '';
    const { rows } = await pool.query(
      'INSERT INTO templates (user_email,institutie,name,signers,shared) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [actor.email.toLowerCase(), institutie, name.trim(), JSON.stringify(signers), !!shared]
    );
    res.status(201).json({ ...rows[0], isOwner: true });
  } catch(e) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ── PUT /api/templates/:id ─────────────────────────────────────────────────
router.put('/api/templates/:id', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const { name, signers, shared } = req.body || {};
  try {
    const { rows } = await pool.query(
      `UPDATE templates
       SET name=$1, signers=$2, shared=$3, updated_at=NOW()
       WHERE id=$4 AND user_email=$5
       RETURNING *`,
      [name?.trim(), JSON.stringify(signers), !!shared, parseInt(req.params.id), actor.email.toLowerCase()]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found_or_not_owner' });
    res.json({ ...rows[0], isOwner: true });
  } catch(e) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ── DELETE /api/templates/:id ──────────────────────────────────────────────
router.delete('/api/templates/:id', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM templates WHERE id=$1 AND user_email=$2',
      [parseInt(req.params.id), actor.email.toLowerCase()]
    );
    if (!rowCount) return res.status(404).json({ error: 'not_found_or_not_owner' });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: 'server_error' });
  }
});

export default router;
