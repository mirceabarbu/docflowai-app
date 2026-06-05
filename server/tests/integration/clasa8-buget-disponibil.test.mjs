/**
 * Integration tests — GET /api/clasa8/buget/disponibil
 * (soft-warning depășire credite bugetare la completarea Sec.B de către CAB)
 *
 * Acoperire:
 *   ✓ 401 fără autentificare
 *   ✓ 400 exclude_df cu format invalid (non-UUID)
 *   ✓ 200 scope pe orgId din JWT ($1) + exclude_df propagat ca $2
 *   ✓ 200 exclude_df omis → $2 = null
 *   ✓ 200 mapping items (buget/disponibil null tolerat, numere parse-uite)
 *   ✓ SQL: aceeași regulă Clasa 8 (col.10 + flow aprobat + ultima revizie) +
 *          clauza de excludere pe nr_unic_inreg
 *   ✓ 500 când BD aruncă eroare
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request      from 'supertest';
import express      from 'express';
import cookieParser from 'cookie-parser';
import jwt          from 'jsonwebtoken';

vi.mock('../../db/index.mjs', () => {
  const mockQuery = vi.fn();
  return { pool: { query: mockQuery } };
});

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
}));

import * as dbModule from '../../db/index.mjs';
import clasa8Router  from '../../routes/clasa8.mjs';

const TEST_JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-vitest-docflowai-2025';
const SAMPLE_UUID = '11111111-2222-3333-4444-555555555555';

function makeToken(overrides = {}) {
  return jwt.sign(
    { userId: 1, email: 'cab@primaria.ro', role: 'user', orgId: 1, nume: 'Test', ...overrides },
    TEST_JWT_SECRET,
    { expiresIn: '2h' }
  );
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((req, _res, next) => { req.requestId = 'test-req'; next(); });
  app.use('/api/clasa8', clasa8Router);
  return app;
}

describe('GET /api/clasa8/buget/disponibil', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = TEST_JWT_SECRET;
  });

  it('401 fără autentificare', async () => {
    const r = await request(makeApp()).get('/api/clasa8/buget/disponibil');
    expect(r.status).toBe(401);
  });

  it('400 exclude_df cu format invalid (non-UUID)', async () => {
    const r = await request(makeApp())
      .get('/api/clasa8/buget/disponibil?exclude_df=not-a-uuid')
      .set('Cookie', `auth_token=${makeToken()}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('exclude_df_invalid');
    expect(dbModule.pool.query).not.toHaveBeenCalled();
  });

  it('200 orgId în $1 + exclude_df propagat ca $2', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] });
    const r = await request(makeApp())
      .get(`/api/clasa8/buget/disponibil?exclude_df=${SAMPLE_UUID}`)
      .set('Cookie', `auth_token=${makeToken({ orgId: 42 })}`);
    expect(r.status).toBe(200);
    const args = dbModule.pool.query.mock.calls[0][1];
    expect(args[0]).toBe(42);
    expect(args[1]).toBe(SAMPLE_UUID);
  });

  it('200 fără exclude_df → $2 = null', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] });
    const r = await request(makeApp())
      .get('/api/clasa8/buget/disponibil')
      .set('Cookie', `auth_token=${makeToken()}`);
    expect(r.status).toBe(200);
    expect(dbModule.pool.query.mock.calls[0][1][1]).toBeNull();
  });

  it('200 mapping items: numere parse-uite, buget/disponibil null tolerat', async () => {
    dbModule.pool.query.mockResolvedValueOnce({
      rows: [
        { cod_ssi: '01A510103', buget: '462470.00', angajat_aprobat: '0.00',      disponibil: '462470.00' },
        { cod_ssi: '02B620100', buget: null,        angajat_aprobat: '700000.00', disponibil: null },
      ],
    });
    const r = await request(makeApp())
      .get('/api/clasa8/buget/disponibil')
      .set('Cookie', `auth_token=${makeToken()}`);
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([
      { cod_ssi: '01A510103', buget: 462470, angajat_aprobat: 0,      disponibil: 462470 },
      { cod_ssi: '02B620100', buget: null,   angajat_aprobat: 700000, disponibil: null },
    ]);
  });

  it('SQL: regula Clasa 8 (col.10 + aprobat + ultima revizie) + clauza de excludere', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] });
    await request(makeApp())
      .get('/api/clasa8/buget/disponibil')
      .set('Cookie', `auth_token=${makeToken()}`);

    const sql = dbModule.pool.query.mock.calls[0][0];
    // aceeași sursă de adevăr ca agregatul Clasa 8
    expect(sql).toContain('sum_rezv_crdt_bug_act');         // col.10
    expect(sql).toContain('DISTINCT ON (fd.nr_unic_inreg)'); // ultima revizie
    expect(sql).toMatch(/ORDER BY fd\.nr_unic_inreg,\s*fd\.revizie_nr DESC/);
    expect(sql).toMatch(/f\.data->>'status'\s*=\s*'completed'/);
    expect(sql).toContain('clasa8_buget');
    // clauza de excludere pe nr_unic_inreg al DF-ului în lucru
    expect(sql).toMatch(/\$2::uuid IS NULL OR fd\.nr_unic_inreg IS DISTINCT FROM/);
  });

  it('500 când BD aruncă eroare', async () => {
    dbModule.pool.query.mockRejectedValueOnce(new Error('connection refused'));
    const r = await request(makeApp())
      .get('/api/clasa8/buget/disponibil')
      .set('Cookie', `auth_token=${makeToken()}`);
    expect(r.status).toBe(500);
    expect(r.body.error).toBe('server_error');
  });
});
