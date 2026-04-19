/**
 * server/modules/notifications/push.mjs — VAPID Web Push (v4 module)
 */

import { pool }   from '../../db/index.mjs';
import { logger } from '../../middleware/logger.mjs';
import { sendPushNotification } from '../../push.mjs';

// ── sendPushToUser ────────────────────────────────────────────────────────────

/**
 * Trimite notificare push la toate subscripțiile unui user.
 * Skip silențios dacă VAPID nu e configurat sau userId e null.
 */
export async function sendPushToUser(userId, { title, body, data = {} }) {
  if (!userId || !process.env.VAPID_PUBLIC_KEY || !pool) return;

  try {
    const { rows: [user] } = await pool.query(
      'SELECT email FROM users WHERE id=$1 LIMIT 1', [userId]
    );
    if (!user) return;

    const email = user.email.toLowerCase();
    const { rows } = await pool.query(
      'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_email=$1',
      [email]
    );
    if (!rows.length) return;

    const payload = { title, body, data };
    const expired = [];

    await Promise.allSettled(rows.map(async (row) => {
      const sub    = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
      const result = await sendPushNotification(sub, payload);
      if (!result.ok && (result.statusCode === 410 || result.statusCode === 404)) {
        expired.push(row.id);
      }
    }));

    if (expired.length) {
      await pool.query(
        'DELETE FROM push_subscriptions WHERE id = ANY($1)', [expired]
      );
    }
  } catch (e) {
    logger.warn({ err: e, userId }, 'sendPushToUser error (non-fatal)');
  }
}

// ── savePushSubscription ──────────────────────────────────────────────────────

export async function savePushSubscription(userId, subscription) {
  if (!userId || !subscription?.endpoint) return;
  try {
    const { rows: [user] } = await pool.query(
      'SELECT email FROM users WHERE id=$1 LIMIT 1', [userId]
    );
    if (!user) return;

    const { endpoint, keys = {} } = subscription;
    await pool.query(
      `INSERT INTO push_subscriptions (user_email, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_email, endpoint) DO NOTHING`,
      [user.email.toLowerCase(), endpoint, keys.p256dh || '', keys.auth || '']
    );
  } catch (e) {
    logger.warn({ err: e, userId }, 'savePushSubscription error (non-fatal)');
  }
}

// ── removePushSubscription ────────────────────────────────────────────────────

export async function removePushSubscription(userId, endpoint) {
  if (!userId || !endpoint) return;
  try {
    const { rows: [user] } = await pool.query(
      'SELECT email FROM users WHERE id=$1 LIMIT 1', [userId]
    );
    if (!user) return;

    await pool.query(
      'DELETE FROM push_subscriptions WHERE user_email=$1 AND endpoint=$2',
      [user.email.toLowerCase(), endpoint]
    );
  } catch (e) {
    logger.warn({ err: e, userId }, 'removePushSubscription error (non-fatal)');
  }
}
