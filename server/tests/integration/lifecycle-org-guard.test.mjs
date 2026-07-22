/**
 * #105h — lifecycle write guards: contract platform-admin pe POST /flows/:id/cancel
 * (aceeași expresie de guard la reinitiate/request-review/reinitiate-review/delegate).
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
import lifecycleRouter, { _injectDeps } from '../../routes/flows/lifecycle.mjs';

function makeApp() {
  _injectDeps({
    notify: vi.fn().mockResolvedValue(undefined), fireWebhook: null, wsPush: vi.fn(),
    PDFLib: null, stampFooterOnPdf: vi.fn(), isSignerTokenExpired: () => false,
    newFlowId: () => 'NEW', buildSignerLink: () => '', stripSensitive: x => x,
    stripPdfB64: x => x, sendSignerEmail: vi.fn().mockResolvedValue(undefined),
  });
  const a = express(); a.use(express.json()); a.use(cookieParser()); a.use('/', lifecycleRouter);
  return a;
}
const app = makeApp();
const flow = (o = {}) => ({ flowId: 'F1', docName: 'X', initEmail: 'init@x.ro', orgId: 1, status: 'active', completed: false, signers: [], ...o });

describe('#105h — POST /flows/:id/cancel org guard', () => {
  beforeEach(() => { vi.clearAllMocks(); dbModule.getFlowData.mockResolvedValue(flow()); });

  it('org_admin din ALT org (2) → 403', async () => {
    CURRENT_ACTOR = { email: 'oa@y.ro', role: 'org_admin', orgId: 2, userId: 9 };
    expect((await request(app).post('/flows/F1/cancel').send({})).status).toBe(403);
  });
  it('admin CU org_id, ALT org (2) → 403 (fail-closed până la flip)', async () => {
    CURRENT_ACTOR = { email: 'admin@y.ro', role: 'admin', orgId: 2, userId: 1 };
    expect((await request(app).post('/flows/F1/cancel').send({})).status).toBe(403);
  });
  it('platform-admin (fără org_id) → NU 403 (cross-org permis)', async () => {
    CURRENT_ACTOR = { email: 'super@z.ro', role: 'admin', orgId: null, userId: 1 };
    expect((await request(app).post('/flows/F1/cancel').send({})).status).not.toBe(403);
  });
  it('admin CU org_id, ACELAȘI org (1) → NU 403', async () => {
    CURRENT_ACTOR = { email: 'admin@x.ro', role: 'admin', orgId: 1, userId: 1 };
    expect((await request(app).post('/flows/F1/cancel').send({})).status).not.toBe(403);
  });
  it('inițiator (alt org irelevant) → NU 403', async () => {
    CURRENT_ACTOR = { email: 'init@x.ro', role: 'user', orgId: 2, userId: 5 };
    expect((await request(app).post('/flows/F1/cancel').send({})).status).not.toBe(403);
  });
});
