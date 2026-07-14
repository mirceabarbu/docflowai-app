/**
 * v3.9.632 — GET /users exclude utilizatorii dezactivați (deleted_at NOT NULL)
 *
 * Sursa dropdown-urilor de selecție utilizator (semnatari „Flux nou",
 * transmitere manuală, delegări, șabloane, signer). Înainte de fix, niciuna
 * din ramurile de query nu excludea deleted_at → userii dezactivați apăreau selectabili.
 *
 * SEC-90 (v3.9.674): cele 3 ramuri (institutie / org_id / fallback „toți userii") au
 * fost COLAPSATE într-una singură, scopată necondiționat pe `org_id` (+ `role <> 'admin'`).
 * Invariantul acestui fișier — listarea NU întoarce utilizatori dezactivați — rămâne
 * valabil și se verifică pe noul query unic.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

vi.mock('../../db/index.mjs', () => ({
  pool:                   { query: vi.fn() },
  requireDb:              vi.fn(() => false),
  invalidateOrgUserCache: vi.fn(),
  writeAuditEvent:        vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/user-leave.mjs', () => ({
  validateLeaveSettings: vi.fn(),
  setUserLeave:          vi.fn(),
  clearUserLeave:        vi.fn(),
  getLeaveInfo:          vi.fn(),
  batchGetLeaveInfo:     vi.fn().mockResolvedValue(new Map()),
}));

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
}));

import * as dbModule from '../../db/index.mjs';
import usersRouter from '../../routes/admin/users.mjs';
import { JWT_SECRET } from '../../middleware/auth.mjs';

function makeAuth(email, userId, role, orgId) {
  return `auth_token=${jwt.sign({ email, userId, role, orgId, tv: 1 }, JWT_SECRET, { expiresIn: '1h' })}`;
}

function createTestApp() {
  const app = express();
  app.use(cookieParser());
  app.use('/', usersRouter);
  return app;
}

const ACTIVE_USER  = { id: 1, email: 'activ@x.ro',    nume: 'Activ Ion',       functie: 'ref', institutie: 'Primaria X', compartiment: 'C1', org_id: 1 };
const DELETED_USER = { id: 2, email: 'dezactivat@x.ro', nume: 'Igrisan Alexandru', functie: 'ref', institutie: 'Primaria X', compartiment: 'C1', org_id: 1 };

function actorRow(overrides = {}) {
  return {
    id: 1, email: 'activ@x.ro', nume: 'Activ Ion', functie: 'ref',
    compartiment: 'C1', institutie: 'Primaria X', role: 'user', org_id: 1,
    token_version: 1, force_password_change: false, ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /users — exclude utilizatori dezactivați (v3.9.632, SEC-90 v3.9.674)', () => {
  it('query-ul unic scopat pe org_id include AND deleted_at IS NULL, întoarce doar activul', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [actorRow()] })
      .mockResolvedValueOnce({ rows: [ACTIVE_USER] });                  // filtrat deja de query (mock simulează backend-ul real)

    const res = await request(createTestApp())
      .get('/users')
      .set('Cookie', makeAuth('activ@x.ro', 1, 'user', 1));

    expect(res.status).toBe(200);
    expect(res.body.map(u => u.email)).toEqual(['activ@x.ro']);
    expect(res.body.map(u => u.email)).not.toContain('dezactivat@x.ro');

    const secondCallSql = dbModule.pool.query.mock.calls[1][0];
    expect(secondCallSql).toMatch(/org_id\s*=\s*\$1/);
    expect(secondCallSql).toMatch(/deleted_at IS NULL/);           // ⭐ invariantul v3.9.632
    expect(secondCallSql).toMatch(/role\s*<>\s*'admin'/);          // SEC-90: super-admin exclus
    expect(secondCallSql).not.toMatch(/institutie\s*=/);           // SEC-90: fără filtru pe institutie
  });

  it('org_admin: același query unic scopat pe org_id, cu deleted_at IS NULL', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [actorRow({ id: 9, email: 'admin@x.ro', role: 'org_admin', institutie: null })] })
      .mockResolvedValueOnce({ rows: [ACTIVE_USER] });

    const res = await request(createTestApp())
      .get('/users')
      .set('Cookie', makeAuth('admin@x.ro', 9, 'org_admin', 1));

    expect(res.status).toBe(200);
    const secondCallSql = dbModule.pool.query.mock.calls[1][0];
    expect(secondCallSql).toMatch(/org_id\s*=\s*\$1/);
    expect(secondCallSql).toMatch(/deleted_at IS NULL/);
  });

  it('actor fără org (fostă ramură „toți userii") ⇒ [] fail-closed, fără listare', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [actorRow({ id: 9, email: 'admin@x.ro', role: 'admin', org_id: null, institutie: null })] });

    const res = await request(createTestApp())
      .get('/users')
      .set('Cookie', makeAuth('admin@x.ro', 9, 'admin', null));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    // SEC-90: NU mai există ramura fallback „SELECT ... FROM users WHERE deleted_at IS NULL"
    // fără filtru de org — deci NU se face niciun al doilea query de listare.
    expect(dbModule.pool.query).toHaveBeenCalledTimes(1);
  });

  it('un user activ apare normal în răspuns', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [actorRow()] })
      .mockResolvedValueOnce({ rows: [ACTIVE_USER] });

    const res = await request(createTestApp())
      .get('/users')
      .set('Cookie', makeAuth('activ@x.ro', 1, 'user', 1));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].email).toBe('activ@x.ro');
  });
});
