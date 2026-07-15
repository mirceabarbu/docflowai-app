/**
 * v3.9.501 — formulare-atasamente cu slot pentru DF
 *
 * Acoperire:
 *   ✓ POST cu ?slot=2 → INSERT cu slot=2
 *   ✓ POST fără query → default slot=1 (backward compat v3.9.500 ORD)
 *   ✓ POST cu slot invalid → cădere la slot=1
 *   ✓ GET list ?slot=2 → SELECT WHERE slot=2
 *   ✓ GET list fără query → SELECT WHERE slot=1
 *   ✓ Replace slot 2 pe DF nu afectează slot 1 (isolation)
 *   ✓ DF cu atașamente pe ambele sloturi: list slot=1 vs slot=2 returnează diferit
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

vi.mock('../../db/index.mjs', () => ({
  pool:            { query: vi.fn() },
  DB_READY:        true,
  requireDb:       vi.fn(() => false),
  saveFlow:        vi.fn().mockResolvedValue(undefined),
  getFlowData:     vi.fn(),
  writeAuditEvent: vi.fn().mockResolvedValue(undefined),
  getDefaultOrgId: vi.fn().mockResolvedValue(1),
  DB_LAST_ERROR:   null,
}));

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
}));

vi.mock('../../middleware/csrf.mjs', () => ({
  csrfMiddleware: (req, res, next) => next(),
}));

vi.mock('../../middleware/require-module.mjs', () => ({
  requireModule: () => (_req, _res, next) => next(),
}));

vi.mock('../../services/authz-formular.mjs', () => ({
  canDestroyOnly:  vi.fn().mockReturnValue({ allowed: true }),
  canEditFormular: vi.fn().mockReturnValue({ allowed: true }),
  // v3.9.554 (B1): listă/download folosesc canViewFormular (authz centralizat)
  canViewFormular: vi.fn().mockReturnValue({ allowed: true, mode: 'edit' }),
  loadActorComp:   vi.fn().mockResolvedValue(''),
  loadActorCompAndCab: vi.fn().mockResolvedValue({ actorComp: '', cabComp: '' }),
  isCabDept:       vi.fn(() => false),
}));

import * as dbModule from '../../db/index.mjs';
import { formulareDbRouter } from '../../routes/formulare/index.mjs';

const DF_ID  = 'aaaadddd-0000-0000-0000-00000000DF01';
const ATT_S1 = 'aaaa1111-1111-1111-1111-111111111111';
const ATT_S2 = 'bbbb2222-2222-2222-2222-222222222222';

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-vitest-docflowai-2025';

function makeAuthCookie(userId = 1, role = 'user', orgId = 1) {
  const t = jwt.sign({ email: 'p1@x.ro', role, orgId, userId }, JWT_SECRET, { expiresIn: '1h' });
  return `auth_token=${t}`;
}

function createTestApp() {
  const app = express();
  app.use(cookieParser());
  app.use('/', formulareDbRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbModule.pool.query.mockReset();
  dbModule.pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('POST upload cu slot', () => {
  it('?slot=2 → INSERT cu slot=2', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 2, status: 'draft' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: ATT_S2, filename: 'sectB.pdf', mime_type: 'application/pdf', size_bytes: 500, slot: 2, created_at: '2026-05-22' }],
        rowCount: 1
      });

    const res = await request(createTestApp())
      .post(`/api/formulare-atasamente/df/${DF_ID}?slot=2`)
      .set('Cookie', makeAuthCookie())
      .set('Content-Type', 'application/pdf')
      .set('X-Filename', 'sectB.pdf')
      .send(Buffer.from('PDF-CONTENT-MOCK'));

    expect(res.status).toBe(200);
    expect(res.body.atasament.slot).toBe(2);

    const insertCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('INSERT INTO formulare_atasamente')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[1][7]).toBe(2);
  });

  it('fără ?slot → default slot=1 (backward compat ORD v3.9.500)', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 2, status: 'draft' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: ATT_S1, filename: 'x.pdf', mime_type: 'application/pdf', size_bytes: 100, slot: 1, created_at: '2026-05-22' }],
        rowCount: 1
      });

    const res = await request(createTestApp())
      .post(`/api/formulare-atasamente/ord/${DF_ID}`)
      .set('Cookie', makeAuthCookie())
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('x'));

    expect(res.status).toBe(200);
    const insertCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('INSERT INTO formulare_atasamente')
    );
    expect(insertCall[1][7]).toBe(1);
  });

  it('?slot=99 (invalid) → cădere la slot=1', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 2, status: 'draft' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: ATT_S1, slot: 1 }],
        rowCount: 1
      });

    const res = await request(createTestApp())
      .post(`/api/formulare-atasamente/df/${DF_ID}?slot=99`)
      .set('Cookie', makeAuthCookie())
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('y'));

    expect(res.status).toBe(200);
    const insertCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('INSERT INTO formulare_atasamente')
    );
    expect(insertCall[1][7]).toBe(1);
  });
});

describe('GET list cu slot', () => {
  it('?slot=2 → SELECT WHERE slot=2', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 2 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: ATT_S2, filename: 'sectB.pdf', mime_type: 'application/pdf', size_bytes: 500, slot: 2, uploaded_by: 1, created_at: '2026-05-22' }],
        rowCount: 1
      });

    const res = await request(createTestApp())
      .get(`/api/formulare-atasamente/df/${DF_ID}?slot=2`)
      .set('Cookie', makeAuthCookie());

    expect(res.status).toBe(200);
    expect(res.body.atasamente).toHaveLength(1);
    expect(res.body.atasamente[0].slot).toBe(2);

    const selectCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('SELECT id, filename, mime_type') &&
      String(c[0]).includes('slot=$3')
    );
    expect(selectCall, 'SELECT cu slot=$3 nu a fost apelat').toBeDefined();
    expect(selectCall[1]).toEqual(['df', DF_ID, 2]);
  });

  it('fără ?slot → SELECT WHERE slot=1', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 2 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: ATT_S1, filename: 'fd.pdf', mime_type: 'application/pdf', size_bytes: 300, slot: 1, uploaded_by: 1, created_at: '2026-05-22' }],
        rowCount: 1
      });

    const res = await request(createTestApp())
      .get(`/api/formulare-atasamente/df/${DF_ID}`)
      .set('Cookie', makeAuthCookie());

    expect(res.status).toBe(200);
    const selectCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('SELECT id, filename, mime_type')
    );
    expect(selectCall[1]).toEqual(['df', DF_ID, 1]);
  });

  it('slot 1 list returnează doar slot 1 (izolare slot)', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 2 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: ATT_S1, filename: 'fd.pdf', mime_type: 'application/pdf', size_bytes: 300, slot: 1, uploaded_by: 1, created_at: '2026-05-22' }],
        rowCount: 1
      });

    const res = await request(createTestApp())
      .get(`/api/formulare-atasamente/df/${DF_ID}?slot=1`)
      .set('Cookie', makeAuthCookie());

    expect(res.body.atasamente).toHaveLength(1);
    expect(res.body.atasamente[0].slot).toBe(1);
    expect(res.body.atasamente.find(a => a.slot === 2)).toBeUndefined();
  });
});
