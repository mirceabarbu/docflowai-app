/**
 * server/modules/notifications/service.mjs — Notification orchestrator
 *
 * notify(eventType, context) — niciodată nu aruncă eroare.
 */

import { pool }   from '../../db/index.mjs';
import { logger } from '../../middleware/logger.mjs';
import { sendEmail }     from './email.mjs';
import { sendWhatsApp }  from './whatsapp.mjs';
import { sendPushToUser } from './push.mjs';
import * as tpl from './templates.mjs';

// ── notify ────────────────────────────────────────────────────────────────────

export async function notify(eventType, context = {}) {
  try {
    await _dispatch(eventType, context);
  } catch (e) {
    logger.error({ err: e, eventType }, 'notify: unhandled error');
  }
}

async function _dispatch(eventType, ctx) {
  switch (eventType) {
    case 'signer.invited':    return _onSignerInvited(ctx);
    case 'flow.completed':    return _onFlowCompleted(ctx);
    case 'flow.refused':      return _onFlowRefused(ctx);
    case 'flow.cancelled':    return _onFlowCancelled(ctx);
    case 'flow.delegated':    return _onFlowDelegated(ctx);
    case 'user.created':      return _onUserCreated(ctx);
    default:
      logger.warn({ eventType }, 'notify: unknown eventType');
  }
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async function _onSignerInvited({ flow, signer, signerLink }) {
  const { subject, html } = tpl.buildSignerEmail({ flow, signer, signerLink });
  await sendEmail({
    to: signer.email, subject, html,
    flowId: flow.id, orgId: flow.org_id, templateCode: 'signer.invited',
  });
  if (signer.phone) {
    await sendWhatsApp({
      phone:        signer.phone,
      templateName: 'signer_invited',
      params:       [signer.name || signer.email, flow.doc_name || flow.docName || '', signerLink],
    });
  }
  if (signer.user_id) {
    await _inapp(signer.user_id, flow.id, 'signer.invited',
      'Document de semnat',
      `Aveți un document de semnat: ${flow.doc_name || flow.title || ''}`,
      { signerLink }
    );
    await sendPushToUser(signer.user_id, {
      title: 'Document de semnat',
      body:  `${flow.doc_name || flow.title || 'document'} — semnătura necesară`,
      data:  { flowId: flow.id, signerLink },
    });
  }
}

async function _onFlowCompleted({ flow, initiator }) {
  const { subject, html } = tpl.buildCompletedEmail({ flow, initiator });
  await sendEmail({
    to: flow.initiator_email || (initiator && initiator.email),
    subject, html,
    flowId: flow.id, orgId: flow.org_id, templateCode: 'flow.completed',
  });
  if (flow.initiator_id) {
    await _inapp(flow.initiator_id, flow.id, 'flow.completed',
      'Document finalizat',
      `${flow.doc_name || flow.title || 'Document'} a fost semnat de toți semnatarii.`
    );
    await sendPushToUser(flow.initiator_id, {
      title: 'Document finalizat',
      body:  `${flow.doc_name || flow.title || 'Document'} — semnat complet`,
      data:  { flowId: flow.id },
    });
  }
}

async function _onFlowRefused({ flow, refusedBy, reason }) {
  const { subject, html } = tpl.buildRefusedEmail({ flow, refusedBy, reason });
  await sendEmail({
    to: flow.initiator_email,
    subject, html,
    flowId: flow.id, orgId: flow.org_id, templateCode: 'flow.refused',
  });
  if (flow.initiator_id) {
    await _inapp(flow.initiator_id, flow.id, 'flow.refused',
      'Document refuzat',
      `${flow.doc_name || flow.title || 'Document'} a fost refuzat de ${refusedBy || 'semnatar'}.`,
      { reason }
    );
    await sendPushToUser(flow.initiator_id, {
      title: 'Document refuzat',
      body:  `${flow.doc_name || 'Document'} — refuzat de ${refusedBy || 'semnatar'}`,
      data:  { flowId: flow.id },
    });
  }
}

async function _onFlowCancelled({ flow }) {
  const signers = Array.isArray(flow.signers) ? flow.signers : [];
  const pendingSigners = signers.filter(s =>
    s.status === 'pending' || s.status === 'current'
  );
  for (const signer of pendingSigners) {
    const { subject, html } = tpl.buildCancelledEmail({ flow, signer });
    await sendEmail({
      to: signer.email, subject, html,
      flowId: flow.id, orgId: flow.org_id, templateCode: 'flow.cancelled',
    });
    if (signer.user_id) {
      await _inapp(signer.user_id, flow.id, 'flow.cancelled',
        'Document anulat',
        `Fluxul pentru ${flow.doc_name || flow.title || 'document'} a fost anulat.`
      );
    }
  }
}

async function _onFlowDelegated({ flow, newSigner, reason }) {
  const { subject, html } = tpl.buildDelegatedEmail({ flow, newSigner, reason });
  await sendEmail({
    to: newSigner.email, subject, html,
    flowId: flow.id, orgId: flow.org_id, templateCode: 'flow.delegated',
  });
}

async function _onUserCreated({ user, tempPassword }) {
  const { subject, html } = tpl.buildWelcomeEmail({ user, tempPassword });
  await sendEmail({
    to: user.email, subject, html,
    templateCode: 'user.created',
  });
}

// ── sendSignerEmail (convenience export) ─────────────────────────────────────

export async function sendSignerEmail(flow, signer, signerLink) {
  return notify('signer.invited', { flow, signer, signerLink });
}

// ── inapp helper ──────────────────────────────────────────────────────────────

async function _inapp(userId, flowId, type, title, message, data = {}) {
  if (!userId || !pool) return;
  try {
    await pool.query(
      `INSERT INTO inapp_notifications (user_id, flow_id, type, title, message, data)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [userId, flowId || null, type, title, message, JSON.stringify(data)]
    );
  } catch (e) {
    logger.warn({ err: e }, '_inapp INSERT failed (non-fatal)');
  }
}
