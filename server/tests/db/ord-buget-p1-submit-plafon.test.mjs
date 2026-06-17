/**
 * Varianta A (owner): garda de buget ORD rulează ȘI la P1 (submit draft→pending_p2), HARD,
 * cu ACEEAȘI verificare ca la P2 (col.5 ≥ 0 ÎNTÂI, apoi plafonul pe bugetul anului de exercițiu).
 *
 * Caracterizare a SCHIMBĂRII intenționate: înainte, P1 submit reușea chiar și peste buget.
 * Acum P1 submit peste buget → 422, exact ca finalizarea P2. Garda P2 NU se schimbă (vezi
 * ord-buget-an-curent-plafon.test.mjs — rămâne verde).
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

d('POST /api/formulare-ord/:id/submit — plafon buget an curent la P1 (Varianta A)', () => {
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
      rowsPlati: [{ plati_estim_ancrt: budget }],
    });
  }

  it('suma ordonanțată ≤ buget an curent → 200 pending_p2', async () => {
    const dfId = await seedDfBudget('29000', '15000000');
    const rows = [{ receptii: '29000', plati_anterioare: '0', suma_ordonantata_plata: '29000' }]; // = buget
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'draft', dfId, rows });
    const res = await request(app).post(`/api/formulare-ord/${ordId}/submit`).set('Cookie', p1()).send({ assigned_to: 2 });
    expect(res.status).toBe(200);
    expect((await getOrd(ordId)).status).toBe('pending_p2');
  });

  it('suma ordonanțată > buget an curent → 422 buget_an_curent_depasit (status rămâne draft)', async () => {
    const dfId = await seedDfBudget('29000', '15000000');
    // c5 = 100000 - 0 - 30000 = 70000 ≥ 0 (col.5 trece) DAR 30000 > 29000 buget an curent.
    const rows = [{ receptii: '100000', plati_anterioare: '0', suma_ordonantata_plata: '30000' }];
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'draft', dfId, rows });
    const res = await request(app).post(`/api/formulare-ord/${ordId}/submit`).set('Cookie', p1()).send({ assigned_to: 2 });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('buget_an_curent_depasit');
    expect(Number(res.body.bugetAnCurent)).toBe(29000);
    expect(Number(res.body.ordonantat)).toBe(30000);
    expect((await getOrd(ordId)).status).toBe('draft'); // neschimbat — nu a fost trimis la P2
  });

  it('ordinea verificărilor: col.5 negativă → 422 receptii_neplatite_negative ÎNAINTE de plafon', async () => {
    const dfId = await seedDfBudget('29000', '15000000');
    // c5 = 100 - 0 - 200 = -100 (col.5 pică) ȘI 200 ≤ 29000 buget. Trebuie să iasă col.5.
    const rows = [{ receptii: '100', plati_anterioare: '0', suma_ordonantata_plata: '200' }];
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'draft', dfId, rows });
    const res = await request(app).post(`/api/formulare-ord/${ordId}/submit`).set('Cookie', p1()).send({ assigned_to: 2 });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('receptii_neplatite_negative');
    expect((await getOrd(ordId)).status).toBe('draft');
  });

  it('cumul peste cicluri arhivate (fără dublă numărare) → 422 la P1', async () => {
    const dfId = await seedDfBudget('29000', '15000000');
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId });
    await pool.query(
      `INSERT INTO alop_ord_cicluri (alop_id, org_id, ciclu_nr, plata_suma_efectiva, status)
       VALUES ($1, 1, 1, 20000, 'completed')`, [alopId]
    );
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
  it('GET /:id expune buget_an_curent + cicluri_arhivate (rezolvate, paritate cu garda)', async () => {
    const dfId = await seedDfBudget('29000', '15000000');
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId });
    await pool.query(
      `INSERT INTO alop_ord_cicluri (alop_id, org_id, ciclu_nr, plata_suma_efectiva, status)
       VALUES ($1, 1, 1, 20000, 'completed')`, [alopId]
    );
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
