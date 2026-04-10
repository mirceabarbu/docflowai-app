/**
 * server/modules/admin/tracking.mjs — Public tracking routes for DocFlowAI v4.
 *
 * These routes are mounted directly on the app (not under a prefix) because
 * the full paths are embedded in sent emails and cannot change.
 *
 * Routes:
 *   GET /admin/outreach/track/:trackingId  — open pixel (1×1 GIF)
 *   GET /admin/outreach/click/:trackingId  — click redirect with URL param
 *
 * Both are public (no auth) and must remain stable.
 * The outreach module in modules/admin/outreach.mjs also handles these
 * via its own router — this file is an explicit alternative registration
 * point for apps that want to mount tracking separately from the API prefix.
 */

import { pool }   from '../../db/index.mjs';
import { logger } from '../../middleware/logger.mjs';

const GIF1x1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const TRACKING_RE = /^[a-f0-9-]{32,36}$/;

/**
 * registerTrackingRoutes — attach open-pixel and click-redirect handlers.
 *
 * @param {import('express').Application} app
 */
export function registerTrackingRoutes(app) {
  // Open-pixel: 1×1 transparent GIF, records first open
  app.get('/d/:trackingId', (req, res) => {
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.end(GIF1x1);

    const { trackingId } = req.params;
    if (!trackingId || !TRACKING_RE.test(trackingId)) return;

    pool.query(`
      UPDATE outreach_recipients
      SET status    = CASE WHEN status = 'sent' THEN 'opened' ELSE status END,
          opened_at = CASE WHEN opened_at IS NULL AND status = 'sent' THEN NOW() ELSE opened_at END
      WHERE tracking_id = $1
    `, [trackingId]).catch(e => logger.warn({ err: e }, 'tracking open pixel error'));
  });

  // Click redirect: records click then redirects to destination
  app.get('/p/:trackingId', (req, res) => {
    const { trackingId } = req.params;
    const raw  = req.query.u ? decodeURIComponent(req.query.u) : '';
    const dest = /^https?:\/\//.test(raw) ? raw : 'https://www.docflowai.ro';

    res.redirect(302, dest);

    if (!trackingId || !TRACKING_RE.test(trackingId)) return;

    pool.query(`
      UPDATE outreach_recipients
      SET status      = CASE WHEN status IN ('sent','pending') THEN 'opened' ELSE status END,
          opened_at   = CASE WHEN opened_at IS NULL THEN NOW() ELSE opened_at END,
          clicked_at  = CASE WHEN clicked_at IS NULL THEN NOW() ELSE clicked_at END,
          click_count = COALESCE(click_count, 0) + 1
      WHERE tracking_id = $1
    `, [trackingId]).catch(e => logger.warn({ err: e }, 'tracking click error'));
  });
}
