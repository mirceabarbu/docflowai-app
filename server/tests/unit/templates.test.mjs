/**
 * DocFlowAI — Unit tests: routes/templates.mjs
 *
 * Acoperire:
 *   ✓ GET  — returnează șabloane proprii + shared
 *   ✓ POST — validare name, signers, email semnatar
 *   ✓ POST — creare reușită (201)
 *   ✓ PUT  — actualizare șablon propriu
 *   ✓ PUT  — 404 dacă nu e proprietar
 *   ✓ DELETE — ștergere șablon propriu
 *   ✓ DELETE — 404 pentru id invalid (NaN)
 *   ✓ 401  — orice rută fără auth
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

// ── Mock-uri ──────────────────────────────────────────────────────────────────

vi.mock('../../db/index.mjs', () => {
  const mockQuery = vi.fn();
  return {
    pool:         { query: mockQuery },
    DB_READY:     true,
    requireDb:    vi.fn(() => false),
    saveFlow:     vi.fn(),
    getFlowData:  vi.fn(),
    initDbWithRetry: vi.fn(),
    DB_LAST_ERROR: null,
  };
});

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../middleware/rateLimiter.mjs', () => ({
  createRateLimiter: () => (_req, _res, next) => next(),
}));

import * as dbModule from '../../db/index.mjs';
import templatesRouter from '../../routes/templates.mjs';

// ── App de test ───────────────────────────────────────────────────────────────

const TEST_JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-for-vitest';
process.env.JWT_SECRET = TEST_JWT_SECRET;

function makeAuthCookie(email = 'owner@test.ro', role = 'user') {
  return `auth_token=${jwt.sign({ email, role, orgId: 1 }, TEST_JWT_SECRET, { expiresIn: '1h' })}`;
}

function createTestApp() {
  const app = express();
  app.use(express.json({ limit: '50kb' }));
  app.use(cookieParser());
  app.use('/', templatesRouter);
  return app;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const validSigners = [{ name: 'Ion', email: 'ion@test.ro' }];

function mockUserRow(overrides = {}) {
  return { institutie: 'Primăria Test', org_id: 1, ...overrides };
}

function mockTemplateRow(overrides = {}) {
  return {
    id: 42, user_email: 'owner@test.ro', institutie: 'Primăria Test',
    name: 'Șablon test', signers: validSigners, shared: false,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => vi.clearAllMocks());

describe('GET /api/templates', () => {

  it('401 — fără auth', async () => {
    const app = createTestApp();
    const res = await request(app).get('/api/templates');
    expect(res.status).toBe(401);
  });

  it('200 — returnează lista cu isOwner calculat corect', async () => {
    const app = createTestApp();
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [mockUserRow()] })          // SELECT institutie, org_id
      .mockResolvedValueOnce({ rows: [                           // SELECT templates
        mockTemplateRow({ user_email: 'owner@test.ro' }),
        mockTemplateRow({ id: 99, user_email: 'altul@test.ro', shared: true }),
      ]});

    const res = await request(app).get('/api/templates')
      .set('Cookie', makeAuthCookie('owner@test.ro'));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].isOwner).toBe(true);
    expect(res.body[1].isOwner).toBe(false);
  });

});

describe('POST /api/templates', () => {

  it('401 — fără auth', async () => {
    const res = await request(createTestApp()).post('/api/templates')
      .send({ name: 'Test', signers: validSigners });
    expect(res.status).toBe(401);
  });

  it('400 — name lipsă', async () => {
    const res = await request(createTestApp()).post('/api/templates')
      .set('Cookie', makeAuthCookie())
      .send({ signers: validSigners });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('name_required');
  });

  it('400 — name prea lung', async () => {
    const res = await request(createTestApp()).post('/api/templates')
      .set('Cookie', makeAuthCookie())
      .send({ name: 'X'.repeat(201), signers: validSigners });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('name_too_long');
  });

  it('400 — signers lipsă', async () => {
    const res = await request(createTestApp()).post('/api/templates')
      .set('Cookie', makeAuthCookie())
      .send({ name: 'Test' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('signers_required');
  });

  it('400 — semnatar cu email invalid', async () => {
    const res = await request(createTestApp()).post('/api/templates')
      .set('Cookie', makeAuthCookie())
      .send({ name: 'Test', signers: [{ name: 'Ion', email: 'invalidemail' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('signer_email_invalid');
  });

  it('201 — creare reușită', async () => {
    const app = createTestApp();
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [mockUserRow()] })
      .mockResolvedValueOnce({ rows: [mockTemplateRow()] });

    const res = await request(app).post('/api/templates')
      .set('Cookie', makeAuthCookie('owner@test.ro'))
      .send({ name: 'Șablon nou', signers: validSigners, shared: false });

    expect(res.status).toBe(201);
    expect(res.body.isOwner).toBe(true);
    expect(res.body.name).toBe('Șablon test'); // din mock
  });

});

describe('PUT /api/templates/:id', () => {

  it('400 — id invalid (NaN)', async () => {
    const res = await request(createTestApp()).put('/api/templates/abc')
      .set('Cookie', makeAuthCookie())
      .send({ name: 'X', signers: validSigners });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_id');
  });

  it('404 — șablon nu aparține utilizatorului', async () => {
    const app = createTestApp();
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] }); // UPDATE returnează 0 rânduri

    const res = await request(app).put('/api/templates/42')
      .set('Cookie', makeAuthCookie())
      .send({ name: 'Modificat', signers: validSigners });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found_or_not_owner');
  });

  it('200 — actualizare reușită', async () => {
    const app = createTestApp();
    dbModule.pool.query.mockResolvedValueOnce({
      rows: [mockTemplateRow({ name: 'Modificat' })]
    });

    const res = await request(app).put('/api/templates/42')
      .set('Cookie', makeAuthCookie('owner@test.ro'))
      .send({ name: 'Modificat', signers: validSigners, shared: true });

    expect(res.status).toBe(200);
    expect(res.body.isOwner).toBe(true);
  });

});

describe('DELETE /api/templates/:id', () => {

  it('400 — id invalid', async () => {
    const res = await request(createTestApp()).delete('/api/templates/xyz')
      .set('Cookie', makeAuthCookie());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_id');
  });

  it('404 — șablon inexistent sau alt proprietar', async () => {
    const app = createTestApp();
    dbModule.pool.query.mockResolvedValueOnce({ rowCount: 0 });

    const res = await request(app).delete('/api/templates/99')
      .set('Cookie', makeAuthCookie());
    expect(res.status).toBe(404);
  });

  it('200 — ștergere reușită', async () => {
    const app = createTestApp();
    dbModule.pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(app).delete('/api/templates/42')
      .set('Cookie', makeAuthCookie('owner@test.ro'));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

});
