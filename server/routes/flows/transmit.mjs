/**
 * DocFlowAI — flows/transmit.mjs
 * Transmitere internă MANUALĂ (repartizare ad-hoc) pe flux finalizat.
 *
 * Refolosește motorul PUR din services/flow-transmit.mjs (Etapa 1) și authz de obiect
 * din services/flow-access.mjs (aceeași bară ca trimiterea externă de email).
 *   POST /flows/:flowId/transmit  { recipients: [{ type:'user'|'comp', value, rezolutie? }] }
 */
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.mjs';
import { pool, requireDb, getFlowData, writeAuditEvent } from '../../db/index.mjs';
import { canActorReadFlow } from '../../services/flow-access.mjs';
import { normalizeRecipients, transmitFlowTo, resolveRecipientEmails, isFlowRecipient, listReceivedFor, acknowledgeReceipt } from '../../services/flow-transmit.mjs';
import { loadActorComp } from '../../services/authz-formular.mjs';
import { logger } from '../../middleware/logger.mjs';

const router = Router();

// Deps injectate din flows/index.mjs
let _notify;
export function _injectDeps(d) { _notify = d.notify; }

router.post('/flows/:flowId/transmit', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { flowId } = req.params;
    const data = await getFlowData(flowId);
    if (!data) return res.status(404).json({ error: 'not_found' });
    if (!data.completed && data.status !== 'completed')
      return res.status(409).json({ error: 'not_completed', message: 'Documentul nu este finalizat.' });
    // authz de obiect — aceeași bară ca trimiterea externă (inițiator/semnatar/admin same-org)
    if (!canActorReadFlow(actor, data, null))
      return res.status(403).json({ error: 'forbidden', message: 'Nu ai drept să transmiți acest document.' });

    const recipients = normalizeRecipients(req.body?.recipients);
    if (!recipients.length)
      return res.status(400).json({ error: 'no_recipients', message: 'Lipsesc destinatari valizi.' });

    const newly = await transmitFlowTo(pool, {
      flowId, orgId: data.orgId || null, recipients,
      transmittedBy: actor.userId || actor.id || null, source: 'manual',
    });
    const targets = await resolveRecipientEmails(pool, newly);
    for (const t of targets) {
      if (!t.email) continue;
      await _notify({ userEmail: t.email, flowId, type: 'REPARTIZAT',
        title: '📨 Document repartizat',
        message: `Documentul „${data.docName || 'document'}" v-a fost transmis spre luare la cunoștință.` });
    }
    writeAuditEvent({ flowId, orgId: data.orgId, eventType: 'FLOW_TRANSMITTED',
      actorEmail: actor.email, payload: { count: newly.length, source: 'manual' } });

    return res.json({ ok: true, added: newly.length, alreadyPresent: recipients.length - newly.length });
  } catch (e) {
    logger.error({ err: e }, 'POST /flows/:flowId/transmit error');
    return res.status(500).json({ error: 'server_error' });
  }
});

// Inbox durabil „📥 Primite" — citește flow_recipients direct, independent de notificări.
router.get('/api/my-received', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const uid = actor.userId || actor.id;
    const comp = await loadActorComp(pool, uid);
    const rows = await listReceivedFor(pool, uid, comp);
    return res.json(rows);
  } catch (e) {
    logger.error({ err: e }, 'GET /api/my-received error');
    return res.status(500).json({ error: 'server_error' });
  }
});

// Confirmare luare la cunoștință PER-PERSOANĂ pe o repartizare (user sau membru al compartimentului).
router.post('/flows/:flowId/acknowledge', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const { flowId } = req.params;
    if (!(await isFlowRecipient(pool, flowId, actor)))
      return res.status(403).json({ error: 'forbidden' });
    const acknowledged_at = await acknowledgeReceipt(pool, flowId, actor.userId || actor.id);
    return res.json({ ok: true, acknowledged_at });
  } catch (e) {
    logger.error({ err: e }, 'POST /flows/:flowId/acknowledge error');
    return res.status(500).json({ error: 'server_error' });
  }
});

export default router;
