/**
 * DocFlowAI — Web Push Notifications
 * Folosește biblioteca web-push (VAPID).
 * Migrarea 008_push_subscriptions a creat tabelul necesar.
 *
 * ENV:
 *   VAPID_PUBLIC_KEY  — cheia publică VAPID (generat o singură dată)
 *   VAPID_PRIVATE_KEY — cheia privată VAPID
 *   VAPID_SUBJECT     — mailto: sau URL (ex: mailto:admin@docflowai.ro)
 *
 * Generare chei: node -e "const wp=require('web-push');console.log(wp.generateVAPIDKeys())"
 * sau din dashboard Railway cu: npx web-push generate-vapid-keys
 */

let webpush = null;
let pushConfigured = false;

// Încarcă web-push opțional (poate să nu fie instalat pe unele deployuri vechi)
try {
  webpush = (await import('web-push')).default;
  const pubKey  = process.env.VAPID_PUBLIC_KEY;
  const privKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@docflowai.ro';
  if (pubKey && privKey) {
    webpush.setVapidDetails(subject, pubKey, privKey);
    pushConfigured = true;
    console.log('✅ Web Push (VAPID) configurat.');
  } else {
    console.warn('⚠️ VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY lipsesc — push notifications dezactivate.');
  }
} catch(e) {
  console.warn('⚠️ web-push nu e instalat — push notifications dezactivate:', e.message);
}

export function isPushConfigured() { return pushConfigured; }
export function getVapidPublicKey() { return process.env.VAPID_PUBLIC_KEY || null; }

/**
 * Trimite o notificare push la un abonament.
 * @param {object} subscription — { endpoint, keys: { p256dh, auth } }
 * @param {object} payload — { title, body, icon?, badge?, data? }
 */
export async function sendPushNotification(subscription, payload) {
  if (!pushConfigured || !webpush) return { ok: false, reason: 'not_configured' };
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return { ok: true };
  } catch(e) {
    console.error('Push error:', e.statusCode, e.body);
    return { ok: false, statusCode: e.statusCode, error: e.body };
  }
}

/**
 * Trimite push la toți abonații unui user.
 * Înlătură automat abonamentele expirate (410 Gone).
 * @param {object} pool — pg Pool
 * @param {string} userEmail
 * @param {object} payload
 */
export async function pushToUser(pool, userEmail, payload) {
  if (!pushConfigured || !webpush || !pool) return;
  try {
    const { rows } = await pool.query(
      'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_email=$1',
      [(userEmail || '').toLowerCase()]
    );
    const expired = [];
    await Promise.allSettled(rows.map(async (row) => {
      const sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
      const result = await sendPushNotification(sub, payload);
      if (!result.ok && (result.statusCode === 410 || result.statusCode === 404)) {
        expired.push(row.id);
      }
    }));
    if (expired.length) {
      await pool.query('DELETE FROM push_subscriptions WHERE id = ANY($1)', [expired]);
      console.log(`🗑 Push: ${expired.length} abonamente expirate șterse pentru ${userEmail}`);
    }
  } catch(e) { console.error('pushToUser error:', e.message); }
}
