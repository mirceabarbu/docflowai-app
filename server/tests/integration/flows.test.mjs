/**
 * DocFlowAI — Integration tests: Flows (creare, GET, sign, refuse, delegate, cancel)
 *
 * Acoperire:
 *
 * POST /flows — creare flux
 *   ✓ 400 docName lipsă / prea scurt
 *   ✓ 400 docName prea lung (>500)
 *   ✓ 400 initName lipsă / prea scurt
 *   ✓ 400 initEmail invalid
 *   ✓ 400 signers lipsă
 *   ✓ 400 signer email invalid
 *   ✓ 400 signer name lipsă
 *   ✓ 400 semnatari duplicați
 *   ✓ 400 prea mulți semnatari (>50)
 *   ✓ 413 PDF prea mare (>50MB)
 *   ✓ 200 creare reușită — răspuns corect
 *   ✓ 200 inițiatorul este și semnatar — signerToken inclus
 *
 * GET /flows/:flowId
 *   ✓ 404 flux inexistent
 *   ✓ 401 fără autentificare și fără token
 *   ✓ 403 token semnatar invalid
 *   ✓ 200 acces cu token semnatar valid
 *   ✓ 200 acces autentificat — câmpuri sensibile absente
 *
 * POST /flows/:flowId/sign
 *   ✓ 400 signature lipsă
 *   ✓ 400 token invalid
 *   ✓ 404 flux inexistent
 *   ✓ 409 flux anulat
 *   ✓ 409 nu e rândul acestui semnatar (status pending)
 *   ✓ 403 token expirat
 *   ✓ 200 semnare reușită — status actualizat
 *   ✓ 200 semnare — awaitingUpload=true în răspuns
 *
 * POST /flows/:flowId/refuse
 *   ✓ 400 reason lipsă
 *   ✓ 400 reason prea lungă (>1000)
 *   ✓ 400 token invalid
 *   ✓ 404 flux inexistent
 *   ✓ 409 flux anulat
 *   ✓ 409 nu e rândul acestui semnatar
 *   ✓ 200 refuz reușit — status flux actualizat
 *
 * POST /flows/:flowId/delegate
 *   ✓ 400 fromToken lipsă
 *   ✓ 400 toEmail invalid
 *   ✓ 400 reason lipsă
 *   ✓ 400 auto-delegare (fromToken și toEmail același user)
 *   ✓ 400 token invalid
 *   ✓ 409 flux anulat
 *   ✓ 200 delegare reușită — semnatar actualizat
 *
 * POST /flows/:flowId/cancel
 *   ✓ 401 fără autentificare
 *   ✓ 403 user care nu e inițiator
 *   ✓ 404 flux inexistent
 *   ✓ 200 anulare de inițiator
 *   ✓ 200 anulare de admin
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

// ── Mock-uri ESM ──────────────────────────────────────────────────────────────

vi.mock('../../db/index.mjs', () => {
  const mockQuery  = vi.fn();
  const mockSave   = vi.fn();
  const mockGet    = vi.fn();
  const mockAudit  = vi.fn();
  const mockOrgId  = vi.fn().mockResolvedValue(1);
  const mockUserMap = vi.fn().mockResolvedValue({});
  return {
    pool:              { query: mockQuery },
    DB_READY:          true,
    requireDb:         vi.fn(() => false),
    saveFlow:          mockSave,
    getFlowData:       mockGet,
    writeAuditEvent:   mockAudit,
    getDefaultOrgId:   mockOrgId,
    getUserMapForOrg:  mockUserMap,
    DB_LAST_ERROR:     null,
  };
});

vi.mock('../../middleware/logger.mjs', () => ({
  logger: {
    info:  vi.fn(), warn:  vi.fn(), error: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  },
}));

// ── Imports după mock-uri ─────────────────────────────────────────────────────

import * as dbModule from '../../db/index.mjs';
import flowsRouter, { injectFlowDeps } from '../../routes/flows.mjs';
import { JWT_SECRET } from '../../middleware/auth.mjs';

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-vitest-docflowai-2025';

/** Token JWT valid pentru un utilizator */
function makeToken(overrides = {}) {
  return jwt.sign(
    { userId: 1, email: 'init@primaria.ro', role: 'user', orgId: 1, nume: 'Ion Popescu', ...overrides },
    TEST_JWT_SECRET,
    { expiresIn: '2h' }
  );
}

