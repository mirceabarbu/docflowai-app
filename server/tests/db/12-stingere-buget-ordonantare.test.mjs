/**
 * Fix 12 (v3.9.582) — cazul REAL owner: bifa „Stingere" rupea bugetul.
 *
 * DF cu „Stingere" bifat (ckbx_sting_ang_in_ancrt='1'):
 *   • col.10 (rows_ctrl.sum_rezv_crdt_bug_act) = 150.000  → PLAFONUL de ordonanțare
 *   • banda rows_plati an curent = 0                       → (irelevantă pentru verificare)
 *   • valoare_totala (tabel 1, SUM rows_val.valt_actualiz) = 250.000 → CARDUL „buget exercițiu"
 *
 * Reguli verificate:
 *   (A) VERIFICAREA ordonanțării = col.10 (150.000) − ordonanțări anterioare, INDIFERENT de bifă.
 *   (B) CARDUL „buget exercițiu" = tabel 1 (250.000) la Stingere; banda rows_plati altfel.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, seedOrd, seedAlop, getOrd, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());
const CUR = new Date().getFullYear();

d('Fix 12 — bifa Stingere: verificare pe col.10, card pe tabel 1', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' }); // id 1
    await seedUser({ orgId: 1, email: 'p2@x.ro' });          // id 2
    app = buildApp();
  });
  afterAll(() => pool.end());
  const p2 = () => makeAuthCookie({ userId: 2, role: 'user', orgId: 1 });
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  // DF Stingere: col.10=150.000, rows_plati an curent=0, valoare_totala=250.000.
  const seedDfStingere = () => seedDf({
    orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-STING-REAL', ckbxSting: '1',
    rowsVal: [{ valt_actualiz: '250000' }],
    rowsPlati: [{ plati_estim_ancrt: '0' }],
    rowsCtrl: [{ sum_rezv_crdt_bug_act: '150000' }],
  });

  it('(A) ordonanțare 50.000 ≤ col.10 (150.000) → PERMISĂ', async () => {
    const dfId = await seedDfStingere();
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2, dfId });
    const rows = [{ receptii: '50000', plati_anterioare: '0', suma_ordonantata_plata: '50000' }];
    const res = await request(app).post(`/api/formulare-ord/${ordId}/complete`).set('Cookie', p2()).send({ rows });
    expect(res.status).toBe(200);
    expect((await getOrd(ordId)).status).toBe('completed');
  });

  it('(A) a doua ordonanțare 120.000 cu 50.000 deja ordonanțați → BLOCATĂ (rămas 100.000)', async () => {
    const dfId = await seedDfStingere();
    // Ciclu arhivat ordonanțat 50.000 (anul curent) pe un ALOP al aceluiași DF.
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId });
    const ordCiclu = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', dfId,
      nrOrd: 'ORD-CIC-50', rows: [{ suma_ordonantata_plata: '50000' }] });
    await pool.query(
      `INSERT INTO alop_ord_cicluri (alop_id, org_id, ciclu_nr, ord_id, an_exercitiu, status)
       VALUES ($1, 1, 1, $2, $3, 'completed')`, [alopId, ordCiclu, CUR]);
    // ORD nou 120.000 → cumul 50.000 + 120.000 = 170.000 > 150.000 → 422.
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2, dfId });
    const rows = [{ receptii: '120000', plati_anterioare: '0', suma_ordonantata_plata: '120000' }];
    const res = await request(app).post(`/api/formulare-ord/${ordId}/complete`).set('Cookie', p2()).send({ rows });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('buget_an_curent_depasit');
    expect(Number(res.body.bugetAnCurent)).toBe(150000);
    expect(Number(res.body.ordonantat)).toBe(170000);
  });

  it('(B) cardul ALOP: df_buget_an_curent = 250.000 (tabel 1), nu 0', async () => {
    const dfId = await seedDfStingere();
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId });
    const res = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(Number(res.body.alop.df_buget_an_curent)).toBe(250000);
    expect(res.body.alop.df_stingere).toBe(true);
  });

  it('(B) cardul în listă: df_buget_an_curent = 250.000 + df_stingere=true', async () => {
    const dfId = await seedDfStingere();
    await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId });
    const res = await request(app).get('/api/alop').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(Number(res.body.alop[0].df_buget_an_curent)).toBe(250000);
    expect(res.body.alop[0].df_stingere).toBe(true);
  });

  it('NON-REGRESIE fără Stingere: card pe banda rows_plati, verificare tot pe col.10', async () => {
    // Fără Stingere: rows_plati an curent = 29.000 (card), col.10 = 10.000 (verificare).
    const dfId = await seedDf({
      orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-NOSTING',
      rowsVal: [{ valt_actualiz: '250000' }],
      rowsPlati: [{ plati_estim_ancrt: '29000' }],
      rowsCtrl: [{ sum_rezv_crdt_bug_act: '10000' }],
    });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId });
    // Card = banda rows_plati (29.000), NU col.10, NU tabel 1.
    const cardRes = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie());
    expect(Number(cardRes.body.alop.df_buget_an_curent)).toBe(29000);
    expect(cardRes.body.alop.df_stingere).toBe(false);
    // Verificare = col.10 (10.000): 15.000 > 10.000 → 422.
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2, dfId });
    const rows = [{ receptii: '100000', plati_anterioare: '0', suma_ordonantata_plata: '15000' }];
    const res = await request(app).post(`/api/formulare-ord/${ordId}/complete`).set('Cookie', p2()).send({ rows });
    expect(res.status).toBe(422);
    expect(Number(res.body.bugetAnCurent)).toBe(10000);
  });
});
