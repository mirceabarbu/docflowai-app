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
  return `auth_token=${jwt.sign({ userId: 1, email, role, orgId: 1, tv: 1 }, TEST_JWT_SECRET, { expiresIn: '1h' })}`;
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
  return {
    id: 1, email: 'owner@test.ro', nume: 'Owner Test', functie: 'Inspector',
    compartiment: 'Test', institutie: 'Primăria Test', role: 'user', org_id: 1,
    token_version: 1, force_password_change: false, ...overrides,
  };
}

function mockResolvedActor() {
  dbModule.pool.query.mockResolvedValueOnce({ rows: [mockUserRow()] });
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

  it('200 — returnează lista cu isOwner/canDelete calculat corect (user simplu)', async () => {
    const app = createTestApp();
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [mockUserRow()] })          // SELECT institutie, org_id
      .mockResolvedValueOnce({ rows: [                           // SELECT templates
        mockTemplateRow({ user_email: 'owner@test.ro' }),
        mockTemplateRow({ id: 99, user_email: 'altul@test.ro', shared: true, org_id: 1 }),
      ]});

    const res = await request(app).get('/api/templates')
      .set('Cookie', makeAuthCookie('owner@test.ro'));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].isOwner).toBe(true);
    expect(res.body[0].canDelete).toBe(true);   // owner
    expect(res.body[1].isOwner).toBe(false);
    expect(res.body[1].canDelete).toBe(false);  // user simplu pe shared al altcuiva
  });

  it('200 — org_admin: canDelete pe shared same-org, dar nu pe alt org / privat', async () => {
    const app = createTestApp();
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [mockUserRow({ email: 'admin@test.ro', role: 'org_admin', org_id: 1 })] })
      .mockResolvedValueOnce({ rows: [
        mockTemplateRow({ id: 10, user_email: 'coleg@test.ro', shared: true,  org_id: 1 }),  // shared same-org
        mockTemplateRow({ id: 11, user_email: 'strain@x.ro',   shared: true,  org_id: 2 }),  // shared alt org
        mockTemplateRow({ id: 12, user_email: 'coleg@test.ro', shared: false, org_id: 1 }),  // privat al altcuiva
      ]});

    const res = await request(app).get('/api/templates')
      .set('Cookie', makeAuthCookie('admin@test.ro', 'org_admin'));

    expect(res.status).toBe(200);
    expect(res.body[0].canDelete).toBe(true);   // shared same-org → manager
    expect(res.body[1].canDelete).toBe(false);  // shared alt org → nu
    expect(res.body[2].canDelete).toBe(false);  // privat (nu shared) → nu
  });

});

describe('POST /api/templates', () => {

  it('401 — fără auth', async () => {
    const res = await request(createTestApp()).post('/api/templates')
      .send({ name: 'Test', signers: validSigners });
    expect(res.status).toBe(401);
  });

  it('400 — name lipsă', async () => {
    mockResolvedActor();
    const res = await request(createTestApp()).post('/api/templates')
      .set('Cookie', makeAuthCookie())
      .send({ signers: validSigners });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('name_required');
  });

  it('400 — name prea lung', async () => {
    mockResolvedActor();
    const res = await request(createTestApp()).post('/api/templates')
      .set('Cookie', makeAuthCookie())
      .send({ name: 'X'.repeat(201), signers: validSigners });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('name_too_long');
  });

  it('400 — signers lipsă', async () => {
    mockResolvedActor();
    const res = await request(createTestApp()).post('/api/templates')
      .set('Cookie', makeAuthCookie())
      .send({ name: 'Test' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('signers_required');
  });

  it('400 — semnatar cu email invalid', async () => {
    mockResolvedActor();
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

  it('401 — fără auth', async () => {
    const res = await request(createTestApp()).delete('/api/templates/42');
    expect(res.status).toBe(401);
  });

  it('400 — id invalid (NaN)', async () => {
    mockResolvedActor(); // resolveActorOr rulează înaintea parseInt
    const res = await request(createTestApp()).delete('/api/templates/xyz')
      .set('Cookie', makeAuthCookie());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_id');
  });

  it('404 — șablon inexistent (contract nou: not_found)', async () => {
    const app = createTestApp();
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [mockUserRow()] })   // resolveActorOr
      .mockResolvedValueOnce({ rows: [] });               // SELECT template → gol

    const res = await request(app).delete('/api/templates/99')
      .set('Cookie', makeAuthCookie());
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

  it('200 — owner șterge propriul șablon (privat)', async () => {
    const app = createTestApp();
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [mockUserRow({ email: 'owner@test.ro', role: 'user', org_id: 1 })] })
      .mockResolvedValueOnce({ rows: [mockTemplateRow({ user_email: 'owner@test.ro', shared: false, org_id: 1 })] })
      .mockResolvedValueOnce({ rowCount: 1 });             // DELETE

    const res = await request(app).delete('/api/templates/42')
      .set('Cookie', makeAuthCookie('owner@test.ro'));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('200 — org_admin șterge șablon SHARED din org-ul lui (proprietar altul)', async () => {
    const app = createTestApp();
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [mockUserRow({ email: 'admin@x.ro', role: 'org_admin', org_id: 1 })] })
      .mockResolvedValueOnce({ rows: [mockTemplateRow({ user_email: 'sters@old.ro', shared: true, org_id: 1 })] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(app).delete('/api/templates/42')
      .set('Cookie', makeAuthCookie('admin@x.ro', 'org_admin'));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('403 — org_admin pe șablon shared din ALT org', async () => {
    const app = createTestApp();
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [mockUserRow({ email: 'admin@x.ro', role: 'org_admin', org_id: 1 })] })
      .mockResolvedValueOnce({ rows: [mockTemplateRow({ user_email: 'strain@y.ro', shared: true, org_id: 2 })] });

    const res = await request(app).delete('/api/templates/42')
      .set('Cookie', makeAuthCookie('admin@x.ro', 'org_admin'));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });

  it('403 — org_admin pe șablon NEshared al altcuiva (același org)', async () => {
    const app = createTestApp();
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [mockUserRow({ email: 'admin@x.ro', role: 'org_admin', org_id: 1 })] })
      .mockResolvedValueOnce({ rows: [mockTemplateRow({ user_email: 'coleg@x.ro', shared: false, org_id: 1 })] });

    const res = await request(app).delete('/api/templates/42')
      .set('Cookie', makeAuthCookie('admin@x.ro', 'org_admin'));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });

  it('200 — admin platformă (role=admin) pe șablon shared din alt org', async () => {
    const app = createTestApp();
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [mockUserRow({ email: 'admin@plat.ro', role: 'admin', org_id: 1 })] })
      .mockResolvedValueOnce({ rows: [mockTemplateRow({ user_email: 'strain@y.ro', shared: true, org_id: 2 })] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(app).delete('/api/templates/42')
      .set('Cookie', makeAuthCookie('admin@plat.ro', 'admin'));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('403 — user oarecare (nu owner, nu manager) pe șablon shared', async () => {
    const app = createTestApp();
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [mockUserRow({ email: 'user@x.ro', role: 'user', org_id: 1 })] })
      .mockResolvedValueOnce({ rows: [mockTemplateRow({ user_email: 'other@x.ro', shared: true, org_id: 1 })] });

    const res = await request(app).delete('/api/templates/42')
      .set('Cookie', makeAuthCookie('user@x.ro', 'user'));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });

});
