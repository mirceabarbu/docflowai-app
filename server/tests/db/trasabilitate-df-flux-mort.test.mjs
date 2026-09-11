/**
 * test:db — #197: modalul „Trasabilitate" NU mai arată un DF cu aprobarea DESFĂCUTĂ ca aprobat.
 *
 * `services/trasabilitate.mjs` (Q2, reviziile DF) deriva `aprobat` doar din „finalizat"
 * (`status='completed' OR completed=true`), fără `deleted_at IS NULL` / `≠cancelled` /
 * `≠refused` — contrazicând badge-ul din listă reparat la #165. Aceeași gaură ca în
 * `clasa8.mjs` (vezi `clasa8-flux-mort.test.mjs`); aceeași sursă unică: `validSignedFlowSql`.
 *
 * Scris ÎNAINTE de corecție — cazul 1 pică pe codul vechi (R1 desfăcută apărea `aprobat:true`).
 * Doar predicatul DF e vizat; cele ORD din același fișier rămân neatinse (compensate prin
 * golirea `formulare_ord.flow_id` în `flow-undo`).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedAlop, seedFlowApproved } from '../helpers/db-real.mjs';
import { getTrasabilitate } from '../../services/trasabilitate.mjs';

const d = describe.skipIf(!hasTestDb());

const NR = '40339';

async function setFlowStatus(flowId, status) {
  await pool.query(`UPDATE flows SET data = jsonb_set(data, '{status}', to_jsonb($2::text)) WHERE id=$1`,
    [flowId, status]);
}
async function softDeleteFlow(flowId) {
  await pool.query(`UPDATE flows SET deleted_at = NOW() WHERE id=$1`, [flowId]);
}
// Anulare administrativă „ca în producție" (#164): cancelled + soft-delete, `completed:true` păstrat.
async function adminCancelFlow(flowId) {
  await setFlowStatus(flowId, 'cancelled');
  await pool.query(`UPDATE flows SET data = jsonb_set(data, '{adminCancelled}', 'true'::jsonb) WHERE id=$1`, [flowId]);
  await softDeleteFlow(flowId);
}

async function seedDosarR0R1() {
  const alop  = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', titlu: 'Dosar A' });
  const flow0 = await seedFlowApproved();
  const flow1 = await seedFlowApproved();
  const df0 = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId: flow0, nrUnic: NR, sourceAlopId: alop });
  const df1 = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId: flow1, nrUnic: NR, sourceAlopId: alop,
                             revizieNr: 1, parentDfId: df0 });
  return { alop, flow0, flow1, df0, df1 };
}

const reviziaNr = (tree, n) => tree.df_revizii.find(r => r.revizie_nr === n);

d('#197 — trasabilitatea nu arată DF-ul cu aprobarea desfăcută ca aprobat', () => {
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user' }); // org 1, user 1
  });
  afterAll(() => pool.end());

  it('1. ⭐ R1 anulată administrativ (cancelled + soft-delete + completed:true) ⇒ aprobat:false; R0 rămâne aprobat:true', async () => {
    const { flow1, df0 } = await seedDosarR0R1();
    await adminCancelFlow(flow1);

    const tree = await getTrasabilitate(pool, 1, 'df', df0);
    expect(tree).toBeTruthy();
    expect(tree.df_revizii).toHaveLength(2);
    expect(reviziaNr(tree, 0).aprobat).toBe(true);
    expect(reviziaNr(tree, 1).aprobat).toBe(false);
  });

  it('2. R1 pe flux REFUZAT cu completed:true ⇒ aprobat:false', async () => {
    const { flow1, df0 } = await seedDosarR0R1();
    await setFlowStatus(flow1, 'refused');
    const tree = await getTrasabilitate(pool, 1, 'df', df0);
    expect(reviziaNr(tree, 0).aprobat).toBe(true);
    expect(reviziaNr(tree, 1).aprobat).toBe(false);
  });

  it('3. R1 pe flux SOFT-ȘTERS (status rămas completed) ⇒ aprobat:false', async () => {
    const { flow1, df0 } = await seedDosarR0R1();
    await softDeleteFlow(flow1);
    const tree = await getTrasabilitate(pool, 1, 'df', df0);
    expect(reviziaNr(tree, 0).aprobat).toBe(true);
    expect(reviziaNr(tree, 1).aprobat).toBe(false);
  });

  it('4. anti-regresie: ambele fluxuri vii și finalizate ⇒ ambele aprobat:true', async () => {
    const { df0 } = await seedDosarR0R1();
    const tree = await getTrasabilitate(pool, 1, 'df', df0);
    expect(reviziaNr(tree, 0).aprobat).toBe(true);
    expect(reviziaNr(tree, 1).aprobat).toBe(true);
  });

  it('5. anti-regresie: DF fără flux ⇒ aprobat:false, fără eroare (LEFT JOIN + predicat pe flux NULL)', async () => {
    const alop = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare' });
    const df = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', nrUnic: NR, sourceAlopId: alop });
    const tree = await getTrasabilitate(pool, 1, 'df', df);
    expect(tree.df_revizii).toHaveLength(1);
    expect(tree.df_revizii[0].aprobat).toBe(false);
  });
});
