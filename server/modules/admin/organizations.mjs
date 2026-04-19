/**
 * server/modules/admin/organizations.mjs — Admin: Organizations API (v4)
 * Mounted at /api/admin/organizations in app.mjs
 *
 * Exports named `Router` for consumption in app.mjs.
 */

import { Router }          from 'express';
import { pool }            from '../../db/index.mjs';
import { requireAuth }     from '../../middleware/auth.mjs';
import { logger }          from '../../middleware/logger.mjs';
import { logAuditEvent }   from '../../db/queries/audit.mjs';
import {
  ValidationError, NotFoundError, ForbiddenError,
} from '../../core/errors.mjs';

export { Router };   // named re-export so app.mjs can do: import { Router as adminOrgRouter }

const router = Router();

// ── Known signing provider codes ─────────────────────────────────────────────

const KNOWN_PROVIDERS = new Set([
  'local-upload', 'sts-cloud', 'certsign', 'transspeed', 'alfatrust', 'namirial',
]);

// ── Guards ────────────────────────────────────────────────────────────────────

function requireAdminRole(req, res, next) {
  if (!req.user || !['admin', 'superadmin', 'org_admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'superadmin_required' });
  }
  next();
}

router.use(requireAuth, requireAdminRole);

// ── GET /api/admin/organizations ──────────────────────────────────────────────

router.get('/', async (req, res, next) => {
  try {
    let rows;
    if (req.user.role === 'admin') {
      // superadmin sees all orgs
      const { rows: r } = await pool.query(
        `SELECT id, name, slug, cif, status, plan,
                signing_providers_enabled, compartimente,
                settings, branding, created_at, updated_at
         FROM organizations
         ORDER BY name`
      );
      rows = r;
    } else {
      // org_admin sees only own org
      const { rows: r } = await pool.query(
        `SELECT id, name, slug, cif, status, plan,
                signing_providers_enabled, compartimente,
                settings, branding, created_at, updated_at
         FROM organizations WHERE id=$1`,
        [req.user.org_id]
      );
      rows = r;
    }
    res.json({ organizations: rows, total: rows.length });
  } catch (err) { next(err); }
});

// ── POST /api/admin/organizations ─────────────────────────────────────────────

router.post('/', requireSuperAdmin, async (req, res, next) => {
  try {
    const { name, slug, cif, plan, signing_providers_enabled = ['local-upload'] } = req.body;
    if (!name || !slug) throw new ValidationError('name și slug sunt obligatorii');

    // Validate providers
    for (const p of signing_providers_enabled) {
      if (!KNOWN_PROVIDERS.has(p)) {
        throw new ValidationError(`Provider necunoscut: ${p}`);
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO organizations
         (name, slug, cif, plan, signing_providers_enabled)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, slug, cif ?? null, plan ?? 'starter', signing_providers_enabled]
    );
    const org = rows[0];

    await logAuditEvent({
      orgId:     org.id,
      actorId:   req.user.id,
      actorEmail: req.user.email,
      eventType: 'org.created',
      message:   `Organizație creată: ${name} (${org.id})`,
      meta:      { orgId: org.id, slug },
    }).catch(() => {});

    logger.info({ orgId: org.id, slug }, 'Organizație creată');
    res.status(201).json({ organization: org });
  } catch (err) { next(err); }
});

// ── GET /api/admin/organizations/:id ─────────────────────────────────────────

router.get('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    // Org_admin can only see own org
    if (req.user.role !== 'admin' && req.user.org_id !== id) {
      throw new ForbiddenError();
    }

    const { rows } = await pool.query(
      `SELECT o.*,
              (SELECT COUNT(*) FROM users WHERE org_id=o.id AND status='active') AS user_count,
              (SELECT COUNT(*) FROM flows WHERE org_id=o.id AND deleted_at IS NULL) AS flow_count
       FROM organizations o WHERE o.id=$1`,
      [id]
    );
    if (!rows[0]) throw new NotFoundError('Organization');
    res.json({ organization: rows[0] });
  } catch (err) { next(err); }
});

// ── PATCH /api/admin/organizations/:id ───────────────────────────────────────

router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (req.user.role !== 'admin' && req.user.org_id !== id) {
      throw new ForbiddenError();
    }

    const { name, cif, compartimente, settings, branding, plan, status } = req.body;

    const sets = ['updated_at = NOW()'];
    const vals = [];
    let idx = 1;

    if (name         !== undefined) { sets.push(`name=$${idx++}`);          vals.push(name); }
    if (cif          !== undefined) { sets.push(`cif=$${idx++}`);           vals.push(cif); }
    if (compartimente !== undefined) { sets.push(`compartimente=$${idx++}`); vals.push(compartimente); }
    if (settings     !== undefined) { sets.push(`settings=$${idx++}::jsonb`); vals.push(JSON.stringify(settings)); }
    if (branding     !== undefined) { sets.push(`branding=$${idx++}::jsonb`); vals.push(JSON.stringify(branding)); }

    // Only superadmin can change plan/status
    if (req.user.role === 'admin') {
      if (plan   !== undefined) { sets.push(`plan=$${idx++}`);   vals.push(plan); }
      if (status !== undefined) { sets.push(`status=$${idx++}`); vals.push(status); }
    }

    vals.push(id);
    const { rows } = await pool.query(
      `UPDATE organizations SET ${sets.join(', ')} WHERE id=$${idx} RETURNING *`,
      vals
    );
    if (!rows[0]) throw new NotFoundError('Organization');

    await logAuditEvent({
      orgId: id, actorId: req.user.id, actorEmail: req.user.email,
      eventType: 'org.updated',
      message:   `Organizație actualizată: ${rows[0].name}`,
      meta:      { changed: Object.keys(req.body) },
    }).catch(() => {});

    res.json({ organization: rows[0] });
  } catch (err) { next(err); }
});

// ── PATCH /api/admin/organizations/:id/providers ──────────────────────────────

router.patch('/:id/providers', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (req.user.role !== 'admin' && req.user.org_id !== id) {
      throw new ForbiddenError();
    }

    const { signing_providers_enabled, signing_providers_config } = req.body;

    if (signing_providers_enabled) {
      for (const p of signing_providers_enabled) {
        if (!KNOWN_PROVIDERS.has(p)) {
          throw new ValidationError(`Provider necunoscut: ${p}`);
        }
      }
    }

    const sets = ['updated_at = NOW()'];
    const vals = [];
    let idx = 1;

    if (signing_providers_enabled !== undefined) {
      sets.push(`signing_providers_enabled=$${idx++}`);
      vals.push(signing_providers_enabled);
    }
    if (signing_providers_config !== undefined) {
      sets.push(`signing_providers_config=$${idx++}::jsonb`);
      vals.push(JSON.stringify(signing_providers_config));
    }

    vals.push(id);
    const { rows } = await pool.query(
      `UPDATE organizations SET ${sets.join(', ')} WHERE id=$${idx} RETURNING id, name, signing_providers_enabled, signing_providers_config`,
      vals
    );
    if (!rows[0]) throw new NotFoundError('Organization');

    await logAuditEvent({
      orgId: id, actorId: req.user.id, actorEmail: req.user.email,
      eventType: 'org.providers_updated',
      message:   `Provideri semnare actualizați`,
      meta:      { providers: signing_providers_enabled },
    }).catch(() => {});

    res.json({ organization: rows[0] });
  } catch (err) { next(err); }
});

export default router;
