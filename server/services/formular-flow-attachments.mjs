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
 * Declanșată din `linkFlowFormular` (formular-shared.mjs, calea fericită — post-guards)
 * ȘI din `alop.mjs` `link-{df,ord}-flow` (calea ALOP necondiționată, fiindcă linkFlowFormular
 * dă 409 când docul nu e completed / e deja pe flux). Idempotent + non-fatal (catch + log).
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

  // INSERT...SELECT atomic. DOUĂ gărzi, pentru două curse diferite:
  //  (1) NOT EXISTS pe (flow_id, filename) — apără RE-RULAREA copierii (a doua chemare a
  //      funcției nu mai adaugă nimic);
  //  (2) #124i: DISTINCT ON (fa.filename, fa.size_bytes) — apără de duplicatele din SURSĂ.
  //      `NOT EXISTS` se evaluează față de starea tabelei la ÎNCEPUTUL instrucțiunii, NU față
  //      de rândurile inserate de aceeași instrucțiune ⇒ înainte de fix, N rânduri sursă cu
  //      același `filename` produceau N rânduri în flow_attachments dintr-o singură execuție.
  //      Comentariul vechi („→ idempotent") era fals; duplicatele găsite în producție pe
  //      flow_attachments (12.08.2026) erau exact asta.
  //      ⚠️ Cheia include `size_bytes` DELIBERAT. Copierea ia atașamentele de pe AMBELE
  //      sloturi ale documentului; două fișiere DIFERITE care împart numele (ex. „Anexa.pdf"
  //      pe slot 1 și pe slot 2) trebuie să ajungă AMÂNDOUĂ în pachetul de semnare. Un
  //      `DISTINCT ON (fa.filename)` singur le-ar topi într-unul și ar scoate tăcut un
  //      document din pachet — regresie mai gravă decât bugul reparat aici. Cu `size_bytes`
  //      în cheie se colapsează doar duplicatele reale (același nume ȘI aceeași dimensiune,
  //      inclusiv aceeași anexă pusă din greșeală pe ambele sloturi). Listarea și
  //      previzualizarea din flux cheiază pe `id` (attachments.mjs:108-112), deci două rânduri
  //      cu același `filename` se afișează corect, separat.
  //      Se păstrează cel mai VECHI rând sursă per (filename, size_bytes).
  //      ⚠️ #128m — NU se filtrează pe `bloc_idx`: fluxul de semnare e UNUL SINGUR, deci
  //      pachetul primește atașamentele TUTUROR blocurilor de furnizor. Corolarul,
  //      INTENȚIONAT (nu e bug): dacă ACELAȘI fișier (nume + dimensiune) e atașat la doi
  //      furnizori, în pachet intră o SINGURĂ dată — pachetul e un document, nu o arhivă
  //      per furnizor. ⛔ Nu adăuga `fa.bloc_idx` în cheia DISTINCT ON „ca să fie simetric":
  //      ar reintroduce exact duplicatele reparate la #124i.
  const { rows } = await pool.query(
    `INSERT INTO flow_attachments (flow_id, filename, mime_type, size_bytes, data)
     SELECT DISTINCT ON (fa.filename, fa.size_bytes)
            $1, fa.filename, fa.mime_type, fa.size_bytes, fa.data
       FROM formulare_atasamente fa
      WHERE fa.form_type = $2
        AND fa.form_id   = $3
        AND fa.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM flow_attachments fla
           WHERE fla.flow_id = $1 AND fla.filename = fa.filename
        )
      ORDER BY fa.filename, fa.size_bytes, fa.created_at ASC
     RETURNING id, filename`,
    [flowId, formType, formId]
  );

  if (rows.length) {
    logger.info({ flowId, formType, formId, copied: rows.length }, 'formular→flux atașamente copiate');
  }
  return rows.length;
}
