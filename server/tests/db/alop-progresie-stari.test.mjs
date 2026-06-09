/**
 * Caracterizare: progresia mașinii de stare ALOP prin rutele de tranziție.
 * draft → angajare → lichidare → ordonantare → plata → completed.
 *
 * Fotografie a comportamentului CURENT (Etapa 0-ALOP). Fiecare pas afirmă
 * status code + starea din DB (getAlop), nu ordinea apelurilor.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedFlow, getAlop, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('ALOP — progresie mașină de stare (happy path)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await seedOrgUser({ role: 'user' }); app = buildApp(); });
  afterAll(() => pool.end());

  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  it('parcurge draft → … → completed prin rutele de tranziție', async () => {
    // 1) POST /api/alop → 201, status draft
    const create = await request(app).post('/api/alop').set('Cookie', cookie())
      .send({ titlu: 'ALOP progresie' });
    expect(create.status).toBe(201);
    const id = create.body.alop.id;
    expect(create.body.alop.status).toBe('draft');

    // 2) link-df → angajare
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'draft' });
    const linkDf = await request(app).post(`/api/alop/${id}/link-df`).set('Cookie', cookie())
      .send({ df_id: dfId });
    expect(linkDf.status).toBe(200);
    expect((await getAlop(id)).status).toBe('angajare');

    // 3) link-df-flow cu un flux ÎN LUCRU (nu declanșează auto-lichidare) → df_flow_id setat, rămâne angajare
    const dfFlow = await seedFlow({ completed: false });
    const linkDfFlow = await request(app).post(`/api/alop/${id}/link-df-flow`).set('Cookie', cookie())
      .send({ flow_id: dfFlow });
    expect(linkDfFlow.status).toBe(200);
    expect((await getAlop(id)).status).toBe('angajare');
    expect((await getAlop(id)).df_flow_id).toBe(dfFlow);

    // 4) df-completed → lichidare, df_completed_at setat
    const dfDone = await request(app).post(`/api/alop/${id}/df-completed`).set('Cookie', cookie()).send({});
    expect(dfDone.status).toBe(200);
    let a = await getAlop(id);
    expect(a.status).toBe('lichidare');
    expect(a.df_completed_at).not.toBeNull();

    // 5) confirma-lichidare → ordonantare, lichidare_confirmed_by/at setate
    const conf = await request(app).post(`/api/alop/${id}/confirma-lichidare`).set('Cookie', cookie())
      .send({ observatii: 'ok', nr_factura: 'F1' });
    expect(conf.status).toBe(200);
    a = await getAlop(id);
    expect(a.status).toBe('ordonantare');
    expect(a.lichidare_confirmed_by).toBe(1);
    expect(a.lichidare_confirmed_at).not.toBeNull();

    // 5b) idempotență: din ordonantare tot 200 (WHERE status IN ('lichidare','ordonantare'))
    const conf2 = await request(app).post(`/api/alop/${id}/confirma-lichidare`).set('Cookie', cookie()).send({});
    expect(conf2.status).toBe(200);
    expect((await getAlop(id)).status).toBe('ordonantare');

    // 6) link-ord → ord_id setat, rămâne ordonantare
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'draft', dfId });
    const linkOrd = await request(app).post(`/api/alop/${id}/link-ord`).set('Cookie', cookie())
      .send({ ord_id: ordId });
    expect(linkOrd.status).toBe(200);
    a = await getAlop(id);
    expect(a.ord_id).toBe(ordId);
    expect(a.status).toBe('ordonantare');

    // 7) link-ord-flow cu flux în lucru → ord_flow_id setat
    const ordFlow = await seedFlow({ completed: false });
    const linkOrdFlow = await request(app).post(`/api/alop/${id}/link-ord-flow`).set('Cookie', cookie())
      .send({ flow_id: ordFlow });
    expect(linkOrdFlow.status).toBe(200);
    expect((await getAlop(id)).ord_flow_id).toBe(ordFlow);

    // 8) ord-completed → plata, ord_completed_at setat
    const ordDone = await request(app).post(`/api/alop/${id}/ord-completed`).set('Cookie', cookie()).send({});
    expect(ordDone.status).toBe(200);
    a = await getAlop(id);
    expect(a.status).toBe('plata');
    expect(a.ord_completed_at).not.toBeNull();

    // 9) confirma-plata → completed, plata_suma_efectiva setat (applyPlataConfirmedSideEffects)
    const plata = await request(app).post(`/api/alop/${id}/confirma-plata`).set('Cookie', cookie())
      .send({ suma_efectiva: 500, nr_ordin_plata: 'OP-1' });
    expect(plata.status).toBe(200);
    expect(plata.body.ok).toBe(true);
    a = await getAlop(id);
    expect(a.status).toBe('completed');
    expect(Number(a.plata_suma_efectiva)).toBe(500);
    expect(a.plata_confirmed_at).not.toBeNull();
  });

  it('df-completed din angajare FĂRĂ df_flow_id → 400 (gardă df_flow NOT NULL)', async () => {
    const create = await request(app).post('/api/alop').set('Cookie', cookie()).send({ titlu: 'x' });
    const id = create.body.alop.id;
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'draft' });
    await request(app).post(`/api/alop/${id}/link-df`).set('Cookie', cookie()).send({ df_id: dfId });
    // angajare, dar df_flow_id încă NULL
    const res = await request(app).post(`/api/alop/${id}/df-completed`).set('Cookie', cookie()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('df_flow_necesar_sau_status_invalid');
    expect((await getAlop(id)).status).toBe('angajare');
  });
});
