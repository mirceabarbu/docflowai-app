/**
 * Regresie (FIX 5): ORD relansat pe al doilea flux cât primul e activ → ord_flow_id zombi pe ALOP.
 * Paritate exactă cu df-zombie-flow.test.mjs.
 *
 * Acoperă:
 *  (1) POST formulare-ord/:id/link-flow refuză al doilea flux pe un ORD cu flux NON-terminal
 *      (409 ord_already_on_active_flow); relansarea e permisă după ce fluxul curent e cancelled,
 *      iar ord_flow_id-ul din ALOP e resincronizat la fluxul nou.
 *  (2) GET /api/alop/:id calculează ord_aprobat din fluxul AUTORITAR (formulare_ord.flow_id),
 *      avansează ALOP la 'plata' ȘI resincronizează ord_flow_id (din fluxul zombi).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedAlop, seedFlowApproved, getAlop, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

async function seedFlowActive(id = `flow-active-${Date.now()}-${Math.random().toString(36).slice(2,8)}`) {
  await pool.query(`INSERT INTO flows (id, data) VALUES ($1, $2::jsonb)`,
    [id, JSON.stringify({ status: 'in_progress' })]);
  return id;
}

d('ORD zombie-flow prevenție + robustețe ALOP (FIX 5)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await seedOrgUser({ role: 'user' }); app = buildApp(); });
  afterAll(() => pool.end());
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  it('(1) link-flow al doilea flux pe ORD cu flux activ → 409; permis după cancel + resync ord_flow_id', async () => {
    const flowActiv = await seedFlowActive();
    // ORD completed dar cu un flux activ deja agățat
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId: flowActiv });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', ordId, ordFlowId: flowActiv });

    const flowNou = await seedFlowActive();
    const r1 = await request(app)
      .post(`/api/formulare-ord/${ordId}/link-flow`)
      .set('Cookie', cookie())
      .send({ flow_id: flowNou });
    expect(r1.status).toBe(409);
    expect(r1.body.error).toBe('ord_already_on_active_flow');

    // Anulează fluxul curent → relansarea devine permisă
    await pool.query(`UPDATE flows SET data = jsonb_set(data, '{status}', '"cancelled"') WHERE id=$1`, [flowActiv]);
    const r2 = await request(app)
      .post(`/api/formulare-ord/${ordId}/link-flow`)
      .set('Cookie', cookie())
      .send({ flow_id: flowNou });
    expect(r2.status).toBe(200);

    const { rows } = await pool.query(`SELECT flow_id FROM formulare_ord WHERE id=$1`, [ordId]);
    expect(rows[0].flow_id).toBe(flowNou);
    // Paritate cu DF: ord_flow_id sincronizat în ALOP
    const a = await getAlop(alopId);
    expect(a.ord_flow_id).toBe(flowNou);
  });

  it('(2) ALOP cu ord_flow_id pe flux ne-finalizat + ORD.flow_id pe flux completed → plata + resync', async () => {
    const flowZombi = await seedFlowActive();          // pointerul vechi de pe ALOP
    const flowAprobat = await seedFlowApproved();      // fluxul autoritar al ORD-ului
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId: await seedFlowApproved() });
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId: flowAprobat, dfId });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', dfId, ordId, ordFlowId: flowZombi });

    const res = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.alop.ord_aprobat).toBe(true);
    expect(res.body.alop.status).toBe('plata');

    const a = await getAlop(alopId);
    expect(a.status).toBe('plata');
    expect(a.ord_flow_id).toBe(flowAprobat); // resincronizat din zombi
  });
});
