/**
 * server/modules/users/routes.mjs — User management API (v4)
 * Mounted at /api/users in app.mjs
 */

import { Router }       from 'express';
import { requireAuth }  from '../../middleware/auth.mjs';
import { acceptCsv }    from '../../middleware/uploadGuard.mjs';
import { getOrgId, assertSameOrg, isSuperAdmin } from '../../core/tenant.mjs';
import { NotFoundError, ForbiddenError } from '../../core/errors.mjs';
import * as svc from './service.mjs';

const router = Router();

// All routes require authentication
router.use(requireAuth);

// Admin-only guard middleware
function requireAdminRole(req, res, next) {
  if (!req.user || !['admin', 'superadmin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

// ── GET /api/users ────────────────────────────────────────────────────────────

router.get('/', requireAdminRole, async (req, res, next) => {
  try {
    const org_id = isSuperAdmin(req) && req.query.org_id
      ? parseInt(req.query.org_id)
      : getOrgId(req);
    const result = await svc.listUsers(org_id, {
      page:   req.query.page,
      limit:  req.query.limit,
      search: req.query.search,
      role:   req.query.role,
      status: req.query.status,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// ── POST /api/users ───────────────────────────────────────────────────────────

router.post('/', requireAdminRole, async (req, res, next) => {
  try {
    const org_id = getOrgId(req);
    const result = await svc.createUser({ ...req.body, org_id });
    res.status(201).json(result);
  } catch (err) { next(err); }
});

// ── GET /api/users/:id ────────────────────────────────────────────────────────

router.get('/:id', async (req, res, next) => {
  try {
    const user = await svc.getUserById(parseInt(req.params.id), req.user);
    if (!user) throw new NotFoundError('User');
    res.json(user);
  } catch (err) { next(err); }
});

// ── PATCH /api/users/:id ──────────────────────────────────────────────────────

router.patch('/:id', requireAdminRole, async (req, res, next) => {
  try {
    const targetId = parseInt(req.params.id);
    // Ensure target user belongs to same org (unless superadmin)
    if (!isSuperAdmin(req)) {
      const target = await svc.getUserById(targetId, req.user);
      if (!target) throw new NotFoundError('User');
    }
    const user = await svc.updateUser(targetId, req.body, req.user);
    if (!user) throw new NotFoundError('User');
    res.json(user);
  } catch (err) { next(err); }
});

// ── DELETE /api/users/:id ─────────────────────────────────────────────────────

router.delete('/:id', requireAdminRole, async (req, res, next) => {
  try {
    const targetId = parseInt(req.params.id);
    if (targetId === req.user.id) {
      return res.status(400).json({ error: 'cannot_delete_self' });
    }
    const result = await svc.softDeleteUser(targetId);
    if (!result) throw new NotFoundError('User');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /api/users/bulk-import ───────────────────────────────────────────────

router.post('/bulk-import', requireAdminRole, acceptCsv({ maxSizeMB: 5 }), async (req, res, next) => {
  try {
    const org_id  = getOrgId(req);
    const csvText = req.uploadedFile.buffer.toString('utf8');
    const result  = await svc.bulkImportCsv(org_id, csvText);
    res.json(result);
  } catch (err) { next(err); }
});

export default router;
