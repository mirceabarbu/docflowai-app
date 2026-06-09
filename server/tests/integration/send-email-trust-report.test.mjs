/**
 * DocFlowAI — Integration tests: send-email + Raport de Conformitate (Trust Report)
 *
 * Montează router-ul REAL din routes/flows/email.mjs și verifică noul branch
 * `includeTrustReport` (v3.9.548):
 *   ✓ includeTrustReport:true + report_pdf în cache → atașament Raport_Conformitate_* trimis
 *   ✓ includeTrustReport:true + cache gol → generateTrustReport() generează și atașează
 *   ✓ includeTrustReport:false → fără atașament Raport_Conformitate_*
 *   ✓ NON-FATAL: generateTrustReport() aruncă → 200 OK, email pleacă fără raport
 *   ✓ audit/eveniment EMAIL_SENT conține includeTrustReport + trustReportAttached
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

// ── Mock-uri ESM ──────────────────────────────────────────────────────────────

vi.mock('../../db/index.mjs', () => ({
  pool:              { query: vi.fn() },
  DB_READY:          true,
  requireDb:         vi.fn(() => false),
  saveFlow:          vi.fn().mockResolvedValue(undefined),
  getFlowData:       vi.fn(),
  getDefaultOrgId:   vi.fn().mockResolvedValue(1),
  getUserMapForOrg:  vi.fn().mockResolvedValue({}),
  writeAuditEvent:   vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../middleware/logger.mjs', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  },
}));

vi.mock('../../emailTemplates.mjs', () => ({
  emailSendExtern: vi.fn(() => ({ html: '<html><body>test</body></html>' })),
}));

vi.mock('../../services/sign-trust-report.mjs', () => ({
  generateTrustReport: vi.fn(),
}));

// ── Imports după mock-uri ─────────────────────────────────────────────────────

import * as dbModule from '../../db/index.mjs';
import { generateTrustReport } from '../../services/sign-trust-report.mjs';
import emailRouter from '../../routes/flows/email.mjs';
import { JWT_SECRET } from '../../middleware/auth.mjs';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeToken(overrides = {}) {
  return jwt.sign(
    { userId: 1, email: 'init@primaria.ro', role: 'user', orgId: 1, nume: 'Ion Popescu', ...overrides },
    JWT_SECRET, { expiresIn: '2h' }
  );
}

function makeCompletedFlow(overrides = {}) {
  return {
    flowId: 'PT_REPORT1', docName: 'Referat test', orgId: 1,
    initEmail: 'init@primaria.ro',
    status: 'completed', completed: true,
    signedPdfB64: Buffer.from('%PDF-1.7 fake signed pdf bytes').toString('base64'),
    signers: [{ name: 'Semnatar', email: 'signer@primaria.ro', rol: 'APROBAT', status: 'signed', signedAt: new Date().toISOString() }],
    events: [],
    ...overrides,
  };
}

let fetchCalls;

/** pool.query rutat pe textul SQL — robust la refactor de ordine */
function setupPoolQuery({ trustRows = [] } = {}) {
  dbModule.pool.query.mockImplementation((sql) => {
    if (/FROM users/i.test(sql)) {
      return Promise.resolve({ rows: [{ nume: 'Ion Popescu', functie: 'Primar', institutie: 'Primăria Test', compartiment: 'Secretariat', email: 'init@primaria.ro' }] });
    }
    if (/trust_reports/i.test(sql)) return Promise.resolve({ rows: trustRows });
    return Promise.resolve({ rows: [] });
  });
}

function createTestApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '50mb' }));
  app.use(cookieParser());
  app.use('/', emailRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.RESEND_API_KEY = 'test-resend-key';
  fetchCalls = [];
  global.fetch = vi.fn(async (url, opts) => {
    fetchCalls.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ id: 'resend-msg-1' }) };
  });
  dbModule.getFlowData.mockResolvedValue(makeCompletedFlow());
  dbModule.saveFlow.mockResolvedValue(undefined);
  dbModule.writeAuditEvent.mockResolvedValue(undefined);
});

const app = createTestApp();

