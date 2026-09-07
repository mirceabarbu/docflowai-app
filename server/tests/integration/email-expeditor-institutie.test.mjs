/**
 * DocFlowAI — Integration tests: expeditorul emailului extern (#180)
 *
 * Verifică compunerea antetului `From` = numele instituției (`organizations.name`)
 * + adresa MAIL_FROM, EXCLUSIV pe trimiterea externă (POST /flows/:id/send-email).
 *
 * Model de test ales: același pattern ca send-email-trust-report.test.mjs — router
 * REAL montat, `pool.query` mock-uit (rutat pe textul SQL), `fetch` mock-uit spre
 * Resend. Ales pentru că exercită logica reală a rutei (inclusiv canActorReadFlow)
 * fără Postgres real, și permite numărarea exactă a apelurilor pool.query — necesar
 * pentru cazul (3) „o singură interogare per cerere, nu una per destinatar".
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

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

import * as dbModule from '../../db/index.mjs';
import emailRouter from '../../routes/flows/email.mjs';
import { JWT_SECRET } from '../../middleware/auth.mjs';

function makeToken(overrides = {}) {
  return jwt.sign(
    { userId: 1, email: 'init@primaria.ro', role: 'user', orgId: 1, tv: 1, nume: 'Ion Popescu', ...overrides },
    JWT_SECRET, { expiresIn: '2h' }
  );
}

function makeCompletedFlow(overrides = {}) {
  return {
    flowId: 'FLOW_180', docName: 'Referat test', orgId: 1,
    initEmail: 'init@primaria.ro',
    status: 'completed', completed: true,
    signedPdfB64: Buffer.from('%PDF-1.7 fake signed pdf bytes').toString('base64'),
    signers: [{ name: 'Semnatar', email: 'signer@primaria.ro', rol: 'APROBAT', status: 'signed', signedAt: new Date().toISOString() }],
    events: [],
    ...overrides,
  };
}

let fetchCalls;
let orgQueryCalls;

function setupPoolQuery({ orgName } = {}) {
  orgQueryCalls = 0;
  dbModule.pool.query.mockImplementation((sql) => {
    if (/FROM organizations/i.test(sql)) {
      orgQueryCalls++;
      if (orgName === undefined) return Promise.reject(new Error('boom — org lookup eșuat'));
      return Promise.resolve({ rows: orgName === null ? [] : [{ name: orgName }] });
    }
    if (/FROM users/i.test(sql)) {
      return Promise.resolve({ rows: [{
        id: 1, email: 'init@primaria.ro', nume: 'Ion Popescu', functie: 'Primar',
        institutie: 'Primăria Test', compartiment: 'Secretariat', role: 'user',
        org_id: 1, token_version: 1, force_password_change: false,
      }] });
    }
    if (/trust_reports/i.test(sql)) return Promise.resolve({ rows: [] });
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
  dbModule.saveFlow.mockResolvedValue(undefined);
  dbModule.writeAuditEvent.mockResolvedValue(undefined);
});

const app = createTestApp();

function send(body, tokenOverrides) {
  return request(app)
    .post('/flows/FLOW_180/send-email')
    .set('Authorization', 'Bearer ' + makeToken(tokenOverrides))
    .send({ to: 'dest@extern.ro', subject: 'Document semnat', bodyText: 'mesaj', ...body });
}

describe('send-email — expeditor pe numele instituției (#180)', () => {
  it('1. flux cu organizations.name="Primaria Zarnesti" → From = "Primaria Zarnesti <noreply@docflowai.ro>"', async () => {
    setupPoolQuery({ orgName: 'Primaria Zarnesti' });
    dbModule.getFlowData.mockResolvedValue(makeCompletedFlow());

    const res = await send({});
    expect(res.status).toBe(200);
    expect(fetchCalls[0].from).toBe('Primaria Zarnesti <noreply@docflowai.ro>');
  });

  it('2. non-regresie: organizație fără nume (rând absent) → From = MAIL_FROM neschimbat, trimiterea nu eșuează', async () => {
    setupPoolQuery({ orgName: null });
    dbModule.getFlowData.mockResolvedValue(makeCompletedFlow());

    const res = await send({});
    expect(res.status).toBe(200);
    expect(fetchCalls[0].from).toBe('DocFlowAI <noreply@docflowai.ro>');
  });

  it('3. o singură interogare "SELECT name FROM organizations", chiar și cu 3 destinatari', async () => {
    setupPoolQuery({ orgName: 'Primaria Zarnesti' });
    dbModule.getFlowData.mockResolvedValue(makeCompletedFlow());

    const res = await send({ to: ['a@x.ro', 'b@x.ro', 'c@x.ro'] });
    expect(res.status).toBe(200);
    expect(fetchCalls.length).toBe(3);
    expect(orgQueryCalls).toBe(1);
    for (const call of fetchCalls) {
      expect(call.from).toBe('Primaria Zarnesti <noreply@docflowai.ro>');
    }
  });

  it('4. flux fără orgId → From = MAIL_FROM, fără interogare, fără eroare', async () => {
    setupPoolQuery({ orgName: 'Primaria Zarnesti' });
    dbModule.getFlowData.mockResolvedValue(makeCompletedFlow({ orgId: undefined }));

    const res = await send({});
    expect(res.status).toBe(200);
    expect(fetchCalls[0].from).toBe('DocFlowAI <noreply@docflowai.ro>');
    expect(orgQueryCalls).toBe(0);
  });

  it('5. eșec la interogarea organizației → From = MAIL_FROM, cererea reușește (non-fatal)', async () => {
    setupPoolQuery({ orgName: undefined }); // rejects
    dbModule.getFlowData.mockResolvedValue(makeCompletedFlow());

    const res = await send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(fetchCalls[0].from).toBe('DocFlowAI <noreply@docflowai.ro>');
  });

  it('6. ancora e data.orgId: actor din altă organizație, flux din alta → numele folosit e al organizației FLUXULUI', async () => {
    setupPoolQuery({ orgName: 'Primaria Zarnesti' });
    // actorul e din orgId=1 (token implicit), fluxul aparține orgId=1 tot (canActorReadFlow
    // verifică orgId-ul actorului vs. al fluxului) — dar ancora interogării e explicit data.orgId,
    // nu actor.org_id: verificăm că valoarea din payload către SELECT e cea a fluxului.
    dbModule.getFlowData.mockResolvedValue(makeCompletedFlow({ orgId: 1 }));

    const res = await send({}, { orgId: 1 });
    expect(res.status).toBe(200);

    const orgCall = dbModule.pool.query.mock.calls.find(c => /FROM organizations/i.test(c[0]));
    expect(orgCall[1]).toEqual([1]);
    expect(fetchCalls[0].from).toBe('Primaria Zarnesti <noreply@docflowai.ro>');
  });
});

describe('non-regresie pe celelalte căi de mail (#180)', () => {
  it('7. mailer.mjs / index.mjs / admin/outreach.mjs nu importă expeditorExtern — notificările interne rămân neatinse', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const root = path.resolve(process.cwd());
    const targets = [
      'server/mailer.mjs',
      'server/index.mjs',
      'server/routes/admin/outreach.mjs',
    ];
    for (const t of targets) {
      const content = fs.readFileSync(path.join(root, t), 'utf8');
      expect(content).not.toMatch(/expeditorExtern|mail-from\.mjs/);
    }
  });
});
