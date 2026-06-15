/**
 * FIX A (afișare, v3.9.556): cardul ALOP expune `df_buget_an_curent` =
 * SUM(formulare_df.rows_plati[].plati_estim_ancrt) al DF-ului activ (alop.df_id),
 * alături de `df_valoare` = SUM(rows_val[].valt_actualiz) — angajamentul total.
 *
 * Doar afișare: df_valoare rămâne neschimbat (caracterizare).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedAlop, seedFlowApproved, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('ALOP — df_buget_an_curent (FIX A, v3.9.556)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await seedOrgUser({ role: 'user' }); app = buildApp(); });
  afterAll(() => pool.end());
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  it('GET /api/alop/:id → df_buget_an_curent = SUM(rows_plati.plati_estim_ancrt), df_valoare neschimbat', async () => {
    const flowId = await seedFlowApproved();
    const dfId = await seedDf({
      orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-BAC-1',
      rowsVal: [{ valt_actualiz: '15000000' }],
      rowsPlati: [{ plati_estim_ancrt: '20000' }, { plati_estim_ancrt: '9000' }],
    });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId, dfFlowId: flowId });

    const res = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(Number(res.body.alop.df_buget_an_curent)).toBe(29000);
    expect(Number(res.body.alop.df_valoare)).toBe(15000000);
  });

  it('rows_plati gol/absent → df_buget_an_curent = 0, fără eroare', async () => {
    const flowId = await seedFlowApproved();
    const dfId = await seedDf({
      orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-BAC-2',
      rowsVal: [{ valt_actualiz: '1000' }],
    });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId, dfFlowId: flowId });

    const res = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(Number(res.body.alop.df_buget_an_curent)).toBe(0);
  });

  it('ALOP fără DF legat → df_buget_an_curent = 0', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft' });
    const res = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(Number(res.body.alop.df_buget_an_curent)).toBe(0);
  });

  it('GET /api/alop (listă) → df_buget_an_curent expus pe rânduri', async () => {
    const flowId = await seedFlowApproved();
    const dfId = await seedDf({
      orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-BAC-3',
      rowsPlati: [{ plati_estim_ancrt: '5000' }],
    });
    await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId, dfFlowId: flowId });

    const res = await request(app).get('/api/alop').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(Number(res.body.alop[0].df_buget_an_curent)).toBe(5000);
  });

  it('revizie cu rows_plati diferit → df_buget_an_curent reflectă revizia activă (alop.df_id)', async () => {
    const flowId = await seedFlowApproved();
    const r0Id = await seedDf({
      orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-BAC-4',
      rowsVal: [{ valt_actualiz: '1000' }],
      rowsPlati: [{ plati_estim_ancrt: '100' }],
    });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId: r0Id, dfFlowId: flowId });

    const rev = await request(app).post(`/api/formulare-df/${r0Id}/revizuieste`).set('Cookie', cookie()).send({ motiv: 'suplimentare' });
    expect(rev.status).toBe(200);
    const r1Id = rev.body.df.id;

    // Revizia copiază rows_plati din părinte (100) — simulăm o valoare nouă pe revizie (300)
    await pool.query(`UPDATE formulare_df SET rows_plati=$2::jsonb WHERE id=$1`, [r1Id, JSON.stringify([{ plati_estim_ancrt: '300' }])]);

    const res = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.alop.df_id).toBe(r1Id);                 // relink invariant (v3.9.554)
    expect(Number(res.body.alop.df_buget_an_curent)).toBe(300); // reflectă R1, nu R0 (100)
  });
});
