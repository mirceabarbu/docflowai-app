/**
 * DocFlowAI — Templates routes
 *
 * Extras din server/index.mjs (Q-06) — zero modificări de logică.
 * Rutele rămân identice funcțional, doar mountate via Router în loc de app direct.
 *
 * Endpoint-uri:
 *   GET    /api/templates        — lista șabloane (proprii + shared din aceeași instituție/org)
 *   POST   /api/templates        — creare șablon nou
 *   PUT    /api/templates/:id    — actualizare șablon (doar owner)
 *   DELETE /api/templates/:id    — ștergere șablon (doar owner)
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.mjs';
import { pool, requireDb } from '../db/index.mjs';
import { logger } from '../middleware/logger.mjs';

const router = Router();

// ── GET /api/templates ────────────────────────────────────────────────────
router.get('/api/templates', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows: uRows } = await pool.query('SELECT institutie, org_id FROM users WHERE email=$1', [actor.email.toLowerCase()]);
    const institutie = uRows[0]?.institutie || '';
    const orgId = uRows[0]?.org_id || actor.orgId || null;
    // FIX v3.2.3: filtrare pe org_id pentru sabloane partajate (nu doar pe institutie text)
    const { rows } = await pool.query(
      `SELECT * FROM templates WHERE user_email=$1 OR (shared=TRUE AND institutie=$2 AND institutie!='' AND ($3::integer IS NULL OR org_id=$3))
       ORDER BY user_email=$1 DESC, name ASC`,
      [actor.email.toLowerCase(), institutie, orgId]
    );
    res.json(rows.map(t => ({ ...t, isOwner: t.user_email === actor.email.toLowerCase() })));
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

// ── POST /api/templates ───────────────────────────────────────────────────
router.post('/api/templates', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const { name, signers, shared } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name_required' });
  if (name.trim().length > 200) return res.status(400).json({ error: 'name_too_long', max: 200 });
  if (!Array.isArray(signers) || signers.length === 0) return res.status(400).json({ error: 'signers_required' });
  if (signers.length > 50) return res.status(400).json({ error: 'too_many_signers', max: 50 });
  for (let i = 0; i < signers.length; i++) {
    const s = signers[i] || {};
    if (!String(s.email || '').trim() || !/^\S+@\S+\.\S+$/.test(String(s.email || '').trim()))
      return res.status(400).json({ error: 'signer_email_invalid', index: i });
  }
  try {
    // FIX b76: citim și org_id — FK obligatoriu pe templates în producție
    const { rows: uRows } = await pool.query('SELECT institutie, org_id FROM users WHERE email=$1', [actor.email.toLowerCase()]);
    const institutie = uRows[0]?.institutie || '';
    const orgId = uRows[0]?.org_id || actor.orgId || null;
    const { rows } = await pool.query(
      'INSERT INTO templates (user_email,institutie,name,signers,shared,org_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [actor.email.toLowerCase(), institutie, name.trim(), JSON.stringify(signers), !!shared, orgId]
    );
    res.status(201).json({ ...rows[0], isOwner: true });
  } catch(e) { logger.error({ err: e }, 'POST /api/templates error'); res.status(500).json({ error: 'server_error' }); }
});

// ── PUT /api/templates/:id ────────────────────────────────────────────────
router.put('/api/templates/:id', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'invalid_id' });
  const { name, signers, shared } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name_required' });
  if (name.trim().length > 200) return res.status(400).json({ error: 'name_too_long', max: 200 });
  if (!Array.isArray(signers) || signers.length === 0) return res.status(400).json({ error: 'signers_required' });
  if (signers.length > 50) return res.status(400).json({ error: 'too_many_signers', max: 50 });
  try {
    const { rows } = await pool.query(
      'UPDATE templates SET name=$1,signers=$2,shared=$3,updated_at=NOW() WHERE id=$4 AND user_email=$5 RETURNING *',
      [name?.trim(), JSON.stringify(signers), !!shared, id, actor.email.toLowerCase()]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found_or_not_owner' });
    res.json({ ...rows[0], isOwner: true });
  } catch(e) { logger.error({ err: e }, 'PUT /api/templates error'); res.status(500).json({ error: 'server_error' }); }
});

// ── DELETE /api/templates/:id ─────────────────────────────────────────────
router.delete('/api/templates/:id', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'invalid_id' });
  try {
    const { rowCount } = await pool.query('DELETE FROM templates WHERE id=$1 AND user_email=$2', [id, actor.email.toLowerCase()]);
    if (!rowCount) return res.status(404).json({ error: 'not_found_or_not_owner' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

export default router;
