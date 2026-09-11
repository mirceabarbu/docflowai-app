/**
 * test:db — #197: Clasa 8 NU mai consumă buget pe DF-uri cu aprobarea DESFĂCUTĂ.
 *
 * Cele două CTE-uri `latest_approved_df` din `services/clasa8.mjs` (centralizator +
 * verificarea de plafon) legau fluxul DOAR prin „finalizat" (`status='completed' OR
 * completed=true`), fără `deleted_at IS NULL` / `≠cancelled` / `≠refused`.
 *
 * Anularea administrativă (#164, `lifecycle.mjs`) face DELIBERAT trei lucruri: pune
 * `status='cancelled'`, face soft-delete pe flux și PĂSTREAZĂ `completed:true` ca istoric;
 * iar `undoCompletedFlowLinks` nu golește `formulare_df.flow_id`. Compuse: un DF a cărui
 * aprobare a fost RETRASĂ continua să consume buget — și, prin `DISTINCT ON … ORDER BY
 * revizie_nr DESC`, era ales tocmai el peste revizia aprobată anterior.
 *
 * Aceeași clasă a fost reparată în #165–#167 pentru listă/detaliu/aprobate; testele de
 * aici acoperă consumul de buget, pe AMBELE interogări. Scrise ÎNAINTE de corecție —
 * cazul 1 pică pe codul vechi (folosea 400 = R1 desfăcută, în loc de 220 = R0).
 *
 * Rulează pe Postgres 17 efemer (vezi CLAUDE.md §test:db).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedAlop, seedFlowApproved } from '../helpers/db-real.mjs';
import { getClasa8Aggregate, getBugetDisponibil } from '../../services/clasa8.mjs';

const d = describe.skipIf(!hasTestDb());

const NR  = '40339';
const SSI = '810101';
const R0_SUMA = '220';
const R1_SUMA = '400';

const itemFor = (result, cod) => result.items.find(x => x.cod_ssi === cod);

async function setFlowStatus(flowId, status) {
  await pool.query(`UPDATE flows SET data = jsonb_set(data, '{status}', to_jsonb($2::text)) WHERE id=$1`,
    [flowId, status]);
}
async function softDeleteFlow(flowId) {
  await pool.query(`UPDATE flows SET deleted_at = NOW() WHERE id=$1`, [flowId]);
}
// Anulare administrativă „ca în producție" (#164): flux soft-șters + `status='cancelled'`,
// dar `completed:true` RĂMÂNE în JSONB (istoric intenționat). `formulare_df.flow_id`
// rămâne pe flux — `undoCompletedFlowLinks` nu-l golește.
async function adminCancelFlow(flowId) {
  await setFlowStatus(flowId, 'cancelled');
  await pool.query(`UPDATE flows SET data = jsonb_set(data, '{adminCancelled}', 'true'::jsonb) WHERE id=$1`, [flowId]);
  await softDeleteFlow(flowId);
}

async function seedBuget(orgId, codSsi, valoare) {
  const { rows } = await pool.query(
    `INSERT INTO clasa8_buget_versions (org_id, version_no, row_count, total_value)
     VALUES ($1, 1, 1, $2) RETURNING id`,
    [orgId, valoare]
  );
  await pool.query(
    `INSERT INTO clasa8_buget (version_id, org_id, cod_ssi, valoare) VALUES ($1,$2,$3,$4)`,
    [rows[0].id, orgId, codSsi, valoare]
  );
}

// Dosar cu R0 (flux `flow0`) și R1 (flux `flow1`), sume col.10 diferite. Întoarce id-urile.
async function seedDosarR0R1() {
  const alop  = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', titlu: 'Dosar A' });
  const flow0 = await seedFlowApproved();
  const flow1 = await seedFlowApproved();
  const df0 = await seedDf({
    orgId: 1, createdBy: 1, status: 'aprobat', flowId: flow0, nrUnic: NR, sourceAlopId: alop,
    rowsCtrl: [{ cod_SSI: SSI, sum_rezv_crdt_bug_act: R0_SUMA }],
  });
  const df1 = await seedDf({
    orgId: 1, createdBy: 1, status: 'aprobat', flowId: flow1, nrUnic: NR, sourceAlopId: alop,
    revizieNr: 1, parentDfId: df0,
    rowsCtrl: [{ cod_SSI: SSI, sum_rezv_crdt_bug_act: R1_SUMA }],
  });
  return { alop, flow0, flow1, df0, df1 };
}

// Verifică AMBELE interogări (centralizator + plafon) pentru aceeași așteptare.
async function expectAngajat(expected) {
  const agg = await getClasa8Aggregate(pool, 1, {});
  const disp = await getBugetDisponibil(pool, 1, null);
  const a = itemFor(agg, SSI);
  const b = itemFor(disp, SSI);
  if (expected === null) {
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
    return { agg, disp };
  }
  expect(a).toBeTruthy();
  expect(a.angajamente).toBe(expected);
  expect(a.df_count).toBe(1);
  expect(b).toBeTruthy();
  expect(b.angajat_aprobat).toBe(expected);
  return { agg, disp };
}

d('#197 — Clasa 8 nu consumă buget pe DF cu aprobarea desfăcută', () => {
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user' }); // org 1, user 1
  });
  afterAll(() => pool.end());

  // ── 1. ⭐⭐ CAZUL CENTRAL ─────────────────────────────────────────────────
  it('1. ⭐⭐ R0 aprobat + R1 anulat administrativ (cancelled + soft-delete + completed:true) ⇒ consumă R0 (220), nu R1 (400)', async () => {
    const { flow1 } = await seedDosarR0R1();
    await adminCancelFlow(flow1);

    // pointerul DF-ului R1 rămâne pe fluxul desfăcut — exact starea din producție
    const { rows } = await pool.query(`SELECT flow_id FROM formulare_df WHERE revizie_nr = 1`);
    expect(rows[0].flow_id).toBe(flow1);

    await expectAngajat(Number(R0_SUMA));
  });

  // ── 2. flux refuzat cu completed:true ⇒ nu consumă ──────────────────────────
  it('2. R1 pe flux REFUZAT cu completed:true ⇒ consumă R0, nu R1', async () => {
    const { flow1 } = await seedDosarR0R1();
    await setFlowStatus(flow1, 'refused');
    await expectAngajat(Number(R0_SUMA));
  });

  it('2b. singura revizie pe flux REFUZAT cu completed:true ⇒ nu consumă deloc', async () => {
    const alop = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare' });
    const flow = await seedFlowApproved();
    await seedDf({
      orgId: 1, createdBy: 1, status: 'aprobat', flowId: flow, nrUnic: NR, sourceAlopId: alop,
      rowsCtrl: [{ cod_SSI: SSI, sum_rezv_crdt_bug_act: R0_SUMA }],
    });
    await setFlowStatus(flow, 'refused');
    await expectAngajat(null);
  });

  // ── 3. flux soft-șters, NEcancelat, completed:true ⇒ nu consumă ─────────────
  it('3. R1 pe flux SOFT-ȘTERS (status rămas completed) ⇒ consumă R0, nu R1', async () => {
    const { flow1 } = await seedDosarR0R1();
    await softDeleteFlow(flow1);
    await expectAngajat(Number(R0_SUMA));
  });

  it('3b. singura revizie pe flux SOFT-ȘTERS ⇒ nu consumă deloc', async () => {
    const alop = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare' });
    const flow = await seedFlowApproved();
    await seedDf({
      orgId: 1, createdBy: 1, status: 'aprobat', flowId: flow, nrUnic: NR, sourceAlopId: alop,
      rowsCtrl: [{ cod_SSI: SSI, sum_rezv_crdt_bug_act: R0_SUMA }],
    });
    await softDeleteFlow(flow);
    await expectAngajat(null);
  });

  // ── 4. ANTI-REGRESIE: ambele revizii vii ⇒ revizia maximă câștigă ───────────
  it('4. R0 și R1 ambele aprobate pe fluxuri VII ⇒ consumă R1 (400), revizia maximă', async () => {
    await seedDosarR0R1();
    await expectAngajat(Number(R1_SUMA));
  });

  // ── 5. ANTI-REGRESIE: o singură revizie vie ⇒ neschimbat ────────────────────
  it('5. o singură revizie aprobată pe flux viu ⇒ consumă neschimbat (220)', async () => {
    const alop = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare' });
    const flow = await seedFlowApproved();
    await seedDf({
      orgId: 1, createdBy: 1, status: 'aprobat', flowId: flow, nrUnic: NR, sourceAlopId: alop,
      rowsCtrl: [{ cod_SSI: SSI, sum_rezv_crdt_bug_act: R0_SUMA }],
    });
    await expectAngajat(Number(R0_SUMA));
  });

  // ── 6. dosar fără nicio revizie vie ⇒ dispare din consum, fără NaN/null/÷0 ──
  it('6. R0 și R1 ambele desfăcute ⇒ dosarul dispare din consum; cu buget importat, rămâne bugetul întreg (fără NaN)', async () => {
    const { flow0, flow1 } = await seedDosarR0R1();
    await adminCancelFlow(flow0);
    await adminCancelFlow(flow1);

    // fără buget: codul nu mai apare deloc, agregatul e curat
    const { agg } = await expectAngajat(null);
    expect(agg.count).toBe(0);
    for (const v of Object.values(agg.totals)) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBe(0);
    }

    // cu buget importat pe cod: rândul există, angajamente 0, rămâne bugetul întreg
    await seedBuget(1, SSI, 1000);
    const agg2 = await getClasa8Aggregate(pool, 1, {});
    const item = itemFor(agg2, SSI);
    expect(item).toBeTruthy();
    expect(item.angajamente).toBe(0);
    expect(item.df_count).toBe(0);
    expect(item.buget).toBe(1000);
    expect(item.ramane_din_buget).toBe(1000);
    expect(item.ramane_din_angajamente).toBe(0);
    for (const v of Object.values(agg2.totals)) expect(Number.isFinite(v)).toBe(true);

    const disp = await getBugetDisponibil(pool, 1, null);
    const di = itemFor(disp, SSI);
    expect(di).toBeTruthy();
    expect(di.angajat_aprobat).toBe(0);
    expect(di.disponibil).toBe(1000);
  });

  // ── 7. plafonul cu excludeDfId (a doua interogare, aceeași gaură) ────────────
  it('7. plafon cu excludeDfId pe alt dosar: dosarul A cu R1 desfăcută contribuie cu R0 (220), nu cu R1', async () => {
    const { flow1 } = await seedDosarR0R1();
    await adminCancelFlow(flow1);

    const alopC = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', titlu: 'Dosar C' });
    const flowC = await seedFlowApproved();
    const dfC = await seedDf({
      orgId: 1, createdBy: 1, status: 'aprobat', flowId: flowC, nrUnic: 'ALT-1', sourceAlopId: alopC,
      rowsCtrl: [{ cod_SSI: SSI, sum_rezv_crdt_bug_act: '100' }],
    });

    const disp = await getBugetDisponibil(pool, 1, dfC); // exclude dosarul C ⇒ rămâne doar A
    const item = itemFor(disp, SSI);
    expect(item).toBeTruthy();
    expect(item.angajat_aprobat).toBe(Number(R0_SUMA));
  });
});
