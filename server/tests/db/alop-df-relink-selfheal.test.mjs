/**
 * Linking DF↔ALOP (v3.9.554) — invariant de business + self-heal.
 *
 * 🔒 INVARIANT (caracterizare, NU modifica): relink-ul de la crearea reviziei
 * (df.mjs /revizuieste) se aplică INTENȚIONAT și ALOP-urilor cu status='completed' —
 * e mecanismul care permite: ALOP finalizat → revizuire DF (valoare mărită) →
 * noua-lichidare recalculează `ramas` pe valoarea reviziei noi → ciclu nou.
 *
 * Self-heal (alop-link.mjs): la aprobarea fluxului DF, ALOP-ul cu legătura ruptă
 * (df_id NULL după refuz R0 / link-df eșuat silențios) e re-legat via source_alop_id.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedAlop, seedFlowApproved, seedFlow,
         getAlop, getDf, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';
import { selfHealAlopDfLink } from '../../services/alop-link.mjs';

const d = describe.skipIf(!hasTestDb());

d('Linking DF↔ALOP — invariant relink-pe-completed + self-heal', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' }); // user 1, org 1
    app = buildApp();
  });
  afterAll(() => pool.end());
  const p1 = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  // ── INVARIANT: revizia RELEAGĂ ALOP-ul completed (protejează noua-lichidare) ────
  it('revizuieste pe DF cu ALOP completed → ALOP relink la revizia nouă, df_flow_id/df_completed_at resetate, status neatins', async () => {
    const flowId = await seedFlowApproved();
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-INV-1', rowsVal: [{ valt_actualiz: '1000' }] });
    const alopId = await seedAlop({
      orgId: 1, createdBy: 1, status: 'completed', dfId, dfFlowId: flowId,
      dfCompletedAt: new Date(), plataSumaEfectiva: 1000, cicluCurent: 1,
    });

    const res = await request(app).post(`/api/formulare-df/${dfId}/revizuieste`).set('Cookie', p1()).send({ motiv: 'valoare mărită' });
    expect(res.status).toBe(200);
    const revId = res.body.df.id;

    const a = await getAlop(alopId);
    expect(a.df_id).toBe(revId);            // relink la R1 — și pe ALOP completed
    expect(a.df_flow_id).toBeNull();
    expect(a.df_completed_at).toBeNull();
    expect(a.status).toBe('completed');     // relink-ul de revizie NU atinge status-ul
  });

  it('noua-lichidare după revizie cu valoare mărită → ramas pe valoarea reviziei noi, ciclu nou, completed_at=NULL', async () => {
    const flowId = await seedFlowApproved();
    // FIX B (v3.9.557): `ramas` din noua-lichidare se calculează pe bugetul anului curent
    // = SUM(rows_plati.plati_estim_ancrt), NU pe angajamentul total SUM(rows_val.valt_actualiz).
    // Seed coerent: angajament total ≥ buget an curent.
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-INV-2', rowsVal: [{ valt_actualiz: '1000' }], rowsPlati: [{ plati_estim_ancrt: '1000' }] });
    const alopId = await seedAlop({
      orgId: 1, createdBy: 1, status: 'completed', dfId, dfFlowId: flowId,
      dfCompletedAt: new Date(), plataSumaEfectiva: 1000, cicluCurent: 1,
    });

    // Revizuire → ALOP relink la R1; bugetul anului curent al reviziei crește la 1500 (aprobat)
    const rev = await request(app).post(`/api/formulare-df/${dfId}/revizuieste`).set('Cookie', p1()).send({ motiv: 'suplimentare' });
    expect(rev.status).toBe(200);
    const revId = rev.body.df.id;
    const revFlowId = await seedFlowApproved();
    await pool.query(
      `UPDATE formulare_df SET rows_val=$2::jsonb, rows_plati=$3::jsonb, status='aprobat', flow_id=$4 WHERE id=$1`,
      [revId, JSON.stringify([{ valt_actualiz: '1500' }]), JSON.stringify([{ plati_estim_ancrt: '1500' }]), revFlowId]
    );

    const res = await request(app).post(`/api/alop/${alopId}/noua-lichidare`).set('Cookie', p1()).send({});
    expect(res.status).toBe(200);
    expect(Number(res.body.ramas)).toBe(500);  // 1500 (buget an curent revizie, plati_estim_ancrt) - 1000 (plătit) — NU 0 pe vechea bază valt_actualiz

    const a = await getAlop(alopId);
    expect(a.status).toBe('lichidare');
    expect(a.completed_at).toBeNull();
    expect(a.ciclu_curent).toBe(2);
  });

  // ── A1: source_alop_id — persistare la creare + copiere la revizie ─────────────
  it('POST /api/formulare-df cu source_alop_id → persistat; PUT nu îl poate modifica', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft' });
    const res = await request(app).post('/api/formulare-df').set('Cookie', p1())
      .send({ nr_unic_inreg: 'DF-SRC-1', source_alop_id: alopId });
    expect(res.status).toBe(200);
    const dfId = res.body.document.id;
    expect((await getDf(dfId)).source_alop_id).toBe(alopId);

    // PUT cu alt source_alop_id → ignorat (nu e în DF_P1_FIELDS)
    const put = await request(app).put(`/api/formulare-df/${dfId}`).set('Cookie', p1())
      .send({ subtitlu_df: 'x', source_alop_id: '00000000-0000-0000-0000-000000000001' });
    expect(put.status).toBe(200);
    expect((await getDf(dfId)).source_alop_id).toBe(alopId);
  });

  it('source_alop_id invalid (non-UUID) la POST → ignorat, document creat fără el', async () => {
    const res = await request(app).post('/api/formulare-df').set('Cookie', p1())
      .send({ nr_unic_inreg: 'DF-SRC-2', source_alop_id: 'nu-e-uuid' });
    expect(res.status).toBe(200);
    expect((await getDf(res.body.document.id)).source_alop_id).toBeNull();
  });

  it('revizuieste copiază source_alop_id din părintele revizuit', async () => {
    const flowId = await seedFlowApproved();
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'completed' });
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-SRC-3' });
    await pool.query(`UPDATE formulare_df SET source_alop_id=$2 WHERE id=$1`, [dfId, alopId]);

    const res = await request(app).post(`/api/formulare-df/${dfId}/revizuieste`).set('Cookie', p1()).send({});
    expect(res.status).toBe(200);
    expect((await getDf(res.body.df.id)).source_alop_id).toBe(alopId);
  });

  // ── A2: self-heal la aprobarea fluxului DF (serviciu peste DB real) ─────────────
  it('refuz R0 → re-aprobare: ALOP angajare cu df_id=NULL e re-legat + tranziție lichidare', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare' }); // df_id NULL (eliberat la refuz R0)
    const flowId = await seedFlowApproved();
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-SH-1' });
    await pool.query(`UPDATE formulare_df SET source_alop_id=$2 WHERE id=$1`, [dfId, alopId]);

    await selfHealAlopDfLink(pool, flowId);

    const a = await getAlop(alopId);
    expect(a.df_id).toBe(dfId);
    expect(a.df_flow_id).toBe(flowId);
    expect(a.df_completed_at).not.toBeNull();
    expect(a.status).toBe('lichidare');     // angajare → lichidare
  });

  it('cazul real: ALOP completed cu df_id=NULL → aprobarea R1 cu source_alop_id re-leagă, status neatins', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'completed', plataSumaEfectiva: 1000 });
    const flowId = await seedFlowApproved();
    const r1Id = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-SH-2', revizieNr: 1 });
    await pool.query(`UPDATE formulare_df SET source_alop_id=$2 WHERE id=$1`, [r1Id, alopId]);

    await selfHealAlopDfLink(pool, flowId);

    const a = await getAlop(alopId);
    expect(a.df_id).toBe(r1Id);
    expect(a.df_flow_id).toBe(flowId);
    expect(a.status).toBe('completed');     // NU se atinge status/completed_at
  });

  it('df_id pointează la revizia veche (același nr_unic) → relink la cea aprobată acum', async () => {
    const oldFlowId = await seedFlowApproved();
    const r0Id = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId: oldFlowId, nrUnic: 'DF-SH-3' });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId: r0Id, dfFlowId: oldFlowId });
    const newFlowId = await seedFlowApproved();
    const r1Id = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId: newFlowId, nrUnic: 'DF-SH-3', revizieNr: 1, parentDfId: r0Id });
    await pool.query(`UPDATE formulare_df SET source_alop_id=$2 WHERE id=$1`, [r1Id, alopId]);

    await selfHealAlopDfLink(pool, newFlowId);

    const a = await getAlop(alopId);
    expect(a.df_id).toBe(r1Id);
    expect(a.df_flow_id).toBe(newFlowId);
    expect(a.status).toBe('lichidare');     // deja în lichidare — neatins
  });

  it('df_id pointează la un DF cu ALT nr_unic_inreg (relegare manuală) → ALOP neatins', async () => {
    const otherDfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-ALTUL' });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId: otherDfId });
    const flowId = await seedFlowApproved();
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-SH-4' });
    await pool.query(`UPDATE formulare_df SET source_alop_id=$2 WHERE id=$1`, [dfId, alopId]);

    await selfHealAlopDfLink(pool, flowId);

    const a = await getAlop(alopId);
    expect(a.df_id).toBe(otherDfId);        // nu suprascrie relegarea manuală
    expect(a.df_flow_id).toBeNull();
  });

  it('ALOP anulat (cancelled_at) → neatins', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', cancelledAt: new Date() });
    const flowId = await seedFlowApproved();
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-SH-5' });
    await pool.query(`UPDATE formulare_df SET source_alop_id=$2 WHERE id=$1`, [dfId, alopId]);

    await selfHealAlopDfLink(pool, flowId);

    const a = await getAlop(alopId);
    expect(a.df_id).toBeNull();
    expect(a.status).toBe('angajare');
  });

  it('idempotent: a doua rulare nu schimbă starea', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare' });
    const flowId = await seedFlowApproved();
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-SH-6' });
    await pool.query(`UPDATE formulare_df SET source_alop_id=$2 WHERE id=$1`, [dfId, alopId]);

    await selfHealAlopDfLink(pool, flowId);
    const first = await getAlop(alopId);
    await selfHealAlopDfLink(pool, flowId);
    const second = await getAlop(alopId);

    expect(second.df_id).toBe(first.df_id);
    expect(second.df_flow_id).toBe(first.df_flow_id);
    expect(second.status).toBe(first.status);
    expect(String(second.df_completed_at)).toBe(String(first.df_completed_at));
  });

  it('DF fără source_alop_id → self-heal nu face nimic (no-op)', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare' });
    const flowId = await seedFlowApproved();
    await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-SH-7' });

    await selfHealAlopDfLink(pool, flowId);

    expect((await getAlop(alopId)).df_id).toBeNull();
  });

  // ── Comportament neschimbat: guard conflict link-df include ALOP-urile finalizate ─
  it('link-df pe DF deja legat la un ALOP completed → 409 df_deja_legat (guard nemodificat)', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-G-1' });
    await seedAlop({ orgId: 1, createdBy: 1, status: 'completed', dfId });
    const alop2 = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft', titlu: 'ALOP 2' });

    const res = await request(app).post(`/api/alop/${alop2}/link-df`).set('Cookie', p1()).send({ df_id: dfId });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('df_deja_legat');
  });

  it('link-df pe DF deja legat la un ALOP activ → 409 df_deja_legat (guard nemodificat)', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-G-2' });
    await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId });
    const alop2 = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft', titlu: 'ALOP 2' });

    const res = await request(app).post(`/api/alop/${alop2}/link-df`).set('Cookie', p1()).send({ df_id: dfId });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('df_deja_legat');
  });
});
