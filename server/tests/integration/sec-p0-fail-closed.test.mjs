/**
 * SEC-P0.3 — POST /flows: identitate tenant FAIL-CLOSED.
 * Lookup după users.id (+ deleted_at IS NULL), zero fallback cross-tenant.
 * Structura de vi.mock ESM oglindește server/tests/integration/flows.test.mjs.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

// ── Mock-uri ESM (identic cu flows.test.mjs) ───────────────────────────────────
vi.mock('../../db/index.mjs', () => {
  const mockQuery   = vi.fn();
  const mockSave    = vi.fn();
  const mockGet     = vi.fn();
  const mockAudit   = vi.fn();
  const mockOrgId   = vi.fn().mockResolvedValue(1);
  const mockUserMap = vi.fn().mockResolvedValue({});
  return {
    pool:             { query: mockQuery },
    DB_READY:         true,
    requireDb:        vi.fn(() => false),
    saveFlow:         mockSave,
    getFlowData:      mockGet,
    writeAuditEvent:  mockAudit,
    getDefaultOrgId:  mockOrgId,
    getUserMapForOrg: mockUserMap,
    DB_LAST_ERROR:    null,
  };
});

vi.mock('../../middleware/logger.mjs', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  },
}));

vi.mock('../../emailTemplates.mjs', () => ({
  emailYourTurn:      vi.fn(() => ({ subject: 's', html: '<p>x</p>' })),
  emailGeneric:       vi.fn(() => ({ subject: 's', html: '<p>x</p>' })),
  emailDelegare:      vi.fn(() => ({ subject: 's', html: '<p>x</p>' })),
  emailResetPassword: vi.fn(() => ({ subject: 's', html: '<p>x</p>' })),
  emailCredentials:   vi.fn(() => ({ subject: 's', html: '<p>x</p>' })),
  emailVerifyGws:     vi.fn(() => ({ subject: 's', html: '<p>x</p>' })),
}));

import * as dbModule from '../../db/index.mjs';
import flowsRouter, { injectFlowDeps } from '../../routes/flows.mjs';

const TEST_JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-vitest-docflowai-2025';

function makeToken(overrides = {}) {
  return jwt.sign(
    { userId: 1, email: 'init@primaria.ro', role: 'user', orgId: 7, nume: 'Ion Popescu', ...overrides },
    TEST_JWT_SECRET,
    { expiresIn: '2h' }
  );
}

function createTestApp() {
  injectFlowDeps({
    notify:               vi.fn().mockResolvedValue(undefined),
    wsPush:               vi.fn(),
    PDFLib:               null,
    stampFooterOnPdf:     null,
    isSignerTokenExpired: () => false,
    newFlowId:            () => 'TEST_ABCD1',
    buildSignerLink:      (req, fid, tok) => `https://app/s?flow=${fid}&token=${tok}`,
    stripSensitive:       (d) => { const { pdfB64, signedPdfB64, ...rest } = d; return rest; },
    stripPdfB64:          (d) => { const { pdfB64, signedPdfB64, ...rest } = d; return rest; },
    sendSignerEmail:      vi.fn().mockResolvedValue({ ok: true }),
  });
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '50mb' }));
  app.use(cookieParser());
  app.use('/', flowsRouter);
  return app;
}

const VALID_BODY = {
  docName: 'Referat aprobare buget',
  initName: 'Ion Popescu',
  initEmail: 'init@primaria.ro',
  signers: [{ name: 'Ana Maria', email: 'signer@primaria.ro', rol: 'AVIZAT' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  dbModule.pool.query.mockReset();
  dbModule.saveFlow.mockReset();
  dbModule.getFlowData.mockReset();
  dbModule.pool.query.mockResolvedValue({ rows: [] });
  dbModule.saveFlow.mockResolvedValue(undefined);
  dbModule.writeAuditEvent.mockResolvedValue(undefined);
});

describe('SEC-P0.3 — POST /flows fail-closed pe identitate tenant', () => {
  it('1 — JWT fără userId ⇒ 401 session_identity_invalid', async () => {
    const app = createTestApp();
    const res = await request(app).post('/flows')
      .set('Cookie', `auth_token=${makeToken({ userId: undefined })}`)
      .send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('session_identity_invalid');
  });

  it('2 — eroare DB la lookup ⇒ 503 org_lookup_failed, fără getDefaultOrgId', async () => {
    dbModule.pool.query.mockReset();
    dbModule.pool.query.mockRejectedValue(new Error('db down'));
    const app = createTestApp();
    const res = await request(app).post('/flows')
      .set('Cookie', `auth_token=${makeToken()}`)
      .send(VALID_BODY);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('org_lookup_failed');
    expect(dbModule.getDefaultOrgId).not.toHaveBeenCalled();
  });

  it('3 — utilizator inexistent / soft-deleted (rows: []) ⇒ 403 actor_not_found, fără flux salvat', async () => {
    const app = createTestApp();
    const res = await request(app).post('/flows')
      .set('Cookie', `auth_token=${makeToken()}`)
      .send(VALID_BODY);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('actor_not_found');
    expect(dbModule.saveFlow).not.toHaveBeenCalled();
  });

  it('4 — utilizator cu org_id null ⇒ 409 user_without_org, fără flux salvat', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [{ id: 1, org_id: null, nume: 'Ion Popescu' }] });
    const app = createTestApp();
    const res = await request(app).post('/flows')
      .set('Cookie', `auth_token=${makeToken()}`)
      .send(VALID_BODY);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('user_without_org');
    expect(dbModule.saveFlow).not.toHaveBeenCalled();
  });

  it('5 — JWT orgId 3 vs DB org_id 7 ⇒ 401 session_org_stale, fără flux salvat', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [{ id: 1, org_id: 7, nume: 'Ion Popescu' }] });
    const app = createTestApp();
    const res = await request(app).post('/flows')
      .set('Cookie', `auth_token=${makeToken({ orgId: 3 })}`)
      .send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('session_org_stale');
    expect(dbModule.saveFlow).not.toHaveBeenCalled();
  });

  it('6 — happy path (JWT orgId 7 == DB org_id 7) ⇒ flux salvat cu orgId 7, fără getDefaultOrgId', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [{ id: 1, org_id: 7, nume: 'Ion Popescu' }] });
    const app = createTestApp();
    const res = await request(app).post('/flows')
      .set('Cookie', `auth_token=${makeToken({ orgId: 7 })}`)
      .send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(dbModule.saveFlow).toHaveBeenCalledOnce();
    expect(dbModule.saveFlow.mock.calls[0][1].orgId).toBe(7);
    expect(dbModule.getDefaultOrgId).not.toHaveBeenCalled();
  });

  it('7 — regresie lookup: interogarea e după id + deleted_at, NU după email', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [{ id: 1, org_id: 7, nume: 'Ion Popescu' }] });
    const app = createTestApp();
    await request(app).post('/flows')
      .set('Cookie', `auth_token=${makeToken({ orgId: 7 })}`)
      .send(VALID_BODY);
    const firstSql = String(dbModule.pool.query.mock.calls[0][0]);
    expect(firstSql).toMatch(/WHERE\s+id\s*=\s*\$1/);
    expect(firstSql).toContain('deleted_at IS NULL');
    expect(firstSql).not.toContain('email=$1');
  });
});
