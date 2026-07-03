// ─────────────────────────────────────────────────────────────────────────────
// flow-transmit.mjs — Transmitere internă (repartizare) a documentului finalizat
//
// Motor PUR de logică (fără UI, fără dependență de fișierele de semnare):
//   - normalizeRecipients(raw)        → validează/curăță configurația de destinatari
//   - transmitFlowTo(pool, opts)      → INSERT idempotent, întoarce doar rândurile noi
//   - isFlowRecipient(pool, flowId, actor) → acces „destinatar" pe user SAU compartiment
//   - resolveRecipientEmails(pool, newlyAdded) → emailuri de notificat (dedup)
//
// Sursa de adevăr a accesului = tabelul flow_recipients (migrarea 088).
// ─────────────────────────────────────────────────────────────────────────────
import { loadActorComp } from './authz-formular.mjs';

const MAX_RECIPIENTS = 20;
const MAX_REZOLUTIE  = 2000;

/**
 * Validează un array brut de destinatari.
 * @param {Array<{type:'user'|'comp', value:*, rezolutie?:string}>} raw
 * @returns {Array<{type:'user'|'comp', value:(number|string), rezolutie:(string|null)}>}
 */
export function normalizeRecipients(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const type = item.type;
    let value;
    if (type === 'user') {
      value = Number(item.value);
      if (!Number.isInteger(value) || value <= 0) continue;
    } else if (type === 'comp') {
      value = String(item.value == null ? '' : item.value).trim();
      if (!value) continue;
    } else {
      continue;
    }
    const key = `${type}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let rezolutie = null;
    if (item.rezolutie != null) {
      rezolutie = String(item.rezolutie).slice(0, MAX_REZOLUTIE);
    }
    out.push({ type, value, rezolutie });
    if (out.length >= MAX_RECIPIENTS) break;
  }
  return out;
}

/**
 * Inserează destinatarii în flow_recipients (idempotent prin ON CONFLICT).
 * Întoarce DOAR rândurile nou inserate — pe astea se trimit notificări.
 * @returns {Promise<Array<{id:number, recipient_user_id:number|null, recipient_compartiment:string|null}>>}
 */
export async function transmitFlowTo(pool, { flowId, orgId, recipients, transmittedBy, source }) {
  const clean = normalizeRecipients(recipients);
  const src = source === 'manual' ? 'manual' : 'auto';
  const newlyAdded = [];
  for (const r of clean) {
    const isUser = r.type === 'user';
    const { rows } = await pool.query(
      `INSERT INTO flow_recipients
         (flow_id, org_id, recipient_user_id, recipient_compartiment, rezolutie, source, transmitted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING
       RETURNING id, recipient_user_id, recipient_compartiment`,
      [
        flowId,
        orgId ?? null,
        isUser ? r.value : null,
        isUser ? null : r.value,
        r.rezolutie,
        src,
        transmittedBy ?? null,
      ]
    );
    if (rows[0]) newlyAdded.push(rows[0]);
  }
  return newlyAdded;
}

/**
 * True dacă actorul e destinatar al fluxului: fie direct (recipient_user_id),
 * fie prin compartimentul său (recipient_compartiment ne-gol).
 */
export async function isFlowRecipient(pool, flowId, actor) {
  if (!flowId || !actor || !actor.userId) return false;
  const { rows: byUser } = await pool.query(
    `SELECT 1 FROM flow_recipients
       WHERE flow_id = $1 AND recipient_user_id = $2 LIMIT 1`,
    [flowId, actor.userId]
  );
  if (byUser.length) return true;

  const comp = await loadActorComp(pool, actor.userId);
  if (!comp) return false;
  const { rows: byComp } = await pool.query(
    `SELECT 1 FROM flow_recipients
       WHERE flow_id = $1
         AND NULLIF(TRIM(recipient_compartiment),'') IS NOT NULL
         AND TRIM(recipient_compartiment) = $2
       LIMIT 1`,
    [flowId, comp]
  );
  return byComp.length > 0;
}

/**
 * Rezolvă emailurile de notificat pentru rândurile nou inserate.
 * user → email-ul userului; compartiment → toți userii (ne-șterși) cu acel compartiment.
 * Dedup pe email lowercase.
 * @returns {Promise<Array<{email:string}>>}
 */
export async function resolveRecipientEmails(pool, newlyAdded) {
  if (!Array.isArray(newlyAdded) || !newlyAdded.length) return [];
  const emails = new Set();

  const userIds = newlyAdded
    .map(r => r.recipient_user_id)
    .filter(v => v != null);
  if (userIds.length) {
    const { rows } = await pool.query(
      `SELECT email FROM users WHERE id = ANY($1::int[]) AND deleted_at IS NULL`,
      [userIds]
    );
    for (const r of rows) if (r.email) emails.add(String(r.email).toLowerCase());
  }

  const comps = newlyAdded
    .map(r => (r.recipient_compartiment || '').trim())
    .filter(Boolean);
  for (const comp of comps) {
    const { rows } = await pool.query(
      `SELECT email FROM users
         WHERE TRIM(compartiment) = $1 AND TRIM(compartiment) <> ''
           AND deleted_at IS NULL`,
      [comp]
    );
    for (const r of rows) if (r.email) emails.add(String(r.email).toLowerCase());
  }

  return [...emails].map(email => ({ email }));
}

/**
 * Listă durabilă „Primite" pentru un user: toate repartizările (directe SAU prin
 * compartiment) NE-legate de notificări efemere — sursa e flow_recipients (mig. 088).
 * Confirmarea (`acknowledged_at`) e per-persoană din flow_recipient_acks (mig. 089).
 * Exclude fluxurile șterse (`deleted_at`). Dedup pe flow_id dacă apare și direct și pe comp.
 * @returns {Promise<Array<object>>}
 */
export async function listReceivedFor(pool, userId, actorComp) {
  const comp = (actorComp || '').trim();
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (fr.flow_id)
              fr.flow_id,
              f.data->>'docName'   AS doc_name,
              fr.rezolutie, fr.transmitted_at, fr.source,
              fr.recipient_compartiment,
              tb.email AS transmitted_by_email, tb.nume AS transmitted_by_name,
              ack.acknowledged_at  AS acknowledged_at
         FROM flow_recipients fr
         JOIN flows f ON f.id = fr.flow_id AND f.deleted_at IS NULL
         LEFT JOIN users tb ON tb.id = fr.transmitted_by
         LEFT JOIN flow_recipient_acks ack ON ack.flow_id = fr.flow_id AND ack.user_id = $1
        WHERE fr.recipient_user_id = $1
           OR ($2 <> '' AND TRIM(fr.recipient_compartiment) = $2)
        ORDER BY fr.flow_id, fr.transmitted_at DESC
     ) dedup
     ORDER BY transmitted_at DESC
     LIMIT 200`,
    [userId, comp]
  );
  return rows;
}

