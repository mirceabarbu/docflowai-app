/**
 * Fix 12 (v3.9.582): plafon HARD la finalizarea ORD — suma ordonanțată cumulată în anul de
 * exercițiu ≤ CREDITELE BUGETARE (col.10 = SUM(formulare_df.rows_ctrl[].sum_rezv_crdt_bug_act))
 * ale DF-ului legat (ord.df_id). NU banda `rows_plati` (aceea = baza cardului), NU angajamentul
 * total (rows_val). INDIFERENT de bifa „Stingere". Simetric cu validarea col.5, defense-in-depth.
 *
 * Cumulul = suma ORD-ului curent (rândurile noi) + suma ORDONANȚATĂ a ciclurilor arhivate
 * (alop_ord_cicluri → JOIN ord_id → SUM(formulare_ord.rows.suma_ordonantata_plata)), per an.
 * ⚠️ se scad ORDONANȚĂRILE anterioare, NU plățile (distincție owner).
 *
 * col.5 (receptii_neplatite_negative) rămâne validare SEPARATĂ și rulează ÎNAINTE.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, seedOrd, seedAlop, getOrd, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());
const CUR = new Date().getFullYear();

d('POST /api/formulare-ord/:id/complete — plafon credite bugetare col.10 (fix 12)', () => {
  let app;
  beforeAll(migrate);
  // userId 1 = P1 (creator), userId 2 = P2 (assigned).
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' });   // id 1, org 1
    await seedUser({ orgId: 1, email: 'p2@x.ro' });           // id 2, org 1
    app = buildApp();
  });
  afterAll(() => pool.end());
  const p2 = () => makeAuthCookie({ userId: 2, role: 'user', orgId: 1 });

  // Plafon = col.10 (rows_ctrl). rows_plati pus la 0 INTENȚIONAT — dovedește că verificarea
  // folosește col.10, nu banda rows_plati. rows_val (15M) = angajament total, tot irelevant.
  async function seedDfBudget(budget = '29000', total = '15000000') {
    return seedDf({
      orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-PLAF-1',
      rowsVal: [{ valt_actualiz: total }],
      rowsPlati: [{ plati_estim_ancrt: '0' }],
      rowsCtrl: [{ sum_rezv_crdt_bug_act: budget }],
    });
  }
  // Ciclu arhivat cu suma ORDONANȚATĂ = `ordonantat` (via ORD propriu), pe anul de exercițiu.
  async function addCicluOrdonantat(alopId, dfId, ordonantat, an = CUR, nr = 1) {
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', dfId,
      nrOrd: `ORD-CIC-${nr}`, rows: [{ suma_ordonantata_plata: String(ordonantat) }] });
    await pool.query(
      `INSERT INTO alop_ord_cicluri (alop_id, org_id, ciclu_nr, ord_id, an_exercitiu, status)
       VALUES ($1, 1, $2, $3, $4, 'completed')`, [alopId, nr, ordId, an]);
  }

  it('suma ordonanțată ≤ credite bugetare col.10 → 200 completed', async () => {
    const dfId = await seedDfBudget('29000', '15000000');
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2, dfId });
    const rows = [{ receptii: '29000', plati_anterioare: '0', suma_ordonantata_plata: '29000' }]; // = buget
    const res = await request(app).post(`/api/formulare-ord/${ordId}/complete`).set('Cookie', p2()).send({ rows });
    expect(res.status).toBe(200);
    expect(res.body.document.status).toBe('completed');
    expect((await getOrd(ordId)).status).toBe('completed');
  });

  it('suma ordonanțată > col.10 → 422 buget_an_curent_depasit (deși angajamentul total are loc)', async () => {
    const dfId = await seedDfBudget('29000', '15000000');
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2, dfId });
    // c5 = 100000 - 0 - 30000 = 70000 ≥ 0 (col.5 trece) DAR 30000 > 29000 col.10.
    const rows = [{ receptii: '100000', plati_anterioare: '0', suma_ordonantata_plata: '30000' }];
    const res = await request(app).post(`/api/formulare-ord/${ordId}/complete`).set('Cookie', p2()).send({ rows });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('buget_an_curent_depasit');
    expect(Number(res.body.bugetAnCurent)).toBe(29000);
    expect(Number(res.body.ordonantat)).toBe(30000);
    expect((await getOrd(ordId)).status).toBe('pending_p2'); // neschimbat
  });

  it('cumul peste cicluri arhivate (suma ORDONANȚATĂ, nu plătită) → 422', async () => {
    const dfId = await seedDfBudget('29000', '15000000');
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2, dfId });
    // ALOP legat de același DF, cu un ciclu arhivat ordonanțat de 20000.
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId });
    await addCicluOrdonantat(alopId, dfId, 20000);
    // ORD nou de 10000 → cumul 20000 + 10000 = 30000 > 29000 → 422.
    const rows = [{ receptii: '100000', plati_anterioare: '0', suma_ordonantata_plata: '10000' }];
    const res = await request(app).post(`/api/formulare-ord/${ordId}/complete`).set('Cookie', p2()).send({ rows });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('buget_an_curent_depasit');
    expect(Number(res.body.ordonantat)).toBe(30000);
  });

  it('ciclu arhivat scade ORDONANȚATUL, nu PLĂTITUL (ordonanțat≠plătit)', async () => {
    // Ciclu cu ordonanțat 20000 dar plătit DOAR 1000. Verificarea trebuie să scadă 20000.
    const dfId = await seedDfBudget('29000', '15000000');
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2, dfId });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId });
    const ordCicluId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', dfId,
      nrOrd: 'ORD-CIC-PLT', rows: [{ suma_ordonantata_plata: '20000' }] });
    await pool.query(
      `INSERT INTO alop_ord_cicluri (alop_id, org_id, ciclu_nr, ord_id, plata_suma_efectiva, an_exercitiu, status)
       VALUES ($1, 1, 1, $2, 1000, $3, 'completed')`, [alopId, ordCicluId, CUR]);
    // ORD nou 10000 → cumul pe ORDONANȚAT = 20000 + 10000 = 30000 > 29000 → 422.
    // (Dacă ar scădea PLĂTITUL 1000: 1000+10000=11000 ≤ 29000 → ar trece. 422 dovedește ordonanțat.)
    const rows = [{ receptii: '100000', plati_anterioare: '0', suma_ordonantata_plata: '10000' }];
    const res = await request(app).post(`/api/formulare-ord/${ordId}/complete`).set('Cookie', p2()).send({ rows });
    expect(res.status).toBe(422);
    expect(Number(res.body.ordonantat)).toBe(30000);
  });

  it('cumul exact pe col.10 (ciclu arhivat + ORD nou = buget) → 200', async () => {
    const dfId = await seedDfBudget('29000', '15000000');
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2, dfId });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId });
    await addCicluOrdonantat(alopId, dfId, 20000);
    const rows = [{ receptii: '100000', plati_anterioare: '0', suma_ordonantata_plata: '9000' }]; // 20000+9000=29000
    const res = await request(app).post(`/api/formulare-ord/${ordId}/complete`).set('Cookie', p2()).send({ rows });
    expect(res.status).toBe(200);
    expect(res.body.document.status).toBe('completed');
  });

  it('ciclu arhivat în alt an de exercițiu NU consumă col.10 al anului curent', async () => {
    const dfId = await seedDfBudget('29000', '15000000');
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2, dfId });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId });
    await addCicluOrdonantat(alopId, dfId, 25000, CUR - 1); // an precedent → ignorat
    const rows = [{ receptii: '100000', plati_anterioare: '0', suma_ordonantata_plata: '10000' }];
    const res = await request(app).post(`/api/formulare-ord/${ordId}/complete`).set('Cookie', p2()).send({ rows });
    expect(res.status).toBe(200); // 10000 ≤ 29000 (ciclul vechi nu contează)
  });

  it('ordinea verificărilor: col.5 negativă → 422 receptii_neplatite_negative ÎNAINTE de plafon', async () => {
    const dfId = await seedDfBudget('29000', '15000000');
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2, dfId });
    // c5 = 100 - 0 - 200 = -100 (col.5 pică) ȘI 200 ≤ 29000 buget. Trebuie să iasă col.5.
    const rows = [{ receptii: '100', plati_anterioare: '0', suma_ordonantata_plata: '200' }];
    const res = await request(app).post(`/api/formulare-ord/${ordId}/complete`).set('Cookie', p2()).send({ rows });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('receptii_neplatite_negative');
  });

  it('ORD fără df_id → plafon sărit (nimic de verificat) → 200', async () => {
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2 }); // df_id null
    const rows = [{ receptii: '100000', plati_anterioare: '0', suma_ordonantata_plata: '99999' }];
    const res = await request(app).post(`/api/formulare-ord/${ordId}/complete`).set('Cookie', p2()).send({ rows });
    expect(res.status).toBe(200);
    expect(res.body.document.status).toBe('completed');
  });

  it('DF cu rows_ctrl gol (col.10 = 0) → orice ordonanțare > 0 → 422', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-PLAF-0',
      rowsVal: [{ valt_actualiz: '15000000' }] }); // fără rows_ctrl → col.10 = 0
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2, dfId });
    const rows = [{ receptii: '100000', plati_anterioare: '0', suma_ordonantata_plata: '1' }];
    const res = await request(app).post(`/api/formulare-ord/${ordId}/complete`).set('Cookie', p2()).send({ rows });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('buget_an_curent_depasit');
    expect(Number(res.body.bugetAnCurent)).toBe(0);
  });

  it('STINGERE bifat: verificarea folosește col.10, NU banda rows_plati (=0)', async () => {
    // Cazul real owner: Stingere bifat → rows_plati an curent = 0, dar col.10 = 150000.
    // Ordonanțarea de 50000 trebuie PERMISĂ (pe col.10), nu blocată de banda 0.
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-STING',
      ckbxSting: '1',
      rowsVal: [{ valt_actualiz: '250000' }],
      rowsPlati: [{ plati_estim_ancrt: '0' }],
      rowsCtrl: [{ sum_rezv_crdt_bug_act: '150000' }] });
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2, dfId });
    const rows = [{ receptii: '100000', plati_anterioare: '0', suma_ordonantata_plata: '50000' }];
    const res = await request(app).post(`/api/formulare-ord/${ordId}/complete`).set('Cookie', p2()).send({ rows });
    expect(res.status).toBe(200);
    expect(res.body.document.status).toBe('completed');
  });
});
