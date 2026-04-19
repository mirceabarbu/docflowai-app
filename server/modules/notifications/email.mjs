/**
 * server/modules/notifications/email.mjs — Resend API email sender
 */

import { pool } from '../../db/index.mjs';
import { logger } from '../../middleware/logger.mjs';
import config from '../../config.mjs';

const RESEND_URL = 'https://api.resend.com/emails';

/**
 * sendEmail — trimite email via Resend API.
 * Niciodată nu aruncă eroare.
 *
 * @param {{ to, subject, html, replyTo?, flowId?, orgId?, templateCode? }} opts
 * @returns {Promise<{ id: string } | null>}
 */
export async function sendEmail({ to, subject, html, replyTo, flowId, orgId, templateCode = 'generic' }) {
  if (!config.RESEND_API_KEY) {
    logger.warn({ to }, 'sendEmail: RESEND_API_KEY lipsă — email nesent');
    return null;
  }

  let providerId  = null;
  let status      = 'failed';
  let errorMsg    = null;

  try {
    const body = {
      from:    config.MAIL_FROM || 'DocFlowAI <noreply@docflowai.ro>',
      to:      [to],
      subject,
      html,
    };
    if (replyTo) body.reply_to = replyTo;

    const resp = await fetch(RESEND_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${config.RESEND_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    const data = await resp.json().catch(() => ({}));

    if (resp.ok) {
      providerId = data.id ?? null;
      status     = 'sent';
      logger.info({ to, msgId: providerId }, 'Email sent');
    } else {
      errorMsg = data?.message || data?.error || `HTTP ${resp.status}`;
      logger.warn({ to, status: resp.status, err: errorMsg }, 'sendEmail: Resend error');
    }
  } catch (e) {
    errorMsg = e.message;
    logger.error({ err: e, to }, 'sendEmail: fetch error');
  }

  // Log to notification_events (non-fatal)
  _logEvent({ to, templateCode, status, providerId, errorMsg, flowId, orgId }).catch(() => {});

  return status === 'sent' ? { id: providerId } : null;
}

async function _logEvent({ to, templateCode, status, providerId, errorMsg, flowId, orgId }) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO notification_events
         (recipient_email, channel, template_code, status,
          provider_message_id, error_message, flow_id, org_id, sent_at, failed_at)
       VALUES ($1, 'email', $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        to, templateCode, status,
        providerId  || null,
        errorMsg    || null,
        flowId      || null,
        orgId       || null,
        status === 'sent'   ? new Date() : null,
        status === 'failed' ? new Date() : null,
      ]
    );
  } catch (e) {
    logger.warn({ err: e }, 'notification_events INSERT failed (non-fatal)');
  }
}
