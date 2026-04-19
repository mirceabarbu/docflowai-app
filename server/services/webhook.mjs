/**
 * server/services/webhook.mjs — Outgoing webhook dispatcher.
 *
 * Reads webhook configuration from organizations.settings.webhooks[] and
 * also the legacy per-org columns (webhook_url, webhook_secret, webhook_events,
 * webhook_enabled) for backward compatibility.
 *
 * Signature: HMAC-SHA256(body, secret) in X-DocFlow-Signature header.
 * Never throws — all errors are logged only.
 */

import crypto from 'crypto';
import { pool }   from '../db/index.mjs';
import { logger } from '../middleware/logger.mjs';

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * fire — dispatch a webhook event to all configured endpoints for the org.
 *
 * @param {number|null} org_id     — organization ID (null = skip)
 * @param {string}      event_type — e.g. 'flow.completed'
 * @param {object}      payload    — event data
 */
export async function fire(org_id, event_type, payload) {
  if (!org_id) return;

  try {
    const { rows } = await pool.query(
      `SELECT settings, webhook_url, webhook_secret, webhook_events, webhook_enabled
       FROM organizations WHERE id=$1 LIMIT 1`,
      [org_id]
    );
    if (!rows[0]) return;

    const org = rows[0];
    const hooks = _collectHooks(org, event_type);

    await Promise.allSettled(
      hooks.map(hook => _dispatch(hook, event_type, payload))
    );
  } catch (e) {
    logger.warn({ err: e, org_id, event_type }, 'webhook.fire: unexpected error (non-fatal)');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Collect all active webhook configs that subscribe to event_type.
 */
function _collectHooks(org, event_type) {
  const hooks = [];

  // v4: settings.webhooks[]
  const v4Webhooks = org.settings?.webhooks ?? [];
  for (const w of v4Webhooks) {
    if (!w.url) continue;
    const events = Array.isArray(w.events) ? w.events : [];
    if (events.length === 0 || events.includes(event_type) || events.includes('*')) {
      hooks.push({ url: w.url, secret: w.secret ?? null });
    }
  }

  // v3 legacy: webhook_url + webhook_events columns
  if (org.webhook_enabled && org.webhook_url) {
    const events = Array.isArray(org.webhook_events) ? org.webhook_events : [];
    if (events.length === 0 || events.includes(event_type)) {
      hooks.push({ url: org.webhook_url, secret: org.webhook_secret ?? null });
    }
  }

  return hooks;
}

/**
 * POST to a single webhook endpoint with HMAC signature.
 * Timeout: 5 seconds. Errors are logged, never re-thrown.
 */
async function _dispatch({ url, secret }, event_type, payload) {
  const body = JSON.stringify({
    event:     event_type,
    data:      payload,
    timestamp: new Date().toISOString(),
  });

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent':   'DocFlowAI-Webhook/4.0',
  };

  if (secret) {
    headers['X-DocFlow-Signature'] = `sha256=${
      crypto.createHmac('sha256', secret).update(body).digest('hex')
    }`;
  }

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url, {
      method:  'POST',
      headers,
      body,
      signal:  controller.signal,
    });
    if (!response.ok) {
      logger.warn({ url, status: response.status, event_type },
        'webhook: non-2xx response');
    } else {
      logger.debug({ url, event_type }, 'webhook: dispatched OK');
    }
  } catch (e) {
    const reason = e.name === 'AbortError' ? 'timeout' : e.message;
    logger.warn({ url, event_type, reason }, 'webhook: dispatch failed (non-fatal)');
  } finally {
    clearTimeout(timeout);
  }
}
