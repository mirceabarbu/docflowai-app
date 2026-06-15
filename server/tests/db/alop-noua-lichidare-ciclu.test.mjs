/**
 * Caracterizare: POST /api/alop/:id/noua-lichidare — ciclul multi-ORD.
 * Arhivează ciclul curent în alop_ord_cicluri, incrementează ciclu_curent,
 * resetează câmpurile ORD/lichidare/plată și readuce status la 'lichidare'.
 *
 * Fotografie a comportamentului CURENT (handler alop.mjs ~1132-1253).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedAlop, seedFlowApproved, getAlop, getAlopCicluri, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('POST /api/alop/:id/noua-lichidare — ciclu multi-ORD', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await seedOrgUser({ role: 'user' }); app = buildApp(); });
  afterAll(() => pool.end());

  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  it('din status ≠ completed → 400 status_invalid', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'plata' });
    const res = await request(app).post(`/api/alop/${alopId}/noua-lichidare`).set('Cookie', cookie()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('status_invalid');
    expect((await getAlop(alopId)).status).toBe('plata');
  });

  it('din completed cu rest disponibil → arhivează ciclul, ciclu_curent++, status=lichidare', async () => {
    // FIX B (v3.9.557): ramas se calculează pe bugetul anului curent
    // (rows_plati.plati_estim_ancrt = 1000), NU pe angajamentul total (rows_val = 9M).
    // Plătit 400 → rest 600 > 0.
    const dfId = await seedDf({
      orgId: 1, createdBy: 1,
      rowsVal: [{ valt_actualiz: '9000000' }],
      rowsPlati: [{ plati_estim_ancrt: '1000' }],
    });
    const alopId = await seedAlop({
      orgId: 1, createdBy: 1, status: 'completed', dfId,
      plataSumaEfectiva: 400, cicluCurent: 1,
    });

    const res = await request(app).post(`/api/alop/${alopId}/noua-lichidare`).set('Cookie', cookie()).send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const a = await getAlop(alopId);
    expect(a.status).toBe('lichidare');
    expect(a.ciclu_curent).toBe(2);
    // câmpurile ciclului curent eliberate
    expect(a.ord_id).toBeNull();
    expect(a.ord_flow_id).toBeNull();
    expect(a.lichidare_confirmed_by).toBeNull();
    expect(a.plata_confirmed_at).toBeNull();
    expect(Number(a.suma_totala_platita)).toBe(400);

    // ciclul anterior arhivat (status 'completed', suma 400)
    const cicluri = await getAlopCicluri(alopId);
    expect(cicluri.length).toBe(1);
    expect(cicluri[0].ciclu_nr).toBe(1);
    expect(cicluri[0].status).toBe('completed');
    expect(Number(cicluri[0].plata_suma_efectiva)).toBe(400);
  });

  it('rest epuizat (ramas <= 0) → 400 limita_depasita, niciun ciclu arhivat', async () => {
    // FIX B: bugetul anului curent (1000) e epuizat de plata (1000) → limita_depasita,
    // CHIAR DACĂ angajamentul total (rows_val = 1M) mai are loc. Dovedește baza nouă de calcul.
    const dfId = await seedDf({
      orgId: 1, createdBy: 1,
      rowsVal: [{ valt_actualiz: '1000000' }],
      rowsPlati: [{ plati_estim_ancrt: '1000' }],
    });
    const alopId = await seedAlop({
      orgId: 1, createdBy: 1, status: 'completed', dfId,
      plataSumaEfectiva: 1000, cicluCurent: 1,
    });

    const res = await request(app).post(`/api/alop/${alopId}/noua-lichidare`).set('Cookie', cookie()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('limita_depasita');
    expect((await getAlop(alopId)).status).toBe('completed');
    expect((await getAlopCicluri(alopId)).length).toBe(0);
  });

  it('INVARIANT FIX B: revizie care mărește plati_estim_ancrt → noua-lichidare permite ciclu nou', async () => {
    // R0: buget an curent 1000, epuizat de plată 1000 → noua-lichidare blocată.
    const flowId = await seedFlowApproved();
    const r0Id = await seedDf({
      orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-INV-1',
      rowsVal: [{ valt_actualiz: '1000000' }],
      rowsPlati: [{ plati_estim_ancrt: '1000' }],
    });
    const alopId = await seedAlop({
      orgId: 1, createdBy: 1, status: 'completed', dfId: r0Id, dfFlowId: flowId,
      plataSumaEfectiva: 1000, cicluCurent: 1,
    });

    // Buget epuizat pe R0 → 400 limita_depasita.
    const blocat = await request(app).post(`/api/alop/${alopId}/noua-lichidare`).set('Cookie', cookie()).send({});
    expect(blocat.status).toBe(400);
    expect(blocat.body.error).toBe('limita_depasita');

    // Revizuiește DF-ul (relink ALOP completed → R1, invariant v3.9.554) și mărește bugetul.
    const rev = await request(app).post(`/api/formulare-df/${r0Id}/revizuieste`).set('Cookie', cookie()).send({ motiv: 'suplimentare buget' });
    expect(rev.status).toBe(200);
    const r1Id = rev.body.df.id;
    await pool.query(`UPDATE formulare_df SET rows_plati=$2::jsonb WHERE id=$1`,
      [r1Id, JSON.stringify([{ plati_estim_ancrt: '5000' }])]);
    expect((await getAlop(alopId)).df_id).toBe(r1Id); // relink invariant

    // Acum bugetul an curent (5000) > plătit (1000) → ramas 4000 → ciclu nou permis.
    const res = await request(app).post(`/api/alop/${alopId}/noua-lichidare`).set('Cookie', cookie()).send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Number(res.body.ramas)).toBe(4000);
    expect((await getAlop(alopId)).status).toBe('lichidare');
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
