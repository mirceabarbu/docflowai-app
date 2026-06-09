/**
 * DocFlowAI — Integration tests: ALOP lazy recovery la GET detail
 *
 * Acoperă fix-ul BUG 2 (v3.9.514): server/routes/alop.mjs
 * Lazy auto-tranziție extinsă — DF aprobat dar ALOP rămas accidental în
 * 'draft' SAU 'angajare' → recuperare automată la 'lichidare' la GET /api/alop/:id.
 *
 * Înainte: condiția cerea exact status==='angajare'. Dacă propagarea normală
 * (P2 /complete în routes/formulare/ sau link-df-flow) eșua silent, ALOP rămânea
 * blocat în 'draft' permanent chiar cu DF aprobat.
 *
 * Cazuri:
 *   ✓ draft    + DF aprobat → lichidare (recuperare nouă)
 *   ✓ angajare + DF aprobat → lichidare (back-compat preexistent)
 *   ✓ draft    + DF NEaprobat → rămâne draft (nicio tranziție)
 *   ✓ cancelled (filtrat de WHERE) → 404, nicio tranziție
 *   ✓ idempotent: ALOP deja 'lichidare' → UPDATE nu rulează, df_completed_at păstrat
 *
 * Mock-based (același pattern ca alop.test.mjs). Token org_admin → fără query
 * de compartiment (loadActorComp e sărit pentru admin/org_admin), deci:
 *   query 0 = SELECT detail
 *   query 1 = lazy UPDATE (condiționat)
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

// ── Mock-uri ESM — hoisted automat de vitest ──────────────────────────────────

vi.mock('../../db/index.mjs', () => {
  const mockQuery = vi.fn();
  return {
    pool:          { query: mockQuery },
    DB_READY:      true,
    requireDb:     vi.fn(() => false),   // false = DB disponibil
    DB_LAST_ERROR: null,
  };
});

vi.mock('../../middleware/logger.mjs', () => ({
  logger: {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  },
}));

vi.mock('../../middleware/csrf.mjs', () => ({
  csrfMiddleware: (_req, _res, next) => next(),
}));

vi.mock('../../middleware/require-module.mjs', () => ({
  requireModule: () => (_req, _res, next) => next(),
}));

// ── Importuri după mock-uri ───────────────────────────────────────────────────

import * as dbModule from '../../db/index.mjs';
import { logger } from '../../middleware/logger.mjs';
import alopRouter from '../../routes/alop.mjs';

// ── Constante ─────────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-vitest-docflowai-2025';
const ALOP_ID = 'aaaabbbb-0000-0000-0000-000000000099';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** JWT org_admin org 1 — sare peste query-ul de compartiment (loadActorComp) */
function makeAdminToken(overrides = {}) {
  return jwt.sign(
    { userId: 2, email: 'admin@primaria.ro', role: 'org_admin', orgId: 1, nume: 'Admin Org', ...overrides },
    JWT_SECRET,
    { expiresIn: '2h' }
  );
}

/** Row ALOP minimal (rândul întors de SELECT detail) */
function makeAlopRow(overrides = {}) {
  return {
    id:              ALOP_ID,
    org_id:          1,
    created_by:      1,
    titlu:           'Achiziție consumabile',
    compartiment:    'Secretariat',
    valoare_totala:  '1500.00',
    status:          'draft',
    df_id:           'ddddffff-0000-0000-0000-000000000099',
    ord_id:          null,
    df_flow_id:      'FLOW_DF_99',
    ord_flow_id:     null,
    df_aprobat:      false,
    ord_aprobat:     false,
    df_completed_at: null,
    ord_completed_at: null,
    cancelled_at:    null,
    df_valoare:      '1500.00',
    suma_platita_total: '0',
    created_at:      new Date().toISOString(),
    updated_at:      new Date().toISOString(),
    ...overrides,
  };
}

/** App Express minimal cu alop router */
function createTestApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(cookieParser());
  app.use('/', alopRouter);
  return app;
}

