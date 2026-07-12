/**
 * v3.9.632 — GET /users exclude utilizatorii dezactivați (deleted_at NOT NULL)
 *
 * Sursa dropdown-urilor de selecție utilizator (semnatari „Flux nou",
 * transmitere manuală, delegări, șabloane, signer). Înainte de fix, niciuna
 * din cele 3 ramuri de query (institutie / org_id / fallback) nu excludea
 * deleted_at → userii dezactivați apăreau selectabili.
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

describe('GET /users — exclude utilizatori dezactivați (v3.9.632)', () => {
  it('ramura institutie: query-ul include AND deleted_at IS NULL, întoarce doar activul', async () => {
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
    expect(secondCallSql).toMatch(/WHERE org_id=\$1 AND institutie=\$2 AND deleted_at IS NULL/);
  });

  it('ramura org_id (fara institutie): query-ul include AND deleted_at IS NULL', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [actorRow({ id: 9, email: 'admin@x.ro', role: 'org_admin', institutie: null })] })
      .mockResolvedValueOnce({ rows: [ACTIVE_USER] });

    const res = await request(createTestApp())
      .get('/users')
      .set('Cookie', makeAuth('admin@x.ro', 9, 'org_admin', 1));

    expect(res.status).toBe(200);
    const secondCallSql = dbModule.pool.query.mock.calls[1][0];
    expect(secondCallSql).toMatch(/WHERE org_id=\$1 AND deleted_at IS NULL/);
  });

  it('ramura fallback (fara institutie, fara orgId): query-ul include WHERE deleted_at IS NULL', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [actorRow({ id: 9, email: 'admin@x.ro', role: 'admin', org_id: null, institutie: null })] })
      .mockResolvedValueOnce({ rows: [ACTIVE_USER] });

    const res = await request(createTestApp())
      .get('/users')
      .set('Cookie', makeAuth('admin@x.ro', 9, 'admin', null));

    expect(res.status).toBe(200);
    const secondCallSql = dbModule.pool.query.mock.calls[1][0];
    expect(secondCallSql).toMatch(/FROM users WHERE deleted_at IS NULL/);
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
