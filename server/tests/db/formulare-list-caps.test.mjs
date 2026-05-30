import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedFlowApproved, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('GET /api/formulare/list — capabilities (caracterizare)', () => {
  let app, orgId, userId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    ({ orgId, userId } = await seedOrgUser({ role: 'org_admin' }));
    app = buildApp();
  });
  afterAll(() => pool.end());

  const cookie = () => makeAuthCookie({ userId: 1, role: 'org_admin', orgId: 1 });
  // după TRUNCATE RESTART IDENTITY, prima org+user au id=1

  it('DF draft fără flux → can_delete=true, aprobat=false', async () => {
    await seedDf({ orgId, createdBy: userId, status: 'draft' });
    const res = await request(app).get('/api/formulare/list?type=df').set('Cookie', cookie());
    expect(res.status).toBe(200);
    const row = res.body.rows[0];
    expect(row.can_delete).toBe(true);
    expect(row.aprobat).toBe(false);
  });

  it('DF pe flux (flow_id setat) → can_delete=false', async () => {
    const flowId = await seedFlowApproved();
    await seedDf({ orgId, createdBy: userId, status: 'transmis_flux', flowId });
    const res = await request(app).get('/api/formulare/list?type=df').set('Cookie', cookie());
    expect(res.body.rows[0].can_delete).toBe(false);
  });

  it('DF aprobat → aprobat=true, can_delete=false', async () => {
    const flowId = await seedFlowApproved();
    await seedDf({ orgId, createdBy: userId, status: 'aprobat', flowId });
    const res = await request(app).get('/api/formulare/list?type=df').set('Cookie', cookie());
    const row = res.body.rows[0];
    expect(row.aprobat).toBe(true);
    expect(row.can_delete).toBe(false);
  });

  it('DF draft cu ORD legată → can_delete=false', async () => {
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'draft' });
    await seedOrd({ orgId, createdBy: userId, status: 'draft', dfId });
    const res = await request(app).get('/api/formulare/list?type=df').set('Cookie', cookie());
    expect(res.body.rows[0].can_delete).toBe(false);
  });

  it('ORD draft fără flux → can_delete=true; ORD pe flux → can_delete=false', async () => {
    await seedOrd({ orgId, createdBy: userId, status: 'draft' });
    const r1 = await request(app).get('/api/formulare/list?type=ord').set('Cookie', cookie());
    expect(r1.body.rows[0].can_delete).toBe(true);

    await truncateAll();
    await seedOrgUser({ role: 'org_admin' });
    const flowId = await seedFlowApproved();
    await seedOrd({ orgId: 1, createdBy: 1, status: 'transmis_flux', flowId });
    const r2 = await request(app).get('/api/formulare/list?type=ord').set('Cookie', cookie());
    expect(r2.body.rows[0].can_delete).toBe(false);
  });
});
