/**
 * DocFlowAI — Integration tests: audit DF/ORD per formular
 *
 * Acoperire:
 *   ✓ scriere audit la tranziții DF (creat, trimis_p2, completat, returnat) și ORD (creat)
 *   ✓ best-effort: eroare la recordFormularAudit NU propagă 500 pe tranziție
 *   ✓ GET /api/formulare-audit/:type/:id — 403 user normal, 200 admin,
 *     403 org_admin pe alt org, 404 id inexistent, 400 type invalid
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

vi.mock('../../db/index.mjs', () => {
  const mockQuery = vi.fn();
  return {
    pool:          { query: mockQuery },
    DB_READY:      true,
    requireDb:     vi.fn(() => false),
    DB_LAST_ERROR: null,
  };
});

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
}));

vi.mock('../../middleware/csrf.mjs', () => ({
  csrfMiddleware: (_req, _res, next) => next(),
}));

import * as dbModule from '../../db/index.mjs';
import { formulareDbRouter } from '../../routes/formulare-db.mjs';

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-vitest-docflowai-2025';
const DF_ID  = 'ddddffff-0000-0000-0000-000000000001';
const ORD_ID = 'aaaaffff-0000-0000-0000-000000000001';

function makeToken(overrides = {}) {
  return jwt.sign(
    { userId: 1, email: 'p1@primaria.ro', role: 'user', orgId: 1, nume: 'P1 Test', ...overrides },
    JWT_SECRET, { expiresIn: '2h' }
  );
}

function makeDfRow(overrides = {}) {
  return {
    id: DF_ID, org_id: 1, created_by: 1, version: 1, status: 'draft',
    revizie_nr: 0, parent_df_id: null, assigned_to: null,
    nr_unic_inreg: '', flow_id: null, motiv_returnare: null, deleted_at: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function createTestApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use('/', formulareDbRouter);
  return app;
}

/** Mock pool.query pe baza substring-ului SQL (robust la ordine). */
function mockBySql(map) {
  dbModule.pool.query.mockImplementation((sql) => {
    const s = String(sql);
    for (const [needle, result] of map) {
      if (s.includes(needle)) return Promise.resolve(result);
    }
    return Promise.resolve({ rows: [] });
  });
}

