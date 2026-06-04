/**
 * Regresie: DF relansat pe al doilea flux cât primul e activ → df_flow_id zombi pe ALOP.
 *
 * Acoperă:
 *  (1) POST link-flow refuză al doilea flux pe un DF cu flux NON-terminal (409
 *      df_already_on_active_flow); relansarea e permisă după ce fluxul curent e cancelled.
 *  (2) GET /api/alop/:id calculează df_aprobat din fluxul AUTORITAR (formulare_df.flow_id),
 *      avansează ALOP la 'lichidare' ȘI resincronizează df_flow_id (din fluxul zombi).
 *  (3) can_generate_or_launch=false când DF e pe un flux activ (flux agățat).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedAlop, seedFlowApproved, getAlop, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

// flux NON-terminal (nici completed, nici cancelled)
async function seedFlowActive(id = `flow-active-${Date.now()}-${Math.random().toString(36).slice(2,8)}`) {
  await pool.query(`INSERT INTO flows (id, data) VALUES ($1, $2::jsonb)`,
    [id, JSON.stringify({ status: 'in_progress' })]);
  return id;
}
async function seedFlowCancelled(id = `flow-cancel-${Date.now()}-${Math.random().toString(36).slice(2,8)}`) {
  await pool.query(`INSERT INTO flows (id, data) VALUES ($1, $2::jsonb)`,
    [id, JSON.stringify({ status: 'cancelled' })]);
  return id;
}

d('DF zombie-flow prevenție + robustețe ALOP', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await seedOrgUser({ role: 'user' }); app = buildApp(); });
  afterAll(() => pool.end());
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  it('(1) link-flow al doilea flux pe DF cu flux activ → 409; permis după cancel', async () => {
    const flowActiv = await seedFlowActive();
    // DF completed dar cu un flux activ deja agățat (cazul lingering)
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', flowId: flowActiv });

    const flowNou = await seedFlowActive();
    const r1 = await request(app)
      .post(`/api/formulare-df/${dfId}/link-flow`)
      .set('Cookie', cookie())
      .send({ flow_id: flowNou });
    expect(r1.status).toBe(409);
    expect(r1.body.error).toBe('df_already_on_active_flow');

    // Anulează fluxul curent → relansarea devine permisă
    await pool.query(`UPDATE flows SET data = jsonb_set(data, '{status}', '"cancelled"') WHERE id=$1`, [flowActiv]);
    const r2 = await request(app)
      .post(`/api/formulare-df/${dfId}/link-flow`)
      .set('Cookie', cookie())
      .send({ flow_id: flowNou });
    expect(r2.status).toBe(200);
    const { rows } = await pool.query(`SELECT flow_id, status FROM formulare_df WHERE id=$1`, [dfId]);
    expect(rows[0].flow_id).toBe(flowNou);
    expect(rows[0].status).toBe('transmis_flux');
  });

  it('(2) ALOP cu df_flow_id pe flux ne-finalizat + DF.flow_id pe flux completed → lichidare + resync', async () => {
    const flowZombi = await seedFlowActive();          // pointerul vechi de pe ALOP
    const flowAprobat = await seedFlowApproved();      // fluxul autoritar al DF-ului
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'transmis_flux', flowId: flowAprobat });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', dfId, dfFlowId: flowZombi });

    const res = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.alop.df_aprobat).toBe(true);
    expect(res.body.alop.status).toBe('lichidare');

    const a = await getAlop(alopId);
    expect(a.status).toBe('lichidare');
    expect(a.df_flow_id).toBe(flowAprobat); // resincronizat din zombi
  });

  it('(2b) fără resync inutil când df_flow_id == DF.flow_id', async () => {
    const flowAprobat = await seedFlowApproved();
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'transmis_flux', flowId: flowAprobat });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', dfId, dfFlowId: flowAprobat });

    const res = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.alop.status).toBe('lichidare');
    const a = await getAlop(alopId);
    expect(a.df_flow_id).toBe(flowAprobat);
  });

  it('(3) can_generate_or_launch=false când DF e pe flux activ', async () => {
    const flowActiv = await seedFlowActive();
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', flowId: flowActiv });
    const res = await request(app).get(`/api/formulare-df/${dfId}`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    const c = res.body.document.capabilities;
    expect(c.can_generate_or_launch).toBe(false);
    expect(c.is_on_flow).toBe(true);
    expect(res.body.document.flow_active).toBe(true);
  });
});
