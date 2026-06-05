/**
 * server/db/queries/formulare-audit.mjs — audit trail per formular DF/ORD.
 *
 * Tabel: formulare_audit (migrația 083). Polimorfic pe (form_type, form_id).
 * recordFormularAudit este BEST-EFFORT — niciodată nu blochează o tranziție de
 * lifecycle. listFormularAudit întoarce evenimentele cu numele actorului rezolvat.
 */

import { logger } from '../../middleware/logger.mjs';

/**
 * Înregistrează un eveniment de audit pentru un formular. Best-effort:
 * orice eroare e logată (warn) și înghițită — NU propagă, NU aruncă.
 */
export async function recordFormularAudit({
  orgId, formType, formId, actorId = null, actorEmail = null,
  eventType, fromStatus = null, toStatus = null, meta = {},
}) {
  try {
    // Import lazy al pool (ca în queries/audit.mjs) pentru a evita dependency cycle.
    const { pool } = await import('../index.mjs');
    if (!pool) return;
    await pool.query(
      `INSERT INTO formulare_audit
         (org_id, form_type, form_id, actor_id, actor_email,
          event_type, from_status, to_status, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [
        orgId ?? null, formType, formId, actorId ?? null, actorEmail ?? null,
        eventType, fromStatus ?? null, toStatus ?? null, JSON.stringify(meta || {}),
      ]
    );
  } catch (e) {
    logger.warn({ err: e, formType, formId, eventType }, 'recordFormularAudit failed (non-fatal)');
  }
}

/**
 * Listează evenimentele de audit pentru un formular, cele mai recente întâi.
 * Rezolvă actor_name din users (nume, fallback la actor_email).
 */
export async function listFormularAudit(formType, formId) {
  const { pool } = await import('../index.mjs');
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT a.id, a.event_type, a.from_status, a.to_status, a.meta,
            a.actor_email, a.created_at,
            COALESCE(NULLIF(u.nume,''), a.actor_email) AS actor_name
       FROM formulare_audit a
       LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.form_type = $1 AND a.form_id = $2
      ORDER BY a.created_at DESC`,
    [formType, formId]
  );
  return rows;
}
