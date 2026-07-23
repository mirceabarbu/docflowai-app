/**
 * DocFlowAI — server/services/flow-undo.mjs
 *
 * Desface legăturile DF/ORD ↔ ALOP ale unui flux FINALIZAT care se anulează
 * administrativ (admin-cancel, #113a). Rulează PE UN CLIENT DE TRANZACȚIE primit
 * ca parametru — apelantul deține BEGIN/COMMIT/ROLLBACK, ca la `noua-lichidare`.
 *
 * ⚠️ DIFERENȚA CRITICĂ față de `cancel`-ul normal (lifecycle.mjs, handlerul `cancel`):
 * cancel-ul obișnuit lasă INTENȚIONAT `formulare_ord.flow_id` pe loc (paritate cu DF),
 * bazându-se pe faptul că self-heal-ul #2 din alop.mjs sare peste fluxurile 'cancelled'.
 * AICI NU e suficient. Pe un flux FINALIZAT, `completed:true` rămâne în JSONB chiar după
 * `status='cancelled'`, iar `ord_aprobat` (alop.mjs) se calculează ca:
 *     COALESCE(fo.flow_id, a.ord_flow_id) IS NOT NULL
 *     AND (f2.data->>'status'='completed' OR (f2.data->>'completed')::boolean = true)
 * — și NU verifică `deleted_at`. Dacă `formulare_ord.flow_id` ar rămâne setat, `ord_aprobat`
 * ar rămâne TRUE, iar auto-tranziția lazy din GET /api/alop/:id ar împinge ALOP-ul înapoi
 * la `plata` (și `needsResync` ar repopula `ord_flow_id`). De aceea GOLIM AMBELE pointere:
 * `formulare_ord.flow_id` ȘI `alop_instances.ord_flow_id`. (Verificat empiric la reparația
 * manuală din 23.07.2026 — vezi RECON-ord-neconform-flux-finalizat.md.)
 *
 * ⛔ NU e o migrare a handlerului `cancel` pe acest helper. Duplicarea (față de cancel) e
 * conștientă și temporară: migrarea lui `cancel` pe `undoCompletedFlowLinks` e un pas
 * ULTERIOR, cu teste proprii — nu se strecoară într-un prompt de feature.
 */

/**
 * @param {import('pg').PoolClient} client — client de tranzacție (apelantul deține BEGIN/COMMIT).
 * @param {string} flowId
 * @returns {Promise<{ dfId: string|null, ordId: string|null, alopId: string|null, statusChanged: boolean }>}
 */
export async function undoCompletedFlowLinks(client, flowId) {
  let dfId = null, ordId = null, alopId = null, statusChanged = false;

  // 1) DF: readuce DF-ul 'transmis_flux' la 'completed' și curăță pointerul DF pe ALOP.
  const { rows: dfRows } = await client.query(
    `UPDATE formulare_df SET status='completed', updated_at=NOW()
       WHERE flow_id=$1 AND status='transmis_flux'
       RETURNING id`,
    [flowId]
  );
  if (dfRows.length) {
    dfId = dfRows[0].id;
    const { rows: aRows } = await client.query(
      `UPDATE alop_instances
          SET df_flow_id=NULL, df_completed_at=NULL, updated_at=NOW()
        WHERE df_id=$1 AND cancelled_at IS NULL
        RETURNING id`,
      [dfId]
    );
    if (aRows.length) alopId = aRows[0].id;
  }

  // 2) ORD: curăță AMBELE pointere (vezi docblock). ORD nu trece prin 'transmis_flux'
  //    (link-flow ORD setează doar flow_id), deci NU resetăm status formular — dar
  //    GOLIM formulare_ord.flow_id, altfel ord_aprobat rămâne TRUE și lazy-transition
  //    reînvie ALOP-ul la 'plata'. ALOP revine 'plata → ordonantare' (tranziție legitimată
  //    de migrația 103, EXCLUSIV pentru acest undo administrativ).
  const { rows: ordRows } = await client.query(
    `SELECT id FROM formulare_ord WHERE flow_id=$1`,
    [flowId]
  );
  if (ordRows.length) {
    ordId = ordRows[0].id;
    await client.query(
      `UPDATE formulare_ord SET flow_id=NULL, updated_at=NOW() WHERE id=$1`,
      [ordId]
    );
    const { rows: aRows } = await client.query(
      `UPDATE alop_instances
          SET ord_flow_id=NULL, ord_completed_at=NULL,
              status = CASE WHEN status='plata' THEN 'ordonantare' ELSE status END,
              updated_at=NOW()
        WHERE ord_id=$1 AND cancelled_at IS NULL
        RETURNING id, status`,
      [ordId]
    );
    if (aRows.length) {
      alopId = aRows[0].id;
      if (aRows[0].status === 'ordonantare') statusChanged = true;
    }
  }

  return { dfId, ordId, alopId, statusChanged };
}
