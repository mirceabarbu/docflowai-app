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

/**
 * finalizeDfOnFlowCompleted — pașii care TREBUIE să ruleze la finalizarea ORICĂRUI
 * flux de semnare DF, indiferent de calea de semnare (upload manual / STS poll /
 * STS callback). Înainte de v3.9.746 existau DOAR pe calea `upload-signed-pdf`,
 * deci fluxurile semnate prin cloud lăsau `formulare_df.status='completed'` și nu
 * declanșau niciodată self-heal-ul legăturii DF↔ALOP.
 * Idempotentă și non-fatală (nu propagă erori — semnarea nu trebuie să pice din cauza asta).
 */
export async function finalizeDfOnFlowCompleted(pool, flowId) {
  if (!pool || !flowId) return;
  try {
    await pool.query(
      `UPDATE formulare_df SET status='aprobat', updated_at=NOW()
        WHERE flow_id=$1 AND deleted_at IS NULL AND status IS DISTINCT FROM 'aprobat'`,
      [flowId]
    );
  } catch (e) {
    logger.error({ err: e, flowId }, 'finalizeDfOnFlowCompleted: marcare aprobat esuata (non-fatal)');
  }
  try {
    await selfHealAlopDfLink(pool, flowId);
  } catch (e) {
    logger.error({ err: e, flowId }, 'finalizeDfOnFlowCompleted: self-heal esuat (non-fatal)');
  }
}

/**
 * selfHealAlopDfLinkByAlop — varianta LAZY, cheiată pe alopId, apelată din
 * GET /api/alop/:id. Rezolvă cazul „ALOP fără DF" fără a atinge calea de semnare:
 * caută documentul DF care revendică ALOP-ul prin `source_alop_id`, cu flux
 * FINALIZAT, și îl reataşează. Marchează și `status='aprobat'` (calea cloud nu o face).
 * Oglindește self-heal #1 pentru ORD din alop.mjs. Non-fatală și idempotentă.
 * Ambiguitatea (mai multe candidate cu revizia MAXIMĂ) se rezolvă prin SKIP + warn.
 */
export async function selfHealAlopDfLinkByAlop(pool, alopId) {
  if (!pool || !alopId) return null;
  try {
    const { rows: cands } = await pool.query(`
      SELECT fd.id, fd.flow_id, fd.revizie_nr, fd.status,
             (f.data->>'completedAt') AS completed_at
        FROM formulare_df fd
        JOIN flows f ON f.id = fd.flow_id
       WHERE fd.source_alop_id = $1
         AND fd.deleted_at IS NULL
         AND f.deleted_at IS NULL
         AND f.data->>'status' IS DISTINCT FROM 'cancelled'
         AND f.data->>'status' IS DISTINCT FROM 'refused'
         AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
       ORDER BY fd.revizie_nr DESC, fd.created_at DESC
    `, [alopId]);

    if (!cands.length) return null;
    if (cands.length > 1 && cands[0].revizie_nr === cands[1].revizie_nr) {
      logger.warn({ alopId, candidateCount: cands.length, revizie: cands[0].revizie_nr },
        '[ALOP] self-heal DF: ambiguu (mai multe DF pe aceeași revizie), skipped');
      return null;
    }
    const cand = cands[0];

    const { rows: linked } = await pool.query(`
      UPDATE alop_instances
         SET df_id = $1,
             df_flow_id = COALESCE(df_flow_id, $2),
             df_completed_at = COALESCE(df_completed_at, $3::timestamptz, NOW()),
             updated_at = NOW()
       WHERE id = $4
         AND df_id IS NULL
         AND cancelled_at IS NULL
      RETURNING id, df_id, df_flow_id, df_completed_at
    `, [cand.id, cand.flow_id, cand.completed_at || null, alopId]);

    if (!linked[0]) return null;

    if (cand.status !== 'aprobat') {
      try {
        await pool.query(
          `UPDATE formulare_df SET status='aprobat', updated_at=NOW()
            WHERE id=$1 AND deleted_at IS NULL AND status IS DISTINCT FROM 'aprobat'`,
          [cand.id]
        );
      } catch (e) {
        logger.error({ err: e, dfId: cand.id }, '[ALOP] self-heal DF: marcare aprobat esuata (non-fatal)');
      }
    }

    logger.info({ alopId, dfId: cand.id, flowId: cand.flow_id, revizie: cand.revizie_nr },
      '[ALOP] self-heal DF: legatura ALOP→DF refacuta (lazy)');
    return linked[0];
  } catch (e) {
    logger.error({ err: e, alopId }, '[ALOP] self-heal DF failed (non-fatal)');
    return null;
  }
}
