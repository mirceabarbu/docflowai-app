/**
 * Varianta A (owner): garda de buget ORD rulează ȘI la P1 (submit draft→pending_p2), HARD.
 * La P1 se validează DOAR plafonul de buget (validateOrdBugetAnCurent), NU col.5 —
 * `receptii` (col.2) e completată de P2, deci la P1 receptii=0 ar face c5 fals negativ și ar
 * bloca trimiterea. col.5 rămâne STRICT la P2 (garda din completeFormular, neschimbată).
 *
 * Fix 12 (v3.9.582): plafonul = CREDITE BUGETARE col.10 (rows_ctrl.sum_rezv_crdt_bug_act),
 * minus suma ORDONANȚATĂ a ciclurilor arhivate (JOIN ord_id), per an de exercițiu.
 *
 * Submit folosește rândurile DEJA salvate (doc.rows, autosave), NU body — de aceea seedOrd
 * primește `rows`.
 *
 * Paritate inline↔backend: GET /:id și /buget-context expun buget_an_curent + cicluri_arhivate
 * REZOLVATE de acel. helper (computeOrdBudgetContext) ca garda hard → atenționarea inline dă
 * exact același verdict.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, seedOrd, seedAlop, getOrd, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());
const CUR = new Date().getFullYear();

d('POST /api/formulare-ord/:id/submit — plafon credite bugetare col.10 la P1 (Varianta A)', () => {
  let app;
  beforeAll(migrate);
  // userId 1 = P1 (creator/submitter), userId 2 = P2 (assigned).
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' });   // id 1, org 1
    await seedUser({ orgId: 1, email: 'p2@x.ro' });           // id 2, org 1
    app = buildApp();
  });
  afterAll(() => pool.end());
  const p1 = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  async function seedDfBudget(budget = '29000', total = '15000000') {
    return seedDf({
      orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-P1-1',
      rowsVal: [{ valt_actualiz: total }],
      rowsPlati: [{ plati_estim_ancrt: '0' }],
      rowsCtrl: [{ sum_rezv_crdt_bug_act: budget }],
    });
  }
  async function addCicluOrdonantat(alopId, dfId, ordonantat, an = CUR, nr = 1) {
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', dfId,
      nrOrd: `ORD-CIC-${nr}`, rows: [{ suma_ordonantata_plata: String(ordonantat) }] });
    await pool.query(
      `INSERT INTO alop_ord_cicluri (alop_id, org_id, ciclu_nr, ord_id, an_exercitiu, status)
       VALUES ($1, 1, $2, $3, $4, 'completed')`, [alopId, nr, ordId, an]);
  }

  it('suma ordonanțată ≤ col.10 → 200 pending_p2', async () => {
    const dfId = await seedDfBudget('29000', '15000000');
    const rows = [{ receptii: '29000', plati_anterioare: '0', suma_ordonantata_plata: '29000' }]; // = buget
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'draft', dfId, rows });
    const res = await request(app).post(`/api/formulare-ord/${ordId}/submit`).set('Cookie', p1()).send({ assigned_to: 2 });
    expect(res.status).toBe(200);
    expect((await getOrd(ordId)).status).toBe('pending_p2');
  });

  it('suma ordonanțată > col.10 → 422 buget_an_curent_depasit (status rămâne draft)', async () => {
    const dfId = await seedDfBudget('29000', '15000000');
    // c5 = 100000 - 0 - 30000 = 70000 ≥ 0 (col.5 trece) DAR 30000 > 29000 col.10.
    const rows = [{ receptii: '100000', plati_anterioare: '0', suma_ordonantata_plata: '30000' }];
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'draft', dfId, rows });
    const res = await request(app).post(`/api/formulare-ord/${ordId}/submit`).set('Cookie', p1()).send({ assigned_to: 2 });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('buget_an_curent_depasit');
    expect(Number(res.body.bugetAnCurent)).toBe(29000);
    expect(Number(res.body.ordonantat)).toBe(30000);
    expect((await getOrd(ordId)).status).toBe('draft'); // neschimbat — nu a fost trimis la P2
  });

  it('col.5 NU se verifică la P1: c5 negativ dar buget OK → 200 pending_p2', async () => {
    const dfId = await seedDfBudget('29000', '15000000');
    // c5 = 100 - 0 - 200 = -100 (col.5 ar pica la P2) DAR 200 ≤ 29000 buget. La P1 → trece.
    const rows = [{ receptii: '100', plati_anterioare: '0', suma_ordonantata_plata: '200' }];
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'draft', dfId, rows });
    const res = await request(app).post(`/api/formulare-ord/${ordId}/submit`).set('Cookie', p1()).send({ assigned_to: 2 });
    expect(res.status).toBe(200);
    expect((await getOrd(ordId)).status).toBe('pending_p2');
  });

  it('caz realist P1: receptii=0 (le pune P2) + sumă ≤ buget → 200 (col.5 NU blochează)', async () => {
    const dfId = await seedDfBudget('29000', '15000000');
    const rows = [{ receptii: '0', plati_anterioare: '0', suma_ordonantata_plata: '5000' }];
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'draft', dfId, rows });
    const res = await request(app).post(`/api/formulare-ord/${ordId}/submit`).set('Cookie', p1()).send({ assigned_to: 2 });
    expect(res.status).toBe(200);
    expect((await getOrd(ordId)).status).toBe('pending_p2');
  });

  it('cumul peste cicluri arhivate (suma ORDONANȚATĂ) → 422 la P1', async () => {
    const dfId = await seedDfBudget('29000', '15000000');
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId });
    await addCicluOrdonantat(alopId, dfId, 20000);
    // ORD nou de 10000 → cumul 20000 + 10000 = 30000 > 29000 → 422.
    const rows = [{ receptii: '100000', plati_anterioare: '0', suma_ordonantata_plata: '10000' }];
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'draft', dfId, rows });
    const res = await request(app).post(`/api/formulare-ord/${ordId}/submit`).set('Cookie', p1()).send({ assigned_to: 2 });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('buget_an_curent_depasit');
    expect(Number(res.body.ordonantat)).toBe(30000);
  });

  it('ORD fără df_id → plafon sărit la P1 → 200', async () => {
    const rows = [{ receptii: '100000', plati_anterioare: '0', suma_ordonantata_plata: '99999' }];
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'draft', rows }); // df_id null
    const res = await request(app).post(`/api/formulare-ord/${ordId}/submit`).set('Cookie', p1()).send({ assigned_to: 2 });
    expect(res.status).toBe(200);
    expect((await getOrd(ordId)).status).toBe('pending_p2');
  });

  // ── Paritate inline↔backend: valorile expuse reproduc verdictul gărzii ──────────
  it('GET /:id expune buget_an_curent (col.10) + cicluri_arhivate (ordonanțat), paritate cu garda', async () => {
    const dfId = await seedDfBudget('29000', '15000000');
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId });
    await addCicluOrdonantat(alopId, dfId, 20000);
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'draft', dfId, rows: [] });
    const res = await request(app).get(`/api/formulare-ord/${ordId}`).set('Cookie', p1());
    expect(res.status).toBe(200);
    expect(Number(res.body.document.buget_an_curent)).toBe(29000);
    expect(Number(res.body.document.cicluri_arhivate)).toBe(20000);
    // Verdict inline reprodus din valorile expuse: cumul = ordNou(10000) + arhivat(20000) = 30000 > 29000.
    const ordNou = 10000;
    const cumul = ordNou + Number(res.body.document.cicluri_arhivate);
    expect(cumul > Number(res.body.document.buget_an_curent) + 0.001).toBe(true);
  });

  it('GET /buget-context?df_id= întoarce același context ca GET /:id', async () => {
    const dfId = await seedDfBudget('29000', '15000000');
    const res = await request(app).get(`/api/formulare-ord/buget-context?df_id=${dfId}`).set('Cookie', p1());
    expect(res.status).toBe(200);
    expect(Number(res.body.context.buget_an_curent)).toBe(29000);
    expect(Number(res.body.context.cicluri_arhivate)).toBe(0);
    expect(typeof res.body.context.an_exercitiu).toBe('number');
  });

  it('GET /buget-context fără df_id valid → context null (no-op atenționare)', async () => {
    const res = await request(app).get(`/api/formulare-ord/buget-context`).set('Cookie', p1());
    expect(res.status).toBe(200);
    expect(res.body.context).toBeNull();
  });
});
