import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedFlowApproved, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('GET /api/formulare/list — flow_viu (#208)', () => {
  let app, orgId, userId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    ({ orgId, userId } = await seedOrgUser({ role: 'org_admin' }));
    app = buildApp();
  });
  afterAll(() => pool.end());

  const cookie = () => makeAuthCookie({ userId: 1, role: 'org_admin', orgId: 1 });

  it('DF cu flux viu → flow_id prezent, flow_viu=true', async () => {
    const flowId = await seedFlowApproved();
    await seedDf({ orgId, createdBy: userId, status: 'transmis_flux', flowId });
    const res = await request(app).get('/api/formulare/list?type=df').set('Cookie', cookie());
    expect(res.status).toBe(200);
    const row = res.body.rows[0];
    expect(row.flow_id).toBe(flowId);
    expect(row.flow_viu).toBe(true);
  });

  it('DF cu flux ȘTERS (deleted_at) → flow_viu=false', async () => {
    const flowId = await seedFlowApproved();
    await pool.query(`UPDATE flows SET deleted_at = now() WHERE id = $1`, [flowId]);
    await seedDf({ orgId, createdBy: userId, status: 'transmis_flux', flowId });
    const res = await request(app).get('/api/formulare/list?type=df').set('Cookie', cookie());
    expect(res.body.rows[0].flow_viu).toBe(false);
  });

  it('DF cu flux ANULAT (status=cancelled, deleted_at NULL) → flow_viu=true', async () => {
    const flowId = await seedFlowApproved();
    await pool.query(
      `UPDATE flows SET data = jsonb_set(data, '{status}', '"cancelled"') WHERE id = $1`,
      [flowId]
    );
    await seedDf({ orgId, createdBy: userId, status: 'transmis_flux', flowId });
    const res = await request(app).get('/api/formulare/list?type=df').set('Cookie', cookie());
    expect(res.body.rows[0].flow_viu).toBe(true);
  });

  it('DF fără flux (flow_id NULL) → flow_viu=false', async () => {
    await seedDf({ orgId, createdBy: userId, status: 'draft' });
    const res = await request(app).get('/api/formulare/list?type=df').set('Cookie', cookie());
    expect(res.body.rows[0].flow_id).toBeNull();
    expect(res.body.rows[0].flow_viu).toBe(false);
  });

  it('ORD cu flux viu → flow_id prezent, flow_viu=true', async () => {
    const flowId = await seedFlowApproved();
    await seedOrd({ orgId, createdBy: userId, status: 'transmis_flux', flowId });
    const res = await request(app).get('/api/formulare/list?type=ord').set('Cookie', cookie());
    expect(res.body.rows[0].flow_id).toBe(flowId);
    expect(res.body.rows[0].flow_viu).toBe(true);
  });

  it('ORD cu flux ȘTERS → flow_viu=false', async () => {
    const flowId = await seedFlowApproved();
    await pool.query(`UPDATE flows SET deleted_at = now() WHERE id = $1`, [flowId]);
    await seedOrd({ orgId, createdBy: userId, status: 'transmis_flux', flowId });
    const res = await request(app).get('/api/formulare/list?type=ord').set('Cookie', cookie());
    expect(res.body.rows[0].flow_viu).toBe(false);
  });

  it('ORD cu flux ANULAT → flow_viu=true', async () => {
    const flowId = await seedFlowApproved();
    await pool.query(
      `UPDATE flows SET data = jsonb_set(data, '{status}', '"cancelled"') WHERE id = $1`,
      [flowId]
    );
    await seedOrd({ orgId, createdBy: userId, status: 'transmis_flux', flowId });
    const res = await request(app).get('/api/formulare/list?type=ord').set('Cookie', cookie());
    expect(res.body.rows[0].flow_viu).toBe(true);
  });

  it('ORD fără flux → flow_viu=false', async () => {
    await seedOrd({ orgId, createdBy: userId, status: 'draft' });
    const res = await request(app).get('/api/formulare/list?type=ord').set('Cookie', cookie());
    expect(res.body.rows[0].flow_id).toBeNull();
    expect(res.body.rows[0].flow_viu).toBe(false);
  });

  it('neregresie — badge_status și numărul total de rânduri identice cu înainte de lot', async () => {
    const flowId = await seedFlowApproved();
    await seedDf({ orgId, createdBy: userId, status: 'aprobat', flowId });
    await seedDf({ orgId, createdBy: userId, status: 'draft', nrUnic: 'DF-2026-002' });
    const res = await request(app).get('/api/formulare/list?type=df').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    const statuses = res.body.rows.map(r => r.badge_status).sort();
    expect(statuses).toEqual(['aprobat', 'draft']);
  });
});
