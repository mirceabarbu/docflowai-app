/**
 * #207 — P0-06 flip: OBSERVARE → RESPINGERE pe POST /flows/:flowId/upload-signed-pdf.
 *
 * Invariant: numărul de semnături din PDF-ul urcat trebuie să CREASCĂ față de versiunea
 * anterioară (`signedPdfB64` sau `pdfB64`). Altfel 422 `pdf_not_signed` + audit
 * `P0_06_REJECTED_UNSIGNED`, iar fluxul NU avansează (nimic persistat). Verificator
 * defect ⇒ 503 `verification_unavailable` (cod DISTINCT), fluxul neschimbat.
 *
 * Context: măsurat pe producție la 15.09.2026 — 11157 upload-uri / 2559 fluxuri, toate
 * prin sts-cloud, zero observări P0-06. Calea manuală are zero utilizări; flip-ul e o
 * poartă închisă PREVENTIV pe o cale nefolosită, nu una validată pe trafic real.
 *
 * Fixture-uri PREEXISTENTE cu număr cunoscut de semnături (numărate cu
 * extractPdfSignatures, sursa de adevăr a rutei):
 *   - server/tests/fixtures/sts-signed-staging.pdf → 1 semnătură
 *   - server/tests/fixtures/f1129_sample.pdf       → 3 semnături
 * Testul măsoară DOAR invariantul de număr — ruta nu validează criptografic aici.
 *
 * ⚠️ Garda de hash (`uploadedHash === preHash`) e ÎNAINTEA blocului P0-06 și dă tot 422
 * `pdf_not_signed`. Ca să dovedim că respinge P0-06 (nu garda de hash), `preHash` din
 * uploadToken e DIFERIT de hash-ul fișierului urcat (exact situația semnatarului 2+, unde
 * garda de hash e moartă structural), iar corpul 422 poartă `sigBefore`/`sigAfter`.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

vi.mock('../../db/index.mjs', () => ({
  pool:              { query: vi.fn() },
  DB_READY:          true,
  requireDb:         vi.fn(() => false),
  saveFlow:          vi.fn().mockResolvedValue(undefined),
  getFlowData:       vi.fn(),
  writeAuditEvent:   vi.fn().mockResolvedValue(undefined),
  getDefaultOrgId:   vi.fn().mockResolvedValue(1),
  getUserMapForOrg:  vi.fn().mockResolvedValue({}),
  DB_LAST_ERROR:     null,
}));
vi.mock('../../middleware/logger.mjs', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  },
}));
vi.mock('../../emailTemplates.mjs', () => ({
  emailYourTurn:      vi.fn(() => ({ subject: 's', html: '<p>t</p>' })),
  emailGeneric:       vi.fn(() => ({ subject: 's', html: '<p>t</p>' })),
  emailDelegare:      vi.fn(() => ({ subject: 's', html: '<p>t</p>' })),
  emailResetPassword: vi.fn(() => ({ subject: 's', html: '<p>t</p>' })),
  emailCredentials:   vi.fn(() => ({ subject: 's', html: '<p>t</p>' })),
  emailVerifyGws:     vi.fn(() => ({ subject: 's', html: '<p>t</p>' })),
  emailSendExtern:    vi.fn(() => ({ html: '<p>t</p>' })),
}));
// Rate limiter-ul de upload (5/min per IP) ar bloca al 6-lea test; nu e obiectul acestui fișier.
vi.mock('../../middleware/rateLimiter.mjs', () => ({
  createRateLimiter: () => (req, res, next) => next(),
}));
// Verificatorul REAL, dar spy-uibil — cazul 9 îl face să arunce o singură dată.
vi.mock('../../services/certificate-verify.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, extractPdfSignatures: vi.fn(actual.extractPdfSignatures) };
});

import * as dbModule from '../../db/index.mjs';
import { extractPdfSignatures } from '../../services/certificate-verify.mjs';
import flowsRouter, { injectFlowDeps } from '../../routes/flows.mjs';
import { JWT_SECRET } from '../../middleware/auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PDF_1SIG = fs.readFileSync(path.join(__dirname, '../fixtures/sts-signed-staging.pdf'));
const PDF_3SIG = fs.readFileSync(path.join(__dirname, '../fixtures/f1129_sample.pdf'));

const FLOW_ID = 'P006_FLIP1';
const SIGNER_TOKEN = crypto.randomBytes(16).toString('hex');
const OTHER_TOKEN  = crypto.randomBytes(16).toString('hex');

function makeFlow(prevPdf) {
  return {
    flowId: FLOW_ID, docName: 'Referat P0-06', initName: 'Ion Popescu', initEmail: 'init@primaria.ro',
    orgId: 1, flowType: 'tabel', status: 'active', completed: false, events: [],
    signedPdfB64: prevPdf.toString('base64'),
    signers: [
      { order: 1, name: 'Semnatar Unu', email: 'signer1@primaria.ro', rol: 'AVIZAT', token: SIGNER_TOKEN,
        tokenCreatedAt: new Date().toISOString(), status: 'signed', signedAt: new Date().toISOString() },
      { order: 2, name: 'Semnatar Doi', email: 'signer2@primaria.ro', rol: 'APROBAT', token: OTHER_TOKEN,
        tokenCreatedAt: new Date().toISOString(), status: 'pending', signedAt: null },
    ],
  };
}

/** uploadToken cu preHash care NU corespunde fișierului urcat — trece de garda de hash. */
function uploadTokenFor(flowId) {
  return jwt.sign({ flowId, signerToken: SIGNER_TOKEN, preHash: 'deadbeef'.repeat(8) }, JWT_SECRET, { expiresIn: '4h' });
}

