/**
 * v3.9.502 (A-3 P0) — GET /flows/:flowId folosește canActorReadFlow
 *
 * Înainte: orice user autentificat putea citi metadata flow-ului (signers,
 * events, institutie, compartiment). Leak cross-org.
 *
 * Acoperire (canActorReadFlow):
 *   ✓ Signer token valid → 200 (fără actor)
 *   ✓ Initiator → 200
 *   ✓ Signer email → 200
 *   ✓ Admin same org → 200
 *   ✓ Admin different org → 403 (cross-org blocat)
 *   ✓ User same org non-init non-signer → 403
 *   ✓ User different org → 403
 *   ✓ Fără actor și fără token → 401
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

vi.mock('../../db/index.mjs', () => ({
  pool:            { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  DB_READY:        true,
  requireDb:       vi.fn(() => false),
  saveFlow:        vi.fn().mockResolvedValue(undefined),
  getFlowData:     vi.fn(),
  writeAuditEvent: vi.fn().mockResolvedValue(undefined),
  getDefaultOrgId: vi.fn().mockResolvedValue(1),
  getUserMapForOrg: vi.fn().mockResolvedValue({}),
  DB_LAST_ERROR:   null,
}));

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
}));

import * as dbModule from '../../db/index.mjs';
import crudRouter, { _injectDeps } from '../../routes/flows/crud.mjs';
import { JWT_SECRET } from '../../middleware/auth.mjs';

const FLOW_ID = 'FLOW_ACL01';
const SIGNER_TOKEN = 'sig-token-001';

function makeAuth(email, userId, role, orgId) {
  return `auth_token=${jwt.sign({ email, userId, role, orgId }, JWT_SECRET, { expiresIn: '1h' })}`;
}

function makeFlowData() {
  return {
    flowId: FLOW_ID, docName: 'X', initEmail: 'init@x.ro', orgId: 1,
    status: 'active', completed: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    events: [],
    signers: [{ name: 'S', email: 'sig@x.ro', token: SIGNER_TOKEN, status: 'current', order: 1 }],
  };
}

function createTestApp() {
  const app = express();
  app.use(cookieParser());
  _injectDeps({
    notify: vi.fn(), wsPush: vi.fn(), PDFLib: null,
    stampFooterOnPdf: vi.fn(), isSignerTokenExpired: () => false,
    newFlowId: () => 'NEW', buildSignerLink: () => '',
    stripSensitive: x => x, stripPdfB64: x => x,
    sendSignerEmail: vi.fn(), fireWebhook: vi.fn(),
  });
  app.use('/', crudRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbModule.getFlowData.mockReset();
});

describe('GET /flows/:flowId — canActorReadFlow (A-3)', () => {
  it('signer token valid fără actor → 200', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());
    const res = await request(createTestApp())
      .get(`/flows/${FLOW_ID}?token=${SIGNER_TOKEN}`);
    expect(res.status).toBe(200);
  });

  it('initiator → 200', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());
    const res = await request(createTestApp())
      .get(`/flows/${FLOW_ID}`)
      .set('Cookie', makeAuth('init@x.ro', 1, 'user', 1));
    expect(res.status).toBe(200);
  });

  it('signer email → 200', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());
    const res = await request(createTestApp())
      .get(`/flows/${FLOW_ID}`)
      .set('Cookie', makeAuth('sig@x.ro', 2, 'user', 1));
    expect(res.status).toBe(200);
  });

  it('admin same org → 200', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());
    const res = await request(createTestApp())
      .get(`/flows/${FLOW_ID}`)
      .set('Cookie', makeAuth('admin@x.ro', 3, 'org_admin', 1));
    expect(res.status).toBe(200);
  });

  it('admin different org → 403', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());
    const res = await request(createTestApp())
      .get(`/flows/${FLOW_ID}`)
      .set('Cookie', makeAuth('admin@y.ro', 99, 'org_admin', 99));
    expect(res.status).toBe(403);
  });

  it('user same org dar non-init non-signer → 403 (cel mai important fix)', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());
    const res = await request(createTestApp())
      .get(`/flows/${FLOW_ID}`)
      .set('Cookie', makeAuth('intruder@x.ro', 99, 'user', 1));
    expect(res.status).toBe(403);
  });

  it('user different org → 403', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());
    const res = await request(createTestApp())
      .get(`/flows/${FLOW_ID}`)
      .set('Cookie', makeAuth('other@y.ro', 88, 'user', 99));
    expect(res.status).toBe(403);
  });

  it('fără actor și fără token → 401', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());
    const res = await request(createTestApp())
      .get(`/flows/${FLOW_ID}`);
    expect(res.status).toBe(401);
  });
});
