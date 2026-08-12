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
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', compartiment: 'CAB' });
    // #126 B: confirmarea MANUALĂ a plății cere actor din compartimentul CAB al
    // organizației (separare de atribuții, fail-closed dacă CAB nu e configurat).
    await pool.query("UPDATE organizations SET cab_compartiment='CAB' WHERE id=1");
    app = buildApp();
  });
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

    // 3) link-df-flow cu un flux ÎN LUCRU (nu declanșează auto-lichidare) → df_flow_id setat, rămâne angajare.
    //    P0-03: fluxul trebuie să fie al aceleiași organizații ȘI să revendice DF-ul (meta.dfId).
    const dfFlow = await seedFlow({ completed: false, orgId: 1, meta: { dfId: String(dfId) } });
    const linkDfFlow = await request(app).post(`/api/alop/${id}/link-df-flow`).set('Cookie', cookie())
      .send({ flow_id: dfFlow });
    expect(linkDfFlow.status).toBe(200);
    expect((await getAlop(id)).status).toBe('angajare');
    expect((await getAlop(id)).df_flow_id).toBe(dfFlow);

    // 4a) df-completed cu fluxul ÎNCĂ NESEMNAT → 409, dosarul NU avansează (poarta P0-03).
    //     Premisa veche a testului („pointer non-NULL = destul") era exact gaura reparată.
    const dfPrea = await request(app).post(`/api/alop/${id}/df-completed`).set('Cookie', cookie()).send({});
    expect(dfPrea.status).toBe(409);
    expect(dfPrea.body.error).toBe('document_nesemnat');
    expect((await getAlop(id)).status).toBe('angajare');

    // 4b) fluxul devine semnat → df-completed → lichidare, df_completed_at setat
    await pool.query(
      `UPDATE flows SET data = data || '{"status":"completed","completed":true}'::jsonb WHERE id=$1`,
      [dfFlow]
    );
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

    // 7) link-ord-flow cu flux în lucru (org + meta.ordId corecte) → ord_flow_id setat
    const ordFlow = await seedFlow({ completed: false, orgId: 1, meta: { ordId: String(ordId) } });
    const linkOrdFlow = await request(app).post(`/api/alop/${id}/link-ord-flow`).set('Cookie', cookie())
      .send({ flow_id: ordFlow });
    expect(linkOrdFlow.status).toBe(200);
    expect((await getAlop(id)).ord_flow_id).toBe(ordFlow);

    // 8a) ord-completed cu fluxul ÎNCĂ NESEMNAT → 409, dosarul rămâne în ordonantare.
    const ordPrea = await request(app).post(`/api/alop/${id}/ord-completed`).set('Cookie', cookie()).send({});
    expect(ordPrea.status).toBe(409);
    expect(ordPrea.body.error).toBe('document_nesemnat');
    expect((await getAlop(id)).status).toBe('ordonantare');

    // 8b) fluxul devine semnat → ord-completed → plata, ord_completed_at setat
    await pool.query(
      `UPDATE flows SET data = data || '{"status":"completed","completed":true}'::jsonb WHERE id=$1`,
      [ordFlow]
    );
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
    // angajare, dar df_flow_id încă NULL. Rămâne 400, dar codul e acum al porții P0-03
    // (`flux_lipsa`), care refuză ÎNAINTE de UPDATE — garda `AND df_flow_id IS NOT NULL`
    // din UPDATE rămâne pe loc ca a doua apărare.
    const res = await request(app).post(`/api/alop/${id}/df-completed`).set('Cookie', cookie()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('flux_lipsa');
    expect((await getAlop(id)).status).toBe('angajare');
  });
});
