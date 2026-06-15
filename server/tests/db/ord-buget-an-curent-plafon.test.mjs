/**
 * FIX B (v3.9.557): plafon HARD la finalizarea ORD — suma ordonanțată cumulată în anul
 * curent ≤ bugetul anului curent = SUM(formulare_df.rows_plati[].plati_estim_ancrt) al
 * DF-ului legat (ord.df_id). Simetric cu validarea col.5, defense-in-depth pe backend.
 *
 * Cumulul = suma ORD-ului curent (rândurile noi) + plățile arhivate ale ciclurilor
 * anterioare (alop_ord_cicluri.plata_suma_efectiva) ale ALOP-ului legat de același DF.
 *
 * col.5 (receptii_neplatite_negative) rămâne validare SEPARATĂ și rulează ÎNAINTE.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, seedOrd, seedAlop, getOrd, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('POST /api/formulare-ord/:id/complete — plafon buget an curent (FIX B)', () => {
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

  // DF cu buget an curent 29000, dar angajament total 15M (rows_val) — plafonul e 29000.
  async function seedDfBudget(budget = '29000', total = '15000000') {
    return seedDf({
      orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-PLAF-1',
      rowsVal: [{ valt_actualiz: total }],
      rowsPlati: [{ plati_estim_ancrt: budget }],
    });
  }

  it('suma ordonanțată ≤ buget an curent → 200 completed', async () => {
    const dfId = await seedDfBudget('29000', '15000000');
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2, dfId });
    const rows = [{ receptii: '29000', plati_anterioare: '0', suma_ordonantata_plata: '29000' }]; // = buget
    const res = await request(app).post(`/api/formulare-ord/${ordId}/complete`).set('Cookie', p2()).send({ rows });
    expect(res.status).toBe(200);
    expect(res.body.document.status).toBe('completed');
    expect((await getOrd(ordId)).status).toBe('completed');
  });

  it('suma ordonanțată > buget an curent → 422 buget_an_curent_depasit (deși angajamentul total are loc)', async () => {
    const dfId = await seedDfBudget('29000', '15000000');
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2, dfId });
    // c5 = 100000 - 0 - 30000 = 70000 ≥ 0 (col.5 trece) DAR 30000 > 29000 buget an curent.
    const rows = [{ receptii: '100000', plati_anterioare: '0', suma_ordonantata_plata: '30000' }];
    const res = await request(app).post(`/api/formulare-ord/${ordId}/complete`).set('Cookie', p2()).send({ rows });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('buget_an_curent_depasit');
    expect(Number(res.body.bugetAnCurent)).toBe(29000);
    expect(Number(res.body.ordonantat)).toBe(30000);
    expect((await getOrd(ordId)).status).toBe('pending_p2'); // neschimbat
  });

  it('cumul peste cicluri arhivate (fără dublă numărare) → 422', async () => {
    const dfId = await seedDfBudget('29000', '15000000');
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2, dfId });
    // ALOP legat de același DF, cu un ciclu arhivat de 20000.
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId });
    await pool.query(
      `INSERT INTO alop_ord_cicluri (alop_id, org_id, ciclu_nr, plata_suma_efectiva, status)
       VALUES ($1, 1, 1, 20000, 'completed')`,
      [alopId]
    );
    // ORD nou de 10000 → cumul 20000 + 10000 = 30000 > 29000 → 422.
    const rows = [{ receptii: '100000', plati_anterioare: '0', suma_ordonantata_plata: '10000' }];
    const res = await request(app).post(`/api/formulare-ord/${ordId}/complete`).set('Cookie', p2()).send({ rows });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('buget_an_curent_depasit');
    expect(Number(res.body.ordonantat)).toBe(30000);
  });

  it('cumul exact pe buget (ciclu arhivat + ORD nou = buget) → 200', async () => {
    const dfId = await seedDfBudget('29000', '15000000');
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2, dfId });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId });
    await pool.query(
      `INSERT INTO alop_ord_cicluri (alop_id, org_id, ciclu_nr, plata_suma_efectiva, status)
       VALUES ($1, 1, 1, 20000, 'completed')`,
      [alopId]
    );
    const rows = [{ receptii: '100000', plati_anterioare: '0', suma_ordonantata_plata: '9000' }]; // 20000+9000=29000
    const res = await request(app).post(`/api/formulare-ord/${ordId}/complete`).set('Cookie', p2()).send({ rows });
    expect(res.status).toBe(200);
    expect(res.body.document.status).toBe('completed');
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

  it('DF cu rows_plati gol (buget 0) → orice ordonanțare > 0 → 422', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-PLAF-0',
      rowsVal: [{ valt_actualiz: '15000000' }] }); // fără rows_plati → buget 0
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2, dfId });
    const rows = [{ receptii: '100000', plati_anterioare: '0', suma_ordonantata_plata: '1' }];
    const res = await request(app).post(`/api/formulare-ord/${ordId}/complete`).set('Cookie', p2()).send({ rows });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('buget_an_curent_depasit');
    expect(Number(res.body.bugetAnCurent)).toBe(0);
  });
});
