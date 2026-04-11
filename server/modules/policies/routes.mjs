/**
 * server/modules/policies/routes.mjs — Policy Engine API (v4)
 * Mounted at /api/policies in app.mjs
 */

import { Router }      from 'express';
import { pool }        from '../../db/index.mjs';
import { requireAuth } from '../../middleware/auth.mjs';
import { getOrgId }    from '../../core/tenant.mjs';
import { NotFoundError, ValidationError } from '../../core/errors.mjs';
import { evaluatePolicy } from './evaluator.mjs';

const router = Router();

function requireAdminRole(req, res, next) {
  if (!req.user || !['admin', 'superadmin', 'org_admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

// ── GET /api/policies ─────────────────────────────────────────────────────────

router.get('/', requireAuth, requireAdminRole, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM policy_rules
       WHERE (org_id=$1 OR org_id IS NULL) AND is_active=TRUE
       ORDER BY priority DESC, created_at ASC`,
      [getOrgId(req)]
    );
    res.json({ policies: rows });
  } catch (err) { next(err); }
});

// ── POST /api/policies ────────────────────────────────────────────────────────

router.post('/', requireAuth, requireAdminRole, async (req, res, next) => {
  try {
    const { scope, code, name, description, rule_json, priority = 0 } = req.body;
    if (!scope || !code || !name || !rule_json) {
      throw new ValidationError('scope, code, name, rule_json sunt obligatorii');
    }
    const { rows } = await pool.query(
      `INSERT INTO policy_rules
         (org_id, scope, code, name, description, rule_json, priority)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       RETURNING *`,
      [getOrgId(req), scope, code, name, description ?? null,
       JSON.stringify(rule_json), priority]
    );
    res.status(201).json({ policy: rows[0] });
  } catch (err) { next(err); }
});

// ── PATCH /api/policies/:id ───────────────────────────────────────────────────

router.patch('/:id', requireAuth, requireAdminRole, async (req, res, next) => {
  try {
    const { name, description, rule_json, priority, is_active } = req.body;
    const sets = ['updated_at = NOW()'];
    const vals = [];
    let idx = 1;
    if (name        !== undefined) { sets.push(`name=$${idx++}`);              vals.push(name); }
    if (description !== undefined) { sets.push(`description=$${idx++}`);       vals.push(description); }
    if (rule_json   !== undefined) { sets.push(`rule_json=$${idx++}::jsonb`);  vals.push(JSON.stringify(rule_json)); }
    if (priority    !== undefined) { sets.push(`priority=$${idx++}`);          vals.push(priority); }
    if (is_active   !== undefined) { sets.push(`is_active=$${idx++}`);         vals.push(is_active); }
    vals.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE policy_rules SET ${sets.join(', ')} WHERE id=$${idx} RETURNING *`,
      vals
    );
    if (!rows[0]) throw new NotFoundError('PolicyRule');
    res.json({ policy: rows[0] });
  } catch (err) { next(err); }
});

// ── DELETE /api/policies/:id ──────────────────────────────────────────────────

router.delete('/:id', requireAuth, requireAdminRole, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE policy_rules SET is_active=FALSE, updated_at=NOW() WHERE id=$1 RETURNING id`,
      [req.params.id]
    );
    if (!rows[0]) throw new NotFoundError('PolicyRule');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /api/policies/evaluate ───────────────────────────────────────────────

router.post('/evaluate', requireAuth, async (req, res, next) => {
  try {
    const { scope, context } = req.body;
    if (!scope) throw new ValidationError('scope este obligatoriu');
    const result = await evaluatePolicy(scope, context ?? {}, getOrgId(req));
    res.json(result);
  } catch (err) { next(err); }
});

export default router;
