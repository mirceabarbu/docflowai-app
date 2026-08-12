/**
 * test:db — #127: Clasa 8 (angajamente bugetare + verificarea de plafon) se cheie
 * pe DOSARUL ALOP, nu pe `nr_unic_inreg` — ultima piesă rămasă neatinsă din #126.
 *
 * Fixtura reproduce producția (vezi #126 / docs/incidents/DF-NR-DUPLICAT.md):
 * două DOSARE ALOP DIFERITE pot avea același `nr_unic_inreg`. Cu cheia veche pe
 * număr, `DISTINCT ON (nr_unic_inreg)` păstra un singur DF ⇒ angajamentele
 * celuilalt dosar dispăreau din raport, iar excluderea `excludeDfId` la
 * verificarea de plafon exclude din greșeală și dosarul STRĂIN.
 *
 * Rulează pe Postgres 17 efemer (vezi CLAUDE.md §test:db).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedAlop, seedFlowApproved } from '../helpers/db-real.mjs';
import { getClasa8Aggregate, getBugetDisponibil } from '../../services/clasa8.mjs';

const d = describe.skipIf(!hasTestDb());

const NR = '40339';
const SSI = '810101';

function itemFor(result, cod) {
  return result.items.find(x => x.cod_ssi === cod);
}

d('#127 — Clasa 8 cheiat pe dosarul ALOP', () => {
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user' }); // org 1, user 1
  });
  afterAll(() => pool.end());

  // ── 1. TESTUL CENTRAL ───────────────────────────────────────────────────
  it('raportul Clasa 8 însumează angajamentele AMBELOR dosare, nu doar una (azi: 220 sau 320)', async () => {
    const alopA = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', titlu: 'Dosar A' });
    const alopB = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', titlu: 'Dosar B' });
    const flowA = await seedFlowApproved();
    const flowB = await seedFlowApproved();
    const dfA = await seedDf({
      orgId: 1, createdBy: 1, status: 'aprobat', flowId: flowA, nrUnic: NR, sourceAlopId: alopA,
      rowsCtrl: [{ cod_SSI: SSI, sum_rezv_crdt_bug_act: '220' }],
    });
    const dfB = await seedDf({
      orgId: 1, createdBy: 1, status: 'aprobat', flowId: flowB, nrUnic: NR, sourceAlopId: alopB,
      rowsCtrl: [{ cod_SSI: SSI, sum_rezv_crdt_bug_act: '320' }],
    });

    const res = await getClasa8Aggregate(pool, 1, {});
    const item = itemFor(res, SSI);
    expect(item).toBeTruthy();
    expect(item.angajamente).toBe(540);
    expect(item.df_count).toBe(2);
    expect([dfA, dfB].every(Boolean)).toBe(true);
  });

  // ── 2. plafonul NU exclude dosarul STRĂIN care partajează numărul ──────────
  it('verificarea de plafon cu excludeDfId=A NU exclude dosarul B (număr partajat, dosar diferit)', async () => {
    const alopA = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', titlu: 'Dosar A' });
    const alopB = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', titlu: 'Dosar B' });
    const flowA = await seedFlowApproved();
    const flowB = await seedFlowApproved();
    const dfA = await seedDf({
      orgId: 1, createdBy: 1, status: 'aprobat', flowId: flowA, nrUnic: NR, sourceAlopId: alopA,
      rowsCtrl: [{ cod_SSI: SSI, sum_rezv_crdt_bug_act: '220' }],
    });
    await seedDf({
      orgId: 1, createdBy: 1, status: 'aprobat', flowId: flowB, nrUnic: NR, sourceAlopId: alopB,
      rowsCtrl: [{ cod_SSI: SSI, sum_rezv_crdt_bug_act: '320' }],
    });

    const res = await getBugetDisponibil(pool, 1, dfA);
    const item = itemFor(res, SSI);
    expect(item).toBeTruthy();
    expect(item.angajat_aprobat).toBe(320); // doar dosarul B — A e exclus, B rămâne
  });

  // ── 3. excluderea rămâne corectă ÎN INTERIORUL dosarului ────────────────────
  it('excludeDfId=R1 exclude ȘI R0 al aceluiași dosar (nu doar rândul R1) — fără dublă numărare', async () => {
    const alopA = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', titlu: 'Dosar A' });
    const flowA0 = await seedFlowApproved();
    const flowA1 = await seedFlowApproved();
    const dfA0 = await seedDf({
      orgId: 1, createdBy: 1, status: 'aprobat', flowId: flowA0, nrUnic: NR, sourceAlopId: alopA,
      rowsCtrl: [{ cod_SSI: SSI, sum_rezv_crdt_bug_act: '220' }],
    });
    const dfA1 = await seedDf({
      orgId: 1, createdBy: 1, status: 'aprobat', flowId: flowA1, nrUnic: NR, sourceAlopId: alopA,
      revizieNr: 1, parentDfId: dfA0,
      rowsCtrl: [{ cod_SSI: SSI, sum_rezv_crdt_bug_act: '400' }],
    });

    const alopC = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', titlu: 'Dosar C' });
    const flowC = await seedFlowApproved();
    await seedDf({
      orgId: 1, createdBy: 1, status: 'aprobat', flowId: flowC, nrUnic: 'ALT-1', sourceAlopId: alopC,
      rowsCtrl: [{ cod_SSI: SSI, sum_rezv_crdt_bug_act: '100' }],
    });

    const res = await getBugetDisponibil(pool, 1, dfA1);
    const item = itemFor(res, SSI);
    expect(item).toBeTruthy();
    // Nici R0 (220), nici R1 (400) al dosarului A nu apar — doar dosarul C (100).
    expect(item.angajat_aprobat).toBe(100);
  });

  // ── 4. LEGACY: fallback pe număr nu regresează ──────────────────────────────
  it('LEGACY (source_alop_id NULL): R0+R1 aprobate, același număr ⇒ se numără O SINGURĂ dată', async () => {
    const flow0 = await seedFlowApproved();
    const flow1 = await seedFlowApproved();
    const legacy0 = await seedDf({
      orgId: 1, createdBy: 1, status: 'aprobat', flowId: flow0, nrUnic: 'LEG-1',
      rowsCtrl: [{ cod_SSI: SSI, sum_rezv_crdt_bug_act: '150' }],
    });
    await seedDf({
      orgId: 1, createdBy: 1, status: 'aprobat', flowId: flow1, nrUnic: 'LEG-1',
      revizieNr: 1, parentDfId: legacy0,
      rowsCtrl: [{ cod_SSI: SSI, sum_rezv_crdt_bug_act: '999' }],
    });

    const res = await getClasa8Aggregate(pool, 1, {});
    const item = itemFor(res, SSI);
    expect(item).toBeTruthy();
    expect(item.angajamente).toBe(999); // doar ultima revizie, nu 150+999
    expect(item.df_count).toBe(1);
  });

  // ── 5. Non-regresie: un singur dosar, R0→R1→R2 ⇒ doar ultima revizie ───────
  it('un singur dosar cu R0→R1→R2 aprobate ⇒ se numără DOAR R2 (ca înainte)', async () => {
    const alopA = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', titlu: 'Dosar A' });
    const flow0 = await seedFlowApproved();
    const flow1 = await seedFlowApproved();
    const flow2 = await seedFlowApproved();
    const df0 = await seedDf({
      orgId: 1, createdBy: 1, status: 'aprobat', flowId: flow0, nrUnic: NR, sourceAlopId: alopA,
      rowsCtrl: [{ cod_SSI: SSI, sum_rezv_crdt_bug_act: '10' }],
    });
    const df1 = await seedDf({
      orgId: 1, createdBy: 1, status: 'aprobat', flowId: flow1, nrUnic: NR, sourceAlopId: alopA,
      revizieNr: 1, parentDfId: df0,
      rowsCtrl: [{ cod_SSI: SSI, sum_rezv_crdt_bug_act: '20' }],
    });
    await seedDf({
      orgId: 1, createdBy: 1, status: 'aprobat', flowId: flow2, nrUnic: NR, sourceAlopId: alopA,
      revizieNr: 2, parentDfId: df1,
      rowsCtrl: [{ cod_SSI: SSI, sum_rezv_crdt_bug_act: '30' }],
    });

    const res = await getClasa8Aggregate(pool, 1, {});
    const item = itemFor(res, SSI);
    expect(item).toBeTruthy();
    expect(item.angajamente).toBe(30);
    expect(item.df_count).toBe(1);
  });
});
