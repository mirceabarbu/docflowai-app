/**
 * v3.9.710 — GET /admin/flows/:flowId/audit: authz la nivel de OBIECT.
 *
 * Înainte: gate de ROL (isAdminOrOrgAdmin) → auditul era invizibil utilizatorilor
 * normali, chiar și pe fluxurile lor. Acum: isFlowAccessAllowed (init | semnatar |
 * admin same-org | destinatar repartizat), aceeași poartă ca pe GET /flows/:id și
 * pe endpointurile de conținut (signed-pdf / pdf / attachments).
 *
 * Miezul de securitate (cazurile 4 & 5): deschiderea NU introduce IDOR — un user
 * autentificat fără legătură cu fluxul (same-org sau alt org) NU primește auditul,
 * care conține hash-uri SHA-256, semnatari și jurnalul complet de evenimente.
 *
 * format=json → nu generează PDF în test.
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

const adminFlowsRouter = (await import('../../routes/admin/flows.mjs')).default;

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use('/', adminFlowsRouter);
  return app;
}

const FLOW_ID = 'flow-audit-acl-1';
const URL = `/admin/flows/${FLOW_ID}/audit?format=json`;

const d = describe.skipIf(!hasTestDb());

d('Audit flux — authz la nivel de obiect (v3.9.710)', () => {
  let app, orgId, initId, signerId, destId, strangerId, adminId;
  let otherOrgId, otherOrgUserId;

  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await pool.query('DELETE FROM flow_recipients');

    const o = await seedOrgUser({ email: 'init@x.ro', role: 'user' });
    orgId = o.orgId; initId = o.userId;
    signerId   = await seedUser({ orgId, email: 'sig@x.ro' });
    destId     = await seedUser({ orgId, email: 'dest@x.ro' });
    strangerId = await seedUser({ orgId, email: 'stranger@x.ro' });
    adminId    = await seedUser({ orgId, email: 'admin@x.ro', role: 'org_admin' });

    // Alt org, complet separat.
    const o2 = await seedOrgUser({ orgName: 'Alt Org', email: 'altorg@y.ro', role: 'user' });
    otherOrgId = o2.orgId; otherOrgUserId = o2.userId;

    await pool.query(
      `INSERT INTO flows (id, data, org_id) VALUES ($1, $2::jsonb, $3)`,
      [FLOW_ID, JSON.stringify({
        flowId: FLOW_ID, status: 'completed', completed: true, orgId,
        initEmail: 'init@x.ro', docName: 'Doc', flowType: 'ancore',
        signers: [{ name: 'S', email: 'sig@x.ro', token: 'sig-token-audit-001' }],
        events: [{ type: 'CREATED', at: new Date().toISOString() }],
      }), orgId]
    );

    await transmitFlowTo(pool, {
      flowId: FLOW_ID, orgId, transmittedBy: null, source: 'auto',
      recipients: [{ type: 'user', value: destId }],
    });
    app = buildApp();
  });
  afterAll(() => pool.end());

  const cookie = (u) => makeAuthCookie(u);

  it('1. inițiatorul fluxului → 200', async () => {
    const res = await request(app).get(URL)
      .set('Cookie', cookie({ userId: initId, role: 'user', orgId, email: 'init@x.ro' }));
    expect(res.status).toBe(200);
    expect(res.body.flowId).toBe(FLOW_ID);
  });

  it('2. semnatar al fluxului → 200', async () => {
    const res = await request(app).get(URL)
      .set('Cookie', cookie({ userId: signerId, role: 'user', orgId, email: 'sig@x.ro' }));
    expect(res.status).toBe(200);
  });

  it('3. destinatar repartizat → 200', async () => {
    const res = await request(app).get(URL)
      .set('Cookie', cookie({ userId: destId, role: 'user', orgId, email: 'dest@x.ro' }));
    expect(res.status).toBe(200);
  });

  it('4. user same-org FĂRĂ legătură cu fluxul → 403 [anti-IDOR]', async () => {
    const res = await request(app).get(URL)
      .set('Cookie', cookie({ userId: strangerId, role: 'user', orgId, email: 'stranger@x.ro' }));
    expect(res.status).toBe(403);
  });

  it('5. user din ALT org → non-200 [anti-IDOR cross-org]', async () => {
    const res = await request(app).get(URL)
      .set('Cookie', cookie({ userId: otherOrgUserId, role: 'user', orgId: otherOrgId, email: 'altorg@y.ro' }));
    expect(res.status).not.toBe(200);
    expect([403, 404]).toContain(res.status);
  });

  it('5b. org_admin din ALT org → non-200 (adminitatea nu traversează org-ul)', async () => {
    const res = await request(app).get(URL)
      .set('Cookie', cookie({ userId: otherOrgUserId, role: 'org_admin', orgId: otherOrgId, email: 'altorg@y.ro' }));
    expect(res.status).not.toBe(200);
  });

  it('6. admin same-org → 200 [regresie: adminul păstrează accesul]', async () => {
    const res = await request(app).get(URL)
      .set('Cookie', cookie({ userId: adminId, role: 'org_admin', orgId, email: 'admin@x.ro' }));
    expect(res.status).toBe(200);
  });

  it('anonim → 401/403', async () => {
    const res = await request(app).get(URL);
    expect([401, 403]).toContain(res.status);
  });
});
