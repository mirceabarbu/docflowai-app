/**
 * #105b — tenant isolation pe report/json.
 * Fluxul e în org 1. Un org_admin din org 2 NU trebuie să-i vadă raportul (#20).
 * Platform-admin (role='admin', fără org_id) vede tot. Inițiator/semnatar neafectați.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

vi.mock('../../db/index.mjs', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
  getFlowData: vi.fn(),
}));
vi.mock('../../services/sign-trust-report.mjs', () => ({
  generateTrustReport: vi.fn().mockResolvedValue({ report: { ok: true } }),
}));
vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import * as dbModule from '../../db/index.mjs';
import reportRouter from '../../routes/report.mjs';
import { JWT_SECRET } from '../../middleware/auth.mjs';

const FLOW_ID = 'FLOW_REP01';
const URL = `/api/flows/${FLOW_ID}/report/json`;

function makeAuth(email, userId, role, orgId) {
  return `auth_token=${jwt.sign({ email, userId, role, orgId }, JWT_SECRET, { expiresIn: '1h' })}`;
}
function makeFlowData(orgId = 1) {
  return {
    flowId: FLOW_ID, docName: 'X', initEmail: 'init@a.ro', orgId,
    status: 'active', completed: false,
    signers: [{ name: 'S', email: 'sig@a.ro', token: 't', status: 'current', order: 1 }],
    signedPdfB64: null, pdfB64: null,
  };
}
function app() {
  const a = express();
  a.use(cookieParser());
  a.use('/', reportRouter);
  return a;
}

beforeEach(() => { vi.clearAllMocks(); dbModule.getFlowData.mockReset(); });

describe('#105b tenant isolation — /report/json (flux org 1)', () => {
  it('org_admin din ALT org (2) → 403 (leak #20 închis)', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData(1));
    const res = await request(app()).get(URL).set('Cookie', makeAuth('oa@b.ro', 9, 'org_admin', 2));
    expect(res.status).toBe(403);
  });
  it('org_admin din ACELAȘI org (1) → nu 403', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData(1));
    const res = await request(app()).get(URL).set('Cookie', makeAuth('oa@a.ro', 8, 'org_admin', 1));
    expect(res.status).not.toBe(403);
  });
  it('platform-admin (role admin, fără org_id) → nu 403 (cross-org)', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData(1));
    const res = await request(app()).get(URL).set('Cookie', makeAuth('admin@docflowai.ro', 1, 'admin', null));
    expect(res.status).not.toBe(403);
  });
  it('admin CU org_id=1 (starea prod azi) pe flux org 1 → nu 403', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData(1));
    const res = await request(app()).get(URL).set('Cookie', makeAuth('admin@docflowai.ro', 1, 'admin', 1));
    expect(res.status).not.toBe(403);
  });
  it('admin CU org_id=1 pe flux ALT org (2) → NU 403 (role-only: admin = platform)', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData(2));
    const res = await request(app()).get(URL).set('Cookie', makeAuth('admin@docflowai.ro', 1, 'admin', 1));
    expect(res.status).not.toBe(403);
  });
  it('inițiator (chiar din alt org) → nu 403', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData(1));
    const res = await request(app()).get(URL).set('Cookie', makeAuth('init@a.ro', 7, 'user', 2));
    expect(res.status).not.toBe(403);
  });
  it('semnatar → nu 403', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData(1));
    const res = await request(app()).get(URL).set('Cookie', makeAuth('sig@a.ro', 6, 'user', 2));
    expect(res.status).not.toBe(403);
  });
  it('user oarecare non-init/non-signer, chiar același org → 403', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData(1));
    const res = await request(app()).get(URL).set('Cookie', makeAuth('rando@a.ro', 5, 'user', 1));
    expect(res.status).toBe(403);
  });
});

describe('#105e tenant isolation — /report/status (flux org 1)', () => {
  const SURL = `/api/flows/${FLOW_ID}/report/status`;
  it('org_admin din ALT org (2) → 403', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData(1));
    const res = await request(app()).get(SURL).set('Cookie', makeAuth('oa@b.ro', 9, 'org_admin', 2));
    expect(res.status).toBe(403);
  });
  it('org_admin din ACELAȘI org (1) → nu 403', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData(1));
    const res = await request(app()).get(SURL).set('Cookie', makeAuth('oa@a.ro', 8, 'org_admin', 1));
    expect(res.status).not.toBe(403);
  });
  it('platform-admin (fără org_id) → nu 403', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData(1));
    const res = await request(app()).get(SURL).set('Cookie', makeAuth('admin@docflowai.ro', 1, 'admin', null));
    expect(res.status).not.toBe(403);
  });
  it('inițiator → nu 403', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData(1));
    const res = await request(app()).get(SURL).set('Cookie', makeAuth('init@a.ro', 7, 'user', 2));
    expect(res.status).not.toBe(403);
  });
});
