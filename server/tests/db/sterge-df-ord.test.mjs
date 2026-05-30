import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedAlop, seedFlowApproved,
         getAlop, getDf, getOrd, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('POST /api/formulare-*/:id/sterge (caracterizare)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await seedOrgUser({ role: 'user' }); app = buildApp(); });
  afterAll(() => pool.end());
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  it('ORD pe flux → 409 cannot_delete_on_flow, rândul rămâne', async () => {
    const flowId = await seedFlowApproved();
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, flowId });
    const res = await request(app).post(`/api/formulare-ord/${ordId}/sterge`).set('Cookie', cookie());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cannot_delete_on_flow');
    expect((await getOrd(ordId)).deleted_at).toBeNull();
  });

  it('ORD fără flux → 200, deleted_at setat, ALOP.ord_id eliberat', async () => {
    const ordId = await seedOrd({ orgId: 1, createdBy: 1 });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', ordId });
    const res = await request(app).post(`/api/formulare-ord/${ordId}/sterge`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect((await getOrd(ordId)).deleted_at).not.toBeNull();
    expect((await getAlop(alopId)).ord_id).toBeNull();
  });

  it('DF cu ORD legată → 409 cannot_delete_has_ord', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1 });
    await seedOrd({ orgId: 1, createdBy: 1, dfId });
    const res = await request(app).post(`/api/formulare-df/${dfId}/sterge`).set('Cookie', cookie());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cannot_delete_has_ord');
  });

  it('DF R0 fără flux/ORD → 200, ALOP.df_id eliberat (NULL)', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', revizieNr: 0 });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, dfId });
    const res = await request(app).post(`/api/formulare-df/${dfId}/sterge`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect((await getDf(dfId)).deleted_at).not.toBeNull();
    expect((await getAlop(alopId)).df_id).toBeNull();
  });

  it('DF R1 (revizie) draft → restore ALOP la parent aprobat', async () => {
    const parentFlow = await seedFlowApproved();
    const parentId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId: parentFlow, revizieNr: 0, nrUnic: 'DF-2026-009' });
    const revId = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', revizieNr: 1, parentDfId: parentId, nrUnic: 'DF-2026-009' });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, dfId: revId }); // ALOP pointează la revizie (ca după revizuieste)
    const res = await request(app).post(`/api/formulare-df/${revId}/sterge`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    const a = await getAlop(alopId);
    expect(a.df_id).toBe(parentId);
    expect(a.df_flow_id).toBe(parentFlow);
  });

  it('DF pe flux → 409 cannot_delete_on_flow', async () => {
    const flowId = await seedFlowApproved();
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'transmis_flux', flowId });
    const res = await request(app).post(`/api/formulare-df/${dfId}/sterge`).set('Cookie', cookie());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cannot_delete_on_flow');
  });
});
