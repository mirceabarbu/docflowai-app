/**
 * DocFlowAI — server/services/formular-flow-attachments.mjs
 *
 * Transfer atașamente formular (DF/ORD) → documente suport flux (v3.9.x, fix 3/4).
 *
 * Context: atașamentele uploadate de utilizator pe un DF/ORD (ex. „declarație interese",
 * „declarație avere") trăiesc în `formulare_atasamente`. La lansarea fluxului de semnare
 * din acel formular, utilizatorul ar trebui să NU le reîncarce — le copiem automat în
 * `flow_attachments` ca documente suport pentru noul `flow_id`.
 *
 * Domeniul EXACT: DOAR atașamentele uploadate de utilizator pe formular. NU capturile
 * (`formulare_capturi`) — conținutul randat al formularului apare deja pe PDF-ul generat
 * al DF/ORD (documentul principal al fluxului).
 *
 * Idempotent: dedup pe (flow_id, filename) — re-lansarea / re-rularea nu duplică.
 * Compatibilitate Drive: rândurile copiate sunt `flow_attachments` OBIȘNUITE, deci trec
 * prin aceeași cale de arhivare (`drive.mjs`) + nullify BYTEA post-arhivare
 * (`admin/maintenance.mjs`) — fără cale nouă, fără bug de umflare DB.
 *
 * Apelată din server/routes/flows/crud.mjs (createFlow), non-fatal (catch + log).
 */

import { logger } from '../middleware/logger.mjs';

/**
 * Copiază atașamentele non-șterse ale unui formular în flow_attachments.
 * @param {import('pg').Pool} pool
 * @param {{ flowId: string, formType: 'df'|'ord', formId: string }} args
 * @returns {Promise<number>} numărul de atașamente copiate (0 dacă niciunul/skip)
 */
export async function copyFormularAttachmentsToFlow(pool, { flowId, formType, formId } = {}) {
  if (!pool || !flowId || !formId) return 0;
  if (formType !== 'df' && formType !== 'ord') return 0;

  // INSERT...SELECT atomic cu guard NOT EXISTS pe (flow_id, filename) → idempotent.
  // Copiază bytes-ul direct (fa.data → flow_attachments.data), păstrând nume + content-type.
  const { rows } = await pool.query(
    `INSERT INTO flow_attachments (flow_id, filename, mime_type, size_bytes, data)
     SELECT $1, fa.filename, fa.mime_type, fa.size_bytes, fa.data
       FROM formulare_atasamente fa
      WHERE fa.form_type = $2
        AND fa.form_id   = $3
        AND fa.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM flow_attachments fla
           WHERE fla.flow_id = $1 AND fla.filename = fa.filename
        )
     RETURNING id, filename`,
    [flowId, formType, formId]
  );

  if (rows.length) {
    logger.info({ flowId, formType, formId, copied: rows.length }, 'formular→flux atașamente copiate');
  }
  return rows.length;
}