function makeAdminToken() {
  return makeToken({ role: 'admin', email: 'admin@primaria.ro' });
}

/** Flux minimal valid pentru mock getFlowData */
function makeFlow(overrides = {}) {
  const token1 = crypto.randomBytes(16).toString('hex');
  const token2 = crypto.randomBytes(16).toString('hex');
  return {
    flowId:    'TEST_ABCD1',
    docName:   'Referat test',
    initName:  'Ion Popescu',
    initEmail: 'init@primaria.ro',
    institutie: 'Primăria Test',
    compartiment: 'Secretariat',
    orgId: 1,
    flowType: 'tabel',
    urgent: false,
    status: 'active',
    completed: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    events: [],
    signers: [
      {
        order: 1, name: 'Semnatar Unu', email: 'signer1@primaria.ro',
        rol: 'AVIZAT', token: token1,
        tokenCreatedAt: new Date().toISOString(),
        status: 'current', signedAt: null,
      },
      {
        order: 2, name: 'Semnatar Doi', email: 'signer2@primaria.ro',
        rol: 'APROBAT', token: token2,
        tokenCreatedAt: new Date().toISOString(),
        status: 'pending', signedAt: null,
      },
    ],
    ...overrides,
  };
}

/** App Express minimal cu flows router */
function createTestApp({ jsonLimit = '50mb' } = {}) {
  injectFlowDeps({
    notify:               vi.fn().mockResolvedValue(undefined),
    wsPush:               vi.fn(),
    PDFLib:               null,
    stampFooterOnPdf:     null,
    isSignerTokenExpired: () => false,
    newFlowId:            () => 'TEST_ABCD1',
    buildSignerLink:      (req, fid, tok) => `https://app/semdoc-signer.html?flow=${fid}&token=${tok}`,
    stripSensitive:       (d, callerSignerToken) => {
      const { pdfB64, signedPdfB64, ...rest } = d;
      return {
        ...rest,
        signers: (d.signers || []).map(s => {
          const { token, ...signerRest } = s;
          // Semnatarul curent vede propriul token; ceilalți nu
          return (callerSignerToken && s.token === callerSignerToken)
            ? { ...signerRest, token }
            : signerRest;
        }),
      };
    },
    stripPdfB64:          (d) => { const { pdfB64, signedPdfB64, ...rest } = d; return rest; },
    sendSignerEmail:      vi.fn().mockResolvedValue({ ok: true }),
  });

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: jsonLimit }));
  app.use(cookieParser());
  app.use('/', flowsRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbModule.pool.query.mockReset();
  dbModule.saveFlow.mockReset();
  dbModule.getFlowData.mockReset();
  // Default: pool.query returnează rows goale (nu crape la fallback queries)
  dbModule.pool.query.mockResolvedValue({ rows: [] });
  dbModule.saveFlow.mockResolvedValue(undefined);
  dbModule.writeAuditEvent.mockResolvedValue(undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /flows — Creare flux
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /flows — validare input', () => {

  it('400 — docName lipsă', async () => {
    const app = createTestApp();
    const res = await request(app).post('/flows')
      .send({ initName: 'Ion', initEmail: 'a@b.com', signers: [{ name: 'X Y', email: 'x@b.com' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('docName_required');
  });

  it('400 — docName prea scurt (1 char)', async () => {
    const app = createTestApp();
    const res = await request(app).post('/flows')
      .send({ docName: 'X', initName: 'Ion', initEmail: 'a@b.com', signers: [{ name: 'X Y', email: 'x@b.com' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('docName_required');
  });

  it('400 — docName prea lung (>500 chars)', async () => {
    const app = createTestApp();
    const res = await request(app).post('/flows')
      .send({ docName: 'A'.repeat(501), initName: 'Ion', initEmail: 'a@b.com', signers: [{ name: 'X Y', email: 'x@b.com' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('docName_too_long');
    expect(res.body.max).toBe(500);
  });

  it('400 — initName lipsă', async () => {
    const app = createTestApp();
    const res = await request(app).post('/flows')
      .send({ docName: 'Referat', initEmail: 'a@b.com', signers: [{ name: 'X Y', email: 'x@b.com' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('initName_required');
  });

  it('400 — initEmail invalid', async () => {
    const app = createTestApp();
    const res = await request(app).post('/flows')
      .send({ docName: 'Referat', initName: 'Ion Popescu', initEmail: 'nu-e-email', signers: [{ name: 'X Y', email: 'x@b.com' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('initEmail_invalid');
  });

  it('400 — signers lipsă (array gol)', async () => {
    const app = createTestApp();
    const res = await request(app).post('/flows')
      .send({ docName: 'Referat', initName: 'Ion', initEmail: 'a@b.com', signers: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('signers_required');
  });

  it('400 — signer email invalid', async () => {
    const app = createTestApp();
    const res = await request(app).post('/flows')
      .send({ docName: 'Referat', initName: 'Ion', initEmail: 'a@b.com', signers: [{ name: 'X Y', email: 'nu-email' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('signer_email_invalid');
    expect(res.body.index).toBe(0);
  });

  it('400 — signer name prea scurt', async () => {
    const app = createTestApp();
    const res = await request(app).post('/flows')
      .send({ docName: 'Referat', initName: 'Ion', initEmail: 'a@b.com', signers: [{ name: 'X', email: 'x@b.com' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('signer_name_required');
  });

  it('400 — semnatari duplicați', async () => {
    const app = createTestApp();
    const res = await request(app).post('/flows')
      .send({
        docName: 'Referat', initName: 'Ion', initEmail: 'a@b.com',
        signers: [
          { name: 'Semnatar Unu', email: 'dup@b.com' },
          { name: 'Semnatar Doi', email: 'DUP@b.com' },  // duplicat case-insensitive
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('duplicate_signer_emails');
  });

  it('400 — prea mulți semnatari (51)', async () => {
    const app = createTestApp();
    const signers = Array.from({ length: 51 }, (_, i) => ({ name: `Semnatar ${i}`, email: `s${i}@b.com` }));
    const res = await request(app).post('/flows')
      .send({ docName: 'Referat', initName: 'Ion', initEmail: 'a@b.com', signers });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('too_many_signers');
    expect(res.body.max).toBe(50);
  });

  it('413 — PDF prea mare (>50MB)', async () => {
    // Limita middleware ridicată la 200mb ca să ajungă la handler (care verifică >50MB bytes estimați).
    // String de ~67MB caractere → estimat 67*0.75 = ~50.25MB bytes → declanșează validarea din handler.
    const app = createTestApp({ jsonLimit: '200mb' });
    const bigPdf = 'A'.repeat(67 * 1024 * 1024);
    const res = await request(app).post('/flows')
      .send({ docName: 'Referat', initName: 'Ion', initEmail: 'a@b.com', signers: [{ name: 'X Y', email: 'x@b.com' }], pdfB64: bigPdf });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('pdf_too_large_max_50mb');
  });

  it('200 — creare reușită, răspuns corect', async () => {
    const app = createTestApp();
    const res = await request(app).post('/flows')
      .send({
        docName: 'Referat aprobare buget',
        initName: 'Ion Popescu',
        initEmail: 'init@primaria.ro',
        signers: [{ name: 'Ana Maria', email: 'signer@primaria.ro', rol: 'AVIZAT' }],
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.flowId).toBe('TEST_ABCD1');
    expect(res.body.firstSignerEmail).toBe('signer@primaria.ro');
    expect(res.body.initIsSigner).toBe(false);
    expect(dbModule.saveFlow).toHaveBeenCalledOnce();
  });

  it('200 — inițiatorul este și semnatar → signerToken inclus', async () => {
    const app = createTestApp();
    const res = await request(app).post('/flows')
      .send({
        docName: 'Referat',
        initName: 'Ion Popescu',
        initEmail: 'init@primaria.ro',
        signers: [{ name: 'Ion Popescu', email: 'init@primaria.ro', rol: 'AVIZAT' }],
      });
    expect(res.status).toBe(200);
    expect(res.body.initIsSigner).toBe(true);
    expect(res.body.signerToken).toBeTruthy();
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// GET /flows/:flowId
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /flows/:flowId', () => {

  it('404 — flux inexistent', async () => {
    dbModule.getFlowData.mockResolvedValue(null);
    const app = createTestApp();
    const res = await request(app)
      .get('/flows/INEXISTENT')
      .set('Cookie', `auth_token=${makeToken()}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

  it('401 — fără autentificare și fără token', async () => {
    // Fluxul trebuie să existe — altfel handler returnează 404 înainte de a verifica auth.
    const flow = makeFlow();
    dbModule.getFlowData.mockResolvedValue(flow);
    const app = createTestApp();
    const res = await request(app).get('/flows/TEST_ABCD1');
    expect(res.status).toBe(401);
  });

  it('403 — token semnatar invalid', async () => {
    const flow = makeFlow();
    dbModule.getFlowData.mockResolvedValue(flow);
    const app = createTestApp();
    const res = await request(app).get('/flows/TEST_ABCD1?token=token-invalid-xyz');
    expect(res.status).toBe(403);
  });

  it('200 — acces cu token semnatar valid', async () => {
    const flow = makeFlow();
    const validToken = flow.signers[0].token;
    dbModule.getFlowData.mockResolvedValue(flow);
    const app = createTestApp();
    const res = await request(app).get(`/flows/TEST_ABCD1?token=${validToken}`);
    expect(res.status).toBe(200);
    expect(res.body.flowId).toBe('TEST_ABCD1');
  });

  it('200 — acces autentificat — pdfB64 și signedPdfB64 absente', async () => {
    const flow = makeFlow({ pdfB64: 'dGVzdA==', signedPdfB64: null });
    dbModule.getFlowData.mockResolvedValue(flow);
    const app = createTestApp();
    const res = await request(app)
      .get('/flows/TEST_ABCD1')
      .set('Cookie', `auth_token=${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.pdfB64).toBeUndefined();
    expect(res.body.signedPdfB64).toBeUndefined();
    expect(res.body.docName).toBe('Referat test');
  });

  it('200 — token semnatar propriu inclus în răspuns (semnatar curent)', async () => {
    const flow = makeFlow();
    const signerToken = flow.signers[0].token;
    dbModule.getFlowData.mockResolvedValue(flow);
    const app = createTestApp();
    const res = await request(app).get(`/flows/TEST_ABCD1?token=${signerToken}`);
    expect(res.status).toBe(200);
    // Semnatarul curent vede propriul token, ceilalți nu
    const self = res.body.signers.find(s => s.email === 'signer1@primaria.ro');
    expect(self?.token).toBe(signerToken);
    const other = res.body.signers.find(s => s.email === 'signer2@primaria.ro');
    expect(other?.token).toBeUndefined();
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// POST /flows/:flowId/sign
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /flows/:flowId/sign', () => {

  it('400 — signature lipsă', async () => {
    const flow = makeFlow();
    dbModule.getFlowData.mockResolvedValue(flow);
    const app = createTestApp();
    const res = await request(app).post('/flows/TEST_ABCD1/sign')
      .send({ token: flow.signers[0].token, signature: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('signature_required');
  });

  it('400 — token invalid (nu există în flux)', async () => {
    const flow = makeFlow();
    dbModule.getFlowData.mockResolvedValue(flow);
    const app = createTestApp();
    const res = await request(app).post('/flows/TEST_ABCD1/sign')
      .send({ token: 'token-inexistent', signature: 'semnat' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_token');
  });

  it('404 — flux inexistent', async () => {
    dbModule.getFlowData.mockResolvedValue(null);
    const app = createTestApp();
    const res = await request(app).post('/flows/INEXISTENT/sign')
      .send({ token: 'orice', signature: 'semnat' });
    expect(res.status).toBe(404);
  });

  it('409 — flux anulat', async () => {
    const flow = makeFlow({ status: 'cancelled' });
    dbModule.getFlowData.mockResolvedValue(flow);
    const app = createTestApp();
    const res = await request(app).post('/flows/TEST_ABCD1/sign')
      .send({ token: flow.signers[0].token, signature: 'semnat' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('flow_cancelled');
  });

  it('409 — nu e rândul acestui semnatar (status pending)', async () => {
    const flow = makeFlow();
    const pendingToken = flow.signers[1].token; // al doilea semnatar e pending
    dbModule.getFlowData.mockResolvedValue(flow);
    const app = createTestApp();
    const res = await request(app).post('/flows/TEST_ABCD1/sign')
      .send({ token: pendingToken, signature: 'semnat' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_current_signer');
  });

  it('403 — token expirat', async () => {
    const flow = makeFlow();
    dbModule.getFlowData.mockResolvedValue(flow);
    // Injectăm cu isSignerTokenExpired=true ÎNAINTE de createApp — createTestApp
    // suprascrie inject-ul cu valoarea default (false). Soluție: construim app-ul manual.
    injectFlowDeps({
      notify:               vi.fn().mockResolvedValue(undefined),
      wsPush:               vi.fn(),
      PDFLib:               null,
      stampFooterOnPdf:     null,
      isSignerTokenExpired: () => true,  // token expirat
      newFlowId:            () => 'TEST_ABCD1',
      buildSignerLink:      (req, fid, tok) => `https://app?flow=${fid}&token=${tok}`,
      stripSensitive:       (d) => d,
      stripPdfB64:          (d) => d,
      sendSignerEmail:      vi.fn(),
    });
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json({ limit: '50mb' }));
    app.use(cookieParser());
    app.use('/', flowsRouter);
    const res = await request(app).post('/flows/TEST_ABCD1/sign')
      .send({ token: flow.signers[0].token, signature: 'semnat' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('token_expired');
  });

  it('200 — semnare reușită, status actualizat', async () => {
    const flow = makeFlow();
    const currentToken = flow.signers[0].token;
    dbModule.getFlowData.mockResolvedValue(flow);
    const app = createTestApp();
    const res = await request(app).post('/flows/TEST_ABCD1/sign')
      .send({ token: currentToken, signature: 'Ion Popescu — Semnătură electronică' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.awaitingUpload).toBe(true);
    expect(res.body.completed).toBe(false); // mai e un semnatar pending
    expect(dbModule.saveFlow).toHaveBeenCalledOnce();
    // Verificăm că statusul a fost actualizat în datele salvate
    const savedData = dbModule.saveFlow.mock.calls[0][1];
    const signer = savedData.signers.find(s => s.token === currentToken);
    expect(signer.status).toBe('signed');
    expect(signer.signature).toBe('Ion Popescu — Semnătură electronică');
  });

  it('200 — semnarea ultimului semnatar → completed=true', async () => {
    // Flux cu un singur semnatar
    const token = crypto.randomBytes(16).toString('hex');
    const flow = makeFlow({
      signers: [{
        order: 1, name: 'Semnatar Unic', email: 'unic@primaria.ro',
        rol: 'APROBAT', token,
        tokenCreatedAt: new Date().toISOString(),
        status: 'current', signedAt: null,
      }],
    });
    dbModule.getFlowData.mockResolvedValue(flow);
    const app = createTestApp();
    const res = await request(app).post('/flows/TEST_ABCD1/sign')
      .send({ token, signature: 'semnat' });
    expect(res.status).toBe(200);
    expect(res.body.completed).toBe(true);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// POST /flows/:flowId/refuse
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /flows/:flowId/refuse', () => {

  it('400 — reason lipsă', async () => {
    const flow = makeFlow();
    dbModule.getFlowData.mockResolvedValue(flow);
    const app = createTestApp();
    const res = await request(app).post('/flows/TEST_ABCD1/refuse')
      .send({ token: flow.signers[0].token, reason: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('reason_required');
  });

  it('400 — reason prea lungă (>1000 chars)', async () => {
    const flow = makeFlow();
    dbModule.getFlowData.mockResolvedValue(flow);
    const app = createTestApp();
    const res = await request(app).post('/flows/TEST_ABCD1/refuse')
      .send({ token: flow.signers[0].token, reason: 'X'.repeat(1001) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('reason_too_long');
  });

  it('400 — token invalid', async () => {
    const flow = makeFlow();
    dbModule.getFlowData.mockResolvedValue(flow);
    const app = createTestApp();
    const res = await request(app).post('/flows/TEST_ABCD1/refuse')
      .send({ token: 'inexistent', reason: 'Nu sunt de acord.' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_token');
  });

  it('404 — flux inexistent', async () => {
    dbModule.getFlowData.mockResolvedValue(null);
    const app = createTestApp();
    const res = await request(app).post('/flows/INEXISTENT/refuse')
      .send({ token: 'orice', reason: 'Motiv' });
    expect(res.status).toBe(404);
  });

  it('409 — flux anulat', async () => {
    const flow = makeFlow({ status: 'cancelled' });
    dbModule.getFlowData.mockResolvedValue(flow);
    const app = createTestApp();
    const res = await request(app).post('/flows/TEST_ABCD1/refuse')
      .send({ token: flow.signers[0].token, reason: 'Motiv' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('flow_cancelled');
  });

  it('409 — nu e rândul acestui semnatar', async () => {
    const flow = makeFlow();
    const pendingToken = flow.signers[1].token;
    dbModule.getFlowData.mockResolvedValue(flow);
    const app = createTestApp();
    const res = await request(app).post('/flows/TEST_ABCD1/refuse')
      .send({ token: pendingToken, reason: 'Nu sunt de acord.' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_current_signer');
  });

  it('200 — refuz reușit, status flux actualizat la refused', async () => {
    const flow = makeFlow();
    const currentToken = flow.signers[0].token;
    dbModule.getFlowData.mockResolvedValue(flow);
    // pool.query mock pentru DELETE notifications
    dbModule.pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const app = createTestApp();
    const res = await request(app).post('/flows/TEST_ABCD1/refuse')
      .send({ token: currentToken, reason: 'Documentul necesită revizuire.' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.refused).toBe(true);
    // Verificăm că saveFlow a fost apelat cu status refused
    expect(dbModule.saveFlow).toHaveBeenCalledOnce();
    const savedData = dbModule.saveFlow.mock.calls[0][1];
    expect(savedData.status).toBe('refused');
    const refusedSigner = savedData.signers.find(s => s.token === currentToken);
    expect(refusedSigner.status).toBe('refused');
    expect(refusedSigner.refuseReason).toBe('Documentul necesită revizuire.');
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// POST /flows/:flowId/delegate
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /flows/:flowId/delegate', () => {

  it('400 — fromToken lipsă', async () => {
    const flow = makeFlow();
    dbModule.getFlowData.mockResolvedValue(flow);
    const app = createTestApp();
    const res = await request(app).post('/flows/TEST_ABCD1/delegate')
      .send({ toEmail: 'delegat@primaria.ro', reason: 'Absență' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('fromToken_required');
  });

  it('400 — toEmail invalid', async () => {
    const flow = makeFlow();
    dbModule.getFlowData.mockResolvedValue(flow);
    const app = createTestApp();
    const res = await request(app).post('/flows/TEST_ABCD1/delegate')
      .send({ fromToken: flow.signers[0].token, toEmail: 'nu-e-email', reason: 'Absență' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('toEmail_invalid');
  });

  it('400 — reason lipsă', async () => {
    const flow = makeFlow();
    dbModule.getFlowData.mockResolvedValue(flow);
    const app = createTestApp();
    const res = await request(app).post('/flows/TEST_ABCD1/delegate')
      .send({ fromToken: flow.signers[0].token, toEmail: 'delegat@primaria.ro', reason: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('reason_required');
  });

  it('400 — token invalid', async () => {
    const flow = makeFlow();
    dbModule.getFlowData.mockResolvedValue(flow);
    const app = createTestApp();
    const res = await request(app).post('/flows/TEST_ABCD1/delegate')
      .send({ fromToken: 'inexistent', toEmail: 'delegat@primaria.ro', reason: 'Absență' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_token');
  });

  it('409 — flux anulat', async () => {
    const flow = makeFlow({ status: 'cancelled' });
    dbModule.getFlowData.mockResolvedValue(flow);
    const app = createTestApp();
    const res = await request(app).post('/flows/TEST_ABCD1/delegate')
      .send({ fromToken: flow.signers[0].token, toEmail: 'delegat@primaria.ro', reason: 'Absență' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('flow_cancelled');
  });

  it('400 — auto-delegare (semnatar încearcă să se delege pe sine)', async () => {
    const flow = makeFlow();
    const currentToken = flow.signers[0].token;
    dbModule.getFlowData.mockResolvedValue(flow);
    // Actorul logat este semnatarul curent
    const app = createTestApp();
    const res = await request(app).post('/flows/TEST_ABCD1/delegate')
      .set('Cookie', `auth_token=${makeToken({ email: 'signer1@primaria.ro' })}`)
      .send({ fromToken: currentToken, toEmail: 'signer1@primaria.ro', reason: 'Test' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('self_delegation_not_allowed');
  });

  it('200 — delegare reușită, semnatar actualizat', async () => {
    const flow = makeFlow();
    const currentToken = flow.signers[0].token;
    dbModule.getFlowData.mockResolvedValue(flow);
    // pool.query pentru SELECT user delegat — returnează date goale (user necunoscut)
    dbModule.pool.query.mockResolvedValue({ rows: [] });
    const app = createTestApp();
    // Trimitem cookie — handler-ul folosește actor.email la delegatedFrom.by
    const res = await request(app).post('/flows/TEST_ABCD1/delegate')
      .set('Cookie', `auth_token=${makeToken({ email: 'signer1@primaria.ro' })}`)
      .send({ fromToken: currentToken, toEmail: 'delegat@primaria.ro', toName: 'Delegat Nou', reason: 'Absență concediu' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.from).toBe('signer1@primaria.ro');
    expect(res.body.to).toBe('delegat@primaria.ro');
    // Verificăm că saveFlow a fost apelat cu datele delegate corecte
    expect(dbModule.saveFlow).toHaveBeenCalledOnce();
    const savedData = dbModule.saveFlow.mock.calls[0][1];
    const delegatedSigner = savedData.signers[0];
    expect(delegatedSigner.email).toBe('delegat@primaria.ro');
    expect(delegatedSigner.name).toBe('Delegat Nou');
    expect(delegatedSigner.status).toBe('current');
    expect(delegatedSigner.delegatedFrom.email).toBe('signer1@primaria.ro');
    expect(delegatedSigner.delegatedFrom.reason).toBe('Absență concediu');
    // Token-ul trebuie să fie nou (diferit de cel original)
    expect(delegatedSigner.token).not.toBe(currentToken);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// POST /flows/:flowId/cancel
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /flows/:flowId/cancel', () => {

  it('401 — fără autentificare', async () => {
    const app = createTestApp();
    const res = await request(app).post('/flows/TEST_ABCD1/cancel').send({});
    expect(res.status).toBe(401);
  });

  it('404 — flux inexistent', async () => {
    dbModule.getFlowData.mockResolvedValue(null);
    const app = createTestApp();
    const res = await request(app).post('/flows/INEXISTENT/cancel')
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({});
    expect(res.status).toBe(404);
  });

  it('403 — user care nu este inițiatorul fluxului', async () => {
    const flow = makeFlow(); // initEmail: init@primaria.ro
    dbModule.getFlowData.mockResolvedValue(flow);
    const app = createTestApp();
    const res = await request(app).post('/flows/TEST_ABCD1/cancel')
      .set('Cookie', `auth_token=${makeToken({ email: 'altcineva@primaria.ro' })}`)
      .send({ reason: 'Test' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });

  it('200 — anulare de inițiator', async () => {
    const flow = makeFlow();
    dbModule.getFlowData.mockResolvedValue(flow);
    dbModule.pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const app = createTestApp();
    const res = await request(app).post('/flows/TEST_ABCD1/cancel')
      .set('Cookie', `auth_token=${makeToken({ email: 'init@primaria.ro' })}`)
      .send({ reason: 'Anulat din greșeală' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.flowId).toBe('TEST_ABCD1');
    // Verificăm că saveFlow a fost apelat cu status cancelled
    const savedData = dbModule.saveFlow.mock.calls[0][1];
    expect(savedData.status).toBe('cancelled');
    expect(savedData.cancelReason).toBe('Anulat din greșeală');
    // Semnatarii current/pending trebuie marcați ca cancelled
    savedData.signers.forEach(s => {
      expect(s.status).toBe('cancelled');
    });
  });

  it('200 — anulare de admin (chiar dacă nu e inițiatorul)', async () => {
    const flow = makeFlow(); // initEmail: init@primaria.ro
    dbModule.getFlowData.mockResolvedValue(flow);
    dbModule.pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const app = createTestApp();
    const res = await request(app).post('/flows/TEST_ABCD1/cancel')
      .set('Cookie', `auth_token=${makeAdminToken()}`) // admin, alt email
      .send({ reason: 'Anulat de admin' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('409 — flux deja anulat', async () => {
    const flow = makeFlow({ status: 'cancelled' });
    dbModule.getFlowData.mockResolvedValue(flow);
    const app = createTestApp();
    const res = await request(app).post('/flows/TEST_ABCD1/cancel')
      .set('Cookie', `auth_token=${makeToken({ email: 'init@primaria.ro' })}`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('already_cancelled');
  });

});