function createTestApp() {
  injectFlowDeps({
    notify: vi.fn().mockResolvedValue(undefined), wsPush: vi.fn(), PDFLib: null, stampFooterOnPdf: null,
    isSignerTokenExpired: () => false, newFlowId: () => FLOW_ID,
    buildSignerLink: (req, fid, tok) => `https://app/semdoc-signer.html?flow=${fid}&token=${tok}`,
    stripSensitive: (d) => d, stripPdfB64: (d) => d,
    sendSignerEmail: vi.fn().mockResolvedValue({ ok: true }),
  });
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '50mb' }));
  app.use(cookieParser());
  app.use('/', flowsRouter);
  return app;
}

function upload(app, pdfBuf) {
  return request(app).post(`/flows/${FLOW_ID}/upload-signed-pdf`)
    .send({ token: SIGNER_TOKEN, uploadToken: uploadTokenFor(FLOW_ID), signedPdfB64: pdfBuf.toString('base64') });
}

const auditTypes = () => dbModule.writeAuditEvent.mock.calls.map(c => c[0]?.eventType);

beforeEach(() => {
  vi.clearAllMocks();
  dbModule.pool.query.mockReset();
  dbModule.saveFlow.mockReset();
  dbModule.getFlowData.mockReset();
  dbModule.pool.query.mockResolvedValue({ rows: [] });
  extractPdfSignatures.mockClear();
});

