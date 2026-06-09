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
         seedOrgUser, seedDf, seedAlop, getAlop, getAlopCicluri, makeAuthCookie } from '../helpers/db-real.mjs';
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
    // DF aprobat valoare 1000, plătit 400 → rest 600 > 0
    const dfId = await seedDf({ orgId: 1, createdBy: 1, rowsVal: [{ valt_actualiz: '1000' }] });
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
    const dfId = await seedDf({ orgId: 1, createdBy: 1, rowsVal: [{ valt_actualiz: '1000' }] });
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