function send(body) {
  return request(app)
    .post('/flows/PT_REPORT1/send-email')
    .set('Authorization', 'Bearer ' + makeToken())
    .send({ to: 'dest@extern.ro', subject: 'Document semnat', bodyText: 'mesaj', ...body });
}

describe('send-email — atașare Raport de Conformitate', () => {
  it('includeTrustReport:true + report_pdf în cache → atașează raportul din cache', async () => {
    const cached = Buffer.from('%PDF-1.7 cached trust report bytes over 100 chars '.repeat(3));
    setupPoolQuery({ trustRows: [{ report_pdf: cached }] });

    const res = await send({ includeTrustReport: true });
    expect(res.status).toBe(200);

    // generateTrustReport NU e apelat — servit din cache
    expect(generateTrustReport).not.toHaveBeenCalled();
    const attachments = fetchCalls[0].attachments;
    const report = attachments.find(a => a.filename.startsWith('Raport_Conformitate_'));
    expect(report).toBeDefined();
    expect(report.filename).toBe('Raport_Conformitate_PT_REPORT1.pdf');
    expect(report.content).toBe(cached.toString('base64'));
  });

  it('includeTrustReport:true + cache gol → generateTrustReport() generează și atașează', async () => {
    setupPoolQuery({ trustRows: [] });
    const generated = Buffer.from('%PDF-1.7 freshly generated report bytes over 100 chars '.repeat(3));
    generateTrustReport.mockResolvedValue({ pdfBytes: generated });

    const res = await send({ includeTrustReport: true });
    expect(res.status).toBe(200);

    expect(generateTrustReport).toHaveBeenCalledOnce();
    const callArg = generateTrustReport.mock.calls[0][0];
    expect(callArg.flowId).toBe('PT_REPORT1');
    expect(Buffer.isBuffer(callArg.pdfBytes)).toBe(true); // bytes-ul PDF-ului semnat

    const report = fetchCalls[0].attachments.find(a => a.filename.startsWith('Raport_Conformitate_'));
    expect(report).toBeDefined();
    expect(report.content).toBe(generated.toString('base64'));
  });

  it('includeTrustReport:false → fără atașament Raport_Conformitate_*', async () => {
    setupPoolQuery({ trustRows: [{ report_pdf: Buffer.from('x'.repeat(200)) }] });

    const res = await send({ includeTrustReport: false });
    expect(res.status).toBe(200);

    expect(generateTrustReport).not.toHaveBeenCalled();
    const report = fetchCalls[0].attachments?.find(a => a.filename.startsWith('Raport_Conformitate_'));
    expect(report).toBeUndefined();
    // PDF-ul semnat rămâne atașat
    expect(fetchCalls[0].attachments.some(a => a.filename.endsWith('_semnat.pdf'))).toBe(true);
  });

  it('NON-FATAL: generateTrustReport aruncă → 200 OK, email pleacă fără raport', async () => {
    setupPoolQuery({ trustRows: [] });
    generateTrustReport.mockRejectedValue(new Error('boom — generare raport eșuată'));

    const res = await send({ includeTrustReport: true });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // emailul a plecat, dar fără raport
    expect(fetchCalls.length).toBe(1);
    const report = fetchCalls[0].attachments?.find(a => a.filename.startsWith('Raport_Conformitate_'));
    expect(report).toBeUndefined();
  });

  it('eveniment + audit EMAIL_SENT conțin includeTrustReport + trustReportAttached', async () => {
    const cached = Buffer.from('%PDF-1.7 cached report '.repeat(10));
    setupPoolQuery({ trustRows: [{ report_pdf: cached }] });

    await send({ includeTrustReport: true });

    // audit
    const auditCall = dbModule.writeAuditEvent.mock.calls.find(c => c[0].eventType === 'EMAIL_SENT');
    expect(auditCall[0].payload.includeTrustReport).toBe(true);
    expect(auditCall[0].payload.trustReportAttached).toBe(true);

    // eveniment salvat în flow
    const savedData = dbModule.saveFlow.mock.calls[0][1];
    const ev = savedData.events.find(e => e.type === 'EMAIL_SENT');
    expect(ev.includeTrustReport).toBe(true);
    expect(ev.trustReportAttached).toBe(true);
  });
});
