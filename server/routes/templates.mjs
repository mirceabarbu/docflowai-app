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
import { resolveActorOr } from '../services/actor-identity.mjs';
import { isAdminOrOrgAdmin, actorCanAccessOrg } from '../services/authz-scope.mjs';

const router = Router();

// ── GET /api/templates ────────────────────────────────────────────────────
router.get('/api/templates', async (req, res) => {
  if (requireDb(res)) return;
  const tokenActor = requireAuth(req, res); if (!tokenActor) return;
  const actor = await resolveActorOr(res, tokenActor, req); if (!actor) return;
  try {
    const orgId = actor.org_id || null;
    // FIX v3.2.3: filtrare pe org_id pentru sabloane partajate (nu doar pe institutie text)
    const { rows } = await pool.query(
      `SELECT * FROM templates WHERE user_email=$1 OR (shared=TRUE AND org_id=$2)
       ORDER BY user_email=$1 DESC, name ASC`,
      [actor.email.toLowerCase(), orgId]
    );
    const accessActor = { role: actor.role, orgId: actor.org_id };
    res.json(rows.map(t => {
      const isOwner = t.user_email === actor.email.toLowerCase();
      const canDelete = isOwner
        || (isAdminOrOrgAdmin(actor) && t.shared === true && actorCanAccessOrg(accessActor, t.org_id));
      return { ...t, isOwner, canDelete };
    }));
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

// ── POST /api/templates ───────────────────────────────────────────────────
router.post('/api/templates', async (req, res) => {
  if (requireDb(res)) return;
  const tokenActor = requireAuth(req, res); if (!tokenActor) return;
  const actor = await resolveActorOr(res, tokenActor, req); if (!actor) return;
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
    const institutie = actor.institutie || '';
    const orgId = actor.org_id || null;
    if (shared && !orgId) {
      return res.status(409).json({ error: 'user_without_org', message: 'Contul nu este asociat unei organizații.' });
    }
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
  const tokenActor = requireAuth(req, res); if (!tokenActor) return;
  const actor = await resolveActorOr(res, tokenActor, req); if (!actor) return;
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'invalid_id' });
  const { name, signers, shared } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name_required' });
  if (name.trim().length > 200) return res.status(400).json({ error: 'name_too_long', max: 200 });
  if (!Array.isArray(signers) || signers.length === 0) return res.status(400).json({ error: 'signers_required' });
  if (signers.length > 50) return res.status(400).json({ error: 'too_many_signers', max: 50 });
  const orgId = actor.org_id || null;
  // Aceeași gardă ca la POST: nu poți partaja un șablon dacă nu ai organizație —
  // ar deveni invizibil pentru toți (shared=TRUE + org_id NULL).
  if (shared && !orgId) {
    return res.status(409).json({ error: 'user_without_org', message: 'Contul nu este asociat unei organizații.' });
  }
  try {
    // COALESCE(org_id, $6): vindecă rândurile vechi cu org_id NULL, dar NU re-pointează
    // un șablon care are deja un org (deliberat — evităm mutarea tăcută între organizații).
    const { rows } = await pool.query(
      'UPDATE templates SET name=$1,signers=$2,shared=$3,org_id=COALESCE(org_id,$6),updated_at=NOW() WHERE id=$4 AND user_email=$5 RETURNING *',
      [name?.trim(), JSON.stringify(signers), !!shared, id, actor.email.toLowerCase(), orgId]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found_or_not_owner' });
    res.json({ ...rows[0], isOwner: true });
  } catch(e) { logger.error({ err: e }, 'PUT /api/templates error'); res.status(500).json({ error: 'server_error' }); }
});

// ── DELETE /api/templates/:id ─────────────────────────────────────────────
// Owner: își șterge orice șablon propriu (privat sau shared).
// Admin / org_admin: pot șterge orice șablon SHARED din propria organizație
// (curățare de șabloane instituție, inclusiv orfane — proprietar șters din DB).
router.delete('/api/templates/:id', async (req, res) => {
  if (requireDb(res)) return;
  const tokenActor = requireAuth(req, res); if (!tokenActor) return;
  const actor = await resolveActorOr(res, tokenActor, req); if (!actor) return;
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'invalid_id' });
  try {
    const { rows } = await pool.query(
      'SELECT id, user_email, shared, org_id FROM templates WHERE id=$1',
      [id]
    );
    const tmpl = rows[0];
    if (!tmpl) return res.status(404).json({ error: 'not_found' });

    const isOwner = tmpl.user_email === actor.email.toLowerCase();
    const accessActor = { role: actor.role, orgId: actor.org_id };
    const isOrgManager = isAdminOrOrgAdmin(actor)
      && tmpl.shared === true
      && actorCanAccessOrg(accessActor, tmpl.org_id);

    if (!isOwner && !isOrgManager) {
      return res.status(403).json({ error: 'forbidden' });
    }

    await pool.query('DELETE FROM templates WHERE id=$1', [id]);
    res.json({ ok: true });
  } catch(e) { logger.error({ err: e }, 'DELETE /api/templates error'); res.status(500).json({ error: 'server_error' }); }
});

export default router;
