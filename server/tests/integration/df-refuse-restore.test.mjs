/**
 * DocFlowAI — Integration tests: handler refuse + restore parent_df_id (Pas 4)
 *
 * Acoperire:
 *   ✓ R0 refuzat → status=neaprobat + alop_instances df_id=NULL
 *   ✓ R1+ refuzat cu parent aprobat → alop_instances df_id=parent.id, df_flow_id=parent.flow_id
 *   ✓ R1+ refuzat cu parent neaprobat → safe fallback df_id=NULL
 *   ✓ R1+ refuzat cu parent flow_id=null (corupt) → fallback df_id=NULL
 *   ✓ R1+ refuzat cu parent inexistent în DB → fallback df_id=NULL
 *   ✓ Refuse fără DF asociat fluxului → success, restore skip (0 rows)
 *   ✓ Restore eșuat (DB hiccup) → refuse rămâne success (non-fatal)
 *   ✓ Guard: refuse pe flux cancelled → 409
 *   ✓ Guard: refuse pe flux completed → 409
 *
 * Notă secvență pool.query în handler refuse:
 *   [0] DELETE FROM notifications (înainte de UPDATE formulare_df)
 *   [1] UPDATE formulare_df SET status='neaprobat'
 *   [2] SELECT formulare_df WHERE flow_id AND status='neaprobat'  ← restore block
 *   [3] UPDATE alop_instances (R0) sau SELECT parent (R1+)
 *   [4] UPDATE alop_instances (R1+)
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';

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
import signingRouter, { _injectDeps } from '../../routes/flows/signing.mjs';

const FLOW_ID        = 'FLOW_RFS001';
const DF_R0_ID       = 'ddddffff-0000-0000-0000-0000000000A0';
const DF_R1_ID       = 'ddddffff-0000-0000-0000-0000000000A1';
const PARENT_FLOW_ID = 'FLOW_PARENT_R0';

function makeFlowData(overrides = {}) {
  const tok = crypto.randomBytes(16).toString('hex');
  return {
    flowId: FLOW_ID, docName: 'DF Test', initEmail: 'init@x.ro', orgId: 1,
    status: 'active', completed: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    events: [],
    signers: [
      { name: 'P1', email: 'p1@x.ro', token: tok, status: 'current', order: 1 },
    ],
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

  app.use('/', signingRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbModule.pool.query.mockReset();
  dbModule.getFlowData.mockReset();
  dbModule.saveFlow.mockReset().mockResolvedValue(undefined);
  dbModule.pool.query.mockResolvedValue({ rows: [] });
});

// ─────────────────────────────────────────────────────────────────────────────
// R0 refuzat → ALOP eliberat
// ─────────────────────────────────────────────────────────────────────────────

describe('R0 refuzat → ALOP df_id=NULL', () => {
  it('refuse flux R0 → UPDATE alop df_id=NULL, df_flow_id=NULL', async () => {
    const flowData = makeFlowData();
    dbModule.getFlowData.mockResolvedValue(flowData);

    dbModule.pool.query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })  // [0] DELETE notifications
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })  // [1] UPDATE neaprobat
      .mockResolvedValueOnce({ rows: [{ id: DF_R0_ID, revizie_nr: 0, parent_df_id: null }] }) // [2] SELECT df
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // [3] UPDATE alop df_id=NULL

    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/refuse`)
      .send({ token: flowData.signers[0].token, reason: 'lipsesc semnături' });

    expect(res.status).toBe(200);
    expect(res.body.refused).toBe(true);

    const alopUpdate = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('UPDATE alop_instances') && String(c[0]).includes('df_id=NULL')
    );
    expect(alopUpdate).toBeDefined();
    expect(alopUpdate[1]).toEqual([DF_R0_ID]);
  });

  it('R0 cu revizie_nr=0 dar parent_df_id setat (edge) → tot df_id=NULL', async () => {
    const flowData = makeFlowData();
    dbModule.getFlowData.mockResolvedValue(flowData);

    dbModule.pool.query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: DF_R0_ID, revizie_nr: 0, parent_df_id: 'some-parent' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/refuse`)
      .send({ token: flowData.signers[0].token, reason: 'test' });

    expect(res.status).toBe(200);

    const alopUpdate = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('UPDATE alop_instances') && String(c[0]).includes('df_id=NULL')
    );
    expect(alopUpdate).toBeDefined();
    expect(alopUpdate[1]).toEqual([DF_R0_ID]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R1+ refuzat cu parent aprobat → restore parent
// ─────────────────────────────────────────────────────────────────────────────

describe('R1+ refuzat → restore la parent aprobat', () => {
  it('refuse R1, parent aprobat → UPDATE alop df_id=parent.id, df_flow_id=parent.flow_id', async () => {
    const flowData = makeFlowData();
    dbModule.getFlowData.mockResolvedValue(flowData);

    dbModule.pool.query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })  // [0] DELETE notifications
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })  // [1] UPDATE neaprobat
      .mockResolvedValueOnce({ rows: [{ id: DF_R1_ID, revizie_nr: 1, parent_df_id: DF_R0_ID }] }) // [2] SELECT df
      .mockResolvedValueOnce({ rows: [{ id: DF_R0_ID, flow_id: PARENT_FLOW_ID, status: 'aprobat' }] }) // [3] SELECT parent
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // [4] UPDATE alop restore

    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/refuse`)
      .send({ token: flowData.signers[0].token, reason: 'erori sectia B' });

    expect(res.status).toBe(200);

    const alopUpdate = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('UPDATE alop_instances') &&
      String(c[0]).includes('df_id=$1') &&
      String(c[0]).includes('df_flow_id=$2')
    );
    expect(alopUpdate).toBeDefined();
    expect(alopUpdate[1][0]).toBe(DF_R0_ID);       // df_id ← parent.id
    expect(alopUpdate[1][1]).toBe(PARENT_FLOW_ID); // df_flow_id ← parent.flow_id
    expect(alopUpdate[1][2]).toBe(DF_R1_ID);       // WHERE df_id=R1.id
  });

  it('refuse R2, parent R1 aprobat → UPDATE alop cu parent R1', async () => {
    const DF_R2_ID = 'ddddffff-0000-0000-0000-0000000000A2';
    const flowData = makeFlowData();
    dbModule.getFlowData.mockResolvedValue(flowData);

    dbModule.pool.query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: DF_R2_ID, revizie_nr: 2, parent_df_id: DF_R1_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: DF_R1_ID, flow_id: 'FLOW_R1', status: 'aprobat' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/refuse`)
      .send({ token: flowData.signers[0].token, reason: 'test R2' });

    expect(res.status).toBe(200);

    const alopUpdate = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('UPDATE alop_instances') && String(c[0]).includes('df_id=$1')
    );
    expect(alopUpdate).toBeDefined();
    expect(alopUpdate[1][0]).toBe(DF_R1_ID);
    expect(alopUpdate[1][2]).toBe(DF_R2_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge case: R1+ refuzat cu parent NEaprobat
// ─────────────────────────────────────────────────────────────────────────────

describe('R1+ refuzat cu parent neaprobat → safe fallback', () => {
  it('parent.status=neaprobat → UPDATE alop df_id=NULL (eliberare)', async () => {
    const flowData = makeFlowData();
    dbModule.getFlowData.mockResolvedValue(flowData);

    dbModule.pool.query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: DF_R1_ID, revizie_nr: 1, parent_df_id: DF_R0_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: DF_R0_ID, flow_id: 'FLOW_R0_REJECTED', status: 'neaprobat' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/refuse`)
      .send({ token: flowData.signers[0].token, reason: 'test' });

    expect(res.status).toBe(200);

    const alopUpdate = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('UPDATE alop_instances') && String(c[0]).includes('df_id=NULL')
    );
    expect(alopUpdate).toBeDefined();
    expect(alopUpdate[1]).toEqual([DF_R1_ID]);
  });

  it('parent fără flow_id (corupt) → fallback la df_id=NULL', async () => {
    const flowData = makeFlowData();
    dbModule.getFlowData.mockResolvedValue(flowData);

    dbModule.pool.query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: DF_R1_ID, revizie_nr: 1, parent_df_id: DF_R0_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: DF_R0_ID, flow_id: null, status: 'aprobat' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/refuse`)
      .send({ token: flowData.signers[0].token, reason: 'test' });

    expect(res.status).toBe(200);

    const alopUpdate = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('UPDATE alop_instances') && String(c[0]).includes('df_id=NULL')
    );
    expect(alopUpdate).toBeDefined();
  });

  it('parent inexistent în DB (0 rows) → fallback la df_id=NULL', async () => {
    const flowData = makeFlowData();
    dbModule.getFlowData.mockResolvedValue(flowData);

    dbModule.pool.query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: DF_R1_ID, revizie_nr: 1, parent_df_id: DF_R0_ID }] })
      .mockResolvedValueOnce({ rows: [] })              // parent SELECT → 0 rows
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/refuse`)
      .send({ token: flowData.signers[0].token, reason: 'test' });

    expect(res.status).toBe(200);

    const alopUpdate = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('UPDATE alop_instances') && String(c[0]).includes('df_id=NULL')
    );
    expect(alopUpdate).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Robustețe: restore eșuat — non-fatal pe refuse
// ─────────────────────────────────────────────────────────────────────────────

describe('Restore eșuat — non-fatal pe refuse', () => {
  it('SELECT df eșuează (DB hiccup) → refuse rămâne success', async () => {
    const flowData = makeFlowData();
    dbModule.getFlowData.mockResolvedValue(flowData);

    dbModule.pool.query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })       // [0] DELETE notifications
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })       // [1] UPDATE neaprobat OK
      .mockRejectedValueOnce(new Error('DB connection lost')); // [2] SELECT df → aruncă

    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/refuse`)
      .send({ token: flowData.signers[0].token, reason: 'test' });

    expect(res.status).toBe(200);
    expect(res.body.refused).toBe(true);
  });

  it('refuse pe flux fără DF (SELECT df → 0 rows) → skip restore', async () => {
    const flowData = makeFlowData();
    dbModule.getFlowData.mockResolvedValue(flowData);

    dbModule.pool.query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // [0] DELETE notifications
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // [1] UPDATE neaprobat 0 rows
      .mockResolvedValueOnce({ rows: [] });             // [2] SELECT df → 0 rows → skip

    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/refuse`)
      .send({ token: flowData.signers[0].token, reason: 'test' });

    expect(res.status).toBe(200);
    expect(res.body.refused).toBe(true);

    // UPDATE alop_instances NU trebuie apelat când SELECT df returnează 0 rows
    const alopUpdate = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('UPDATE alop_instances')
    );
    expect(alopUpdate).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// State machine guard
// ─────────────────────────────────────────────────────────────────────────────

describe('Guard: refuse pe flux în stare terminală', () => {
  it('refuze pe flux cu status=cancelled → 409', async () => {
    const flowData = makeFlowData({ status: 'cancelled' });
    dbModule.getFlowData.mockResolvedValue(flowData);

    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/refuse`)
      .send({ token: flowData.signers[0].token, reason: 'test' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('flow_cancelled');
  });

  it('refuze pe flux completed cu semnatari signed → 409 not_current_signer', async () => {
    // Într-un flux completed, toți semnatarii au status='signed', deci tokenul e valid
    // dar signer-ul nu e 'current' → 409 not_current_signer
    const tok = crypto.randomBytes(16).toString('hex');
    const flowData = makeFlowData({
      status: 'completed', completed: true,
      signers: [{ name: 'P1', email: 'p1@x.ro', token: tok, status: 'signed', order: 1 }],
    });
    dbModule.getFlowData.mockResolvedValue(flowData);

    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/refuse`)
      .send({ token: tok, reason: 'test' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_current_signer');
  });
});
