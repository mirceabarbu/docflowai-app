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
  // #134f — invariantul de business RĂMÂNE (un ALOP `completed` chiar se releagă la revizia
  // nouă), dar MOMENTUL s-a mutat: nu la CREAREA reviziei, ci la APROBAREA ei, prin
  // selfHealAlopDfLink — singurul care mai mută pointerul. Aserția veche (relink imediat +
  // df_flow_id/df_completed_at resetate) cimenta exact semantica pe care lotul o schimbă.
  it('revizuieste pe DF cu ALOP completed → pointerul se mută la APROBAREA reviziei, status neatins', async () => {
    const flowId = await seedFlowApproved();
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-INV-1', rowsVal: [{ valt_actualiz: '1000' }] });
    const alopId = await seedAlop({
      orgId: 1, createdBy: 1, status: 'completed', dfId, dfFlowId: flowId,
      dfCompletedAt: new Date(), plataSumaEfectiva: 1000, cicluCurent: 1,
    });
    await pool.query(`UPDATE formulare_df SET source_alop_id=$2 WHERE id=$1`, [dfId, alopId]);

    const res = await request(app).post(`/api/formulare-df/${dfId}/revizuieste`).set('Cookie', p1()).send({ motiv: 'valoare mărită' });
    expect(res.status).toBe(200);
    const revId = res.body.df.id;

    // Cât timp R1 e în lucru, dosarul rămâne pe revizia ÎN VIGOARE (R0), cu dovada aprobării.
    const inLucru = await getAlop(alopId);
    expect(inLucru.df_id).toBe(dfId);
    expect(inLucru.df_flow_id).toBe(flowId);
    expect(inLucru.df_completed_at).not.toBeNull();
    expect(inLucru.status).toBe('completed');

    // 🔒 Aprobarea lui R1 releagă ALOP-ul CHIAR DACĂ e `completed` (doar `cancelled_at`
    // exclude) — mecanismul care permite ciclul următor. NU adăuga filtre pe completed.
    const revFlow = await seedFlowApproved();
    await pool.query(`UPDATE formulare_df SET flow_id=$2 WHERE id=$1`, [revId, revFlow]);
    await selfHealAlopDfLink(pool, revFlow);

    const a = await getAlop(alopId);
    expect(a.df_id).toBe(revId);            // relink la R1 — și pe ALOP completed
    expect(a.df_flow_id).toBe(revFlow);
    expect(a.df_completed_at).not.toBeNull();
    expect(a.status).toBe('completed');     // relink-ul de revizie NU atinge status-ul
  });

  it('noua-lichidare după revizie cu valoare mărită → ramas pe valoarea reviziei noi, ciclu nou, completed_at=NULL', async () => {
    const flowId = await seedFlowApproved();
    // FIX 12 (v3.9.582): `ramas` din noua-lichidare se calculează pe CREDITELE BUGETARE
    // col.10 = SUM(rows_ctrl.sum_rezv_crdt_bug_act) al DF-ului legat (revizia activă), MINUS
    // ordonanțările anterioare — NU pe banda `rows_plati`, NU pe angajamentul total
    // SUM(rows_val.valt_actualiz). Seed coerent: col.10 inițial 1000, revizia mărește la 1500.
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-INV-2', rowsVal: [{ valt_actualiz: '1000' }], rowsPlati: [{ plati_estim_ancrt: '1000' }], rowsCtrl: [{ sum_rezv_crdt_bug_act: '1000' }] });
    const alopId = await seedAlop({
      orgId: 1, createdBy: 1, status: 'completed', dfId, dfFlowId: flowId,
      dfCompletedAt: new Date(), plataSumaEfectiva: 1000, cicluCurent: 1,
    });
    await pool.query(`UPDATE formulare_df SET source_alop_id=$2 WHERE id=$1`, [dfId, alopId]);

    // Revizuire; creditele bugetare col.10 ale reviziei cresc la 1500.
    const rev = await request(app).post(`/api/formulare-df/${dfId}/revizuieste`).set('Cookie', p1()).send({ motiv: 'suplimentare' });
    expect(rev.status).toBe(200);
    const revId = rev.body.df.id;
    const revFlowId = await seedFlowApproved();
    await pool.query(
      `UPDATE formulare_df SET rows_val=$2::jsonb, rows_plati=$3::jsonb, rows_ctrl=$4::jsonb, status='aprobat', flow_id=$5 WHERE id=$1`,
      [revId, JSON.stringify([{ valt_actualiz: '1500' }]), JSON.stringify([{ plati_estim_ancrt: '1500' }]), JSON.stringify([{ sum_rezv_crdt_bug_act: '1500' }]), revFlowId]
    );
    // #134f — pointerul se mută abia ACUM, la aprobarea reviziei. Înainte de asta,
    // noua-lichidare ar fi citit (corect) tot col.10 al lui R0.
    await selfHealAlopDfLink(pool, revFlowId);

    const res = await request(app).post(`/api/alop/${alopId}/noua-lichidare`).set('Cookie', p1()).send({});
    expect(res.status).toBe(200);
    // FIX 12: ramas = col.10 al reviziei ACTIVE (alop.df_id relegat = 1500) − ordonanțat anterior (0,
    // fără ORD/cicluri arhivate). Citește col.10 din revizia NOUĂ (1500), NU din DF-ul inițial (1000)
    // — dovada că relink-ul s-a aplicat. (Vechea bază FIX B scădea „plătit" 1000 → 500.)
    expect(Number(res.body.ramas)).toBe(1500);

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
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare' });
    // #134c: dupa fix, identitatea e DOSARUL (source_alop_id) — r0 il poarta de la creare,
    // reflectand invariantul real (revizuieste COPIAZA source_alop_id din parinte, nu-l
    // adauga doar pe copil). Inainte de fix testul seta source_alop_id DOAR pe r1 (via UPDATE
    // dupa creare), o stare artificiala ce nu apare in productie pe calea reala /revizuieste.
    const r0Id = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId: oldFlowId, nrUnic: 'DF-SH-3', sourceAlopId: alopId });
    await pool.query(`UPDATE alop_instances SET df_id=$2, df_flow_id=$3 WHERE id=$1`, [alopId, r0Id, oldFlowId]);
    const newFlowId = await seedFlowApproved();
    const r1Id = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId: newFlowId, nrUnic: 'DF-SH-3', revizieNr: 1, parentDfId: r0Id, sourceAlopId: alopId });

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

  // ── #134c: garda de self-heal cheiaza pe DOSAR (source_alop_id), nu pe nr_unic_inreg ──
  // Context: nr_unic_inreg poate fi DUPLICAT intre dosare ALOP diferite in productie
  // (docs/incidents/DF-NR-DUPLICAT.md). Garda veche compara doar numarul -> accepta
  // gresit un DF dintr-un alt dosar drept "aceeasi serie".

  it('K1 (invariant): df_id legat manual la un DF din ALT dosar, cu ACELASI nr_unic_inreg → ramane neatins (garda cheiaza pe dosar, nu pe numar)', async () => {
    // Dosarul Y: ALOP AY cu propriul DF, acelasi numar de inregistrare '4711'.
    const alopY = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', titlu: 'ALOP Y' });
    const dyR0 = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: '4711', sourceAlopId: alopY });

    // Dosarul X: ALOP AX legat MANUAL la DF-ul dosarului Y (relegare manuala, cross-dosar).
    const alopX = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', titlu: 'ALOP X', dfId: dyR0 });

    // Se aproba o revizie a PROPRIULUI DF al dosarului X, cu ACELASI numar '4711'.
    const flowX1 = await seedFlowApproved();
    const dxR1 = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId: flowX1, nrUnic: '4711', sourceAlopId: alopX, revizieNr: 1 });

    await selfHealAlopDfLink(pool, flowX1);

    const a = await getAlop(alopX);
    // Garda pe DOSAR: dyR0 apartine dosarului Y (source_alop_id=alopY) != dosarul lui dxR1 (alopX)
    // => EXISTS fals => relegarea manuala NU e suprascrisa.
    expect(a.df_id).toBe(dyR0);
    expect(a.df_flow_id).toBeNull();
  });

  it('K2 (non-regresie): relegare corecta in cadrul aceluiasi dosar, chiar cu numar comun cu alt dosar', async () => {
    // Un alt dosar (Y) cu acelasi numar, ca sa dovedim ca relinkul nu se bazeaza pe numar.
    await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: '4711' });

    const dxR0Flow = await seedFlowApproved();
    const dxR0 = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId: dxR0Flow, nrUnic: '4711' });
    const alopX = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId: dxR0, dfFlowId: dxR0Flow });
    await pool.query(`UPDATE formulare_df SET source_alop_id=$2 WHERE id=$1`, [dxR0, alopX]);

    const dxR1Flow = await seedFlowApproved();
    const dxR1 = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId: dxR1Flow, nrUnic: '4711', sourceAlopId: alopX, revizieNr: 1, parentDfId: dxR0 });

    await selfHealAlopDfLink(pool, dxR1Flow);

    const a = await getAlop(alopX);
    expect(a.df_id).toBe(dxR1);
    expect(a.df_flow_id).toBe(dxR1Flow);
  });

  // NOTĂ (raportată, nu ascunsă): selfHealAlopDfLink SELECTEAZĂ DF-ul aprobat cu
  // `source_alop_id IS NOT NULL` (linia 36) — deci `df` din funcție are ÎNTOTDEAUNA
  // source_alop_id populat, niciodată `dosarKeyOf(df)` nu cade pe fallback-ul de
  // nr_unic_inreg. Fallback-ul rămâne relevant pentru fd (a.df_id) dacă acesta e
  // legacy — dar atunci comparația e mereu FALS (nr_unic text vs. UUID alopId),
  // deci un fd cu adevărat legacy (fără source_alop_id) NU mai e recunoscut ca
  // "aceeași serie" doar pe bază de număr — comportament NOU, mai strict decât
  // înainte, dar SIGUR (nu suprascrie o legătură ambiguă). K3 testează în schimb
  // invariantul relevant la acest call-site: match-ul se face pe DOSAR (id), nu pe
  // număr — chiar dacă numărul de înregistrare diferă între revizii.
  it('K3: match pe dosar (source_alop_id), nu pe numar — functioneaza chiar daca nr_unic_inreg difera intre revizii', async () => {
    const oldFlowId = await seedFlowApproved();
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare' });
    const r0Id = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId: oldFlowId, nrUnic: 'DF-NUM-VECHI', sourceAlopId: alopId });
    await pool.query(`UPDATE alop_instances SET df_id=$2, df_flow_id=$3 WHERE id=$1`, [alopId, r0Id, oldFlowId]);

    const newFlowId = await seedFlowApproved();
    // Numar DIFERIT fata de r0Id (editat intre revizii), dar acelasi dosar (source_alop_id).
    const r1Id = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId: newFlowId, nrUnic: 'DF-NUM-NOU', revizieNr: 1, parentDfId: r0Id, sourceAlopId: alopId });

    await selfHealAlopDfLink(pool, newFlowId);

    const a = await getAlop(alopId);
    expect(a.df_id).toBe(r1Id);
    expect(a.df_flow_id).toBe(newFlowId);
  });

  it('K4: df_id pointeaza la un DF din alt dosar (numar diferit) → relegare manuala respectata, ALOP neatins', async () => {
    const otherDfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-K4-ALTUL' });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId: otherDfId });
    const flowId = await seedFlowApproved();
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-K4-NOU', sourceAlopId: alopId });

    await selfHealAlopDfLink(pool, flowId);

    const a = await getAlop(alopId);
    expect(a.df_id).toBe(otherDfId);
    expect(a.df_flow_id).toBeNull();
  });

  it('K5: izolare pe org — un DF cu aceeasi cheie de dosar din alt org NU potriveste', async () => {
    const { orgId: org2 } = await seedOrgUser({ orgName: 'Org Test 2', role: 'user', email: 'p1-org2@x.ro' });
    const flowId = await seedFlowApproved();
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare' });
    // DF cu source_alop_id = alopId, dar in alt ORG (izolare multi-tenant) — nu ar trebui gasit
    // de selectia initiala (flow_id + source_alop_id), dar testam explicit garda EXISTS pe org_id
    // legand manual un df_id "strain" si verificand ca nu se produce relegare cross-org.
    const foreignDf = await seedDf({ orgId: org2, createdBy: 1, status: 'aprobat', nrUnic: 'DF-K5', sourceAlopId: alopId });
    await pool.query(`UPDATE alop_instances SET df_id=$2 WHERE id=$1`, [alopId, foreignDf]);

    await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-K5', sourceAlopId: alopId, revizieNr: 1 });

    await selfHealAlopDfLink(pool, flowId);

    const a = await getAlop(alopId);
    // EXISTS-ul din garda filtreaza pe fd.org_id = $4 (org-ul DF-ului aprobat acum, org 1);
    // foreignDf e in org 2 -> nu trece de filtrul de org -> ramane relegarea straina neatinsa.
    expect(a.df_id).toBe(foreignDf);
  });
});
