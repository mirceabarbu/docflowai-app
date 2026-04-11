/**
 * server/modules/archive/routes.mjs — Archive API (v4)
 * Mounted at /api/archive in app.mjs
 */

import { Router }      from 'express';
import { requireAuth } from '../../middleware/auth.mjs';
import { getOrgId }    from '../../core/tenant.mjs';
import * as svc from './service.mjs';

const router = Router();

function requireAdminRole(req, res, next) {
  if (!req.user || !['admin', 'superadmin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

// ── POST /api/archive/flows/:id ───────────────────────────────────────────────

router.post('/flows/:id', requireAuth, requireAdminRole, async (req, res, next) => {
  try {
    const result = await svc.archiveFlow(req.params.id, getOrgId(req));
    res.json(result);
  } catch (err) { next(err); }
});

// ── GET /api/archive/flows/:id ────────────────────────────────────────────────

router.get('/flows/:id', requireAuth, async (req, res, next) => {
  try {
    const status = await svc.getArchiveStatus(req.params.id);
    if (!status) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Archive job not found' } });
    res.json(status);
  } catch (err) { next(err); }
});

export default router;
