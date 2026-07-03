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
import { pool, requireDb, getFlowData, saveFlow, writeAuditEvent } from '../../db/index.mjs';
import { canActorReadFlow } from '../../services/flow-access.mjs';
import { normalizeRecipients, transmitFlowTo, resolveRecipientEmails, alreadyHasAccessEmails, isFlowRecipient, listReceivedFor, acknowledgeReceipt, countUnacknowledgedFor } from '../../services/flow-transmit.mjs';
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

    // Inițiatorul/semnatarii au deja acces (canActorReadFlow) — repartizarea nu e necesară pentru ei.
    // Țintă user care e inițiator/semnatar → exclusă complet; țintă compartiment rămâne (ceilalți
    // membri au nevoie), dar nu-i notificăm pe semnatarii din compartiment.
    const excludeEmails = alreadyHasAccessEmails(data);
    let recipientsEff = recipients;
    if (excludeEmails.size && recipients.some(r => r.type === 'user')) {
      const uids = recipients.filter(r => r.type === 'user').map(r => Number(r.value)).filter(Boolean);
      const emailById = new Map();
      if (uids.length) {
        const { rows } = await pool.query('SELECT id, lower(email) AS email FROM users WHERE id = ANY($1::int[])', [uids]);
        for (const r of rows) emailById.set(r.id, r.email);
      }
      recipientsEff = recipients.filter(r => r.type !== 'user' || !excludeEmails.has(emailById.get(Number(r.value))));
    }
    const skippedHasAccess = recipients.length - recipientsEff.length;

    // dacă TOȚI destinatarii aleși au deja acces → răspuns informativ, nu succes tăcut
    if (!recipientsEff.length) {
      return res.json({ ok: true, added: 0, alreadyPresent: 0, skippedHasAccess,
        message: 'Destinatarii aleși au deja acces la document (inițiator/semnatari) — repartizarea nu e necesară.' });
    }

    const newly = await transmitFlowTo(pool, {
      flowId, orgId: data.orgId || null, recipients: recipientsEff,
      transmittedBy: actor.userId || actor.id || null, source: 'manual',
    });
    const targets = await resolveRecipientEmails(pool, newly);
    for (const t of targets) {
      if (!t.email || excludeEmails.has(String(t.email).toLowerCase())) continue;
      await _notify({ userEmail: t.email, flowId, type: 'REPARTIZAT',
        title: '📨 Document repartizat',
        message: `Documentul „${data.docName || 'document'}" v-a fost transmis spre luare la cunoștință.` });
    }

    // Trasabilitate (paritate cu EMAIL_SENT): FLOW_TRANSMITTED per rând nou, în data.events[]
    // (sursă pentru "Progres flux") ȘI în audit_events (sursă pentru "Evenimente").
    if (!Array.isArray(data.events)) data.events = [];
    const nowIso = new Date().toISOString();
    for (const row of newly) {
      const recipientKey = row.recipient_user_id
        ? `user:${row.recipient_user_id}`
        : `comp:${String(row.recipient_compartiment || '').trim().toLowerCase()}`;
      let recipientLabel;
      if (row.recipient_user_id) {
        const { rows: uRows } = await pool.query('SELECT nume,email FROM users WHERE id=$1', [row.recipient_user_id]);
        recipientLabel = uRows[0]?.nume || uRows[0]?.email || `user #${row.recipient_user_id}`;
      } else {
        recipientLabel = `Compartimentul „${row.recipient_compartiment}"`;
      }
      const rez = recipientsEff.find(r =>
        (r.type === 'user' && row.recipient_user_id && String(r.value) === String(row.recipient_user_id)) ||
        (r.type === 'comp' && row.recipient_compartiment && r.value === row.recipient_compartiment)
      )?.rezolutie || null;
      data.events.push({
        at: nowIso, type: 'FLOW_TRANSMITTED', by: actor.email,
        source: 'manual', recipientKey, recipientLabel, rezolutie: rez,
      });
      writeAuditEvent({ flowId, orgId: data.orgId, eventType: 'FLOW_TRANSMITTED',
        actorEmail: actor.email, payload: { recipientKey, recipientLabel, rezolutie: rez, source: 'manual' } });
    }
    if (newly.length) { data.updatedAt = nowIso; await saveFlow(flowId, data); }

    return res.json({ ok: true, added: newly.length, alreadyPresent: recipientsEff.length - newly.length, skippedHasAccess });
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

