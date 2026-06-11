/**
 * presigned-upload.test.mjs (v3.9.552)
 *
 * Creare flux cu PDF deja semnat la upload:
 *   - toți semnatarii primesc padesRect (page = ultima pagină)
 *   - data.preSignedUpload === true + eveniment PRESIGNED_UPLOAD_DETECTED
 *   - răspunsul API conține preSignedUpload:true
 * Creare flux cu PDF normal: comportament neschimbat (footer aplicat,
 *   stampFooterOnPdf apelat, fără flag).
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import zlib from 'node:zlib';
import * as PDFLib from 'pdf-lib';

vi.mock('../../db/index.mjs', () => {
  const mockQuery = vi.fn();
  return {
    pool:         { query: mockQuery },
    DB_READY:     true,
    requireDb:    vi.fn(() => false),
    saveFlow:     vi.fn().mockResolvedValue(undefined),
    getFlowData:  vi.fn(),
    getDefaultOrgId: vi.fn().mockResolvedValue(1),
    getUserMapForOrg: vi.fn().mockResolvedValue({}),
    writeAuditEvent: vi.fn().mockResolvedValue(undefined),
    initDbWithRetry: vi.fn(),
    DB_LAST_ERROR: null,
  };
});

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
}));

vi.mock('../../middleware/rateLimiter.mjs', () => ({
  createRateLimiter: () => (_req, _res, next) => next(),
}));

vi.mock('../../services/registratura.mjs', () => ({
  allocateNumber: vi.fn().mockResolvedValue(null),
}));

import * as dbModule from '../../db/index.mjs';
import flowsRouter, { injectFlowDeps } from '../../routes/flows.mjs';
import jwt from 'jsonwebtoken';

const TEST_JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-for-vitest';
process.env.JWT_SECRET = TEST_JWT_SECRET;

// ── PDF builder minimal (1 pagină, conținut sus) ───────────────────────────
function buildPdf(extraCatalog = '') {
  const stream = `BT /F1 12 Tf 1 0 0 1 50 800 Tm (titlu) Tj ET\n`;
  const compressed = zlib.deflateSync(Buffer.from(stream, 'latin1'));
  let buf = Buffer.from('%PDF-1.4\n', 'latin1');
  const offsets = [];
  const pushObj = (s) => { offsets.push(buf.length); buf = Buffer.concat([buf, Buffer.from(s, 'latin1')]); };
  const pushRaw = (parts) => { offsets.push(buf.length); buf = Buffer.concat([buf, ...parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p, 'latin1'))]); };
  pushObj(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R ${extraCatalog} >>\nendobj\n`);
  pushObj(`2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`);
  pushObj(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n`);
  pushRaw([`4 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`, compressed, `\nendstream\nendobj\n`]);
  pushObj(`5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);
  const xrefOff = buf.length;
  const total = offsets.length + 1;
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefOff}\n%%EOF\n`;
  buf = Buffer.concat([buf, Buffer.from(xref, 'latin1')]);
  return buf.toString('base64');
}

const SIGNED_PDF = buildPdf('/SigMark /ByteRange'); // pdfLooksSigned → true
const CLEAN_PDF  = buildPdf();                       // pdfLooksSigned → false

const stampSpy = vi.fn().mockImplementation(async (pdf) => pdf);

function createTestApp() {
  injectFlowDeps({
    notify:                vi.fn().mockResolvedValue(undefined),
    wsPush:                vi.fn(),
    PDFLib,                                          // PDFLib REAL — necesar pentru computeSignerRectsReadOnly
    stampFooterOnPdf:      stampSpy,
    isSignerTokenExpired:  vi.fn().mockReturnValue(false),
    newFlowId:             vi.fn().mockReturnValue('TEST_PRESIGN001'),
    buildSignerLink:       vi.fn().mockReturnValue('https://app.test/sign'),
    stripSensitive:        vi.fn().mockImplementation((d) => d),
    stripPdfB64:           vi.fn().mockImplementation((d) => d),
    sendSignerEmail:       vi.fn().mockResolvedValue({ ok: true }),
    jsonPdfParser:         express.json({ limit: '52mb' }),
  });
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use(cookieParser());
  app.use('/', flowsRouter);
  return app;
}

function makeAuthCookie() {
  const payload = { email: 'initiator@primaria.ro', role: 'user', orgId: 1 };
  return `auth_token=${jwt.sign(payload, TEST_JWT_SECRET, { expiresIn: '1h' })}`;
}

function payload(overrides = {}) {
  return {
    docName:   'Document deja semnat',
    initName:  'Ion Popescu',
    initEmail: 'initiator@primaria.ro',
    signers: [
      { order: 1, name: 'Maria Ionescu', email: 'maria@primaria.ro', rol: 'APROBAT' },
      { order: 2, name: 'Vasile Pop',    email: 'vasile@primaria.ro', rol: 'AVIZAT' },
    ],
    flowType: 'tabel',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  stampSpy.mockImplementation(async (pdf) => pdf);
  dbModule.pool.query
    .mockResolvedValueOnce({ rows: [{ org_id: 1 }] })
    .mockResolvedValueOnce({ rows: [{ functie: 'Referent', compartiment: '', institutie: 'Primăria Test' }] });
});

describe('POST /flows — PDF pre-semnat la upload', () => {
  it('PDF semnat → padesRect pe toți, preSignedUpload + eveniment, footer omis', async () => {
    const app = createTestApp();
    const res = await request(app).post('/flows')
      .set('Cookie', makeAuthCookie())
      .send(payload({ pdfB64: SIGNED_PDF }));

    expect(res.status).toBe(200);
    expect(res.body.preSignedUpload).toBe(true);

    // stampFooterOnPdf NU trebuie apelat pe PDF semnat
    expect(stampSpy).not.toHaveBeenCalled();

    // Inspectează data salvată
    const saved = dbModule.saveFlow.mock.calls[0][1];
    expect(saved.preSignedUpload).toBe(true);
    expect(saved.signers).toHaveLength(2);
    for (const s of saved.signers) {
      expect(s.padesRect).toBeTruthy();
      expect(s.padesRect.page).toBe(1); // ultima (singura) pagină
      expect(s.padesRect.h).toBe(65);
    }
    const ev = saved.events.find(e => e.type === 'PRESIGNED_UPLOAD_DETECTED');
    expect(ev).toBeTruthy();
  });

  it('PDF normal → footer aplicat (stampFooterOnPdf apelat), fără flag', async () => {
    const app = createTestApp();
    const res = await request(app).post('/flows')
      .set('Cookie', makeAuthCookie())
      .send(payload({ pdfB64: CLEAN_PDF }));

    expect(res.status).toBe(200);
    expect(res.body.preSignedUpload).toBe(false);
    expect(stampSpy).toHaveBeenCalledTimes(1);

    const saved = dbModule.saveFlow.mock.calls[0][1];
    expect(saved.preSignedUpload).toBe(false);
    expect(saved.events.find(e => e.type === 'PRESIGNED_UPLOAD_DETECTED')).toBeFalsy();
  });
});