/** Apelurile UPDATE de recuperare lazy (df draft/angajare → lichidare) */
function lazyUpdateCalls() {
  return dbModule.pool.query.mock.calls.filter(c =>
    typeof c[0] === 'string' &&
    /UPDATE\s+alop_instances/i.test(c[0]) &&
    c[0].includes("status IN ('draft', 'angajare')")
  );
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  dbModule.pool.query.mockReset();
  dbModule.pool.query.mockResolvedValue({ rows: [] });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/alop/:id — lazy recovery din draft cu DF aprobat', () => {
  it('ALOP draft + DF aprobat → auto-tranziție la lichidare la GET detail', async () => {
    const T1 = new Date('2026-05-20T10:00:00.000Z').toISOString();
    const row = makeAlopRow({ status: 'draft', df_aprobat: true, df_completed_at: null });
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [row] })                                       // SELECT detail
      .mockResolvedValueOnce({ rows: [{ status: 'lichidare', df_completed_at: T1 }] }); // lazy UPDATE

    const app = createTestApp();
    const res = await request(app)
      .get(`/api/alop/${ALOP_ID}`)
      .set('Cookie', `auth_token=${makeAdminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.alop.status).toBe('lichidare');
    expect(res.body.alop.df_completed_at).toBe(T1);

    // UPDATE-ul de recuperare a fost emis, cu guard idempotent COALESCE + WHERE
    const calls = lazyUpdateCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toContain('COALESCE(df_completed_at, NOW())');
    // [id, actor.userId, resyncFlow] — fără df_authoritative_flow_id în row → fără resync (null)
    expect(calls[0][1]).toEqual([ALOP_ID, 2, null]);

    // Audit log emis cu status-ul de pornire
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('lazy auto-tranziție draft→lichidare')
    );
  });

  it('ALOP angajare + DF aprobat pe flux autoritar diferit → resync df_flow_id', async () => {
    const T1 = new Date('2026-05-20T12:00:00.000Z').toISOString();
    // df_flow_id (zombi) ≠ df_authoritative_flow_id (formulare_df.flow_id real)
    const row = makeAlopRow({
      status: 'angajare', df_aprobat: true, df_completed_at: null,
      df_flow_id: 'FLOW_ZOMBIE', df_authoritative_flow_id: 'FLOW_AUTORITAR',
    });
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [{ status: 'lichidare', df_completed_at: T1, df_flow_id: 'FLOW_AUTORITAR' }] });

    const app = createTestApp();
    const res = await request(app)
      .get(`/api/alop/${ALOP_ID}`)
      .set('Cookie', `auth_token=${makeAdminToken()}`);

    expect(res.status).toBe(200);
    const calls = lazyUpdateCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toContain('df_flow_id = COALESCE($3, df_flow_id)');
    expect(calls[0][1]).toEqual([ALOP_ID, 2, 'FLOW_AUTORITAR']); // [id, actor.userId, resyncFlow]
    expect(res.body.alop.df_flow_id).toBe('FLOW_AUTORITAR');
  });

  it('ALOP angajare + DF aprobat → tot la lichidare (back-compat preexistent)', async () => {
    const T1 = new Date('2026-05-20T11:00:00.000Z').toISOString();
    const row = makeAlopRow({ status: 'angajare', df_aprobat: true, df_completed_at: null });
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [{ status: 'lichidare', df_completed_at: T1 }] });

    const app = createTestApp();
    const res = await request(app)
      .get(`/api/alop/${ALOP_ID}`)
      .set('Cookie', `auth_token=${makeAdminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.alop.status).toBe('lichidare');
    expect(lazyUpdateCalls()).toHaveLength(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('lazy auto-tranziție angajare→lichidare')
    );
  });

  it('ALOP draft + DF NEaprobat → rămâne draft (nicio tranziție)', async () => {
    const row = makeAlopRow({ status: 'draft', df_aprobat: false, df_completed_at: null });
    dbModule.pool.query.mockResolvedValueOnce({ rows: [row] }); // doar SELECT detail

    const app = createTestApp();
    const res = await request(app)
      .get(`/api/alop/${ALOP_ID}`)
      .set('Cookie', `auth_token=${makeAdminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.alop.status).toBe('draft');
    expect(lazyUpdateCalls()).toHaveLength(0); // UPDATE nu s-a declanșat
  });

  it('ALOP cancelled → 404 (filtrat de WHERE), nicio tranziție', async () => {
    // Detail SELECT include `AND a.cancelled_at IS NULL` → row gol pentru ALOP anulat
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] });

    const app = createTestApp();
    const res = await request(app)
      .get(`/api/alop/${ALOP_ID}`)
      .set('Cookie', `auth_token=${makeAdminToken()}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
    expect(lazyUpdateCalls()).toHaveLength(0);
  });

  it('idempotent: ALOP deja lichidare → UPDATE nu rulează, df_completed_at păstrat', async () => {
    const T1 = new Date('2026-05-20T10:00:00.000Z').toISOString();
    // Al doilea GET: ALOP deja recuperat (status='lichidare'), df_completed_at = T1
    const row = makeAlopRow({ status: 'lichidare', df_aprobat: true, df_completed_at: T1 });
    dbModule.pool.query.mockResolvedValueOnce({ rows: [row] }); // doar SELECT detail

    const app = createTestApp();
    const res = await request(app)
      .get(`/api/alop/${ALOP_ID}`)
      .set('Cookie', `auth_token=${makeAdminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.alop.status).toBe('lichidare');
    // df_completed_at NU e re-actualizat la NOW() — păstrat la T1
    expect(res.body.alop.df_completed_at).toBe(T1);
    expect(lazyUpdateCalls()).toHaveLength(0); // WHERE status IN ('draft','angajare') exclude lichidare
  });
});
