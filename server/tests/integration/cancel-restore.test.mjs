/**
 * DocFlowAI — Integration tests: handler cancel + restore DF/ALOP
 *
 * v3.9.497 (Finding #2 audit Pas 4): cancel restore — asimetric față de refuse.
 *
 * Acoperire:
 *   ✓ cancel cu DF în transmis_flux → DF=completed, ALOP df_flow_id=NULL, df_id PĂSTRAT
 *   ✓ cancel R1 (revizie) → DF R1=completed, ALOP df_flow_id=NULL, df_id=R1 (nu parent)
 *   ✓ cancel fără DF asociat → success, restore skip (RETURNING 0 rows)
 *   ✓ cancel cu DF în status diferit (ex. de_revizuit) → DF neatins
 *   ✓ Restore eșuat (DB hiccup) → cancel rămâne success (non-fatal)
 *   ✓ Guard: cancel pe flux completed → 409
 *   ✓ Guard: cancel pe flux deja cancelled → 409
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

vi.mock('../../middleware/auth.mjs', async () => {
  const actual = await vi.importActual('../../middleware/auth.mjs');
  return {
    ...actual,
    AUTH_COOKIE: 'auth_token',
    JWT_SECRET: 'test-secret-min-32-chars-long-for-jwt-signing',
    requireAuth(req, res, next) {
      const payload = { email: 'init@x.ro', role: 'user', orgId: 1, userId: 1 };
      if (typeof next === 'function') { req.actor = payload; next(); }
      return payload;
    },
    requireAdmin: vi.fn((req, res, next) => { if (typeof next === 'function') next(); }),
    sha256Hex: (s) => s,
    escHtml: (s) => s,
    getOptionalActor: (req) => ({ email: 'init@x.ro', role: 'user', orgId: 1, userId: 1 }),
  };
});

vi.mock('../../db/index.mjs', () => ({
  pool:             { query: vi.fn() },
  DB_READY:         true,
  requireDb:        vi.fn(() => false),
  saveFlow:         vi.fn().mockResolvedValue(undefined),
  getFlowData:      vi.fn(),
  writeAuditEvent:  vi.fn().mockResolvedValue(undefined),
  getDefaultOrgId:  vi.fn().mockResolvedValue(1),
  getUserMapForOrg: vi.fn().mockResolvedValue({}),
  DB_LAST_ERROR:    null,
}));

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
}));

import * as dbModule from '../../db/index.mjs';
import lifecycleRouter, { _injectDeps } from '../../routes/flows/lifecycle.mjs';

const FLOW_ID  = 'FLOW_CRS001';
const DF_R0_ID = 'ddddffff-0000-0000-0000-0000000000C0';
const DF_R1_ID = 'ddddffff-0000-0000-0000-0000000000C1';

function makeFlowData(overrides = {}) {
  return {
    flowId: FLOW_ID, docName: 'DF Test', initEmail: 'init@x.ro', orgId: 1,
    status: 'active', completed: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    events: [],
    signers: [{ name: 'P1', email: 'p1@x.ro', token: 'tok', status: 'current', order: 1 }],
    ...overrides,
  };
}

function createTestApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  _injectDeps({
    notify:               vi.fn().mockResolvedValue(undefined),
    fireWebhook:          null,
    wsPush:               vi.fn(),
    PDFLib:               null,
    stampFooterOnPdf:     vi.fn(),
    isSignerTokenExpired: () => false,
    newFlowId:            () => 'NEW',
    buildSignerLink:      () => '',
    stripSensitive:       x => x,
    stripPdfB64:          x => x,
    sendSignerEmail:      vi.fn().mockResolvedValue(undefined),
  });
  app.use('/', lifecycleRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbModule.pool.query.mockReset();
  dbModule.getFlowData.mockReset();
  dbModule.saveFlow.mockReset().mockResolvedValue(undefined);
  dbModule.pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('cancel cu DF în transmis_flux → DF=completed, ALOP df_flow_id=NULL', () => {
  it('R0 cancel → DF R0 completed, ALOP df_id păstrat, df_flow_id=NULL', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());
    // Execution order: 1) UPDATE formulare_df, 2) UPDATE alop_instances, 3) DELETE notifications
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ id: DF_R0_ID, revizie_nr: 0, parent_df_id: null }], rowCount: 1 }) // UPDATE formulare_df RETURNING
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE alop_instances
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // DELETE notifications

    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/cancel`)
      .send({ reason: 'test cancel' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const dfUpdate = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes("UPDATE formulare_df SET status='completed'") &&
      String(c[0]).includes("status='transmis_flux'")
    );
    expect(dfUpdate, 'DF update transmis_flux → completed lipsește').toBeDefined();
    expect(dfUpdate[1]).toEqual([FLOW_ID]);

    const alopUpdate = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('UPDATE alop_instances') &&
      String(c[0]).includes('df_flow_id=NULL') &&
      !String(c[0]).includes('df_id=NULL')
    );
    expect(alopUpdate, 'ALOP update df_flow_id=NULL (păstrând df_id) lipsește').toBeDefined();
    expect(alopUpdate[1]).toEqual([DF_R0_ID]);
  });

  it('R1 cancel (revizie) → DF R1 completed, ALOP păstrează df_id=R1 (NU restore la parent)', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ id: DF_R1_ID, revizie_nr: 1, parent_df_id: DF_R0_ID }], rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/cancel`)
      .send({ reason: 'test cancel R1' });

    expect(res.status).toBe(200);

    const alopUpdate = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('UPDATE alop_instances') &&
      String(c[0]).includes('df_flow_id=NULL')
    );
    expect(alopUpdate).toBeDefined();
    // df_id rămâne R1 (NU parent R0 — cancel păstrează revizia curentă)
    expect(alopUpdate[1]).toEqual([DF_R1_ID]);
    // În contrast cu refuse, cancel NU caută parent_df_id
    const parentSelect = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('SELECT id, flow_id, status FROM formulare_df')
    );
    expect(parentSelect, 'cancel NU trebuie să caute parent_df_id').toBeUndefined();
  });
});

describe('cancel fără DF în transmis_flux → restore skip', () => {
  it('cancel cu flow fără DF asociat (RETURNING 0 rows) → success, fără UPDATE alop', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());
    // UPDATE formulare_df RETURNING [] (no rows matched), then DELETE notifications
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/cancel`)
      .send({ reason: 'no df' });

    expect(res.status).toBe(200);
    const alopUpdate = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('UPDATE alop_instances')
    );
    expect(alopUpdate, 'când nu există DF în transmis_flux, ALOP nu trebuie atins').toBeUndefined();
  });

  it('cancel cu DF în status diferit (ex. de_revizuit) → DF/ALOP neatinse', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());
    // UPDATE cu WHERE status='transmis_flux' matchează 0 rows → RETURNING []
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/cancel`)
      .send({ reason: 'df in de_revizuit' });

    expect(res.status).toBe(200);
    const alopUpdate = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('UPDATE alop_instances')
    );
    expect(alopUpdate).toBeUndefined();
  });
});

describe('Erori non-fatale', () => {
  it('UPDATE formulare_df aruncă → cancel rămâne success', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData());
    // DF restore throws, but DELETE notifications still needs to work
    dbModule.pool.query
      .mockRejectedValueOnce(new Error('DB hiccup'))
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/cancel`)
      .send({ reason: 'db error' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('Guards: cancel pe stări invalide', () => {
  it('cancel pe flux completed → 409', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData({ completed: true }));
    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/cancel`)
      .send({ reason: 'try' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('already_completed');
  });

  it('cancel pe flux deja cancelled → 409', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData({ status: 'cancelled' }));
    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/cancel`)
      .send({ reason: 'try' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('already_cancelled');
  });
});
