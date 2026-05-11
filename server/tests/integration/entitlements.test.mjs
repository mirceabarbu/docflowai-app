/**
 * DocFlowAI — Integration tests: Entitlements (PASUL 2)
 *
 * Acoperire:
 *   Resolver (services/entitlements.mjs):
 *     ✓ Default catalog când nu există override
 *     ✓ user override câștigă peste comp + org
 *     ✓ comp override câștigă peste org (fără user)
 *     ✓ org override (fără user/comp)
 *     ✓ Modul necunoscut/inactiv → false
 *     ✓ Cache 60s: două apeluri = un singur SELECT
 *     ✓ Cache invalidat după invalidate()
 *
 *   Endpoint /api/admin/entitlements:
 *     ✓ PUT cu user normal → 403
 *     ✓ PUT cu org_admin → 403 (nu superadmin)
 *     ✓ PUT cu superadmin → 200 + invocă upsert
 *
 *   Endpoint /api/entitlements/me:
 *     ✓ returnează mapa pentru user logat
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

// ── Mock-uri ESM ─────────────────────────────────────────────────────────────
vi.mock('../../db/index.mjs', () => {
  const mockQuery = vi.fn();
  return {
    pool:           { query: mockQuery },
    DB_READY:       true,
    requireDb:      vi.fn(() => false),
    DB_LAST_ERROR:  null,
    writeAuditEvent: vi.fn(async () => {}),
  };
});

vi.mock('../../middleware/logger.mjs', () => ({
  logger: {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  },
  redactUrl: (u) => u,
}));

vi.mock('../../middleware/csrf.mjs', () => ({
  csrfMiddleware: (_req, _res, next) => next(),
  generateCsrfToken: () => 'test-csrf',
}));

// ── Imports după mock-uri ────────────────────────────────────────────────────
import * as dbModule from '../../db/index.mjs';
import entitlementsAdminRouter from '../../routes/admin/entitlements.mjs';
import {
  isModuleEnabled,
  getAllModulesForUser,
  invalidate,
  invalidateAll,
} from '../../services/entitlements.mjs';

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-vitest-docflowai-2025';

function makeToken(overrides = {}) {
  return jwt.sign(
    { userId: 100, email: 'user@org.ro', role: 'user', orgId: 1, compartiment: 'Achiziții', ...overrides },
    JWT_SECRET,
    { expiresIn: '2h' }
  );
}

function makeOrgAdminToken(overrides = {}) {
  return jwt.sign(
    { userId: 200, email: 'orgadmin@org.ro', role: 'org_admin', orgId: 1, ...overrides },
    JWT_SECRET,
    { expiresIn: '2h' }
  );
}

function makeSuperadminToken(overrides = {}) {
  return jwt.sign(
    { userId: 1, email: 'admin@docflowai.ro', role: 'admin', orgId: null, ...overrides },
    JWT_SECRET,
    { expiresIn: '2h' }
  );
}

function createAdminApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/admin/entitlements', entitlementsAdminRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbModule.pool.query.mockReset();
  dbModule.pool.query.mockResolvedValue({ rows: [] });
  invalidateAll();
});

// ─────────────────────────────────────────────────────────────────────────────
// Resolver — most-specific wins
// ─────────────────────────────────────────────────────────────────────────────
describe('isModuleEnabled — resolver', () => {
  it('fără override → fallback la default_enabled din catalog (true)', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [] })                          // module_entitlements: empty
      .mockResolvedValueOnce({ rows: [{ default_enabled: true }] }); // catalog
    const enabled = await isModuleEnabled(dbModule.pool, {
      moduleKey: 'refnec', userId: 100, compartiment: 'Achiziții', orgId: 1,
    });
    expect(enabled).toBe(true);
  });

  it('user override (true) câștigă peste comp (false) și org (false)', async () => {
    dbModule.pool.query.mockResolvedValueOnce({
      rows: [
        { scope_type: 'user', enabled: true },
        { scope_type: 'comp', enabled: false },
        { scope_type: 'org',  enabled: false },
      ],
    });
    const enabled = await isModuleEnabled(dbModule.pool, {
      moduleKey: 'refnec', userId: 100, compartiment: 'Achiziții', orgId: 1,
    });
    expect(enabled).toBe(true);
  });

  it('comp override (false) câștigă peste org (true) când nu există user', async () => {
    dbModule.pool.query.mockResolvedValueOnce({
      rows: [
        { scope_type: 'comp', enabled: false },
        { scope_type: 'org',  enabled: true },
      ],
    });
    const enabled = await isModuleEnabled(dbModule.pool, {
      moduleKey: 'alop', userId: 101, compartiment: 'Buget', orgId: 1,
    });
    expect(enabled).toBe(false);
  });

  it('org override (true) când nu există user/comp', async () => {
    dbModule.pool.query.mockResolvedValueOnce({
      rows: [{ scope_type: 'org', enabled: true }],
    });
    const enabled = await isModuleEnabled(dbModule.pool, {
      moduleKey: 'clasa8', userId: 102, compartiment: 'Audit', orgId: 1,
    });
    expect(enabled).toBe(true);
  });

  it('lipsă match peste tot + catalog.active=false (nimic în catalog) → false', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [] })  // module_entitlements: empty
      .mockResolvedValueOnce({ rows: [] }); // catalog: empty (sau active=false)
    const enabled = await isModuleEnabled(dbModule.pool, {
      moduleKey: 'inexistent', userId: 103, compartiment: 'X', orgId: 1,
    });
    expect(enabled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cache
// ─────────────────────────────────────────────────────────────────────────────
describe('cache 60s + invalidate', () => {
  it('două apeluri consecutive → un singur SELECT (hit cache)', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ scope_type: 'user', enabled: true }] });
    const ctx = { moduleKey: 'refnec', userId: 500, compartiment: 'A', orgId: 1 };
    const r1 = await isModuleEnabled(dbModule.pool, ctx);
    const r2 = await isModuleEnabled(dbModule.pool, ctx);
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(dbModule.pool.query).toHaveBeenCalledTimes(1);
  });

  it('cache invalidat după invalidate({userId}) → SELECT re-rulat', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ scope_type: 'user', enabled: true }] })
      .mockResolvedValueOnce({ rows: [{ scope_type: 'user', enabled: false }] });
    const ctx = { moduleKey: 'refnec', userId: 600, compartiment: 'A', orgId: 1 };
    const r1 = await isModuleEnabled(dbModule.pool, ctx);
    expect(r1).toBe(true);
    invalidate({ userId: 600 });
    const r2 = await isModuleEnabled(dbModule.pool, ctx);
    expect(r2).toBe(false);
    expect(dbModule.pool.query).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint /api/admin/entitlements PUT — gardă superadmin
// ─────────────────────────────────────────────────────────────────────────────
describe('PUT /api/admin/entitlements — gardă superadmin', () => {
  it('403 — user normal', async () => {
    const app = createAdminApp();
    const res = await request(app)
      .put('/api/admin/entitlements')
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({ module_key: 'refnec', scope_type: 'user', scope_id: '100', enabled: true });
    expect(res.status).toBe(403);
  });

  it('403 — org_admin (nu superadmin)', async () => {
    const app = createAdminApp();
    const res = await request(app)
      .put('/api/admin/entitlements')
      .set('Cookie', `auth_token=${makeOrgAdminToken()}`)
      .send({ module_key: 'refnec', scope_type: 'user', scope_id: '100', enabled: true });
    expect(res.status).toBe(403);
  });

  it('200 — superadmin → upsert returnează entitlement', async () => {
    // Sequence:
    //  1) SELECT module_key FROM module_catalog → exists
    //  2) SELECT enabled FROM module_entitlements (old) → empty
    //  3) INSERT ... RETURNING → returnează rândul nou
    const insertedRow = {
      id: 42, module_key: 'refnec', scope_type: 'user', scope_id: '100',
      enabled: true, set_by: 1, set_at: new Date().toISOString(), notes: null,
    };
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ module_key: 'refnec' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [insertedRow] });

    const app = createAdminApp();
    const res = await request(app)
      .put('/api/admin/entitlements')
      .set('Cookie', `auth_token=${makeSuperadminToken()}`)
      .send({ module_key: 'refnec', scope_type: 'user', scope_id: '100', enabled: true });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.entitlement).toEqual(insertedRow);

    // Verificăm că s-a făcut INSERT (al 3-lea apel) cu valorile corecte
    const insertCall = dbModule.pool.query.mock.calls[2];
    expect(insertCall[0]).toMatch(/INSERT INTO module_entitlements/i);
    expect(insertCall[1]).toEqual(expect.arrayContaining(['refnec', 'user', '100', true]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/entitlements/me — batch resolver
// ─────────────────────────────────────────────────────────────────────────────
describe('getAllModulesForUser (helper folosit de /api/entitlements/me)', () => {
  it('returnează mapa { module_key: boolean } cu most-specific wins per modul', async () => {
    // Două module în catalog:
    //  - refnec: default_enabled=true, user_e=null, comp_e=null, org_e=null → true
    //  - alop:   default_enabled=true, user_e=false  → false
    dbModule.pool.query.mockResolvedValueOnce({
      rows: [
        { module_key: 'refnec', default_enabled: true,  user_e: null,  comp_e: null, org_e: null },
        { module_key: 'alop',   default_enabled: true,  user_e: false, comp_e: null, org_e: null },
      ],
    });
    const out = await getAllModulesForUser(dbModule.pool, {
      userId: 999, compartiment: 'Achiziții', orgId: 1,
    });
    expect(out).toEqual({ refnec: true, alop: false });
  });
});
