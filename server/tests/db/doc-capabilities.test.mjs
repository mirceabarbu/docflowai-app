import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedFlowApproved, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('GET detaliu DF/ORD → document.capabilities (caracterizare)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await seedOrgUser({ role: 'user' }); app = buildApp(); });
  afterAll(() => pool.end());
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  it('DF draft → can_send_p2 + can_reset', async () => {
    const id = await seedDf({ orgId: 1, createdBy: 1, status: 'draft' });
    const res = await request(app).get(`/api/formulare-df/${id}`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    const c = res.body.document.capabilities;
    expect(c).toBeTruthy();
    expect(c.can_send_p2).toBe(true);
    expect(c.can_reset).toBe(true);
  });

  it('DF aprobat → download_signed + revise', async () => {
    const flowId = await seedFlowApproved();
    const id = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId });
    const res = await request(app).get(`/api/formulare-df/${id}`).set('Cookie', cookie());
    const c = res.body.document.capabilities;
    expect(c.aprobat).toBe(true);
    expect(c.can_download_signed).toBe(true);
    expect(c.can_revise).toBe(true);
  });

  it('DF transmis_flux (neaprobat) → on_flow + download_flux', async () => {
    const fid = `flow-pending-${Date.now()}`;
    await pool.query(`INSERT INTO flows (id, data) VALUES ($1, $2::jsonb)`, [fid, JSON.stringify({ status: 'in_progress' })]);
    const id = await seedDf({ orgId: 1, createdBy: 1, status: 'transmis_flux', flowId: fid });
    const res = await request(app).get(`/api/formulare-df/${id}`).set('Cookie', cookie());
    const c = res.body.document.capabilities;
    expect(c.is_on_flow).toBe(true);
    expect(c.can_download_flux).toBe(true);
    expect(c.aprobat).toBe(false);
  });

  it('DF neaprobat → revise', async () => {
    const id = await seedDf({ orgId: 1, createdBy: 1, status: 'neaprobat', revizieNr: 1 });
    const res = await request(app).get(`/api/formulare-df/${id}`).set('Cookie', cookie());
    const c = res.body.document.capabilities;
    expect(c.is_neaprobat).toBe(true);
    expect(c.can_revise).toBe(true);
  });

  it('ORD draft → can_send_p2; ORD aprobat → download_signed fără revise', async () => {
    const idDraft = await seedOrd({ orgId: 1, createdBy: 1, status: 'draft' });
    const r1 = await request(app).get(`/api/formulare-ord/${idDraft}`).set('Cookie', cookie());
    expect(r1.body.document.capabilities.can_send_p2).toBe(true);

    const flowId = await seedFlowApproved();
    const idApr = await seedOrd({ orgId: 1, createdBy: 1, status: 'aprobat', flowId });
    const r2 = await request(app).get(`/api/formulare-ord/${idApr}`).set('Cookie', cookie());
    const c = r2.body.document.capabilities;
    expect(c.can_download_signed).toBe(true);
    expect(c.can_revise).toBe(false);
  });
});
