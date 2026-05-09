/**
 * Integration tests — Clasa 8 Buget (import versionat, delete, meta, coduri)
 *
 * Acoperire:
 *   ✓ 401 fără auth pe POST /import și DELETE
 *   ✓ 403 CSRF invalid pe POST /import și DELETE
 *   ✓ 400 validări payload (rows lipsă / gol / prea mare / valoare invalidă)
 *   ✓ 200 import OK — secvența SQL corectă
 *   ✓ 200 DELETE — șterge buget, NU versiunile
 *   ✓ 200 GET /meta cu/fără versiune activă
 *   ✓ 200 GET /coduri format { items:[...] }
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request     from 'supertest';
import express     from 'express';
import cookieParser from 'cookie-parser';
import jwt         from 'jsonwebtoken';

const TEST_JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-vitest-docflowai-2025';

// ── mock pool ──────────────────────────────────────────────────────────────────
const mockClientQuery   = vi.fn();
const mockClientRelease = vi.fn();
const mockClient = { query: mockClientQuery, release: mockClientRelease };

vi.mock('../../db/index.mjs', () => {
  const mockQuery   = vi.fn();
  const mockConnect = vi.fn();
  return { pool: { query: mockQuery, connect: mockConnect } };
});

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
}));

import * as dbModule  from '../../db/index.mjs';
import clasa8Router   from '../../routes/clasa8.mjs';

function makeToken(overrides = {}) {
  return jwt.sign(
    { userId: 1, email: 'init@primaria.ro', role: 'user', orgId: 1, nume: 'Test', ...overrides },
    TEST_JWT_SECRET,
    { expiresIn: '2h' }
  );
}

const CSRF = 'csrf-test-token';
const AUTH_COOKIE = `auth_token=${makeToken()}`;
const FULL_COOKIES = `${AUTH_COOKIE}; csrf_token=${CSRF}`;

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use((req, _res, next) => { req.requestId = 'test-req'; next(); });
  app.use('/api/clasa8', clasa8Router);
  return app;
}

describe('POST /api/clasa8/buget/import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    dbModule.pool.connect.mockResolvedValue(mockClient);
  });

  it('401 fără autentificare', async () => {
    const r = await request(makeApp()).post('/api/clasa8/buget/import').send({ rows: [] });
    expect(r.status).toBe(401);
  });

  it('403 CSRF invalid (header lipsă)', async () => {
    const r = await request(makeApp())
      .post('/api/clasa8/buget/import')
      .set('Cookie', FULL_COOKIES)
      .send({ rows: [{ cod_ssi: 'A1', valoare: 100 }] });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('csrf_invalid');
  });

  it('400 rows lipsă', async () => {
    const r = await request(makeApp())
      .post('/api/clasa8/buget/import')
      .set('Cookie', FULL_COOKIES)
      .set('X-CSRF-Token', CSRF)
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('rows_required');
  });

  it('400 rows array gol', async () => {
    const r = await request(makeApp())
      .post('/api/clasa8/buget/import')
      .set('Cookie', FULL_COOKIES)
      .set('X-CSRF-Token', CSRF)
      .send({ rows: [] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('rows_required');
  });

  it('400 rows.length > 5000', async () => {
    const rows = Array.from({ length: 5001 }, (_, i) => ({ cod_ssi: String(i), valoare: 1 }));
    const r = await request(makeApp())
      .post('/api/clasa8/buget/import')
      .set('Cookie', FULL_COOKIES)
      .set('X-CSRF-Token', CSRF)
      .send({ rows });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('rows_too_many');
  });

  it('400 valoare negativă', async () => {
    const r = await request(makeApp())
      .post('/api/clasa8/buget/import')
      .set('Cookie', FULL_COOKIES)
      .set('X-CSRF-Token', CSRF)
      .send({ rows: [{ cod_ssi: 'A1', valoare: -5 }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('valoare_invalid');
  });

  it('400 valoare NaN/string', async () => {
    const r = await request(makeApp())
      .post('/api/clasa8/buget/import')
      .set('Cookie', FULL_COOKIES)
      .set('X-CSRF-Token', CSRF)
      .send({ rows: [{ cod_ssi: 'A1', valoare: 'abc' }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('valoare_invalid');
  });

  it('200 import OK — secvența SQL corectă', async () => {
    const fakeVersionId = '11111111-0000-0000-0000-000000000001';
    const fakeUploadedAt = new Date().toISOString();

    mockClientQuery
      .mockResolvedValueOnce(undefined)                               // BEGIN
      .mockResolvedValueOnce({ rows: [{ next_v: 3 }] })              // SELECT MAX
      .mockResolvedValueOnce({                                        // INSERT version
        rows: [{ id: fakeVersionId, version_no: 3, uploaded_at: fakeUploadedAt }]
      })
      .mockResolvedValueOnce({ rowCount: 2 })                        // DELETE buget
      .mockResolvedValueOnce({ rowCount: 2 })                        // INSERT buget rows
      .mockResolvedValueOnce(undefined);                             // COMMIT

    const r = await request(makeApp())
      .post('/api/clasa8/buget/import')
      .set('Cookie', FULL_COOKIES)
      .set('X-CSRF-Token', CSRF)
      .send({ rows: [{ cod_ssi: 'A1', valoare: 1000 }, { cod_ssi: 'B2', valoare: 2000 }], filename: 'buget.xlsx' });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.version_no).toBe(3);
    expect(r.body.count).toBe(2);
    expect(r.body.total).toBe(3000);

    // Verifică secvența: BEGIN → SELECT MAX → INSERT version → DELETE → INSERT rows → COMMIT
    const calls = mockClientQuery.mock.calls.map(c => c[0]);
    expect(calls[0]).toMatch(/BEGIN/i);
    expect(calls[1]).toMatch(/SELECT COALESCE\(MAX\(version_no\)/i);
    expect(calls[2]).toMatch(/INSERT INTO clasa8_buget_versions/i);
    expect(calls[3]).toMatch(/DELETE FROM clasa8_buget/i);
    expect(calls[4]).toMatch(/INSERT INTO clasa8_buget/i);
    expect(calls[5]).toMatch(/COMMIT/i);

    // Verifică că clasa8_buget_versions NU e ștearsă
    const deleteCallSql = calls.find(s => /DELETE/i.test(s));
    expect(deleteCallSql).not.toMatch(/clasa8_buget_versions/i);

    expect(mockClientRelease).toHaveBeenCalled();
  });
});

describe('DELETE /api/clasa8/buget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = TEST_JWT_SECRET;
  });

  it('401 fără autentificare', async () => {
    const r = await request(makeApp()).delete('/api/clasa8/buget');
    expect(r.status).toBe(401);
  });

  it('403 CSRF invalid', async () => {
    const r = await request(makeApp())
      .delete('/api/clasa8/buget')
      .set('Cookie', FULL_COOKIES);
    expect(r.status).toBe(403);
  });

  it('200 DELETE — șterge buget activ, NU versiunile', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rowCount: 7 });

    const r = await request(makeApp())
      .delete('/api/clasa8/buget')
      .set('Cookie', FULL_COOKIES)
      .set('X-CSRF-Token', CSRF);

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.deleted).toBe(7);

    const sql = dbModule.pool.query.mock.calls[0][0];
    expect(sql).toMatch(/DELETE FROM clasa8_buget WHERE org_id/i);
    expect(sql).not.toMatch(/clasa8_buget_versions/i);
  });
});

describe('GET /api/clasa8/buget/meta', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = TEST_JWT_SECRET;
  });

  it('401 fără autentificare', async () => {
    const r = await request(makeApp()).get('/api/clasa8/buget/meta');
    expect(r.status).toBe(401);
  });

  it('200 fără versiune activă → active: null', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] });
    const r = await request(makeApp())
      .get('/api/clasa8/buget/meta')
      .set('Cookie', AUTH_COOKIE);
    expect(r.status).toBe(200);
    expect(r.body.active).toBeNull();
  });

  it('200 cu versiune activă → obiect cu câmpurile corecte', async () => {
    const fakeAt = new Date().toISOString();
    dbModule.pool.query.mockResolvedValueOnce({
      rows: [{
        version_no: 2, uploaded_at: fakeAt, source_filename: 'buget2025.xlsx',
        row_count: 15, total_value: '500000.00', uploaded_by_nume: 'Ion Popescu',
      }]
    });
    const r = await request(makeApp())
      .get('/api/clasa8/buget/meta')
      .set('Cookie', AUTH_COOKIE);
    expect(r.status).toBe(200);
    expect(r.body.active.version_no).toBe(2);
    expect(r.body.active.source_filename).toBe('buget2025.xlsx');
    expect(r.body.active.row_count).toBe(15);
    expect(r.body.active.uploaded_by_nume).toBe('Ion Popescu');
  });
});

describe('GET /api/clasa8/buget/coduri', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = TEST_JWT_SECRET;
  });

  it('401 fără autentificare', async () => {
    const r = await request(makeApp()).get('/api/clasa8/buget/coduri');
    expect(r.status).toBe(401);
  });

  it('200 format { items:[{cod_ssi, valoare}] }', async () => {
    dbModule.pool.query.mockResolvedValueOnce({
      rows: [
        { cod_ssi: 'A1001', valoare: '10000.00' },
        { cod_ssi: 'B2002', valoare: '25000.50' },
      ]
    });
    const r = await request(makeApp())
      .get('/api/clasa8/buget/coduri')
      .set('Cookie', AUTH_COOKIE);
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(2);
    expect(r.body.items[0].cod_ssi).toBe('A1001');
    expect(r.body.items[0].valoare).toBe(10000);
    expect(r.body.items[1].valoare).toBe(25000.5);
  });
});
