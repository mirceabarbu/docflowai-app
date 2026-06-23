/**
 * Caracterizare: POST /api/alop/:id/noua-lichidare — ciclul multi-ORD.
 * Arhivează ciclul curent în alop_ord_cicluri, incrementează ciclu_curent,
 * resetează câmpurile ORD/lichidare/plată și readuce status la 'lichidare'.
 *
 * Fix 12 (v3.9.582): garda de buget = CREDITE BUGETARE col.10
 * (SUM(rows_ctrl.sum_rezv_crdt_bug_act)) − suma ORDONANȚATĂ a anului de exercițiu (cicluri
 * arhivate via ord_id + ORD-ul curent alop.ord_id), NU banda rows_plati, NU plățile.
 * `suma_totala_platita` rămâne suma PLĂTITĂ (audit) — separată de plafon.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedAlop, seedFlowApproved, getAlop, getAlopCicluri, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('POST /api/alop/:id/noua-lichidare — ciclu multi-ORD', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await seedOrgUser({ role: 'user' }); app = buildApp(); });
  afterAll(() => pool.end());

  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });
  // ORD curent al ALOP-ului, cu suma ordonanțată = `ordonantat` (intră în plafon via alop.ord_id).
  const seedOrdFor = (dfId, ordonantat, nr = 'ORD-CUR') => seedOrd({
    orgId: 1, createdBy: 1, status: 'completed', dfId, nrOrd: nr,
    rows: [{ suma_ordonantata_plata: String(ordonantat) }],
  });

  it('din status ≠ completed → 400 status_invalid', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'plata' });
    const res = await request(app).post(`/api/alop/${alopId}/noua-lichidare`).set('Cookie', cookie()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('status_invalid');
    expect((await getAlop(alopId)).status).toBe('plata');
  });

  it('din completed cu rest disponibil → arhivează ciclul, ciclu_curent++, status=lichidare', async () => {
    // Fix 12: ramas = col.10 (1000) − ordonanțat curent (400) = 600 > 0. NU pe banda rows_plati,
    // NU pe angajamentul total (rows_val = 9M). suma_totala_platita = plătit (400).
    const dfId = await seedDf({
      orgId: 1, createdBy: 1,
      rowsVal: [{ valt_actualiz: '9000000' }],
      rowsCtrl: [{ sum_rezv_crdt_bug_act: '1000' }],
    });
    const ordId = await seedOrdFor(dfId, 400);
    const alopId = await seedAlop({
      orgId: 1, createdBy: 1, status: 'completed', dfId, ordId,
      plataSumaEfectiva: 400, cicluCurent: 1,
    });

    const res = await request(app).post(`/api/alop/${alopId}/noua-lichidare`).set('Cookie', cookie()).send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Number(res.body.ramas)).toBe(600);

    const a = await getAlop(alopId);
    expect(a.status).toBe('lichidare');
    expect(a.ciclu_curent).toBe(2);
    expect(a.ord_id).toBeNull();
    expect(a.lichidare_confirmed_by).toBeNull();
    expect(a.plata_confirmed_at).toBeNull();
    expect(Number(a.suma_totala_platita)).toBe(400);

    const cicluri = await getAlopCicluri(alopId);
    expect(cicluri.length).toBe(1);
    expect(cicluri[0].ciclu_nr).toBe(1);
    expect(cicluri[0].status).toBe('completed');
    expect(Number(cicluri[0].plata_suma_efectiva)).toBe(400);
  });

  it('rest epuizat (ordonanțat ≥ col.10) → 400 limita_depasita, niciun ciclu arhivat', async () => {
    // Fix 12: col.10 (1000) integral ordonanțat de ORD curent (1000) → limita_depasita,
    // CHIAR DACĂ angajamentul total (rows_val = 1M) mai are loc. Dovedește baza col.10.
    const dfId = await seedDf({
      orgId: 1, createdBy: 1,
      rowsVal: [{ valt_actualiz: '1000000' }],
      rowsCtrl: [{ sum_rezv_crdt_bug_act: '1000' }],
    });
    const ordId = await seedOrdFor(dfId, 1000);
    const alopId = await seedAlop({
      orgId: 1, createdBy: 1, status: 'completed', dfId, ordId,
      plataSumaEfectiva: 1000, cicluCurent: 1,
    });

    const res = await request(app).post(`/api/alop/${alopId}/noua-lichidare`).set('Cookie', cookie()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('limita_depasita');
    expect((await getAlop(alopId)).status).toBe('completed');
    expect((await getAlopCicluri(alopId)).length).toBe(0);
  });

  it('INVARIANT: revizie care mărește col.10 → noua-lichidare permite ciclu nou', async () => {
    // R0: col.10 1000, integral ordonanțat (1000) → noua-lichidare blocată.
    const flowId = await seedFlowApproved();
    const r0Id = await seedDf({
      orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-INV-1',
      rowsVal: [{ valt_actualiz: '1000000' }],
      rowsCtrl: [{ sum_rezv_crdt_bug_act: '1000' }],
    });
    const ordId = await seedOrdFor(r0Id, 1000);
    const alopId = await seedAlop({
      orgId: 1, createdBy: 1, status: 'completed', dfId: r0Id, dfFlowId: flowId, ordId,
      plataSumaEfectiva: 1000, cicluCurent: 1,
    });

    // Buget epuizat pe R0 → 400 limita_depasita.
    const blocat = await request(app).post(`/api/alop/${alopId}/noua-lichidare`).set('Cookie', cookie()).send({});
    expect(blocat.status).toBe(400);
    expect(blocat.body.error).toBe('limita_depasita');

    // Revizuiește DF-ul (relink ALOP completed → R1, invariant v3.9.554) și mărește col.10.
    const rev = await request(app).post(`/api/formulare-df/${r0Id}/revizuieste`).set('Cookie', cookie()).send({ motiv: 'suplimentare buget' });
    expect(rev.status).toBe(200);
    const r1Id = rev.body.df.id;
    await pool.query(`UPDATE formulare_df SET rows_ctrl=$2::jsonb WHERE id=$1`,
      [r1Id, JSON.stringify([{ sum_rezv_crdt_bug_act: '5000' }])]);
    expect((await getAlop(alopId)).df_id).toBe(r1Id); // relink invariant

    // Acum col.10 (5000) − ordonanțat curent (1000) = 4000 > 0 → ciclu nou permis.
    const res = await request(app).post(`/api/alop/${alopId}/noua-lichidare`).set('Cookie', cookie()).send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Number(res.body.ramas)).toBe(4000);
    expect((await getAlop(alopId)).status).toBe('lichidare');
  });

  it('CONCURENȚĂ (P0.2): două noua-lichidare simultane → exact un ciclu arhivat', async () => {
    // col.10 5000, ordonanțat curent 1000 → ramas 4000: o singură arhivare e legitimă.
    const dfId = await seedDf({
      orgId: 1, createdBy: 1,
      rowsVal: [{ valt_actualiz: '9000000' }],
      rowsCtrl: [{ sum_rezv_crdt_bug_act: '5000' }],
    });
    const ordId = await seedOrdFor(dfId, 1000);
    const alopId = await seedAlop({
      orgId: 1, createdBy: 1, status: 'completed', dfId, ordId,
      plataSumaEfectiva: 1000, cicluCurent: 1,
    });

    const [a, b] = await Promise.all([
      request(app).post(`/api/alop/${alopId}/noua-lichidare`).set('Cookie', cookie()).send({}),
      request(app).post(`/api/alop/${alopId}/noua-lichidare`).set('Cookie', cookie()).send({}),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 400]);

    const cicluri = await getAlopCicluri(alopId);
    expect(cicluri.length).toBe(1);
    const alop = await getAlop(alopId);
    expect(alop.ciclu_curent).toBe(2);
    expect(alop.status).toBe('lichidare');
  });

  it('ALOP cancelled → 404 not_found', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, rowsVal: [{ valt_actualiz: '1000' }] });
    const alopId = await seedAlop({
      orgId: 1, createdBy: 1, status: 'completed', dfId,
      plataSumaEfectiva: 100, cicluCurent: 1, cancelledAt: new Date(),
    });
    const res = await request(app).post(`/api/alop/${alopId}/noua-lichidare`).set('Cookie', cookie()).send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });
});
