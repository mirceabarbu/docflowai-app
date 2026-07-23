/**
 * #111a — GET /my-flows/:flowId/download aliniat la poarta partajată isFlowAccessAllowed.
 *
 * Înainte: check inline divergent (isInit || isSigner || (isAdmin && sameOrg)) — rata
 * DOUĂ ramuri pe care poarta canonică le are: destinatar repartizat (transmitere internă,
 * v3.9.601+) și platform-admin (#105f, isPlatformAdmin = role==='admin' fără dependență de
 * org_id). Un destinatar repartizat vedea documentul pe signed-pdf/pdf, dar primea 403 la
 * download — bug funcțional real.
 *
 * Auto-skip fără TEST_DATABASE_URL (npm test rămâne verde); rulează în CI cu Postgres real.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import {
  hasTestDb, migrate, truncateAll, pool,
  seedOrgUser, seedUser, makeAuthCookie,
} from '../helpers/db-real.mjs';
import { transmitFlowTo } from '../../services/flow-transmit.mjs';

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  redactUrl: (u) => u,
}));

const crudMod = await import('../../routes/flows/crud.mjs');
const crudRouter = crudMod.default;
crudMod._injectDeps({ stripSensitive: (d) => d });

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use('/', crudRouter);
  return app;
}

const FLOW_ID = 'flow-myflows-download-acl-1';
const URL = `/my-flows/${FLOW_ID}/download`;
const B64 = Buffer.from('hello-pdf').toString('base64');

const d = describe.skipIf(!hasTestDb());

d('GET /my-flows/:flowId/download — poarta partajată isFlowAccessAllowed (#111a)', () => {
  let app, orgId, initId, signerId, destId, strangerId, adminId;
  let otherOrgId, otherOrgAdminId, platformAdminId;

  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await pool.query('DELETE FROM flows_pdfs');
    await pool.query('DELETE FROM flow_recipients');

    const o = await seedOrgUser({ email: 'init@x.ro', role: 'user' });
    orgId = o.orgId; initId = o.userId;
    signerId   = await seedUser({ orgId, email: 'sig@x.ro' });
    destId     = await seedUser({ orgId, email: 'dest@x.ro' });
    strangerId = await seedUser({ orgId, email: 'stranger@x.ro' });
    adminId    = await seedUser({ orgId, email: 'admin@x.ro', role: 'org_admin' });

    // Alt org, complet separat.
    const o2 = await seedOrgUser({ orgName: 'Alt Org 111a', email: 'altorg@y.ro', role: 'user' });
    otherOrgId = o2.orgId;
    otherOrgAdminId = await seedUser({ orgId: otherOrgId, email: 'otheradmin@y.ro', role: 'org_admin' });
    // Platform-admin: role='admin', fără org_id (isPlatformAdmin = role==='admin', #105).
    platformAdminId = await seedUser({ orgId: otherOrgId, email: 'platadmin@y.ro', role: 'admin' });

    await pool.query(
      `INSERT INTO flows (id, data, org_id) VALUES ($1, $2::jsonb, $3)`,
      [FLOW_ID, JSON.stringify({
        flowId: FLOW_ID, status: 'completed', completed: true, orgId,
        initEmail: 'init@x.ro', docName: 'Doc', flowType: 'ancore',
        signers: [{ name: 'S', email: 'sig@x.ro' }],
      }), orgId]
    );
    await pool.query(`INSERT INTO flows_pdfs (flow_id, key, data) VALUES ($1, 'signedPdfB64', $2)`, [FLOW_ID, B64]);

    // Destinatar repartizat — bug-ul reparat de #111a.
    await transmitFlowTo(pool, {
      flowId: FLOW_ID, orgId, transmittedBy: null, source: 'auto',
      recipients: [{ type: 'user', value: destId }],
    });
    app = buildApp();
  });
  afterAll(() => pool.end());

  const cookie = (u) => makeAuthCookie(u);

  it('1. inițiator → nu 403', async () => {
    const res = await request(app).get(URL)
      .set('Cookie', cookie({ userId: initId, role: 'user', orgId, email: 'init@x.ro' }));
    expect(res.status).not.toBe(403);
  });

  it('2. semnatar → nu 403', async () => {
    const res = await request(app).get(URL)
      .set('Cookie', cookie({ userId: signerId, role: 'user', orgId, email: 'sig@x.ro' }));
    expect(res.status).not.toBe(403);
  });

  it('3. destinatar repartizat → nu 403 [bug reparat]', async () => {
    const res = await request(app).get(URL)
      .set('Cookie', cookie({ userId: destId, role: 'user', orgId, email: 'dest@x.ro' }));
    expect(res.status).not.toBe(403);
  });

  it('4. org_admin din aceeași org → nu 403', async () => {
    const res = await request(app).get(URL)
      .set('Cookie', cookie({ userId: adminId, role: 'org_admin', orgId, email: 'admin@x.ro' }));
    expect(res.status).not.toBe(403);
  });

  it('5. org_admin din ALTĂ org → 403', async () => {
    const res = await request(app).get(URL)
      .set('Cookie', cookie({ userId: otherOrgAdminId, role: 'org_admin', orgId: otherOrgId, email: 'otheradmin@y.ro' }));
    expect(res.status).toBe(403);
  });

  it('6. user oarecare din aceeași org, fără legătură cu fluxul → 403', async () => {
    const res = await request(app).get(URL)
      .set('Cookie', cookie({ userId: strangerId, role: 'user', orgId, email: 'stranger@x.ro' }));
    expect(res.status).toBe(403);
  });

  it('7. platform-admin pe flux din altă org → nu 403 [#105f]', async () => {
    const res = await request(app).get(URL)
      .set('Cookie', cookie({ userId: platformAdminId, role: 'admin', orgId: otherOrgId, email: 'platadmin@y.ro' }));
    expect(res.status).not.toBe(403);
  });

  it('8. anonim → 401/403', async () => {
    const res = await request(app).get(URL);
    expect([401, 403]).toContain(res.status);
  });
});
