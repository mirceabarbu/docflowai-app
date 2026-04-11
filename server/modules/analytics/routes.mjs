/**
 * server/modules/analytics/routes.mjs — Analytics API (v4)
 * Mounted at /api/analytics in app.mjs
 */

import { Router }      from 'express';
import { requireAuth } from '../../middleware/auth.mjs';
import { getOrgId }    from '../../core/tenant.mjs';
import * as svc from './service.mjs';

const router = Router();

function requireAdminRole(req, res, next) {
  if (!req.user || !['admin', 'superadmin', 'org_admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

// ── GET /api/analytics/summary ────────────────────────────────────────────────

router.get('/summary', requireAuth, requireAdminRole, async (req, res, next) => {
  try {
    const summary = await svc.getSummary(getOrgId(req), {
      from: req.query.from,
      to:   req.query.to,
    });
    res.json(summary);
  } catch (err) { next(err); }
});

// ── GET /api/analytics/flows ──────────────────────────────────────────────────

router.get('/flows', requireAuth, requireAdminRole, async (req, res, next) => {
  try {
    const timeline = await svc.getFlowsTimeline(getOrgId(req), {
      days: req.query.days,
    });
    res.json({ timeline });
  } catch (err) { next(err); }
});

// ── GET /api/analytics/signing ────────────────────────────────────────────────

router.get('/signing', requireAuth, requireAdminRole, async (req, res, next) => {
  try {
    const stats = await svc.getSigningStats(getOrgId(req));
    res.json({ signing: stats });
  } catch (err) { next(err); }
});

// ── GET /api/analytics/forms ──────────────────────────────────────────────────

router.get('/forms', requireAuth, requireAdminRole, async (req, res, next) => {
  try {
    const stats = await svc.getFormsStats(getOrgId(req));
    res.json({ forms: stats });
  } catch (err) { next(err); }
});

export default router;
