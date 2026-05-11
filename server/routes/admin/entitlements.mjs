/**
 * DocFlowAI — Admin entitlements (PASUL 2)
 *
 * Endpoints (toate sub /api/admin/entitlements, doar superadmin):
 *   GET    /catalog                  — lista modulelor din module_catalog
 *   GET    /                         — entitlements pentru un scope (scope_type + scope_id)
 *   PUT    /                         — upsert entitlement (module_key, scope_type, scope_id, enabled, notes?)
 *   DELETE /                         — șterge entitlement
 *   GET    /resolve                  — diagnostic: valoarea efectivă + lanțul de override
 *
 * Gardă: role='admin' (super-admin global, indiferent de org_id — aliniat cu
 * pattern-ul aplicației: vezi server/routes/admin/_helpers.mjs). Org-admin = 403.
 */

import { Router } from 'express';
import { csrfMiddleware } from '../../middleware/csrf.mjs';
import { requireAuth } from '../../middleware/auth.mjs';
import { pool, requireDb, writeAuditEvent } from '../../db/index.mjs';
import { logger } from '../../middleware/logger.mjs';
import { invalidate, resolveDetailed } from '../../services/entitlements.mjs';

const router = Router();
const _csrf  = csrfMiddleware;

/** Gardă superadmin global (role='admin'). Returnează actor sau trimite 403/401 și null. */
function requireSuperadmin(req, res) {
  const actor = requireAuth(req, res);
  if (!actor) return null;
  if (actor.role !== 'admin') {
    res.status(403).json({ error: 'forbidden' });
    return null;
  }
  return actor;
}

const ALLOWED_SCOPE_TYPES = new Set(['org', 'comp', 'user']);

function _normalizeScope({ scope_type, scope_id }) {
  if (!ALLOWED_SCOPE_TYPES.has(scope_type)) return null;
  const id = (scope_id == null ? '' : String(scope_id)).trim();
  if (!id) return null;
  return { scope_type, scope_id: id };
}