// Bădge sidebar „📥 Primite" — count neconfirmate (query mai ieftin decât lista completă).
router.get('/api/my-received/count', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const uid = actor.userId || actor.id;
    const comp = await loadActorComp(pool, uid);
    const count = await countUnacknowledgedFor(pool, uid, comp);
    return res.json({ count });
  } catch (e) {
    logger.error({ err: e }, 'GET /api/my-received/count error');
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

    // Ține minte dacă exista deja o confirmare — acknowledgeReceipt e idempotent (ON CONFLICT
    // DO NOTHING), deci fără acest pre-check am duplica FLOW_ACKNOWLEDGED la fiecare reconfirmare.
    const { rows: existingAck } = await pool.query(
      'SELECT 1 FROM flow_recipient_acks WHERE flow_id=$1 AND user_id=$2',
      [flowId, actor.userId || actor.id]
    );
    const wasAlreadyAcked = existingAck.length > 0;
    const acknowledged_at = await acknowledgeReceipt(pool, flowId, actor.userId || actor.id);

    if (!wasAlreadyAcked) {
      // Identitatea confirmatorului: nume + funcție · compartiment (același format ca semnatarii).
      const { rows: uRows } = await pool.query(
        'SELECT nume, functie, compartiment FROM users WHERE id=$1', [actor.userId || actor.id]);
      const u = uRows[0] || {};
      // compActorului: refolosit atât la recipientKey (comp) cât și la ținta notificării (B).
      const compActorului = ((u.compartiment ?? await loadActorComp(pool, actor.userId || actor.id)) || '').trim();

      // Corelare exactă cu transmiterea: aceeași recipientKey folosită la FLOW_TRANSMITTED
      // (user direct SAU compartiment) — reutilizează verificarea din isFlowRecipient, dar
      // interoghează explicit ca să aflăm CARE ramură a picat.
      const { rows: directRows } = await pool.query(
        'SELECT 1 FROM flow_recipients WHERE flow_id=$1 AND recipient_user_id=$2', [flowId, actor.userId || actor.id]);
      const recipientKey = directRows.length
        ? `user:${actor.userId || actor.id}`
        : `comp:${compActorului.toLowerCase()}`;

      const data = await getFlowData(flowId);
      if (data) {
        data.events = Array.isArray(data.events) ? data.events : [];
        data.events.push({ at: acknowledged_at, type: 'FLOW_ACKNOWLEDGED', by: actor.email,
          byName: u.nume || actor.nume || actor.email,
          byFunctie: u.functie || null, byCompartiment: u.compartiment || null,
          recipientKey });
        data.updatedAt = new Date().toISOString();
        await saveFlow(flowId, data);
        writeAuditEvent({ flowId, orgId: data.orgId, eventType: 'FLOW_ACKNOWLEDGED', actorEmail: actor.email, payload: { recipientKey } });

        // B. Notifică expeditorul la confirmare NOUĂ: manual → transmitted_by; auto (NULL) → inițiator.
        // Non-fatal — un eșec de notificare nu rupe confirmarea (200 rămâne 200).
        try {
          const { rows: trRows } = await pool.query(
            `SELECT DISTINCT fr.transmitted_by FROM flow_recipients fr WHERE fr.flow_id=$1
               AND (fr.recipient_user_id=$2 OR ($3 <> '' AND TRIM(fr.recipient_compartiment)=$3))`,
            [flowId, actor.userId || actor.id, compActorului]);
          let targetEmail = null;
          const tbId = trRows.find(r => r.transmitted_by)?.transmitted_by;
          if (tbId) {
            const { rows: tRows } = await pool.query('SELECT email FROM users WHERE id=$1', [tbId]);
            targetEmail = tRows[0]?.email || null;
          }
          if (!targetEmail) targetEmail = data.initEmail || null;   // auto-transmit → inițiator
          if (targetEmail && targetEmail.toLowerCase() !== actor.email.toLowerCase() && _notify) {
            await _notify({ userEmail: targetEmail, flowId, type: 'REPARTIZAT_CONFIRMAT',
              title: '✅ Confirmare primire',
              message: `${u.nume || actor.email} a confirmat primirea documentului „${data.docName || 'document'}".` });
          }
        } catch (notifErr) {
          logger.warn({ err: notifErr, flowId }, 'notificare REPARTIZAT_CONFIRMAT eșuată (non-fatal)');
        }
      }
    }

    return res.json({ ok: true, acknowledged_at });
  } catch (e) {
    logger.error({ err: e }, 'POST /flows/:flowId/acknowledge error');
    return res.status(500).json({ error: 'server_error' });
  }
});

export default router;
