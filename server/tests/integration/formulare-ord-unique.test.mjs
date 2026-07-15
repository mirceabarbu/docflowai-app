/**
 * DocFlowAI — Integration tests: unicitate nr_ordonant_pl pe POST/PUT ORD
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

// ── Mock-uri ESM ──────────────────────────────────────────────────────────────

vi.mock('../../db/index.mjs', () => {
  const q = vi.fn();
  return {
    pool:          { query: q },
    DB_READY:      true,
    requireDb:     vi.fn(() => false),
    DB_LAST_ERROR: null,
    writeAuditEvent: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../middleware/logger.mjs', () => ({
  logger: {
    info:  vi.fn(), warn:  vi.fn(), error: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  },
  redactUrl: (u) => u,
}));

vi.mock('../../middleware/csrf.mjs', () => ({
  csrfMiddleware: (_req, _res, next) => next(),
}));

vi.mock('../../middleware/require-module.mjs', () => ({
  requireModule: () => (_req, _res, next) => next(),
}));

vi.mock('../../services/authz-formular.mjs', () => ({
  loadActorComp: vi.fn().mockResolvedValue('Compartiment Test'),
  loadActorCompAndCab: vi.fn().mockResolvedValue({ actorComp: 'Compartiment Test', cabComp: '' }),
  isCabDept: vi.fn(() => false),
  canEditFormular: vi.fn().mockResolvedValue({ allowed: true, role: 'comp' }),
  canDestroyOnly: vi.fn().mockResolvedValue({ allowed: true }),
}));

// ── Importuri după mock-uri ───────────────────────────────────────────────────

import * as dbModule from '../../db/index.mjs';
import { formulareDbRouter } from '../../routes/formulare/index.mjs';

// ── App Express minimală ──────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-vitest-docflowai-2025';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(formulareDbRouter);
  return app;
}

const app = makeApp();

const ORG_A = 'aaaa0000-0000-0000-0000-000000000001';
const ORG_B = 'bbbb0000-0000-0000-0000-000000000002';
const DOC_ID = 'dddd0001-0000-0000-0000-000000000001';
const DOC_ID_2 = 'dddd0002-0000-0000-0000-000000000002';

function makeToken(overrides = {}) {
  return jwt.sign(
    { userId: 1, email: 'user@test.ro', role: 'org_admin', orgId: ORG_A, nume: 'Test', ...overrides },
    JWT_SECRET, { expiresIn: '2h' }
  );
}

const TOKEN_ORG_A = makeToken();
const TOKEN_ORG_B = makeToken({ userId: 2, email: 'user2@test.ro', orgId: ORG_B });

function fakeOrdRow(overrides = {}) {
  return {
    id: DOC_ID, status: 'draft', org_id: ORG_A, created_by: 1,
    nr_ordonant_pl: 'ORD-100', version: 1, assigned_to: null,
    deleted_at: null, ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/formulare-ord — unicitate nr_ordonant_pl', () => {
  beforeEach(() => { dbModule.pool.query.mockReset(); });

  it('201/ok — nr_ordonant_pl unic în org', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [] })           // dup check → no match
      .mockResolvedValueOnce({ rows: [fakeOrdRow()] }); // INSERT RETURNING
    const res = await request(app)
      .post('/api/formulare-ord')
      .set('Cookie', `auth_token=${TOKEN_ORG_A}`)
      .send({ nr_ordonant_pl: 'ORD-200' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('409 — nr_ordonant_pl deja existent în aceeași org', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [{ id: DOC_ID }] }); // dup check → match
    const res = await request(app)
      .post('/api/formulare-ord')
      .set('Cookie', `auth_token=${TOKEN_ORG_A}`)
      .send({ nr_ordonant_pl: 'ORD-100' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('nr_ord_duplicat');
  });

  it('ok — nr_ordonant_pl existent dar în ALTĂ org (izolare tenant)', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [] })           // dup check org B → no match
      .mockResolvedValueOnce({ rows: [fakeOrdRow({ org_id: ORG_B })] });
    const res = await request(app)
      .post('/api/formulare-ord')
      .set('Cookie', `auth_token=${TOKEN_ORG_B}`)
      .send({ nr_ordonant_pl: 'ORD-100' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('ok — nr_ordonant_pl identic cu document soft-deleted', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [] })           // dup check (deleted_at IS NULL) → no match
      .mockResolvedValueOnce({ rows: [fakeOrdRow()] });
    const res = await request(app)
      .post('/api/formulare-ord')
      .set('Cookie', `auth_token=${TOKEN_ORG_A}`)
      .send({ nr_ordonant_pl: 'ORD-DELETED' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('PUT /api/formulare-ord/:id — unicitate nr_ordonant_pl', () => {
  beforeEach(() => { dbModule.pool.query.mockReset(); });

  it('409 — nr_ordonant_pl schimbat la valoare deja existentă', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [fakeOrdRow({ id: DOC_ID, nr_ordonant_pl: 'ORD-100' })] }) // SELECT existing doc
      .mockResolvedValueOnce({ rows: [{ id: DOC_ID_2 }] }); // dup check → match
    const res = await request(app)
      .put(`/api/formulare-ord/${DOC_ID}`)
      .set('Cookie', `auth_token=${TOKEN_ORG_A}`)
      .send({ nr_ordonant_pl: 'ORD-200' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('nr_ord_duplicat');
  });

  it('ok — PUT cu același nr_ordonant_pl (no-op, fără dup check)', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [fakeOrdRow({ id: DOC_ID, nr_ordonant_pl: 'ORD-100' })] }) // SELECT existing doc
      .mockResolvedValueOnce({ rows: [fakeOrdRow()] }); // UPDATE RETURNING
    const res = await request(app)
      .put(`/api/formulare-ord/${DOC_ID}`)
      .set('Cookie', `auth_token=${TOKEN_ORG_A}`)
      .send({ nr_ordonant_pl: 'ORD-100' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
