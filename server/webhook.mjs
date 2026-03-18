/**
 * DocFlowAI — webhook.mjs
 * Livrare webhook generic per organizație.
 *
 * Suportă orice sistem care primește HTTP POST:
 *   AvanDoc / iDocNet / registratură proprie / Zapier / n8n / Make.com
 *
 * Securitate: HMAC-SHA256 pe body JSON, semnat cu webhook_secret per org.
 *   Header: X-DocFlowAI-Signature: sha256=<hex>
 *   Header: X-DocFlowAI-Event: flow.completed | flow.refused | flow.cancelled
 *
 * Fire-and-forget cu un singur retry după 5s — nu blochează request-ul principal.
 */

import crypto from 'crypto';
import { logger } from './middleware/logger.mjs';

// Pool injectat din index.mjs pentru a evita dependency cycle
let _pool = null;
export function injectWebhookPool(pool) { _pool = pool; }

// URL de bază al aplicației (pentru downloadUrl în payload)
let _appBaseUrl = '';
export function injectWebhookBaseUrl(url) { _appBaseUrl = url.replace(/\/$/, ''); }

/**
 * Caută configurația webhook a organizației și trimite evenimentul.
 * Apelat async (setImmediate) — nu blochează response-ul HTTP.
 *
 * @param {number|null} orgId  — org_id din fluxul curent
 * @param {string}      event  — 'flow.completed' | 'flow.refused' | 'flow.cancelled'
 * @param {object}      data   — datele fluxului (din getFlowData)
 */
export async function fireWebhook(orgId, event, data) {
  if (!_pool || !orgId) return;

  try {
    const { rows } = await _pool.query(
      `SELECT webhook_url, webhook_secret, webhook_events, webhook_enabled
       FROM organizations WHERE id = $1`,
      [orgId]
    );
    const org = rows[0];
    if (!org || !org.webhook_enabled || !org.webhook_url) return;
    if (!Array.isArray(org.webhook_events) || !org.webhook_events.includes(event)) return;

    const payload = buildPayload(event, data);
    await deliverWithRetry(org.webhook_url, org.webhook_secret, event, payload);
  } catch(e) {
    logger.warn({ err: e, orgId, event }, 'webhook: eroare la citire config (non-fatal)');
  }
}

// ── Construiește payload-ul JSON standardizat ──────────────────────────────
function buildPayload(event, data) {
  return {
    event,                                           // 'flow.completed' etc.
    flowId:       data.flowId       || null,
    docName:      data.docName      || null,
    institutie:   data.institutie   || null,
    compartiment: data.compartiment || null,
    initEmail:    data.initEmail    || null,
    initName:     data.initName     || null,
    status:       data.status       || null,
    completedAt:  data.completedAt  || null,
    refusedAt:    data.refusedAt    || null,
    cancelledAt:  data.cancelledAt  || null,
    cancelReason: data.cancelReason || null,
    signers: (data.signers || []).map(s => ({
      name:     s.name     || null,
      email:    s.email    || null,
      rol:      s.rol      || null,
      status:   s.status   || null,
      signedAt: s.signedAt || null,
    })),
    downloadUrl: data.completed && data.flowId && _appBaseUrl
      ? `${_appBaseUrl}/flows/${encodeURIComponent(data.flowId)}/signed-pdf`
      : null,
    sentAt: new Date().toISOString(),
  };
}

// ── Livrare HTTP POST cu HMAC + un retry după 5s ───────────────────────────
async function deliverWithRetry(url, secret, event, payload) {
  const body = JSON.stringify(payload);
  const sig   = sign(secret, body);
  const headers = {
    'Content-Type':              'application/json',
    'X-DocFlowAI-Event':         event,
    'X-DocFlowAI-Signature':     `sha256=${sig}`,
    'X-DocFlowAI-Delivery':      crypto.randomUUID(),
    'User-Agent':                'DocFlowAI-Webhook/1.0',
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 10_000); // 10s timeout
      const res = await fetch(url, { method: 'POST', headers, body, signal: ctrl.signal });
      clearTimeout(timeout);
      if (res.ok) {
        logger.info({ url, event, status: res.status, attempt }, 'webhook: livrat cu succes');
        return;
      }
      logger.warn({ url, event, status: res.status, attempt }, 'webhook: server a returnat eroare');
    } catch(e) {
      logger.warn({ url, event, err: e.message, attempt }, 'webhook: eroare de rețea');
    }
    if (attempt < 2) await new Promise(r => setTimeout(r, 5000)); // retry după 5s
  }
  logger.warn({ url, event }, 'webhook: toate tentativele eșuate');
}

// ── HMAC-SHA256 ───────────────────────────────────────────────────────────
function sign(secret, body) {
  if (!secret) return 'unsigned';
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}
