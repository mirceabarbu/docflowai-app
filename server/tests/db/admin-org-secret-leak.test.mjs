/**
 * #123 P0-04 (audit v3.9.746) — `signing_providers_config` (conține `privateKeyPem`, cheia
 * privată STS Cloud) nu are voie să părăsească serverul prin GET /admin/organizations/:id.
 * Verifică și că PUT /admin/organizations/:id face MERGE cu configul existent (nu înlocuire
 * totală) — un caller care nu mai primește cheia nu trebuie să o poată șterge tăcut.
 *
 * Rulează ruta REALĂ (admin/organizations.mjs) peste Postgres real.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { hasTestDb, migrate, truncateAll, pool, seedOrgUser, makeAuthCookie } from '../helpers/db-real.mjs';

vi.mock('../../middleware/csrf.mjs', () => ({ csrfMiddleware: (_req, _res, next) => next() }));

const orgsRouter = (await import('../../routes/admin/organizations.mjs')).default;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/', orgsRouter);
  return app;
}

const PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----TEST-----END RSA PRIVATE KEY-----';

async function seedOrgWithStsConfig(orgId) {
  await pool.query(
    `UPDATE organizations
        SET signing_providers_enabled = $2,
            signing_providers_config  = $3::jsonb
      WHERE id = $1`,
    [orgId, ['local-upload', 'sts-cloud'],
     JSON.stringify({ 'sts-cloud': { clientId: 'c1', kid: 'k1', privateKeyPem: PRIVATE_KEY } })]
  );
}

const d = describe.skipIf(!hasTestDb());

d('#123 P0-04 — cheia STS nu pleacă spre browser (Postgres real)', () => {
  let app, orgId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    const seeded = await seedOrgUser({ role: 'admin' });
    orgId = seeded.orgId;
    await seedOrgWithStsConfig(orgId);
    app = buildApp();
  });
  afterAll(() => pool.end());

  const adminCookie = () => makeAuthCookie({ userId: 1, role: 'admin', orgId, email: 'p1@x.ro' });

  it('GET /admin/organizations/:id nu mai conține signing_providers_config nicăieri în body', async () => {
    const res = await request(app).get(`/admin/organizations/${orgId}`).set('Cookie', adminCookie());
    expect(res.status).toBe(200);
    expect(res.body.signing_providers_config).toBeUndefined();
    expect(res.body.signing_providers_enabled).toBeDefined();
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('privateKeyPem');
    expect(raw).not.toContain('BEGIN RSA PRIVATE KEY');
  });

  it('control pozitiv: GET /admin/organizations/:id/signing continuă să funcționeze (configSafe)', async () => {
    const res = await request(app).get(`/admin/organizations/${orgId}/signing`).set('Cookie', adminCookie());
    expect(res.status).toBe(200);
    expect(res.body.configSafe['sts-cloud'].hasPrivateKey).toBe(true);
    expect(res.body.configSafe['sts-cloud'].privateKeyPem).toBeUndefined();
  });

  it('PUT /admin/organizations/:id cu config parțial (fără cheie) face MERGE — cheia supraviețuiește', async () => {
    const res = await request(app)
      .put(`/admin/organizations/${orgId}`)
      .set('Cookie', adminCookie())
      .send({ signing_providers_enabled: ['local-upload', 'sts-cloud'], signing_providers_config: { 'sts-cloud': { clientId: 'c2' } } });
    expect(res.status).toBe(200);

    const { rows } = await pool.query('SELECT signing_providers_config FROM organizations WHERE id=$1', [orgId]);
    const cfg = rows[0].signing_providers_config['sts-cloud'];
    expect(cfg.privateKeyPem).toBe(PRIVATE_KEY);
    expect(cfg.clientId).toBe('c2');
  });
});