/**
 * Numără fluxurile repartizate (direct SAU prin compartiment) NECONFIRMATE de acest user —
 * query mai ieftin decât listReceivedFor (doar COUNT), pentru bădge-ul din sidebar.
 * @returns {Promise<number>}
 */
export async function countUnacknowledgedFor(pool, userId, actorComp) {
  const comp = (actorComp || '').trim();
  const { rows } = await pool.query(
    `SELECT count(DISTINCT fr.flow_id) AS count
       FROM flow_recipients fr
       JOIN flows f ON f.id = fr.flow_id AND f.deleted_at IS NULL
       LEFT JOIN flow_recipient_acks ack ON ack.flow_id = fr.flow_id AND ack.user_id = $1
      WHERE (fr.recipient_user_id = $1 OR ($2 <> '' AND TRIM(fr.recipient_compartiment) = $2))
        AND ack.acknowledged_at IS NULL`,
    [userId, comp]
  );
  return Number(rows[0]?.count || 0);
}

/**
 * Emailurile care au deja acces la flux prin canActorReadFlow (inițiator + semnatari) —
 * excluse din repartizare (n-are rost să le „transmiți" un document pe care îl pot deschide).
 * Pură: primește doar flow.data. @returns {Set<string>}
 */
export function alreadyHasAccessEmails(flowData) {
  const out = new Set();
  const push = (e) => { const v = String(e || '').trim().toLowerCase(); if (v) out.add(v); };
  push(flowData?.initEmail);
  for (const s of (Array.isArray(flowData?.signers) ? flowData.signers : [])) push(s?.email);
  return out;
}

/**
 * Confirmă luarea la cunoștință PER-PERSOANĂ (idempotent). Întoarce `acknowledged_at`
 * (nou la prima confirmare, sau valoarea existentă la apeluri repetate).
 * @returns {Promise<string>}
 */
export async function acknowledgeReceipt(pool, flowId, userId) {
  const { rows } = await pool.query(
    `INSERT INTO flow_recipient_acks (flow_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT (flow_id, user_id) DO NOTHING
     RETURNING acknowledged_at`,
    [flowId, userId]
  );
  if (rows[0]) return rows[0].acknowledged_at;
  const { rows: existing } = await pool.query(
    `SELECT acknowledged_at FROM flow_recipient_acks WHERE flow_id = $1 AND user_id = $2`,
    [flowId, userId]
  );
  return existing[0]?.acknowledged_at ?? null;
}
