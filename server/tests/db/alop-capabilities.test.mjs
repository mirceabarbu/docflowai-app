import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedAlop, seedFlowApproved, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('GET /api/alop/:id → alop.capabilities (caracterizare)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await seedOrgUser({ role: 'user' }); app = buildApp(); });
  afterAll(() => pool.end());
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  it('ALOP draft fără DF/ORD → df_action=completeaza, can_delete=true', async () => {
    const id = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft' });
    const res = await request(app).get(`/api/alop/${id}`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    const c = res.body.alop.capabilities;
    expect(c).toBeTruthy();
    expect(c.df_action).toBe('completeaza');
    expect(c.can_delete).toBe(true);
    expect(c.can_refresh).toBe(true);
  });

  it('ALOP lichidare cu DF aprobat → confirma_lichidare + can_revise_df + df_action=null (FIX 4) + can_delete=false', async () => {
    const fid = await seedFlowApproved();
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId: fid });
    const id = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId, dfFlowId: fid });
    const res = await request(app).get(`/api/alop/${id}`).set('Cookie', cookie());
    const c = res.body.alop.capabilities;
    expect(c.phase_action).toBe('confirma_lichidare');
    expect(c.can_revise_df).toBe(true);
    // FIX 4: niciun buton DF în zona de acțiuni post-angajare
    expect(c.df_action).toBeNull();
    expect(c.can_delete).toBe(false);
  });

  it('ALOP ordonantare fără ORD → completeaza_ord', async () => {
    const fid = await seedFlowApproved();
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId: fid });
    const id = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', dfId, dfFlowId: fid });
    const res = await request(app).get(`/api/alop/${id}`).set('Cookie', cookie());
    expect(res.body.alop.capabilities.phase_action).toBe('completeaza_ord');
  });

  it('ALOP plata → confirma_plata', async () => {
    const fid = await seedFlowApproved();
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId: fid });
    const id = await seedAlop({ orgId: 1, createdBy: 1, status: 'plata', dfId, dfFlowId: fid, ordId: null });
    const res = await request(app).get(`/api/alop/${id}`).set('Cookie', cookie());
    const c = res.body.alop.capabilities;
    expect(c.phase_action).toBe('confirma_plata');
    // FIX 4 + FIX 6: niciun buton DF primar, dar „Revizuiește DF" rămâne disponibil în plată
    expect(c.df_action).toBeNull();
    expect(c.can_revise_df).toBe(true);
  });

  it('lista → can_delete pe rânduri active fără DF/ORD', async () => {
    await seedAlop({ orgId: 1, createdBy: 1, status: 'draft' });
    const res = await request(app).get('/api/alop').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.alop[0].can_delete).toBe(true);
  });
});
