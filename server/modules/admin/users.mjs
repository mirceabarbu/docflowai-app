/**
 * server/modules/admin/users.mjs — Admin: User management API (v4)
 * Mounted at /api/admin/users in app.mjs
 *
 * Exports named `Router` for consumption in app.mjs.
 */

import { Router }          from 'express';
import { pool }            from '../../db/index.mjs';
import { requireAuth }     from '../../middleware/auth.mjs';
import { logger }          from '../../middleware/logger.mjs';
import { logAuditEvent }   from '../../db/queries/audit.mjs';
import { acceptCsv }       from '../../middleware/uploadGuard.mjs';
import { getOrgId, isSuperAdmin } from '../../core/tenant.mjs';
import { NotFoundError, ForbiddenError } from '../../core/errors.mjs';
import { hashPassword }    from '../../core/hashing.mjs';
import { generateToken }   from '../../core/ids.mjs';
import * as userRepo       from '../users/repository.mjs';
import { notify }          from '../notifications/service.mjs';

export { Router };   // named re-export

const router = Router();

// ── Guards ────────────────────────────────────────────────────────────────────

function requireAdminRole(req, res, next) {
  if (!req.user || !['admin', 'superadmin', 'org_admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

router.use(requireAuth, requireAdminRole);

// Ensure target user belongs to same org (unless superadmin)
async function ensureSameOrg(req, targetId) {
  if (isSuperAdmin(req)) return;
  const target = await userRepo.getUserById(targetId);
  if (!target) throw new NotFoundError('User');
  if (target.org_id !== req.user.org_id) throw new ForbiddenError();
}

// ── GET /api/admin/users ──────────────────────────────────────────────────────

router.get('/', async (req, res, next) => {
  try {
    const org_id = isSuperAdmin(req) && req.query.org_id
      ? parseInt(req.query.org_id)
      : getOrgId(req);
    const result = await userRepo.listUsers(org_id, {
      page:   req.query.page,
      limit:  req.query.limit,
      search: req.query.search,
      role:   req.query.role,
      status: req.query.status,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// ── POST /api/admin/users ─────────────────────────────────────────────────────

router.post('/', async (req, res, next) => {
  try {
    const org_id = getOrgId(req);
    const tempPassword = req.body.password ? null : generateToken().slice(0, 12);
    const { user } = await userRepo.createUser({
      ...req.body,
      org_id,
      password: req.body.password || tempPassword,
    });

    if (tempPassword) {
      await notify('user.created', { user, tempPassword }).catch(() => {});
    }

    await logAuditEvent({
      orgId: org_id, actorId: req.user.id, actorEmail: req.user.email,
      eventType: 'admin.user_created',
      message:   `Utilizator creat: ${user.email}`,
      meta:      { userId: user.id },
    }).catch(() => {});

    res.status(201).json({ user, tempPassword: tempPassword ?? undefined });
  } catch (err) { next(err); }
});

// ── GET /api/admin/users/:id ──────────────────────────────────────────────────

router.get('/:id', async (req, res, next) => {
  try {
    const targetId = parseInt(req.params.id);
    await ensureSameOrg(req, targetId);
    const user = await userRepo.getUserById(targetId);
    if (!user) throw new NotFoundError('User');
    res.json({ user });
  } catch (err) { next(err); }
});

// ── PATCH /api/admin/users/:id ────────────────────────────────────────────────

router.patch('/:id', async (req, res, next) => {
  try {
    const targetId = parseInt(req.params.id);
    await ensureSameOrg(req, targetId);

    // Only superadmin can assign superadmin role
    if (req.body.role === 'superadmin' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'insufficient_privileges' });
    }

    const user = await userRepo.updateUser(targetId, req.body);
    if (!user) throw new NotFoundError('User');

    await logAuditEvent({
      orgId: req.user.org_id, actorId: req.user.id, actorEmail: req.user.email,
      eventType: 'admin.user_updated',
      message:   `Utilizator actualizat: ${user.email}`,
      meta:      { userId: targetId, changed: Object.keys(req.body) },
    }).catch(() => {});

    res.json({ user });
  } catch (err) { next(err); }
});

// ── DELETE /api/admin/users/:id ───────────────────────────────────────────────

router.delete('/:id', async (req, res, next) => {
  try {
    const targetId = parseInt(req.params.id);
    if (targetId === req.user.id) {
      return res.status(400).json({ error: 'cannot_delete_self' });
    }
    await ensureSameOrg(req, targetId);

    const result = await userRepo.softDeleteUser(targetId);
    if (!result) throw new NotFoundError('User');

    await logAuditEvent({
      orgId: req.user.org_id, actorId: req.user.id, actorEmail: req.user.email,
      eventType: 'admin.user_deactivated',
      message:   `Utilizator dezactivat: ID ${targetId}`,
      meta:      { userId: targetId },
    }).catch(() => {});

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /api/admin/users/:id/reset-password ──────────────────────────────────

router.post('/:id/reset-password', async (req, res, next) => {
  try {
    const targetId = parseInt(req.params.id);
    await ensureSameOrg(req, targetId);

    const target = await userRepo.getUserById(targetId);
    if (!target) throw new NotFoundError('User');

    const tempPassword = generateToken().slice(0, 12);
    const hash = await hashPassword(tempPassword);

    await pool.query(
      `UPDATE users
       SET password_hash=$1, hash_algo='pbkdf2_v2',
           force_password_change=TRUE,
           token_version = token_version + 1,
           updated_at = NOW()
       WHERE id=$2`,
      [hash, targetId]
    );

    await notify('user.created', {
      user: target,
      tempPassword,
      isReset: true,
    }).catch(() => {});

    await logAuditEvent({
      orgId: req.user.org_id, actorId: req.user.id, actorEmail: req.user.email,
      eventType: 'admin.password_reset',
      message:   `Parola resetată pentru: ${target.email}`,
      meta:      { userId: targetId },
    }).catch(() => {});

    logger.info({ targetId, adminId: req.user.id }, 'Parolă resetată de admin');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /api/admin/users/:id/force-logout ────────────────────────────────────

router.post('/:id/force-logout', async (req, res, next) => {
  try {
    const targetId = parseInt(req.params.id);
    await ensureSameOrg(req, targetId);

    await pool.query(
      `UPDATE users SET token_version = token_version + 1, updated_at = NOW() WHERE id=$1`,
      [targetId]
    );

    await logAuditEvent({
      orgId: req.user.org_id, actorId: req.user.id, actorEmail: req.user.email,
      eventType: 'admin.force_logout',
      message:   `Sesiuni invalidate pentru user ID ${targetId}`,
      meta:      { userId: targetId },
    }).catch(() => {});

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /api/admin/users/bulk-import ────────────────────────────────────────

router.post('/bulk-import', acceptCsv({ maxSizeMB: 5 }), async (req, res, next) => {
  try {
    const org_id  = getOrgId(req);
    const csvText = req.uploadedFile.buffer.toString('utf8');
    const result  = await userRepo.bulkImportCsv(org_id, csvText);

    await logAuditEvent({
      orgId: org_id, actorId: req.user.id, actorEmail: req.user.email,
      eventType: 'admin.bulk_import',
      message:   `Bulk import: ${result.created} creați, ${result.skipped} ignorați, ${result.errors.length} erori`,
      meta:      result,
    }).catch(() => {});

    res.json(result);
  } catch (err) { next(err); }
});

export default router;
