/**
 * DocFlowAI — Webhook dispatcher (FEAT-01 v3.3.8)
 *
 * Trimite notificări HTTP POST externe la completarea unui flux (FLOW_COMPLETED).
 * Configurat per organizație: câmpul organizations.webhook_url.
 *
 * FUNCȚIONALITATE:
 *  - dispatchWebhook(flowData, pool) — apelat din flows.mjs la FLOW_COMPLETED
 *    Salvează un job în webhook_deliveries și încearcă livrarea imediată.
 *  - _runWebhookRetryJob() — rulat la 60s de server/index.mjs
 *    Reîncercă job-urile eșuate cu backoff exponențial (max 5 încercări, până la 24h).
 *
 * SECURITATE:
 *  - Semnătură HMAC-SHA256 per delivery (header X-DocFlowAI-Signature)
 *    Secretul e câmpul organizations.webhook_secret — setat din admin panel.
 *  - Timeout 10s per request HTTP — nu blochează serverul la endpoint-uri lente.
 *  - Payload minim: nu include PDF-urile base64, doar metadata fluxului.
 *
 * RETRY POLICY:
 *  Attempt 1: imediat
 *  Attempt 2: +5 minute
 *  Attempt 3: +30 minute
 *  Attempt 4: +2 ore
 *  Attempt 5: +24 ore (final)
 *  După 5 eșecuri: status='failed', nu se mai reîncercă.
 */

import crypto from 'crypto';
import { logger } from './middleware/logger.mjs';

// Backoff exponențial în minute: [5, 30, 120, 1440]
const RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000, 2 * 3600_000, 24 * 3600_000];
const MAX_ATTEMPTS = 5;
const HTTP_TIMEOUT_MS = 10_000;

// ── Payload builder — fără date sensibile ────────────────────────────────────
function buildPayload(flowData, eventType = 'FLOW_COMPLETED') {
  const { pdfB64, signedPdfB64, originalPdfB64, ...safeData } = flowData;
  return {
    event:    eventType,
    flowId:   flowData.flowId,
    orgId:    flowData.orgId,
    docName:  flowData.docName,
    flowType: flowData.flowType,
    initName: flowData.initName,
    initEmail:flowData.initEmail,
    institutie: flowData.institutie,
    completedAt: flowData.completedAt || new Date().toISOString(),
    signersCount: (flowData.signers || []).length,
    signers: (flowData.signers || []).map(s => ({
      name:     s.name,
      email:    s.email,
      rol:      s.rol,
      status:   s.status,
      signedAt: s.signedAt,
    })),
    hasDriveArchive: flowData.storage === 'drive',
    driveFileLinkFinal: flowData.driveFileLinkFinal || null,
    ts: new Date().toISOString(),
  };
}

// ── HMAC-SHA256 signature ────────────────────────────────────────────────────
function signPayload(payloadStr, secret) {
  if (!secret) return null;
  return 'sha256=' + crypto.createHmac('sha256', secret).update(payloadStr).digest('hex');
}

