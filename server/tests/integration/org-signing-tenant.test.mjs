/**
 * #207 — Tenant leak pe GET /admin/organizations/:id/signing.
 *
 * Ruta verifica doar `isAdminOrOrgAdmin(actor)` și folosea `req.params.id` direct: un
 * org_admin din instituția A putea citi configurația de semnare a instituției B
 * (clientId, kid, redirectUri, idpUrl, apiUrl, publicKeyPem, existența secretelor).
 * Cheia privată era deja mascată — restul e metadata cross-tenant.
 *
 * Fix: org_admin cu orgId ≠ :id ⇒ 404 `org_not_found` (NU 403 — nu confirmăm existența
 * organizației). Platform-admin (`role==='admin'`) trece cross-org, corect.
 *
 * Rulează ruta REALĂ (admin/organizations.mjs) cu pool-ul mock-uit.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

vi.mock('../../db/index.mjs', () => ({
  pool:            { query: vi.fn() },
  DB_READY:        true,
  requireDb:       vi.fn(() => false),
  writeAuditEvent: vi.fn().mockResolvedValue(undefined),
  DB_LAST_ERROR:   null,
}));
vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../middleware/csrf.mjs', () => ({ csrfMiddleware: (_req, _res, next) => next() }));

import * as dbModule from '../../db/index.mjs';
import orgsRouter from '../../routes/admin/organizations.mjs';

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-vitest-docflowai-2025';
const ORG_A = 11, ORG_B = 22;

function cookieFor(payload) {
  const t = jwt.sign({ userId: 1, tv: 1, ...payload }, JWT_SECRET, { expiresIn: '1h' });
  return `auth_token=${t}`;
}
const orgAAdmin = () => cookieFor({ role: 'org_admin', orgId: ORG_A, email: 'oa@a.ro' });
const platform  = () => cookieFor({ role: 'admin',     orgId: null,  email: 'root@docflowai.ro' });
const plainUser = () => cookieFor({ role: 'user',      orgId: ORG_A, email: 'u@a.ro' });

const CONFIG_FIELDS = ['clientId', 'kid', 'redirectUri', 'idpUrl', 'apiUrl', 'publicKeyPem', 'hasPrivateKey'];

function orgRow(id) {
  return {
    id, name: `Org ${id}`,
    signing_providers_enabled: ['local-upload', 'sts-cloud'],
    signing_providers_config: {
      'sts-cloud': {
        clientId: `client-${id}`, kid: `kid-${id}`, redirectUri: `https://org${id}/cb`,
        idpUrl: 'https://idp.stsisp.ro/', apiUrl: 'https://sign.stsisp.ro/api/v1',
        publicKeyPem: `PUB-${id}`, privateKeyPem: `PRIV-${id}`,
      },
    },
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/', orgsRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbModule.pool.query.mockReset();
  // Orice organizație cerută „există" în DB — poarta trebuie să respingă ÎNAINTE de query.
  dbModule.pool.query.mockImplementation(async (_sql, params) => ({ rows: [orgRow(params?.[0])], rowCount: 1 }));
});

describe('#207 GET /admin/organizations/:id/signing — izolare tenant', () => {
  it('⭐ org_admin din A cere organizația B ⇒ 404 org_not_found, zero câmpuri de config, fără query în DB', async () => {
    const res = await request(buildApp()).get(`/admin/organizations/${ORG_B}/signing`).set('Cookie', orgAAdmin());
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'org_not_found' });
    const raw = JSON.stringify(res.body);
    for (const f of CONFIG_FIELDS) expect(raw).not.toContain(f);
    expect(raw).not.toContain(`client-${ORG_B}`);
    expect(raw).not.toContain('sts-cloud');
    // Poarta e înaintea SELECT-ului: nu atingem rândul altui tenant nici măcar pentru a-l masca.
    expect(dbModule.pool.query).not.toHaveBeenCalled();
  });

  it('org_admin din A cere propria organizație ⇒ 200, config prezent (cheia privată mascată)', async () => {
    const res = await request(buildApp()).get(`/admin/organizations/${ORG_A}/signing`).set('Cookie', orgAAdmin());
    expect(res.status).toBe(200);
    expect(res.body.orgId).toBe(ORG_A);
    expect(res.body.configSafe['sts-cloud'].clientId).toBe(`client-${ORG_A}`);
    expect(res.body.configSafe['sts-cloud'].hasPrivateKey).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(`PRIV-${ORG_A}`);
  });

  it('admin (platformă) cere orice organizație ⇒ 200', async () => {
    const res = await request(buildApp()).get(`/admin/organizations/${ORG_B}/signing`).set('Cookie', platform());
    expect(res.status).toBe(200);
    expect(res.body.orgId).toBe(ORG_B);
    expect(res.body.configSafe['sts-cloud'].kid).toBe(`kid-${ORG_B}`);
  });

  it('utilizator obișnuit ⇒ 403 (neregresie)', async () => {
    const res = await request(buildApp()).get(`/admin/organizations/${ORG_A}/signing`).set('Cookie', plainUser());
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });
});
