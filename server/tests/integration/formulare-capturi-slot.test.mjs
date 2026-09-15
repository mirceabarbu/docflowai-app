/**
 * v3.9.499 — formulare-capturi endpoint cu slot parameter
 *
 * Acoperire:
 *   ✓ POST cu ?slot=2 → salvează în slot 2 (nu șterge slot 1)
 *   ✓ POST fără query → default slot=1 (backward compat DF)
 *   ✓ POST cu slot invalid (3, "abc") → cădere la slot=1
 *   ✓ GET ?slot=2 → returnează slot 2 specific
 *   ✓ GET fără query → default slot=1 (backward compat)
 *   ✓ GET ?slot=2 fără date → 404 cu slot:2 în body
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

const ORD_ID = 'ddddffff-0000-0000-0000-00000000ABCD';

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-vitest-docflowai-2025';

function makeAuthCookie(userId = 1, role = 'user', orgId = 1) {
  const t = jwt.sign({ email: 'p2@x.ro', role, orgId, userId }, JWT_SECRET, { expiresIn: '1h' });
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

describe('POST /api/formulare-capturi/:type/:id cu slot', () => {
  // #205 — înlocuirea capturii din slot e o SINGURĂ interogare atomică (INSERT ... ON CONFLICT
  // pe cheia (form_type, form_id, slot, COALESCE(bloc_idx,0))), nu DELETE + INSERT separate
  // (cursă: două cereri paralele ștergeau amândouă, a doua lovea indexul unic cu 500).
  // Intenția rămâne aceeași ca la v3.9.499: „slot 2 nu atinge slot 1" — cheia de conflict
  // conține slotul, deci un upload pe slot 2 nu poate înlocui decât rândul slotului 2.
  it('POST cu ?slot=2 → fără DELETE; un singur INSERT ON CONFLICT cu cheia (slot=2, bloc=0)', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 1, status: 'pending_p2' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'cap-new', filename: 'x.png', mimetype: 'image/png', size_bytes: 100, slot: 2, created_at: '2026-05-22' }], rowCount: 1 });

    const res = await request(createTestApp())
      .post(`/api/formulare-capturi/ord/${ORD_ID}?slot=2`)
      .set('Cookie', makeAuthCookie())
      .set('Content-Type', 'image/png')
      .send(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // #205 — NICIUN DELETE: ștergerea separată era jumătatea vulnerabilă a cursei.
    const deleteCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('DELETE FROM formulare_capturi')
    );
    expect(deleteCall, 'DELETE separat NU trebuie emis (#205: ON CONFLICT atomic)').toBeUndefined();

    const insertCalls = dbModule.pool.query.mock.calls.filter(c =>
      String(c[0]).includes('INSERT INTO formulare_capturi')
    );
    expect(insertCalls).toHaveLength(1);
    const [sql, params] = insertCalls[0];
    // Ținta ON CONFLICT trebuie să fie EXACT expresia indexului unic din migrarea 107 —
    // cu `bloc_idx` simplu, Postgres nu găsește constrângerea și aruncă la EXECUȚIE.
    expect(sql.replace(/\s+/g, ' ')).toContain('ON CONFLICT (form_type, form_id, slot, (COALESCE(bloc_idx, 0))) DO UPDATE SET');
    // Cheia: (type, id, slot=2, bloc=0) — slot 2 nu poate înlocui decât rândul slotului 2.
    // #128n — blocul de furnizor face parte din cheie (absent din query ⇒ 0).
    expect(params.slice(0, 2)).toEqual(['ord', ORD_ID]);
    expect(params[7]).toBe(2);   // slot
    expect(params[8]).toBe(0);   // bloc_idx
    expect(res.body.captura).toMatchObject({ id: 'cap-new', slot: 2 });
  });

  it('POST fără ?slot → default slot=1', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 1, status: 'draft' }], rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'cap-x', slot: 1 }], rowCount: 1 });

    const res = await request(createTestApp())
      .post(`/api/formulare-capturi/ord/${ORD_ID}`)
      .set('Cookie', makeAuthCookie())
      .set('Content-Type', 'image/png')
      .send(Buffer.from([0x89, 0x50, 0x4E, 0x47]));

    expect(res.status).toBe(200);
    const insertCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('INSERT INTO formulare_capturi')
    );
    expect(insertCall[1][7]).toBe(1);
  });

  it('POST cu slot invalid (3) → cădere la slot=1', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 1, status: 'draft' }], rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'cap-x', slot: 1 }], rowCount: 1 });

    const res = await request(createTestApp())
      .post(`/api/formulare-capturi/ord/${ORD_ID}?slot=3`)
      .set('Cookie', makeAuthCookie())
      .set('Content-Type', 'image/png')
      .send(Buffer.from([0x89, 0x50]));

    expect(res.status).toBe(200);
    const insertCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('INSERT INTO formulare_capturi')
    );
    expect(insertCall[1][7]).toBe(1);
  });
});

describe('GET /api/formulare-capturi/:type/:id cu slot', () => {
  it('GET ?slot=2 → SELECT cu slot=2 în WHERE', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ filename: 'c2.png', mimetype: 'image/png', data: Buffer.from([0x89]) }], rowCount: 1 });

    const res = await request(createTestApp())
      .get(`/api/formulare-capturi/ord/${ORD_ID}?slot=2`)
      .set('Cookie', makeAuthCookie());

    expect(res.status).toBe(200);
    const selectCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('SELECT filename, mimetype, data FROM formulare_capturi') &&
      String(c[0]).includes('slot=$3')
    );
    expect(selectCall, 'SELECT cu slot lipsește').toBeDefined();
    expect(selectCall[1]).toEqual(['ord', ORD_ID, 2, 0]);  // #128n: + bloc_idx
  });

  it('GET fără query → default slot=1 (backward compat DF)', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ filename: 'c1.png', mimetype: 'image/png', data: Buffer.from([0x89]) }], rowCount: 1 });

    const res = await request(createTestApp())
      .get(`/api/formulare-capturi/df/${ORD_ID}`)
      .set('Cookie', makeAuthCookie());

    expect(res.status).toBe(200);
    const selectCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('SELECT filename, mimetype, data FROM formulare_capturi')
    );
    expect(selectCall[1]).toEqual(['df', ORD_ID, 1, 0]);  // #128n: + bloc_idx
  });

  it('GET ?slot=2 fără date → 404 cu body.slot=2', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(createTestApp())
      .get(`/api/formulare-capturi/ord/${ORD_ID}?slot=2`)
      .set('Cookie', makeAuthCookie());

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('no_captura');
    expect(res.body.slot).toBe(2);
  });
});
