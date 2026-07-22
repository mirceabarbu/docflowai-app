/**
 * #105i — write guards signing/attachments: contract platform-admin.
 * DELETE attachment (attachments.mjs) + regenerate-token (signing.mjs), reprezentative.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

let CURRENT_ACTOR = null;

vi.mock('../../middleware/auth.mjs', async () => {
  const actual = await vi.importActual('../../middleware/auth.mjs');
  return {
    ...actual,
    AUTH_COOKIE: 'auth_token',
    requireAuth(req, res, next) {
      if (typeof next === 'function') { req.actor = CURRENT_ACTOR; next(); return; }
      return CURRENT_ACTOR;
    },
    requireAdmin: vi.fn((req, res, next) => { if (typeof next === 'function') next(); }),
    getOptionalActor: () => CURRENT_ACTOR,
  };
});

vi.mock('../../db/index.mjs', () => ({
  pool:             { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  DB_READY:         true,
  requireDb:        vi.fn(() => false),
  saveFlow:         vi.fn().mockResolvedValue(undefined),
  getFlowData:      vi.fn(),
  writeAuditEvent:  vi.fn().mockResolvedValue(undefined),
  getDefaultOrgId:  vi.fn().mockResolvedValue(1),
  getUserMapForOrg: vi.fn().mockResolvedValue({}),
  DB_LAST_ERROR:    null,
}));

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
}));

import * as dbModule from '../../db/index.mjs';
import signingRouter from '../../routes/flows/signing.mjs';
import attachmentsRouter from '../../routes/flows/attachments.mjs';

function makeApp() {
  const a = express(); a.use(express.json()); a.use(cookieParser());
  a.use('/', signingRouter); a.use('/', attachmentsRouter);
  return a;
}
const app = makeApp();
const flow = (o = {}) => ({ flowId: 'F1', docName: 'X', initEmail: 'init@x.ro', orgId: 1, status: 'active', completed: false, signers: [{ name: 'S', email: 's@x.ro', token: 't', status: 'current' }], ...o });

describe('#105i — signing/attachments org guard', () => {
  beforeEach(() => { vi.clearAllMocks(); dbModule.getFlowData.mockResolvedValue(flow()); });

  it('DELETE attachment: org_admin din ALT org → 403', async () => {
    CURRENT_ACTOR = { email: 'oa@y.ro', role: 'org_admin', orgId: 2, userId: 9 };
    expect((await request(app).delete('/flows/F1/attachments/1')).status).toBe(403);
  });
  it('DELETE attachment: admin CU org_id cross-org → NU 403 (role-only: admin = platform)', async () => {
    CURRENT_ACTOR = { email: 'admin@y.ro', role: 'admin', orgId: 2, userId: 1 };
    expect((await request(app).delete('/flows/F1/attachments/1')).status).not.toBe(403);
  });
  it('DELETE attachment: platform-admin (fără org_id) → NU 403', async () => {
    CURRENT_ACTOR = { email: 'super@z.ro', role: 'admin', orgId: null, userId: 1 };
    expect((await request(app).delete('/flows/F1/attachments/1')).status).not.toBe(403);
  });

  it('regenerate-token: org_admin din ALT org → 403', async () => {
    CURRENT_ACTOR = { email: 'oa@y.ro', role: 'org_admin', orgId: 2, userId: 9 };
    const res = await request(app).post('/flows/F1/regenerate-token').send({ signerEmail: 'nomatch@z.ro' });
    expect(res.status).toBe(403);
  });
  it('regenerate-token: platform-admin → NU 403 (trece de guard; 404 signer_not_found)', async () => {
    CURRENT_ACTOR = { email: 'super@z.ro', role: 'admin', orgId: null, userId: 1 };
    const res = await request(app).post('/flows/F1/regenerate-token').send({ signerEmail: 'nomatch@z.ro' });
    expect(res.status).not.toBe(403);
  });
});