function auditCalls(eventType) {
  return dbModule.pool.query.mock.calls.filter(c =>
    String(c[0]).includes('INSERT INTO formulare_audit') &&
    (!eventType || c[1]?.[5] === eventType)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  dbModule.pool.query.mockReset();
  dbModule.pool.query.mockResolvedValue({ rows: [] });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Scriere audit la tranziții
// ─────────────────────────────────────────────────────────────────────────────

describe('audit write — tranziții DF/ORD', () => {
  it('DF create → eveniment "creat" cu to_status=draft', async () => {
    mockBySql([['INSERT INTO formulare_df', { rows: [makeDfRow()] }]]);
    const res = await request(createTestApp())
      .post('/api/formulare-df')
      .set('Cookie', `auth_token=${makeToken({ role: 'admin' })}`)
      .send({ den_inst_pb: 'Primăria Test' });
    expect(res.status).toBe(200);
    const calls = auditCalls('creat');
    expect(calls.length).toBe(1);
    expect(calls[0][1][1]).toBe('df');           // form_type
    expect(calls[0][1][7]).toBe('draft');        // to_status
  });

  it('DF submit → eveniment "trimis_p2" cu meta.assigned_to', async () => {
    mockBySql([
      ['SELECT * FROM formulare_df', { rows: [makeDfRow({ status: 'draft' })] }],
      ['FROM users WHERE id=$1 AND org_id=$2', { rows: [{ id: 2, email: 'p2@primaria.ro', nume: 'P2' }] }],
      ['UPDATE formulare_df', { rows: [makeDfRow({ status: 'pending_p2', assigned_to: 2 })] }],
    ]);
    const res = await request(createTestApp())
      .post(`/api/formulare-df/${DF_ID}/submit`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({ assigned_to: 2 });
    expect(res.status).toBe(200);
    const calls = auditCalls('trimis_p2');
    expect(calls.length).toBe(1);
    expect(calls[0][1][8]).toContain('assigned_to'); // meta JSON
    expect(calls[0][1][6]).toBe('draft');            // from_status
    expect(calls[0][1][7]).toBe('pending_p2');       // to_status
  });

  it('DF complete → eveniment "completat" cu to_status=completed', async () => {
    mockBySql([
      ['SELECT * FROM formulare_df', { rows: [makeDfRow({ status: 'pending_p2', assigned_to: 2 })] }],
      ['UPDATE formulare_df', { rows: [makeDfRow({ status: 'completed', assigned_to: 2 })] }],
    ]);
    const res = await request(createTestApp())
      .post(`/api/formulare-df/${DF_ID}/complete`)
      .set('Cookie', `auth_token=${makeToken({ userId: 2, email: 'p2@primaria.ro' })}`)
      .send({});
    expect(res.status).toBe(200);
    const calls = auditCalls('completat');
    expect(calls.length).toBe(1);
    expect(calls[0][1][7]).toBe('completed');
  });

  it('DF returneaza → eveniment "returnat" cu meta.motiv', async () => {
    mockBySql([
      ['SELECT * FROM formulare_df', { rows: [makeDfRow({ status: 'pending_p2', assigned_to: 1 })] }],
      ['UPDATE formulare_df', { rows: [makeDfRow({ status: 'returnat' })] }],
    ]);
    const res = await request(createTestApp())
      .post(`/api/formulare-df/${DF_ID}/returneaza`)
      .set('Cookie', `auth_token=${makeToken({ userId: 1 })}`)
      .send({ motiv: 'date incorecte' });
    expect(res.status).toBe(200);
    const calls = auditCalls('returnat');
    expect(calls.length).toBe(1);
    expect(calls[0][1][8]).toContain('date incorecte');
  });

  it('ORD create → eveniment "creat" cu form_type=ord', async () => {
    mockBySql([['INSERT INTO formulare_ord', { rows: [{ id: ORD_ID, org_id: 1, created_by: 1, status: 'draft' }] }]]);
    const res = await request(createTestApp())
      .post('/api/formulare-ord')
      .set('Cookie', `auth_token=${makeToken({ role: 'admin' })}`)
      .send({ den_inst_pb: 'Primăria Test' });
    expect(res.status).toBe(200);
    const calls = auditCalls('creat');
    expect(calls.length).toBe(1);
    expect(calls[0][1][1]).toBe('ord');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Best-effort — eroarea de audit nu blochează tranziția
// ─────────────────────────────────────────────────────────────────────────────

describe('audit best-effort', () => {
  it('eroare la INSERT formulare_audit → tranziția rămâne 200', async () => {
    dbModule.pool.query.mockImplementation((sql) => {
      const s = String(sql);
      if (s.includes('INSERT INTO formulare_audit')) return Promise.reject(new Error('boom'));
      if (s.includes('INSERT INTO formulare_df')) return Promise.resolve({ rows: [makeDfRow()] });
      return Promise.resolve({ rows: [] });
    });
    const res = await request(createTestApp())
      .post('/api/formulare-df')
      .set('Cookie', `auth_token=${makeToken({ role: 'admin' })}`)
      .send({ den_inst_pb: 'Primăria Test' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. GET /api/formulare-audit/:type/:id — autorizare + format
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/formulare-audit/:type/:id', () => {
  it('403 — user normal (nici admin, nici org_admin)', async () => {
    const res = await request(createTestApp())
      .get(`/api/formulare-audit/df/${DF_ID}`)
      .set('Cookie', `auth_token=${makeToken({ role: 'user' })}`);
    expect(res.status).toBe(403);
  });

  it('400 — type invalid', async () => {
    const res = await request(createTestApp())
      .get(`/api/formulare-audit/xxx/${DF_ID}`)
      .set('Cookie', `auth_token=${makeToken({ role: 'admin' })}`);
    expect(res.status).toBe(400);
  });

  it('404 — document inexistent', async () => {
    mockBySql([['FROM formulare_df d', { rows: [] }]]);
    const res = await request(createTestApp())
      .get(`/api/formulare-audit/df/${DF_ID}`)
      .set('Cookie', `auth_token=${makeToken({ role: 'admin' })}`);
    expect(res.status).toBe(404);
  });

  it('403 — org_admin pe document din alt org', async () => {
    mockBySql([['FROM formulare_df d', { rows: [{ id: DF_ID, org_id: 99, status: 'draft' }] }]]);
    const res = await request(createTestApp())
      .get(`/api/formulare-audit/df/${DF_ID}`)
      .set('Cookie', `auth_token=${makeToken({ role: 'org_admin', orgId: 1 })}`);
    expect(res.status).toBe(403);
  });

  it('200 — admin primește document + events', async () => {
    mockBySql([
      ['FROM formulare_df d', { rows: [{ id: DF_ID, org_id: 1, nr: '123/2026', status: 'completed',
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        init_name: 'P1 Test', init_email: 'p1@primaria.ro' }] }],
      ['FROM formulare_audit a', { rows: [
        { id: 'e1', event_type: 'creat', from_status: null, to_status: 'draft',
          meta: {}, actor_email: 'p1@primaria.ro', actor_name: 'P1 Test',
          created_at: new Date().toISOString() },
      ] }],
    ]);
    const res = await request(createTestApp())
      .get(`/api/formulare-audit/df/${DF_ID}`)
      .set('Cookie', `auth_token=${makeToken({ role: 'admin' })}`);
    expect(res.status).toBe(200);
    expect(res.body.document.nr).toBe('123/2026');
    expect(res.body.events.length).toBe(1);
    expect(res.body.events[0].event_type).toBe('creat');
  });

  it('200 — export CSV cu BOM + antet coloane', async () => {
    mockBySql([
      ['FROM formulare_df d', { rows: [{ id: DF_ID, org_id: 1, nr: '123/2026', status: 'completed',
        created_at: new Date().toISOString(), updated_at: new Date().toISOString() }] }],
      ['FROM formulare_audit a', { rows: [] }],
    ]);
    const res = await request(createTestApp())
      .get(`/api/formulare-audit/df/${DF_ID}?format=csv`)
      .set('Cookie', `auth_token=${makeToken({ role: 'admin' })}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text.charCodeAt(0)).toBe(0xFEFF);            // BOM
    expect(res.text).toContain('timestamp,event,actor,from,to,meta');
  });
});
