/**
 * DB caracterizare — fix afișare (prompt 76): un flux DF REFUZAT
 * (`data.status='refused'`) nu mai trebuie considerat „activ" în derivarea
 * `df_flow_active` → ALOP la `angajare` nu mai arată „Pe flux — semnare".
 *
 * DOAR AFIȘARE (read-only): `df_flow_active` e derivat din starea reală a
 * fluxului, fără backfill. Complement la #74 (handler-ul de refuz).
 *
 * Cazuri:
 *  (1) flux refuzat → df_flow_active=false (listă + detaliu)
 *  (2) sanity non-regresie: flux activ (nici completed/cancelled/refused) → df_flow_active=true
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedAlop, seedFlow, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

async function setFlowStatus(id, status) {
  await pool.query(
    `UPDATE flows SET data = jsonb_set(data, '{status}', to_jsonb($2::text)) WHERE id=$1`,
    [id, status]
  );
}

d('ALOP display — flux DF refuzat nu mai apare „Pe flux" (prompt 76)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' }); // user 1, org 1
    app = buildApp();
  });
  afterAll(() => pool.end());
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1, email: 'p1@x.ro' });

  it('1. flux refuzat → df_flow_active=false (listă + detaliu)', async () => {
    const df = await seedDf({ orgId: 1, createdBy: 1, status: 'transmis_flux', nrUnic: 'DF-RF-1' });
    const flowId = await seedFlow({ completed: false });
    await setFlowStatus(flowId, 'refused');
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', dfId: df, dfFlowId: flowId });

    const list = await request(app).get('/api/alop').set('Cookie', cookie());
    expect(list.status).toBe(200);
    const row = list.body.alop.find(r => r.id === alopId);
    expect(row.df_flow_active).toBe(false);

    const detail = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie());
    expect(detail.status).toBe(200);
    expect(detail.body.alop.df_flow_active).toBe(false);
  });

  it('2. sanity: flux activ (pending) → df_flow_active=true (non-regresie)', async () => {
    const df = await seedDf({ orgId: 1, createdBy: 1, status: 'transmis_flux', nrUnic: 'DF-RF-2' });
    const flowId = await seedFlow({ completed: false }); // data.status='pending'
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', dfId: df, dfFlowId: flowId });

    const list = await request(app).get('/api/alop').set('Cookie', cookie());
    expect(list.status).toBe(200);
    const row = list.body.alop.find(r => r.id === alopId);
    expect(row.df_flow_active).toBe(true);

    const detail = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie());
    expect(detail.status).toBe(200);
    expect(detail.body.alop.df_flow_active).toBe(true);
  });
});
