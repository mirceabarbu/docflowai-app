/**
 * DocFlowAI — Templates routes v3.3.8
 *
 * Extras din server/index.mjs (FIX-05 v3.3.8).
 * CRUD complet pentru sablooane de flux: GET / POST / PUT / DELETE.
 *
 * Logică:
 *  - Un utilizator vede propriile șabloane + șabloanele shared ale org-ului său
 *  - Doar proprietarul poate edita / șterge un șablon
 *  - Validare: name max 200 chars, max 50 semnatari, fiecare semnatar cu email valid
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.mjs';
import { pool, requireDb } from '../db/index.mjs';
import { logger } from '../middleware/logger.mjs';

const router = Router();

// ── Validare semnatari — refolosit în POST și PUT ──────────────────────────
function validateTemplateBody(body, res) {
  const { name, signers } = body || {};
  if (!name || !String(name).trim()) { res.status(400).json({ error: 'name_required' }); return false; }
  if (String(name).trim().length > 200) { res.status(400).json({ error: 'name_too_long', max: 200 }); return false; }
  if (!Array.isArray(signers) || signers.length === 0) { res.status(400).json({ error: 'signers_required' }); return false; }
  if (signers.length > 50) { res.status(400).json({ error: 'too_many_signers', max: 50 }); return false; }
  for (let i = 0; i < signers.length; i++) {
    const s = signers[i] || {};
    if (!String(s.email || '').trim() || !/^\S+@\S+\.\S+$/.test(String(s.email || '').trim())) {
      res.status(400).json({ error: 'signer_email_invalid', index: i }); return false;
    }
    if (!String(s.name || '').trim()) { res.status(400).json({ error: 'signer_name_required', index: i }); return false; }
  }
  return true;
}

// ── GET /api/templates ────────────────────────────────────────────────────
router.get('/api/templates', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { rows: uRows } = await pool.query(
      'SELECT institutie, org_id FROM users WHERE email=$1',
      [actor.email.toLowerCase()]
    );
    const institutie = uRows[0]?.institutie || '';
    const orgId = uRows[0]?.org_id || actor.orgId || null;

    // FIX v3.2.3: filtrare pe org_id pentru șabloane shared — nu doar pe institutie text
    const { rows } = await pool.query(
      `SELECT * FROM templates
       WHERE user_email=$1
          OR (shared=TRUE AND institutie=$2 AND institutie!='' AND ($3::integer IS NULL OR org_id=$3))
       ORDER BY user_email=$1 DESC, name ASC`,
      [actor.email.toLowerCase(), institutie, orgId]
    );
    res.json(rows.map(t => ({ ...t, isOwner: t.user_email === actor.email.toLowerCase() })));
  } catch(e) {
    logger.error({ err: e }, 'GET /api/templates error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── POST /api/templates ───────────────────────────────────────────────────
router.post('/api/templates', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (!validateTemplateBody(req.body, res)) return;
  const { name, signers, shared } = req.body;
  try {
    const { rows: uRows } = await pool.query(
      'SELECT institutie, org_id FROM users WHERE email=$1',
      [actor.email.toLowerCase()]
    );
    const institutie = uRows[0]?.institutie || '';
    const orgId = uRows[0]?.org_id || null;
    const { rows } = await pool.query(
      'INSERT INTO templates (user_email,institutie,org_id,name,signers,shared) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [actor.email.toLowerCase(), institutie, orgId, name.trim(), JSON.stringify(signers), !!shared]
    );
    res.status(201).json({ ...rows[0], isOwner: true });
  } catch(e) {
    logger.error({ err: e }, 'POST /api/templates error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── PUT /api/templates/:id ────────────────────────────────────────────────
router.put('/api/templates/:id', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (!validateTemplateBody(req.body, res)) return;
  const { name, signers, shared } = req.body;
  const id = parseInt(req.params.id);
  if (!id || isNaN(id)) return res.status(400).json({ error: 'invalid_id' });
  try {
    const { rows } = await pool.query(
      'UPDATE templates SET name=$1,signers=$2,shared=$3,updated_at=NOW() WHERE id=$4 AND user_email=$5 RETURNING *',
      [name.trim(), JSON.stringify(signers), !!shared, id, actor.email.toLowerCase()]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found_or_not_owner' });
    res.json({ ...rows[0], isOwner: true });
  } catch(e) {
    logger.error({ err: e }, 'PUT /api/templates/:id error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── DELETE /api/templates/:id ─────────────────────────────────────────────
router.delete('/api/templates/:id', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  const id = parseInt(req.params.id);
  if (!id || isNaN(id)) return res.status(400).json({ error: 'invalid_id' });
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM templates WHERE id=$1 AND user_email=$2',
      [id, actor.email.toLowerCase()]
    );
    if (!rowCount) return res.status(404).json({ error: 'not_found_or_not_owner' });
    res.json({ ok: true });
  } catch(e) {
    logger.error({ err: e }, 'DELETE /api/templates/:id error');
    res.status(500).json({ error: 'server_error' });
  }
});

export default router;
