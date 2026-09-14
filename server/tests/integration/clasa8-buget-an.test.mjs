/**
 * Integration (mock pool) — #202: parametrul `an` pe rutele Clasa 8 buget.
 *
 * Acoperire (fără bază):
 *   ✓ validarea `an` (_parseAn) — implicit anul curent; întreg în [2000, 2100]; altfel 400 an_invalid
 *   ✓ 400 an_invalid ⇒ NICIO conexiune/scriere (validat înainte de pool.connect)
 *   ✓ import: SQL-urile poartă `an` — DELETE scopat `AND an = $2`, INSERT cu 5 coloane / 5 placeholders
 *   ✓ forma răspunsurilor: import/meta/DELETE includ `an`
 *   ✓ meta/coduri/DELETE: `an` e al doilea parametru SQL
 *
 * Comportamentul REAL pe date (Y intact după import pe Y+1) e în server/tests/db/clasa8-buget-an.test.mjs.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request     from 'supertest';
import express     from 'express';
import cookieParser from 'cookie-parser';
import jwt         from 'jsonwebtoken';

const TEST_JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-vitest-docflowai-2025';

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
vi.mock('../../middleware/require-module.mjs', () => ({
  requireModule: () => (_req, _res, next) => next(),
}));

import * as dbModule  from '../../db/index.mjs';
import clasa8Router   from '../../routes/clasa8.mjs';

const CSRF = 'csrf-test-token';
const AUTH_COOKIE = `auth_token=${jwt.sign(
  { userId: 1, email: 'init@primaria.ro', role: 'user', orgId: 1, nume: 'Test' },
  TEST_JWT_SECRET, { expiresIn: '2h' })}`;
const FULL_COOKIES = `${AUTH_COOKIE}; csrf_token=${CSRF}`;
const Y = new Date().getFullYear();

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use((req, _res, next) => { req.requestId = 'test-req'; next(); });
  app.use('/api/clasa8', clasa8Router);
  return app;
}

function mockImportOk(an, versionNo = 7) {
  mockClientQuery
    .mockResolvedValueOnce(undefined)                                       // BEGIN
    .mockResolvedValueOnce({ rows: [{ next_v: versionNo }] })              // SELECT MAX
    .mockResolvedValueOnce({ rows: [{ id: 'v-id', version_no: versionNo, uploaded_at: 'T', an }] }) // INSERT version
    .mockResolvedValueOnce({ rowCount: 0 })                                // DELETE buget (an)
    .mockResolvedValueOnce({ rowCount: 2 })                                // INSERT buget rows
    .mockResolvedValueOnce(undefined);                                     // COMMIT
}

const postImport = (body) => request(makeApp())
  .post('/api/clasa8/buget/import')
  .set('Cookie', FULL_COOKIES).set('X-CSRF-Token', CSRF)
  .send(body);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  dbModule.pool.connect.mockResolvedValue(mockClient);
});

describe('#202 — validarea `an` (_parseAn) prin rute', () => {
  it.each([
    ['abc',   'șir nenumeric'],
    [1999,    'sub AN_MIN'],
    [2101,    'peste AN_MAX'],
    [2026.5,  'nu e întreg'],
    ['2026.5','șir ne-întreg'],
    [true,    'boolean'],
    // NB: `[2026]` (array cu un element) NU e aici — Number([2026]) === 2026, deci _parseAn îl
    // acceptă ca 2026 (coerciție JS). Benign pentru un body JSON; documentat în raportul #202.
  ])('import cu an=%j (%s) ⇒ 400 an_invalid, fără pool.connect', async (bad) => {
    const r = await postImport({ an: bad, rows: [{ cod_ssi: 'A1', valoare: 1 }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('an_invalid');
    expect(r.body.message).toMatch(/2000.*2100/);
    expect(dbModule.pool.connect).not.toHaveBeenCalled();
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, Y,    'lipsă ⇒ anul curent'],
    [null,      Y,    'null ⇒ anul curent'],
    ['',        Y,    'gol ⇒ anul curent'],
    [2027,      2027, 'număr'],
    ['2027',    2027, 'șir numeric'],
    [2000,      2000, 'limita inferioară'],
    [2100,      2100, 'limita superioară'],
  ])('import cu an=%j ⇒ acceptat ca %d (%s)', async (raw, expected) => {
    mockImportOk(expected);
    const r = await postImport({ ...(raw === undefined ? {} : { an: raw }), rows: [{ cod_ssi: 'A1', valoare: 1 }] });
    expect(r.status).toBe(200);
    expect(r.body.an).toBe(expected);
  });

  it('DELETE ?an=abc / meta ?an=1999 / coduri ?an=2101 ⇒ 400 an_invalid, fără query', async () => {
    const app = makeApp();
    const r1 = await request(app).delete('/api/clasa8/buget?an=abc').set('Cookie', FULL_COOKIES).set('X-CSRF-Token', CSRF);
    const r2 = await request(app).get('/api/clasa8/buget/meta?an=1999').set('Cookie', FULL_COOKIES);
    const r3 = await request(app).get('/api/clasa8/buget/coduri?an=2101').set('Cookie', FULL_COOKIES);
    for (const r of [r1, r2, r3]) {
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('an_invalid');
    }
    expect(dbModule.pool.query).not.toHaveBeenCalled();
  });
});

describe('#202 — SQL-ul importului poartă anul', () => {
  it('DELETE scopat pe an; INSERT versiuni cu an ($7); INSERT rânduri cu 5 coloane și 5 placeholders/rând', async () => {
    mockImportOk(2027, 3);
    const r = await postImport({ an: 2027, filename: 'b.xlsx',
      rows: [{ cod_ssi: 'A1', valoare: 1000 }, { cod_ssi: 'B2', valoare: 2000 }] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, version_no: 3, uploaded_at: 'T', an: 2027, count: 2, total: 3000 });

    const calls = mockClientQuery.mock.calls;
    // INSERT versiune: coloana `an` + $7 = 2027
    expect(calls[2][0]).toMatch(/INSERT INTO clasa8_buget_versions[\s\S]*total_value, an\)/);
    expect(calls[2][1]).toEqual([1, 3, 1, 'b.xlsx', 2, 3000, 2027]);
    // DELETE: scopat pe (org_id, an) — patch-ul central al lotului
    expect(calls[3][0]).toBe('DELETE FROM clasa8_buget WHERE org_id = $1 AND an = $2');
    expect(calls[3][1]).toEqual([1, 2027]);
    // INSERT rânduri: 5 coloane, placeholders 1..5 și 6..10, params 5/rând cu an ultimul
    expect(calls[4][0]).toMatch(/INSERT INTO clasa8_buget \(version_id, org_id, cod_ssi, valoare, an\) VALUES \(\$1, \$2, \$3, \$4, \$5\), \(\$6, \$7, \$8, \$9, \$10\)$/);
    expect(calls[4][1]).toEqual(['v-id', 1, 'A1', 1000, 2027, 'v-id', 1, 'B2', 2000, 2027]);
    expect(calls[5][0]).toMatch(/COMMIT/i);
  });
});

describe('#202 — DELETE / meta / coduri scopate pe an', () => {
  it('DELETE /buget?an=2027 ⇒ SQL cu AND an = $2, params [org, 2027], răspuns cu an', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rowCount: 4 });
    const r = await request(makeApp()).delete('/api/clasa8/buget?an=2027')
      .set('Cookie', FULL_COOKIES).set('X-CSRF-Token', CSRF);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, deleted: 4, an: 2027 });
    const [sql, params] = dbModule.pool.query.mock.calls[0];
    expect(sql).toBe('DELETE FROM clasa8_buget WHERE org_id = $1 AND an = $2');
    expect(params).toEqual([1, 2027]);
  });

  it('DELETE /buget fără an ⇒ anul curent', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rowCount: 0 });
    const r = await request(makeApp()).delete('/api/clasa8/buget')
      .set('Cookie', FULL_COOKIES).set('X-CSRF-Token', CSRF);
    expect(r.body).toEqual({ ok: true, deleted: 0, an: Y });
    expect(dbModule.pool.query.mock.calls[0][1]).toEqual([1, Y]);
  });

  it('GET /buget/meta?an=2027 ⇒ WHERE v.an = $2, răspuns { an, active }', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [{
      version_no: 9, uploaded_at: 'T', source_filename: 'f', row_count: 3, total_value: '1.00', uploaded_by_nume: 'U' }] });
    const r = await request(makeApp()).get('/api/clasa8/buget/meta?an=2027').set('Cookie', FULL_COOKIES);
    expect(r.status).toBe(200);
    expect(r.body.an).toBe(2027);
    expect(r.body.active).toMatchObject({ version_no: 9, row_count: 3 });
    const [sql, params] = dbModule.pool.query.mock.calls[0];
    expect(sql).toMatch(/WHERE v\.org_id = \$1 AND v\.an = \$2/);
    expect(sql).toMatch(/EXISTS \(SELECT 1 FROM clasa8_buget b WHERE b\.version_id = v\.id\)/); // restul neatins
    expect(params).toEqual([1, 2027]);
  });

  it('GET /buget/meta fără an ⇒ anul curent, active:null când nu există', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] });
    const r = await request(makeApp()).get('/api/clasa8/buget/meta').set('Cookie', FULL_COOKIES);
    expect(r.body).toEqual({ an: Y, active: null });
    expect(dbModule.pool.query.mock.calls[0][1]).toEqual([1, Y]);
  });

  it('GET /buget/coduri?an=2027 ⇒ WHERE org_id = $1 AND an = $2, format { items }', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [{ cod_ssi: 'A1', valoare: '10.00' }] });
    const r = await request(makeApp()).get('/api/clasa8/buget/coduri?an=2027').set('Cookie', FULL_COOKIES);
    expect(r.body).toEqual({ items: [{ cod_ssi: 'A1', valoare: 10 }] });
    const [sql, params] = dbModule.pool.query.mock.calls[0];
    expect(sql).toMatch(/WHERE org_id = \$1 AND an = \$2 ORDER BY cod_ssi ASC/);
    expect(params).toEqual([1, 2027]);
  });
});
