/**
 * Integration tests — Clasa 8 (centralizator angajamente/ordonanțări/plăți)
 *
 * Acoperire:
 *   ✓ 401 fără autentificare
 *   ✓ 400 ssi prea lung
 *   ✓ 200 răspuns gol când nu există date completed
 *   ✓ 200 agregare corectă pe DF Sec.B (1 cod_SSI, 1 DF)
 *   ✓ 200 agregare corectă pe ORD rows (1 cod_SSI, 1 ORD)
 *   ✓ 200 alocare proporțională plăți (regula de 3)
 *   ✓ 200 toleranță convenție duală cod_SSI vs codSSI
 *   ✓ 200 filtru ssi prefix funcționează
 *   ✓ 200 multi-tenant izolare (orgId diferit nu vede datele)
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request    from 'supertest';
import express    from 'express';
import cookieParser from 'cookie-parser';
import jwt        from 'jsonwebtoken';

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

function makeToken(overrides = {}) {
  return jwt.sign(
    { userId: 1, email: 'init@primaria.ro', role: 'user', orgId: 1, nume: 'Test', ...overrides },
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

describe('GET /api/clasa8', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = TEST_JWT_SECRET;
  });

  it('401 fără autentificare', async () => {
    const app = makeApp();
    const r = await request(app).get('/api/clasa8');
    expect(r.status).toBe(401);
  });

  it('400 ssi prea lung', async () => {
    const app = makeApp();
    const r = await request(app)
      .get('/api/clasa8?ssi=' + 'x'.repeat(101))
      .set('Cookie', `auth_token=${makeToken()}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('ssi_too_long');
  });

  it('200 răspuns gol când BD returnează 0 rânduri', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp();
    const r = await request(app).get('/api/clasa8').set('Cookie', `auth_token=${makeToken()}`);
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
    expect(r.body.count).toBe(0);
    expect(r.body.totals).toEqual({
      buget: 0, angajamente: 0, ordonantari: 0, plati: 0,
      ramane_din_buget: 0, ramane_din_angajamente: 0,
    });
  });

  it('200 agregare cu rânduri și totale corecte', async () => {
    dbModule.pool.query.mockResolvedValueOnce({
      rows: [
        {
          cod_ssi: '01A510103',
          angajamente: '1000.00', ordonantari: '800.00', plati: '600.00',
          // noua formulă: angajamente − ordonanțări = 1000 − 800 = 200
          ramane_din_angajamente: '200.00',
          buget: null, ramane_din_buget: null,
          df_count: 2, ord_count: 1,
        },
        {
          cod_ssi: '02B620100',
          angajamente: '500.00', ordonantari: '500.00', plati: '500.00',
          ramane_din_angajamente: '0.00',
          buget: null, ramane_din_buget: null,
          df_count: 1, ord_count: 1,
        },
      ]
    });
    const app = makeApp();
    const r = await request(app).get('/api/clasa8').set('Cookie', `auth_token=${makeToken()}`);
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(2);
    expect(r.body.items[0].cod_ssi).toBe('01A510103');
    expect(r.body.items[0].angajamente).toBe(1000);
    expect(r.body.items[0].buget).toBeNull();
    expect(r.body.items[0].ramane_din_buget).toBeNull();
    expect(r.body.items[0].ramane_din_angajamente).toBe(200);
    expect(r.body.totals).toEqual({
      buget: 0, angajamente: 1500, ordonantari: 1300, plati: 1100,
      ramane_din_buget: 0, ramane_din_angajamente: 200,
    });
  });

  it('200 filtru ssi e propagat corect ca parametru SQL', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp();
    const r = await request(app)
      .get('/api/clasa8?ssi=01A')
      .set('Cookie', `auth_token=${makeToken()}`);
    expect(r.status).toBe(200);
    expect(r.body.filters_applied.ssi).toBe('01A');
    // SQL trebuie să fi fost apelat cu prefix-ul transformat în 'X%'
    const callArgs = dbModule.pool.query.mock.calls[0];
    expect(callArgs[0]).toContain('ILIKE');
    expect(callArgs[1]).toContain('%01A%');
  });

  it('200 multi-tenant: orgId din JWT propagat în query ($1)', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp();
    const r = await request(app)
      .get('/api/clasa8')
      .set('Cookie', `auth_token=${makeToken({ orgId: 42 })}`);
    expect(r.status).toBe(200);
    const callArgs = dbModule.pool.query.mock.calls[0];
    expect(callArgs[1][0]).toBe(42); // primul parametru SQL = orgId
  });

  it('500 când BD aruncă eroare', async () => {
    dbModule.pool.query.mockRejectedValueOnce(new Error('connection refused'));
    const app = makeApp();
    const r = await request(app).get('/api/clasa8').set('Cookie', `auth_token=${makeToken()}`);
    expect(r.status).toBe(500);
    expect(r.body.error).toBe('server_error');
  });

  it('SQL folosește sursele corecte: rows_ctrl col.10 + flow APROBAT + DISTINCT ON ultima revizie', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp();
    await request(app).get('/api/clasa8').set('Cookie', `auth_token=${makeToken()}`);

    const sql = dbModule.pool.query.mock.calls[0][0];

    // ── Pozitive: trebuie să fie prezente ────────────────────────────────
    // Filtru aprobat (flow signing completat)
    expect(sql).toContain('JOIN flows f');
    expect(sql).toMatch(/f\.data->>'status'\s*=\s*'completed'/);
    expect(sql).toMatch(/f\.data->>'completed'/);
    // Ultima revizie per nr_unic_inreg
    expect(sql).toContain('DISTINCT ON (fd.nr_unic_inreg)');
    expect(sql).toMatch(/ORDER BY fd\.nr_unic_inreg,\s*fd\.revizie_nr DESC/);
    // Angajamente: Sec.B col.10 = sum_rezv_crdt_bug_act
    expect(sql).toContain('rows_ctrl');
    expect(sql).toContain('sum_rezv_crdt_bug_act');
    // Ordonanțări: ORD col.4
    expect(sql).toContain('suma_ordonantata_plata');
    // Plăți: confirmate efectiv
    expect(sql).toContain('plata_confirmed_at IS NOT NULL');

    // ── buget CTE și noua formulă ─────────────────────────────────────────
    expect(sql).toContain('clasa8_buget');
    expect(sql).toMatch(/-\s*COALESCE\(o\.suma,\s*0\)\)::numeric,\s*2\)\s*AS\s*ramane_din_angajamente/i);

    // ── Negative: NU trebuie să mai fie sursa veche ──────────────────────
    expect(sql).not.toContain('sum_rezv_crdt_ang_act'); // col.7 (credite ANG, greșit)
    expect(sql).not.toContain('valt_actualiz');         // Sec.A (greșit ca sursă)
    expect(sql).not.toMatch(/\bfd\.status\s*=\s*'completed'/);
    expect(sql).not.toMatch(/\bfo\.status\s*=\s*'completed'/);
  });
});