// ── HTTP delivery ────────────────────────────────────────────────────────────
async function _deliver(webhookUrl, payloadObj, secret) {
  const payloadStr = JSON.stringify(payloadObj);
  const sig = signPayload(payloadStr, secret);

  const headers = {
    'Content-Type':    'application/json',
    'User-Agent':      'DocFlowAI-Webhook/3.3.8',
    'X-DocFlowAI-Event': payloadObj.event || 'FLOW_COMPLETED',
  };
  if (sig) headers['X-DocFlowAI-Signature'] = sig;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  try {
    const resp = await fetch(webhookUrl, {
      method:  'POST',
      headers,
      body:    payloadStr,
      signal:  controller.signal,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status} ${resp.statusText}` };
    }
    return { ok: true };
  } catch(e) {
    clearTimeout(timeoutId);
    return { ok: false, error: e.name === 'AbortError' ? 'timeout_10s' : String(e.message || e) };
  }
}

// ── dispatchWebhook — apelat la FLOW_COMPLETED ───────────────────────────────
export async function dispatchWebhook(flowData, pool, eventType = 'FLOW_COMPLETED') {
  if (!pool) return;
  const orgId = flowData.orgId;
  if (!orgId) return;

  try {
    // Citim webhook_url și secret din organizations
    const { rows } = await pool.query(
      'SELECT webhook_url, webhook_secret FROM organizations WHERE id=$1',
      [orgId]
    );
    const org = rows[0];
    if (!org?.webhook_url) return; // org fără webhook configurat — skip silențios

    const payload = buildPayload(flowData, eventType);

    // Salvăm delivery job în DB
    const { rows: jobRows } = await pool.query(
      `INSERT INTO webhook_deliveries
        (org_id, flow_id, event_type, payload, status, attempts, next_retry)
       VALUES ($1,$2,$3,$4,'pending',0,NOW())
       RETURNING id`,
      [orgId, flowData.flowId, eventType, JSON.stringify(payload)]
    );
    const jobId = jobRows[0]?.id;

    // Încearcă livrarea imediată
    const result = await _deliver(org.webhook_url, payload, org.webhook_secret);
    if (result.ok) {
      await pool.query(
        `UPDATE webhook_deliveries SET status='delivered', attempts=1,
         delivered_at=NOW() WHERE id=$1`,
        [jobId]
      );
      logger.info({ flowId: flowData.flowId, orgId, webhookUrl: org.webhook_url }, 'Webhook livrat cu succes');
    } else {
      const nextRetry = new Date(Date.now() + RETRY_DELAYS_MS[0]);
      await pool.query(
        `UPDATE webhook_deliveries SET status='pending', attempts=1,
         last_error=$1, next_retry=$2 WHERE id=$3`,
        [result.error, nextRetry.toISOString(), jobId]
      );
      logger.warn({ flowId: flowData.flowId, orgId, error: result.error }, 'Webhook eșuat, retry planificat');
    }
  } catch(e) {
    logger.error({ err: e, flowId: flowData.flowId, orgId }, 'dispatchWebhook error');
  }
}

// ── _runWebhookRetryJob — apelat periodic din index.mjs ─────────────────────
export async function _runWebhookRetryJob(pool) {
  if (!pool) return;
  try {
    // Preluăm max 10 job-uri pending cu next_retry trecut, SKIP LOCKED anti-race
    const { rows: jobs } = await pool.query(`
      UPDATE webhook_deliveries SET status='processing'
      WHERE id IN (
        SELECT id FROM webhook_deliveries
        WHERE status='pending' AND next_retry <= NOW() AND attempts < $1
        ORDER BY next_retry ASC LIMIT 10
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, org_id, flow_id, event_type, payload, attempts
    `, [MAX_ATTEMPTS]);

    if (!jobs.length) return;

    for (const job of jobs) {
      try {
        const { rows: orgRows } = await pool.query(
          'SELECT webhook_url, webhook_secret FROM organizations WHERE id=$1',
          [job.org_id]
        );
        const org = orgRows[0];
        if (!org?.webhook_url) {
          await pool.query(
            `UPDATE webhook_deliveries SET status='failed', last_error='org_webhook_removed' WHERE id=$1`,
            [job.id]
          );
          continue;
        }

        const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
        const result = await _deliver(org.webhook_url, payload, org.webhook_secret);
        const newAttempts = job.attempts + 1;

        if (result.ok) {
          await pool.query(
            `UPDATE webhook_deliveries SET status='delivered', attempts=$1,
             delivered_at=NOW(), last_error=NULL WHERE id=$2`,
            [newAttempts, job.id]
          );
          logger.info({ jobId: job.id, flowId: job.flow_id, attempt: newAttempts }, 'Webhook retry reușit');
        } else if (newAttempts >= MAX_ATTEMPTS) {
          await pool.query(
            `UPDATE webhook_deliveries SET status='failed', attempts=$1, last_error=$2 WHERE id=$3`,
            [newAttempts, result.error, job.id]
          );
          logger.warn({ jobId: job.id, flowId: job.flow_id, attempts: newAttempts, error: result.error }, 'Webhook: toate retry-urile epuizate');
        } else {
          const delay = RETRY_DELAYS_MS[Math.min(newAttempts - 1, RETRY_DELAYS_MS.length - 1)];
          const nextRetry = new Date(Date.now() + delay);
          await pool.query(
            `UPDATE webhook_deliveries SET status='pending', attempts=$1,
             last_error=$2, next_retry=$3 WHERE id=$4`,
            [newAttempts, result.error, nextRetry.toISOString(), job.id]
          );
        }
      } catch(e) {
        logger.error({ err: e, jobId: job.id }, 'Webhook retry job error per job');
        await pool.query(
          `UPDATE webhook_deliveries SET status='pending', last_error=$1 WHERE id=$2`,
          [String(e.message || e), job.id]
        ).catch(() => {});
      }
    }
  } catch(e) {
    logger.error({ err: e }, 'Webhook retry job processor error');
  }
}
