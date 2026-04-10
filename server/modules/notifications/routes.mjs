/**
 * server/modules/notifications/routes.mjs — In-app notifications API (v4)
 * Mounted at /api/notifications in app.mjs
 */

import { Router }      from 'express';
import { requireAuth } from '../../middleware/auth.mjs';
import { pool }        from '../../db/index.mjs';
import { parsePagination } from '../../core/pagination.mjs';
import { savePushSubscription, removePushSubscription } from './push.mjs';

const router = Router();

// ── GET /api/notifications ────────────────────────────────────────────────────

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { user } = req;
    const { page, limit, offset } = parsePagination(req.query);
    const onlyUnread = req.query.unread === 'true';

    const conds = ['user_id=$1'];
    const vals  = [user.id];
    if (onlyUnread) conds.push('read=false');

    const { rows } = await pool.query(
      `SELECT *, COUNT(*) OVER() AS _total
       FROM inapp_notifications
       WHERE ${conds.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${vals.length + 1} OFFSET $${vals.length + 2}`,
      [...vals, limit, offset]
    );
    const total = rows.length > 0 ? parseInt(rows[0]._total) : 0;
    res.json({ notifications: rows.map(({ _total, ...r }) => r), total, page, limit });
  } catch (err) { next(err); }
});

// ── GET /api/notifications/count ──────────────────────────────────────────────

router.get('/count', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT COUNT(*) AS cnt FROM inapp_notifications WHERE user_id=$1 AND read=false',
      [req.user.id]
    );
    res.json({ unread: parseInt(rows[0].cnt) });
  } catch (err) { next(err); }
});

// ── POST /api/notifications/read ──────────────────────────────────────────────

router.post('/read', requireAuth, async (req, res, next) => {
  try {
    const { user } = req;
    const { ids, all } = req.body;

    if (all) {
      await pool.query(
        'UPDATE inapp_notifications SET read=true WHERE user_id=$1 AND read=false',
        [user.id]
      );
    } else if (Array.isArray(ids) && ids.length > 0) {
      await pool.query(
        'UPDATE inapp_notifications SET read=true WHERE user_id=$1 AND id = ANY($2)',
        [user.id, ids]
      );
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /api/notifications/push-subscribe ────────────────────────────────────

router.post('/push-subscribe', requireAuth, async (req, res, next) => {
  try {
    await savePushSubscription(req.user.id, req.body);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /api/notifications/push-unsubscribe ──────────────────────────────────

router.post('/push-unsubscribe', requireAuth, async (req, res, next) => {
  try {
    await removePushSubscription(req.user.id, req.body.endpoint);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
