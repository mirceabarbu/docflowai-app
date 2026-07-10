/**
 * DocFlowAI — Integration tests: handler refuse → DF neaprobat + ALOP (prompt 74, B2)
 *
 * Rescris pentru comportamentul B2 (rezolvare ROBUSTĂ prin df_flow_id):
 *   ✓ R0 refuzat → status=neaprobat + alop_instances df_flow_id=NULL, df_id PĂSTRAT
 *   ✓ R0 split-path (rezolvat prin alop.df_flow_id, fd.flow_id NULL) → identic
 *   ✓ R1+ refuzat cu parent aprobat → alop_instances df_id=parent.id, df_flow_id=parent.flow_id
 *   ✓ R1+ refuzat cu parent neaprobat → fallback df_flow_id=NULL, df_id PĂSTRAT
 *   ✓ Audit 'neaprobat' scris (recordFormularAudit → formulare_audit)
 *   ✓ Refuse fără DF asociat fluxului → success, skip (0 rows)
 *   ✓ Restore eșuat (DB hiccup) → refuse rămâne success (non-fatal)
 *   ✓ Guard: refuse pe flux cancelled/completed → 409
 *
 * Mock-ul pool.query rutează pe conținutul SQL (NU pozițional) → robust la refactor.
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

// Rutează pool.query pe conținutul SQL. Config per-test: dfRow (rezolvarea DF),
// parentRow (SELECT parent R1+). null → 0 rows.
function installQueryRouter({ dfRow = null, parentRow = null, dfSelectThrows = false } = {}) {
  dbModule.pool.query.mockImplementation(async (sql) => {
    const s = String(sql);
    if (s.includes('DELETE FROM notifications')) return { rowCount: 0, rows: [] };
    if (s.includes('FROM formulare_df') && s.includes('revizie_nr, parent_df_id')) {
      if (dfSelectThrows) throw new Error('DB connection lost');
      return { rows: dfRow ? [dfRow] : [] };
    }
    if (s.includes("UPDATE formulare_df SET status='neaprobat'")) return { rowCount: 1, rows: [] };
    if (s.includes('INSERT INTO formulare_audit')) return { rows: [] };
    if (s.includes('SELECT id, flow_id, status FROM formulare_df WHERE id=$1')) {
      return { rows: parentRow ? [parentRow] : [] };
    }
    if (s.includes('UPDATE alop_instances')) return { rowCount: 1, rows: [] };
    return { rows: [] };
  });
}

const alopCalls = () => dbModule.pool.query.mock.calls.filter(c => String(c[0]).includes('UPDATE alop_instances'));
const auditCall  = () => dbModule.pool.query.mock.calls.find(c => String(c[0]).includes('INSERT INTO formulare_audit'));

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
});

// ─────────────────────────────────────────────────────────────────────────────
// R0 refuzat → df_flow_id=NULL, df_id PĂSTRAT (B2)
// ─────────────────────────────────────────────────────────────────────────────

describe('R0 refuzat → ALOP df_flow_id=NULL, df_id păstrat (B2)', () => {
  it('refuse R0 → UPDATE alop df_flow_id=NULL (NU df_id=NULL), WHERE df_id=refDf.id', async () => {
    const flowData = makeFlowData();
    dbModule.getFlowData.mockResolvedValue(flowData);
    installQueryRouter({ dfRow: { id: DF_R0_ID, revizie_nr: 0, parent_df_id: null, status: 'transmis_flux' } });

    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/refuse`)
      .send({ token: flowData.signers[0].token, reason: 'lipsesc semnături' });

    expect(res.status).toBe(200);
    expect(res.body.refused).toBe(true);

    const [update] = alopCalls();
    expect(update).toBeDefined();
    expect(String(update[0])).toContain('df_flow_id=NULL');
    expect(String(update[0])).not.toContain('df_id=NULL'); // B2: df_id PĂSTRAT
    expect(update[1]).toEqual([DF_R0_ID]);

    // Audit 'neaprobat' scris
    const audit = auditCall();
    expect(audit).toBeDefined();
  });

  it('R0 split-path (DF completed, fd.flow_id NULL — rezolvat prin alop.df_flow_id) → identic', async () => {
    const flowData = makeFlowData();
    dbModule.getFlowData.mockResolvedValue(flowData);
    installQueryRouter({ dfRow: { id: DF_R0_ID, revizie_nr: 0, parent_df_id: null, status: 'completed' } });

    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/refuse`)
      .send({ token: flowData.signers[0].token, reason: 'split-path' });

    expect(res.status).toBe(200);
    const [update] = alopCalls();
    expect(update).toBeDefined();
    expect(String(update[0])).toContain('df_flow_id=NULL');
    expect(String(update[0])).not.toContain('df_id=NULL');
    expect(update[1]).toEqual([DF_R0_ID]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R1+ refuzat cu parent aprobat → restore parent
// ─────────────────────────────────────────────────────────────────────────────

describe('R1+ refuzat → restore la parent aprobat', () => {
  it('refuse R1, parent aprobat → UPDATE alop df_id=parent.id, df_flow_id=parent.flow_id', async () => {
    const flowData = makeFlowData();
    dbModule.getFlowData.mockResolvedValue(flowData);
    installQueryRouter({
      dfRow: { id: DF_R1_ID, revizie_nr: 1, parent_df_id: DF_R0_ID, status: 'transmis_flux' },
      parentRow: { id: DF_R0_ID, flow_id: PARENT_FLOW_ID, status: 'aprobat' },
    });

    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/refuse`)
      .send({ token: flowData.signers[0].token, reason: 'erori sectia B' });

    expect(res.status).toBe(200);

    const update = alopCalls().find(c => String(c[0]).includes('df_id=$1') && String(c[0]).includes('df_flow_id=$2'));
    expect(update).toBeDefined();
    expect(update[1][0]).toBe(DF_R0_ID);       // df_id ← parent.id
    expect(update[1][1]).toBe(PARENT_FLOW_ID); // df_flow_id ← parent.flow_id
    expect(update[1][2]).toBe(DF_R1_ID);       // WHERE df_id=R1.id
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R1+ refuzat cu parent NEaprobat → fallback (df_id păstrat, flux curățat)
// ─────────────────────────────────────────────────────────────────────────────

describe('R1+ refuzat cu parent neaprobat → fallback df_flow_id=NULL', () => {
  it('parent.status=neaprobat → UPDATE alop df_flow_id=NULL, df_id păstrat', async () => {
    const flowData = makeFlowData();
    dbModule.getFlowData.mockResolvedValue(flowData);
    installQueryRouter({
      dfRow: { id: DF_R1_ID, revizie_nr: 1, parent_df_id: DF_R0_ID, status: 'transmis_flux' },
      parentRow: { id: DF_R0_ID, flow_id: 'FLOW_R0_REJECTED', status: 'neaprobat' },
    });

    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/refuse`)
      .send({ token: flowData.signers[0].token, reason: 'test' });

    expect(res.status).toBe(200);
    const update = alopCalls().find(c => String(c[0]).includes('df_flow_id=NULL'));
    expect(update).toBeDefined();
    expect(String(update[0])).not.toContain('df_id=NULL');
    expect(update[1]).toEqual([DF_R1_ID]);
  });

  it('parent inexistent (0 rows) → fallback df_flow_id=NULL', async () => {
    const flowData = makeFlowData();
    dbModule.getFlowData.mockResolvedValue(flowData);
    installQueryRouter({
      dfRow: { id: DF_R1_ID, revizie_nr: 1, parent_df_id: DF_R0_ID, status: 'transmis_flux' },
      parentRow: null,
    });

    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/refuse`)
      .send({ token: flowData.signers[0].token, reason: 'test' });

    expect(res.status).toBe(200);
    const update = alopCalls().find(c => String(c[0]).includes('df_flow_id=NULL'));
    expect(update).toBeDefined();
    expect(update[1]).toEqual([DF_R1_ID]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Robustețe: non-fatal + skip
// ─────────────────────────────────────────────────────────────────────────────

describe('Robustețe — non-fatal pe refuse', () => {
  it('SELECT df eșuează (DB hiccup) → refuse rămâne success', async () => {
    const flowData = makeFlowData();
    dbModule.getFlowData.mockResolvedValue(flowData);
    installQueryRouter({ dfSelectThrows: true });

    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/refuse`)
      .send({ token: flowData.signers[0].token, reason: 'test' });

    expect(res.status).toBe(200);
    expect(res.body.refused).toBe(true);
  });

  it('refuse pe flux fără DF (SELECT df → 0 rows) → skip, fără UPDATE alop', async () => {
    const flowData = makeFlowData();
    dbModule.getFlowData.mockResolvedValue(flowData);
    installQueryRouter({ dfRow: null });

    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/refuse`)
      .send({ token: flowData.signers[0].token, reason: 'test' });

    expect(res.status).toBe(200);
    expect(res.body.refused).toBe(true);
    expect(alopCalls().length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// State machine guard
// ─────────────────────────────────────────────────────────────────────────────

describe('Guard: refuse pe flux în stare terminală', () => {
  it('refuze pe flux cu status=cancelled → 409', async () => {
    const flowData = makeFlowData({ status: 'cancelled' });
    dbModule.getFlowData.mockResolvedValue(flowData);
    installQueryRouter({});

    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/refuse`)
      .send({ token: flowData.signers[0].token, reason: 'test' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('flow_cancelled');
  });

  it('refuze pe flux completed cu semnatari signed → 409 not_current_signer', async () => {
    const tok = crypto.randomBytes(16).toString('hex');
    const flowData = makeFlowData({
      status: 'completed', completed: true,
      signers: [{ name: 'P1', email: 'p1@x.ro', token: tok, status: 'signed', order: 1 }],
    });
    dbModule.getFlowData.mockResolvedValue(flowData);
    installQueryRouter({});

    const res = await request(createTestApp())
      .post(`/flows/${FLOW_ID}/refuse`)
      .send({ token: tok, reason: 'test' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_current_signer');
  });
});