describe('#207 P0-06 flip — POST /flows/:flowId/upload-signed-pdf', () => {
  it('premisă: fixture-urile au 1 și respectiv 3 semnături (numărate de verificatorul rutei)', () => {
    expect(extractPdfSignatures(PDF_1SIG)).toHaveLength(1);
    expect(extractPdfSignatures(PDF_3SIG)).toHaveLength(3);
  });

  it('⭐ 7. același număr de semnături (1 → 1) ⇒ 422 pdf_not_signed, fluxul NEschimbat', async () => {
    const flow = makeFlow(PDF_1SIG);
    const before = JSON.stringify({ signedPdfB64: flow.signedPdfB64, events: flow.events, versions: flow.signedPdfVersions, s2: flow.signers[1].status });
    dbModule.getFlowData.mockResolvedValue(flow);

    const res = await upload(createTestApp(), PDF_1SIG);

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('pdf_not_signed');
    // Dovada că a respins P0-06, nu garda de hash: corpul poartă contorul de semnături.
    expect(res.body.sigBefore).toBe(1);
    expect(res.body.sigAfter).toBe(1);

    // Nimic persistat: fără saveFlow, fără SIGNED_PDF_UPLOADED, fără mutații pe data.
    expect(dbModule.saveFlow).not.toHaveBeenCalled();
    expect(auditTypes()).not.toContain('SIGNED_PDF_UPLOADED');
    expect(JSON.stringify({ signedPdfB64: flow.signedPdfB64, events: flow.events, versions: flow.signedPdfVersions, s2: flow.signers[1].status })).toBe(before);
    expect(flow.signers[1].status).toBe('pending'); // semnatarul următor NU a devenit current
  });

  it('⭐ 10. cazul 7 scrie evenimentul de audit P0_06_REJECTED_UNSIGNED (tip NOU, distinct de observarea istorică)', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlow(PDF_1SIG));
    const res = await upload(createTestApp(), PDF_1SIG);
    expect(res.status).toBe(422);
    const ev = dbModule.writeAuditEvent.mock.calls.map(c => c[0]).find(e => e.eventType === 'P0_06_REJECTED_UNSIGNED');
    expect(ev).toBeDefined();
    expect(ev.flowId).toBe(FLOW_ID);
    expect(ev.actorEmail).toBe('signer1@primaria.ro');
    expect(ev.payload).toEqual({ sigBefore: 1, sigAfter: 1 });
    expect(auditTypes()).not.toContain('P0_06_OBSERVED_UNSIGNED');
  });

  it('⭐ 8. o semnătură în plus (1 → 3) ⇒ 200, fluxul avansează (calea fericită, neregresie)', async () => {
    const flow = makeFlow(PDF_1SIG);
    dbModule.getFlowData.mockResolvedValue(flow);

    const res = await upload(createTestApp(), PDF_3SIG);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.completed).toBe(false);
    expect(dbModule.saveFlow).toHaveBeenCalledTimes(1);
    expect(dbModule.saveFlow.mock.calls[0][0]).toBe(FLOW_ID);
    expect(flow.signedPdfB64).toBe(PDF_3SIG.toString('base64'));
    expect(flow.signedPdfVersions).toHaveLength(1);
    expect(flow.events.map(e => e.type)).toContain('SIGNED_PDF_UPLOADED');
    expect(flow.signers[0].pdfUploaded).toBe(true);
    expect(flow.signers[1].status).toBe('current');
    expect(auditTypes()).toContain('SIGNED_PDF_UPLOADED');
    expect(auditTypes()).not.toContain('P0_06_REJECTED_UNSIGNED');
  });

  it('⭐ 9. extractPdfSignatures aruncă ⇒ 503 verification_unavailable (NU 422), fluxul neschimbat', async () => {
    const flow = makeFlow(PDF_1SIG);
    dbModule.getFlowData.mockResolvedValue(flow);
    extractPdfSignatures.mockImplementationOnce(() => { throw new Error('verifier down'); });

    const res = await upload(createTestApp(), PDF_3SIG);

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('verification_unavailable');
    expect(dbModule.saveFlow).not.toHaveBeenCalled();
    expect(flow.signedPdfB64).toBe(PDF_1SIG.toString('base64'));
    expect(flow.events).toEqual([]);
    expect(flow.signers[1].status).toBe('pending');
    expect(auditTypes()).not.toContain('SIGNED_PDF_UPLOADED');
    expect(auditTypes()).not.toContain('P0_06_REJECTED_UNSIGNED');
  });

  it('prima semnătură pe un flux fără signedPdfB64 (pdfB64 nesemnat → 1 semnătură) ⇒ 200', async () => {
    const flow = makeFlow(PDF_1SIG);
    delete flow.signedPdfB64;
    flow.pdfB64 = Buffer.from('%PDF-1.4 nesemnat').toString('base64'); // 0 semnături
    dbModule.getFlowData.mockResolvedValue(flow);

    const res = await upload(createTestApp(), PDF_1SIG);
    expect(res.status).toBe(200);
    expect(dbModule.saveFlow).toHaveBeenCalledTimes(1);
  });
});