// ── GET /catalog ──────────────────────────────────────────────────────────────
router.get('/catalog', async (req, res) => {
  if (requireDb(res)) return;
  if (!requireSuperadmin(req, res)) return;
  try {
    const { rows } = await pool.query(
      `SELECT module_key, display_name, description, category,
              default_enabled, active, display_order
         FROM module_catalog
         ORDER BY display_order ASC, module_key ASC`
    );
    res.json({ modules: rows });
  } catch (e) {
    logger.error({ err: e }, 'admin/entitlements catalog error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── GET / ── entitlements pe scope ────────────────────────────────────────────
router.get('/', async (req, res) => {
  if (requireDb(res)) return;
  if (!requireSuperadmin(req, res)) return;
  const scope_type = String(req.query.scope_type || '');
  const scope_id   = String(req.query.scope_id || '');
  const scope = _normalizeScope({ scope_type, scope_id });
  if (!scope) return res.status(400).json({ error: 'invalid_scope' });
  try {
    const { rows } = await pool.query(
      `SELECT id, module_key, scope_type, scope_id, enabled, set_by, set_at, notes
         FROM module_entitlements
         WHERE scope_type=$1 AND scope_id=$2
         ORDER BY module_key ASC`,
      [scope.scope_type, scope.scope_id]
    );
    res.json({ entitlements: rows });
  } catch (e) {
    logger.error({ err: e }, 'admin/entitlements list error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── PUT / ── upsert ───────────────────────────────────────────────────────────
router.put('/', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireSuperadmin(req, res);
  if (!actor) return;

  const body = req.body || {};
  const moduleKey = String(body.module_key || '').trim();
  const scope = _normalizeScope({ scope_type: body.scope_type, scope_id: body.scope_id });
  const enabled = !!body.enabled;
  const notes = body.notes != null ? String(body.notes).slice(0, 500) : null;
  if (!moduleKey || !scope) return res.status(400).json({ error: 'invalid_request' });

  try {
    // Validăm că modulul există în catalog (FK ar prinde, dar dăm mesaj clar).
    const { rows: catRows } = await pool.query(
      'SELECT module_key FROM module_catalog WHERE module_key=$1',
      [moduleKey]
    );
    if (!catRows.length) return res.status(400).json({ error: 'unknown_module' });

    // Pentru audit log: vechea valoare (dacă există)
    const { rows: prev } = await pool.query(
      `SELECT enabled FROM module_entitlements
         WHERE module_key=$1 AND scope_type=$2 AND scope_id=$3`,
      [moduleKey, scope.scope_type, scope.scope_id]
    );
    const oldEnabled = prev.length ? !!prev[0].enabled : null;

    const { rows: out } = await pool.query(
      `INSERT INTO module_entitlements (module_key, scope_type, scope_id, enabled, set_by, set_at, notes)
         VALUES ($1, $2, $3, $4, $5, NOW(), $6)
         ON CONFLICT (module_key, scope_type, scope_id)
         DO UPDATE SET enabled = EXCLUDED.enabled,
                       set_by  = EXCLUDED.set_by,
                       set_at  = NOW(),
                       notes   = EXCLUDED.notes
         RETURNING id, module_key, scope_type, scope_id, enabled, set_by, set_at, notes`,
      [moduleKey, scope.scope_type, scope.scope_id, enabled, actor.userId, notes]
    );

    // Invalidare cache: pe user dacă scope='user' și avem id numeric; altfel global.
    if (scope.scope_type === 'user') {
      invalidate({ userId: scope.scope_id });
    } else {
      invalidate();
    }

    // Audit log (fire-and-forget intern)
    writeAuditEvent({
      flowId: null, orgId: null,
      eventType: 'entitlement_change',
      actorEmail: actor.email,
      actorIp: req.ip || null,
      payload: {
        actor_id: actor.userId,
        module_key: moduleKey,
        scope_type: scope.scope_type,
        scope_id: scope.scope_id,
        old_enabled: oldEnabled,
        new_enabled: enabled,
        notes,
      },
    }).catch(() => {});

    res.json({ ok: true, entitlement: out[0] });
  } catch (e) {
    logger.error({ err: e }, 'admin/entitlements upsert error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── DELETE / ── șterge entitlement ────────────────────────────────────────────
router.delete('/', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireSuperadmin(req, res);
  if (!actor) return;

  const moduleKey = String(req.query.module_key || '').trim();
  const scope = _normalizeScope({ scope_type: req.query.scope_type, scope_id: req.query.scope_id });
  if (!moduleKey || !scope) return res.status(400).json({ error: 'invalid_request' });

  try {
    const { rows: prev } = await pool.query(
      `SELECT enabled FROM module_entitlements
         WHERE module_key=$1 AND scope_type=$2 AND scope_id=$3`,
      [moduleKey, scope.scope_type, scope.scope_id]
    );
    const { rowCount } = await pool.query(
      `DELETE FROM module_entitlements
         WHERE module_key=$1 AND scope_type=$2 AND scope_id=$3`,
      [moduleKey, scope.scope_type, scope.scope_id]
    );

    if (scope.scope_type === 'user') invalidate({ userId: scope.scope_id });
    else invalidate();

    if (prev.length) {
      writeAuditEvent({
        flowId: null, orgId: null,
        eventType: 'entitlement_change',
        actorEmail: actor.email,
        actorIp: req.ip || null,
        payload: {
          actor_id: actor.userId,
          module_key: moduleKey,
          scope_type: scope.scope_type,
          scope_id: scope.scope_id,
          old_enabled: !!prev[0].enabled,
          new_enabled: null, // deleted
          op: 'delete',
        },
      }).catch(() => {});
    }

    res.json({ ok: true, deleted: rowCount });
  } catch (e) {
    logger.error({ err: e }, 'admin/entitlements delete error');
    res.status(500).json({ error: 'server_error' });
  }
});

// ── GET /resolve ── diagnostic pentru UI ──────────────────────────────────────
router.get('/resolve', async (req, res) => {
  if (requireDb(res)) return;
  if (!requireSuperadmin(req, res)) return;

  const userId = req.query.user_id ? String(req.query.user_id) : null;
  const moduleKey = String(req.query.module_key || '').trim();
  if (!userId || !moduleKey) return res.status(400).json({ error: 'invalid_request' });

  try {
    const { rows } = await pool.query(
      'SELECT id, org_id, compartiment, email, nume FROM users WHERE id=$1',
      [userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'user_not_found' });
    const u = rows[0];
    const detail = await resolveDetailed(pool, {
      moduleKey,
      userId: u.id,
      compartiment: u.compartiment || null,
      orgId: u.org_id != null ? String(u.org_id) : null,
    });
    res.json({
      user: { id: u.id, email: u.email, nume: u.nume, org_id: u.org_id, compartiment: u.compartiment },
      module_key: moduleKey,
      ...detail,
    });
  } catch (e) {
    logger.error({ err: e }, 'admin/entitlements resolve error');
    res.status(500).json({ error: 'server_error' });
  }
});

export default router;
