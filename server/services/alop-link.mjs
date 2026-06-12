/**
 * DocFlowAI — server/services/alop-link.mjs
 *
 * Self-heal relink DF → ALOP la aprobarea fluxului de semnare (v3.9.554).
 *
 * Context: legarea inițială DF↔ALOP (link-df) depinde exclusiv de frontend și poate
 * eșua silențios (409/403/CSRF/rețea), iar refuzul unui DF R0 eliberează ALOP-ul
 * (df_id=NULL) fără ca re-aprobarea ulterioară să-l re-lege. Rezultat: ALOP „Fără DF"
 * permanent, care nu mai poate primi „nouă lichidare" după revizuirea DF-ului.
 *
 * Soluție: DF-urile create din context ALOP poartă proveniența în formulare_df.source_alop_id
 * (migrarea 084). La aprobarea fluxului DF (toți semnatarii au semnat), această funcție
 * re-leagă ALOP-ul dacă legătura e ruptă sau pointează la o revizie veche.
 *
 * 🔒 INVARIANT DE BUSINESS: re-legarea se aplică INTENȚIONAT și ALOP-urilor cu
 * status='completed' (doar cancelled_at IS NULL exclude) — e mecanismul care permite
 * fluxul: ALOP finalizat → revizuire DF (valoare mărită) → noua-lichidare recalculează
 * `ramas` pe valoarea reviziei noi (via alop.df_id) → ciclu nou de ordonanțare.
 * NU adăuga filtre `completed_at IS NULL` aici.
 *
 * Apelată din ambele call-site-uri care marchează DF-ul 'aprobat' la finalizarea fluxului:
 *   - server/routes/flows/signing.mjs (upload-signed-pdf, allDone)
 *   - server/routes/flows/crud.mjs   (edge case: flux deja completed la creare)
 * Idempotentă și non-fatală (catch + log).
 */

import { logger } from '../middleware/logger.mjs';

export async function selfHealAlopDfLink(pool, flowId) {
  if (!pool || !flowId) return;
  try {
    // DF aprobat pe acest flux, cu proveniență ALOP cunoscută
    const { rows: dfRows } = await pool.query(
      `SELECT id, org_id, nr_unic_inreg, source_alop_id
         FROM formulare_df
        WHERE flow_id = $1 AND source_alop_id IS NOT NULL AND deleted_at IS NULL
        LIMIT 1`,
      [flowId]
    );
    if (!dfRows.length) return;
    const df = dfRows[0];

    // Re-leagă DOAR dacă ALOP-ul e necancelat (include ALOP-urile completed — vezi
    // invariantul de mai sus) și df_id e NULL (legătură ruptă: refuz R0, link-df ratat)
    // sau pointează la o altă revizie a aceluiași document (același nr_unic_inreg).
    // Un df_id care pointează la un DF cu alt nr_unic_inreg NU se atinge (relegare manuală).
    const { rowCount } = await pool.query(
      `UPDATE alop_instances a
          SET df_id = $1, df_flow_id = $2, df_completed_at = NOW(), updated_at = NOW()
        WHERE a.id = $3
          AND a.cancelled_at IS NULL
          AND (a.df_id IS DISTINCT FROM $1 OR a.df_flow_id IS DISTINCT FROM $2)
          AND (
            a.df_id IS NULL
            OR EXISTS (
              SELECT 1 FROM formulare_df fd
               WHERE fd.id = a.df_id AND fd.org_id = $4 AND fd.nr_unic_inreg = $5
            )
          )`,
      [df.id, flowId, df.source_alop_id, df.org_id, df.nr_unic_inreg]
    );
    if (!rowCount) return;

    // Tranziție de stadiu DOAR din draft/angajare → lichidare (pattern link-df-flow).
    // ALOP-uri în lichidare/ordonantare/plata/completed: doar câmpurile de legătură.
    await pool.query(
      `UPDATE alop_instances
          SET status = 'lichidare', updated_at = NOW()
        WHERE id = $1 AND status IN ('draft','angajare') AND cancelled_at IS NULL`,
      [df.source_alop_id]
    );
    logger.info({ flowId, dfId: df.id, alopId: df.source_alop_id },
      '[ALOP] self-heal relink la aprobarea fluxului DF');
  } catch (e) {
    logger.warn({ err: e, flowId }, '[ALOP] self-heal relink failed (non-fatal)');
  }
}
