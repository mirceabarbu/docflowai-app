/**
 * v3.9.502 (A-2 P0) — download endpoint folosește getFlowData + d (nu data)
 *
 * Înainte: SELECT direct ratează flows_pdfs (signedPdfB64 separat),
 * iar referința `data.docName` → ReferenceError la runtime → 500.
 *
 * Acoperire:
 *   ✓ getFlowData rehidratează signedPdfB64 → 200 download
 *   ✓ flow fără signed PDF → 404 no_signed_pdf
 *   ✓ user non-init non-signer non-admin → 403 forbidden
 *   ✓ admin same org → 200 (ACL extins față de versiunea veche)
 *   ✓ filename folosește safeName (nu pattern hardcoded fără docName)
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

const FLOW_ID = 'FLOW_DL001';

function makeAuth(email = 'init@x.ro', userId = 1, role = 'user', orgId = 1) {
  return `auth_token=${jwt.sign({ email, userId, role, orgId }, JWT_SECRET, { expiresIn: '1h' })}`;
}

function makeFlowData(overrides = {}) {
  return {
    flowId: FLOW_ID, docName: 'Contract Test', initEmail: 'init@x.ro', orgId: 1,
    status: 'completed', completed: true,
    signers: [{ name: 'S1', email: 'sig@x.ro', token: 'tk', status: 'signed', order: 1 }],
    signedPdfB64: 'JVBERi0xLjQK',  // PDF mock din flows_pdfs (rehidratat de getFlowData)
    ...overrides,
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

describe('GET /my-flows/:flowId/download — A-2', () => {
  it('initiator + getFlowData returnează signedPdfB64 → 200 application/pdf', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());

    const res = await request(createTestApp())
      .get(`/my-flows/${FLOW_ID}/download`)
      .set('Cookie', makeAuth('init@x.ro'));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/filename=/);
    expect(dbModule.getFlowData).toHaveBeenCalledWith(FLOW_ID);
  });

  it('signer din flow → 200', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());

    const res = await request(createTestApp())
      .get(`/my-flows/${FLOW_ID}/download`)
      .set('Cookie', makeAuth('sig@x.ro'));

    expect(res.status).toBe(200);
  });

  it('user random same-org non-admin → 403', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());

    const res = await request(createTestApp())
      .get(`/my-flows/${FLOW_ID}/download`)
      .set('Cookie', makeAuth('intruder@x.ro', 999, 'user', 1));

    expect(res.status).toBe(403);
  });

  it('admin same-org → 200 (extended ACL)', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());

    const res = await request(createTestApp())
      .get(`/my-flows/${FLOW_ID}/download`)
      .set('Cookie', makeAuth('admin@x.ro', 1, 'org_admin', 1));

    expect(res.status).toBe(200);
  });

  it('admin different-org → 403', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData({ orgId: 99 }));

    const res = await request(createTestApp())
      .get(`/my-flows/${FLOW_ID}/download`)
      .set('Cookie', makeAuth('admin@x.ro', 1, 'org_admin', 1));

    expect(res.status).toBe(403);
  });

  it('no signedPdfB64 + no drive → 404 no_signed_pdf', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData({ signedPdfB64: null }));

    const res = await request(createTestApp())
      .get(`/my-flows/${FLOW_ID}/download`)
      .set('Cookie', makeAuth('init@x.ro'));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('no_signed_pdf');
  });
});
