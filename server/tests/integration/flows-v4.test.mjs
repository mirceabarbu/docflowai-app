/**
 * DocFlowAI — Integration tests: Flow Engine v4
 *
 * Testează routes + service cu repository mock-uit (fără DB reală).
 *
 * Acoperire:
 *   ✓ POST /api/flows → flow creat cu signers (201)
 *   ✓ POST /api/flows → 422 validare signers lipsă
 *   ✓ GET  /api/flows → lista flows (200)
 *   ✓ GET  /api/flows/:id → flow by id (200)
 *   ✓ GET  /api/flows/:id → 404 inexistent
 *   ✓ POST /api/flows/:id/document → upload PDF (201)
 *   ✓ POST /api/flows/:id/start → primul semnatar activat cu token (200)
 *   ✓ POST /api/flows/:id/advance cu token valid → flow avansat (200)
 *   ✓ POST /api/flows/:id/advance cu token invalid → 404
 *   ✓ DELETE /api/flows/:id → flow cancelled (200)
 *   ✓ DELETE /api/flows/:id → 401 fără auth
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request      from 'supertest';
import express      from 'express';
import cookieParser from 'cookie-parser';
import jwt          from 'jsonwebtoken';

// ── Mocks — hoisted de vitest ────────────────────────────────────────────────

vi.mock('../../modules/flows/repository.mjs', () => ({
  createFlow:             vi.fn(),
  getFlowById:            vi.fn(),
  updateFlowStatus:       vi.fn(),
  updateSigner:           vi.fn(),
  getCurrentSigner:       vi.fn(),
  getSignerByToken:       vi.fn(),
  getNextPendingSigner:   vi.fn(),
  listFlows:              vi.fn(),
  softDeleteFlow:         vi.fn(),
  insertDocumentRevision: vi.fn(),
  updateFlowDocument:     vi.fn(),
  getFlowRevisions:       vi.fn(),
}));

vi.mock('../../db/queries/audit.mjs', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../middleware/logger.mjs', () => ({
  logger: {
    info:  vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  },
  requestLogger: vi.fn((_req, _res, next) => next()),
}));

// ── Imports după mock-uri ─────────────────────────────────────────────────────

import * as mockRepo from '../../modules/flows/repository.mjs';
import flowsRouter   from '../../modules/flows/routes.mjs';
import { errorHandler } from '../../middleware/errorHandler.mjs';

// ── Constants ────────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET;
const ORG_ID     = 1;
const USER_ID    = 42;
const FLOW_ID    = 'test_flow_abc123';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeToken(overrides = {}) {
  return jwt.sign(
    {
      sub: USER_ID, email: 'admin@test.ro', org_id: ORG_ID,
      role: 'admin', name: 'Test Admin',
      userId: USER_ID, orgId: ORG_ID, ver: 1, tv: 1,
      ...overrides,
    },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

function makeFlow(overrides = {}) {
  return {
    id:              FLOW_ID,
    org_id:          ORG_ID,
    initiator_id:    USER_ID,
    initiator_email: 'admin@test.ro',
    initiator_name:  'Test Admin',
    title:           'Test Flow',
    doc_name:        'test.pdf',
    doc_type:        'tabel',
    status:          'draft',
    current_step:    0,
    metadata:        {},
    data:            {},
    signers: [
      {
        id: 'signer_1', flow_id: FLOW_ID, step_order: 0,
        email: 'signer@test.ro', name: 'Ion Semnatar',
        role: null, function: null, status: 'pending',
        token: null, token_expires: null,
        signing_method: null, signed_at: null,
        decision: null, notes: null, meta: {},
      },
    ],
    ...overrides,
  };
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/flows', flowsRouter);
  app.use(errorHandler);
  return app;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/flows', () => {
  it('201 — flow creat cu signers', async () => {
    const flow = makeFlow();
    mockRepo.createFlow.mockResolvedValue(flow);

    const res = await request(createApp())
      .post('/api/flows')
      .set('Cookie', `dfai_token=${makeToken()}`)
      .send({
        title:    'Test Flow',
        doc_name: 'test.pdf',
        signers:  [{ email: 'signer@test.ro', name: 'Ion Semnatar' }],
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(FLOW_ID);
    expect(res.body.signers).toHaveLength(1);
    expect(mockRepo.createFlow).toHaveBeenCalledOnce();
  });

  it('422 — signers lipsă', async () => {
    const res = await request(createApp())
      .post('/api/flows')
      .set('Cookie', `dfai_token=${makeToken()}`)
      .send({ title: 'Test', doc_name: 'test.pdf', signers: [] });

    expect(res.status).toBe(422);
  });

  it('422 — semnatar cu email invalid', async () => {
    const res = await request(createApp())
      .post('/api/flows')
      .set('Cookie', `dfai_token=${makeToken()}`)
      .send({ title: 'Test', signers: [{ email: 'not-an-email', name: 'X' }] });

    expect(res.status).toBe(422);
  });

  it('401 — fără autentificare', async () => {
    const res = await request(createApp())
      .post('/api/flows')
      .send({ title: 'Test', signers: [{ email: 'a@b.ro', name: 'X' }] });

    expect(res.status).toBe(401);
  });
});

describe('GET /api/flows', () => {
  it('200 — returnează lista flows', async () => {
    mockRepo.listFlows.mockResolvedValue({ flows: [makeFlow()], total: 1, page: 1, limit: 20 });

    const res = await request(createApp())
      .get('/api/flows')
      .set('Cookie', `dfai_token=${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.flows).toHaveLength(1);
    expect(res.body.total).toBe(1);
  });
});

describe('GET /api/flows/:id', () => {
  it('200 — flow găsit (fără tokens și fără pdfB64)', async () => {
    const flow = makeFlow({
      signers: [{ ...makeFlow().signers[0], token: 'secret_token', token_expires: new Date() }],
    });
    mockRepo.getFlowById.mockResolvedValue(flow);

    const res = await request(createApp())
      .get(`/api/flows/${FLOW_ID}`)
      .set('Cookie', `dfai_token=${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(FLOW_ID);
    // tokens stripped
    expect(res.body.signers[0].token).toBeUndefined();
  });

  it('404 — flow inexistent', async () => {
    mockRepo.getFlowById.mockResolvedValue(null);

    const res = await request(createApp())
      .get(`/api/flows/nonexistent`)
      .set('Cookie', `dfai_token=${makeToken()}`);

    expect(res.status).toBe(404);
  });
});

describe('POST /api/flows/:id/document', () => {
  it('201 — upload PDF valid', async () => {
    const pdfBuffer = Buffer.from('%PDF-1.4\n% test content');

    mockRepo.getFlowById.mockResolvedValue(makeFlow({ status: 'draft' }));
    mockRepo.insertDocumentRevision.mockResolvedValue({ id: 'rev_1', revision_no: 1 });
    mockRepo.updateFlowDocument.mockResolvedValue();
    mockRepo.updateFlowStatus.mockResolvedValue();

    const res = await request(createApp())
      .post(`/api/flows/${FLOW_ID}/document`)
      .set('Cookie', `dfai_token=${makeToken()}`)
      .attach('file', pdfBuffer, { contentType: 'application/pdf', filename: 'test.pdf' });

    expect(res.status).toBe(201);
    expect(res.body.revision_id).toBe('rev_1');
    expect(res.body.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('404 — flow inexistent', async () => {
    mockRepo.getFlowById.mockResolvedValue(null);
    const pdfBuffer = Buffer.from('%PDF-1.4\n% test');

    const res = await request(createApp())
      .post(`/api/flows/bad_id/document`)
      .set('Cookie', `dfai_token=${makeToken()}`)
      .attach('file', pdfBuffer, { contentType: 'application/pdf', filename: 'test.pdf' });

    expect(res.status).toBe(404);
  });
});

describe('POST /api/flows/:id/start', () => {
  it('200 — primul semnatar activat cu token', async () => {
    const flow = makeFlow({ status: 'active', metadata: { hasDocument: true } });
    mockRepo.getFlowById
      .mockResolvedValueOnce(flow)                        // startFlow check
      .mockResolvedValueOnce(makeFlow({ status: 'in_progress' })); // re-fetch after start
    mockRepo.updateSigner.mockResolvedValue();
    mockRepo.updateFlowStatus.mockResolvedValue();

    const res = await request(createApp())
      .post(`/api/flows/${FLOW_ID}/start`)
      .set('Cookie', `dfai_token=${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.signerToken).toBeDefined();
    expect(res.body.firstSigner.status).toBe('current');
  });

  it('409 — flow nu e active', async () => {
    mockRepo.getFlowById.mockResolvedValue(makeFlow({ status: 'draft' }));

    const res = await request(createApp())
      .post(`/api/flows/${FLOW_ID}/start`)
      .set('Cookie', `dfai_token=${makeToken()}`);

    expect(res.status).toBe(409);
  });
});

describe('POST /api/flows/:id/advance', () => {
  it('200 — flow avansat (approved, un singur semnatar → completed)', async () => {
    const expiry = new Date(Date.now() + 3600_000);
    mockRepo.getSignerByToken.mockResolvedValue({
      id: 'signer_1', flow_id: FLOW_ID, step_order: 0,
      email: 'signer@test.ro', org_id: ORG_ID,
      flow_status: 'in_progress', doc_name: 'test.pdf', doc_type: 'tabel',
      status: 'current', token: 'valid_token', token_expires: expiry,
    });
    mockRepo.updateSigner.mockResolvedValue();
    mockRepo.getNextPendingSigner.mockResolvedValue(null); // no next → completed
    mockRepo.updateFlowStatus.mockResolvedValue();

    const res = await request(createApp())
      .post(`/api/flows/${FLOW_ID}/advance`)
      .send({ token: 'valid_token', decision: 'approved' });

    expect(res.status).toBe(200);
    expect(res.body.action).toBe('completed');
  });

  it('200 — avansat la al doilea semnatar', async () => {
    const expiry = new Date(Date.now() + 3600_000);
    mockRepo.getSignerByToken.mockResolvedValue({
      id: 'signer_1', flow_id: FLOW_ID, step_order: 0,
      email: 'signer@test.ro', org_id: ORG_ID,
      flow_status: 'in_progress', doc_name: 'test.pdf', doc_type: 'tabel',
      status: 'current', token: 'valid_token', token_expires: expiry,
    });
    mockRepo.updateSigner.mockResolvedValue();
    mockRepo.getNextPendingSigner.mockResolvedValue({
      id: 'signer_2', flow_id: FLOW_ID, step_order: 1,
      email: 'signer2@test.ro', status: 'pending',
    });
    mockRepo.updateFlowStatus.mockResolvedValue();

    const res = await request(createApp())
      .post(`/api/flows/${FLOW_ID}/advance`)
      .send({ token: 'valid_token', decision: 'approved' });

    expect(res.status).toBe(200);
    expect(res.body.action).toBe('advanced');
    expect(res.body.nextSigner.email).toBe('signer2@test.ro');
  });

  it('404 — token invalid / expirat', async () => {
    mockRepo.getSignerByToken.mockResolvedValue(null);

    const res = await request(createApp())
      .post(`/api/flows/${FLOW_ID}/advance`)
      .send({ token: 'bad_token', decision: 'approved' });

    expect(res.status).toBe(404);
  });

  it('400 — token lipsă în body', async () => {
    const res = await request(createApp())
      .post(`/api/flows/${FLOW_ID}/advance`)
      .send({ decision: 'approved' });

    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/flows/:id', () => {
  it('200 — flow anulat de admin', async () => {
    mockRepo.getFlowById.mockResolvedValue(makeFlow({ status: 'draft' }));
    mockRepo.updateFlowStatus.mockResolvedValue();

    const res = await request(createApp())
      .delete(`/api/flows/${FLOW_ID}`)
      .set('Cookie', `dfai_token=${makeToken({ role: 'admin' })}`)
      .send({ reason: 'Test cancel' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('401 — fără autentificare', async () => {
    const res = await request(createApp())
      .delete(`/api/flows/${FLOW_ID}`);

    expect(res.status).toBe(401);
  });

  it('403 — user care nu e inițiator', async () => {
    mockRepo.getFlowById.mockResolvedValue(
      makeFlow({ initiator_id: 999, status: 'draft' }) // alt inițiator
    );

    const res = await request(createApp())
      .delete(`/api/flows/${FLOW_ID}`)
      .set('Cookie', `dfai_token=${makeToken({ role: 'user', sub: USER_ID, userId: USER_ID })}`)
      .send({ reason: 'test' });

    expect(res.status).toBe(403);
  });
});
