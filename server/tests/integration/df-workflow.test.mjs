/**
 * DocFlowAI — Integration tests: DF workflow (state machine P1/P2 + revizuire)
 *
 * Acoperire:
 *   ✓ POST /api/formulare-df/:id/submit — draft → pending_p2 cu motiv_returnare resetat
 *   ✓ POST /api/formulare-df/:id/submit — refuză pe status=completed (409)
 *   ✓ POST /api/formulare-df/:id/submit — acceptat din status=returnat
 *   ✓ POST /api/formulare-df/:id/submit — acceptat din status=de_revizuit
 *   ✓ POST /api/formulare-df/:id/returneaza — pending_p2 → returnat cu motiv salvat
 *   ✓ POST /api/formulare-df/:id/returneaza — 400 fără motiv
 *   ✓ POST /api/formulare-df/:id/revizuieste — R0 aprobat → R1 cu rows_val.valt_rev_prec prefill
 *   ✓ POST /api/formulare-df/:id/revizuieste — UPDATE alop_instances re-link cu df_flow_id=NULL
 *   ✓ POST /api/formulare-df/:id/revizuieste — 400 pe status=draft (neaprobat, fără flag)
 *   ✓ POST /api/formulare-df/:id/revizuieste — 200 pe status=neaprobat (refuz anterior)
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

// ── Mock-uri ESM — hoisted automat ────────────────────────────────────────────

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

const DF_ID    = 'ddddffff-0000-0000-0000-000000000001';
const DF_R1_ID = 'ddddffff-0000-0000-0000-000000000002';
const FLOW_ID  = 'FLOW_DF001';

function makeToken(overrides = {}) {
  return jwt.sign(
    { userId: 1, email: 'p1@primaria.ro', role: 'user', orgId: 1, nume: 'P1 Test', ...overrides },
    JWT_SECRET, { expiresIn: '2h' }
  );
}

function makeDfRow(overrides = {}) {
  return {
    id: DF_ID, org_id: 1, created_by: 1, version: 1,
    status: 'draft', revizie_nr: 0, parent_df_id: null,
    este_revizie: false, este_revizie_an_urmator: false,
    nr_unic_inreg: '123/2026', revizuirea: '0',
    cif: '4221306', den_inst_pb: 'Primăria Test',
    rows_val: [{ valt_actualiz: 560, valt_rev_prec: 0, influente: 560 }],
    rows_ctrl: [{ sum_rezv_crdt_ang_act: 560, sum_rezv_crdt_bug_act: 560 }],
    ckbx_ang_leg_emise_ct_an_urm: '0',
    flow_id: null,
    motiv_returnare: null,
    deleted_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
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

beforeEach(() => {
  vi.clearAllMocks();
  dbModule.pool.query.mockReset();
  dbModule.pool.query.mockResolvedValue({ rows: [] });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Submit: P1 → P2
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /:id/submit — P1 trimite la P2', () => {
  it('200 — draft → pending_p2 cu motiv_returnare resetat', async () => {
    const dfDraft   = makeDfRow({ status: 'draft' });
    const dfUpdated = makeDfRow({ status: 'pending_p2', assigned_to: 2, motiv_returnare: null });

    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [dfDraft] })
      .mockResolvedValueOnce({ rows: [{ compartiment: '' }] }) // loadActorComp (FEATURE 3.B)
      .mockResolvedValueOnce({ rows: [{ id: 2, email: 'p2@primaria.ro', nume: 'P2' }] })
      .mockResolvedValueOnce({ rows: [dfUpdated] })
      .mockResolvedValueOnce({ rows: [{ email: 'p2@primaria.ro' }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(createTestApp())
      .post(`/api/formulare-df/${DF_ID}/submit`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({ assigned_to: 2 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.document.status).toBe('pending_p2');

    const updateCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('UPDATE formulare_df') && String(c[0]).includes('pending_p2')
    );
    expect(updateCall).toBeDefined();
    expect(String(updateCall[0])).toContain('motiv_returnare=NULL');
  });

  it('409 — submit pe DF cu status=completed', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [makeDfRow({ status: 'completed' })] });

    const res = await request(createTestApp())
      .post(`/api/formulare-df/${DF_ID}/submit`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({ assigned_to: 2 });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('document_not_draft');
  });

  it('409 — submit pe DF cu status=pending_p2 (deja trimis)', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [makeDfRow({ status: 'pending_p2' })] });

    const res = await request(createTestApp())
      .post(`/api/formulare-df/${DF_ID}/submit`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({ assigned_to: 2 });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('document_not_draft');
  });

  it('200 — submit acceptat din status=returnat (relansare după returnare P2)', async () => {
    const dfReturnat = makeDfRow({ status: 'returnat', motiv_returnare: 'verificare necesară' });
    const dfUpdated  = makeDfRow({ status: 'pending_p2', assigned_to: 2 });

    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [dfReturnat] })
      .mockResolvedValueOnce({ rows: [{ id: 2, email: 'p2@primaria.ro' }] })
      .mockResolvedValueOnce({ rows: [dfUpdated] })
      .mockResolvedValueOnce({ rows: [{ email: 'p2@primaria.ro' }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(createTestApp())
      .post(`/api/formulare-df/${DF_ID}/submit`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({ assigned_to: 2 });

    expect(res.status).toBe(200);
  });

  it('200 — submit acceptat din status=de_revizuit (review_requested din flux)', async () => {
    const dfDeRevizuit = makeDfRow({ status: 'de_revizuit' });
    const dfUpdated    = makeDfRow({ status: 'pending_p2', assigned_to: 2 });

    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [dfDeRevizuit] })
      .mockResolvedValueOnce({ rows: [{ id: 2, email: 'p2@primaria.ro' }] })
      .mockResolvedValueOnce({ rows: [dfUpdated] })
      .mockResolvedValueOnce({ rows: [{ email: 'p2@primaria.ro' }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(createTestApp())
      .post(`/api/formulare-df/${DF_ID}/submit`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({ assigned_to: 2 });

    expect(res.status).toBe(200);
  });

  it('401 — submit fără token de autentificare', async () => {
    const res = await request(createTestApp())
      .post(`/api/formulare-df/${DF_ID}/submit`)
      .send({ assigned_to: 2 });

    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Returneaza: P2 → P1
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /:id/returneaza — P2 returnează la P1', () => {
  it('200 — pending_p2 → returnat cu motiv salvat', async () => {
    const dfPending  = makeDfRow({ status: 'pending_p2', assigned_to: 1 });
    const dfReturnat = makeDfRow({ status: 'returnat', motiv_returnare: 'date incorecte sectia A' });

    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [dfPending] })
      .mockResolvedValueOnce({ rows: [dfReturnat] })
      .mockResolvedValueOnce({ rows: [{ email: 'p1@primaria.ro' }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(createTestApp())
      .post(`/api/formulare-df/${DF_ID}/returneaza`)
      .set('Cookie', `auth_token=${makeToken({ userId: 1 })}`)
      .send({ motiv: 'date incorecte sectia A' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verifică UPDATE cu motiv corect
    const updateCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes("status='returnat'") && String(c[0]).includes('motiv_returnare')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[1][0]).toBe('date incorecte sectia A');
  });

  it('400 — fără motiv', async () => {
    const res = await request(createTestApp())
      .post(`/api/formulare-df/${DF_ID}/returneaza`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it('400 — motiv string gol', async () => {
    const res = await request(createTestApp())
      .post(`/api/formulare-df/${DF_ID}/returneaza`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({ motiv: '   ' });

    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Revizuieste: R0 aprobat → R1 cu prefill col5/col7
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /:id/revizuieste — creare R1+ cu prefill', () => {
  it('200 — R0 aprobat → R1 cu rows_val.valt_rev_prec = R0.valt_actualiz', async () => {
    const r0Aprobat = makeDfRow({
      status: 'aprobat', flow_id: FLOW_ID,
      rows_val: [
        { valt_actualiz: 560, valt_rev_prec: 0, influente: 560 },
        { valt_actualiz: 1000, valt_rev_prec: 0, influente: 1000 },
      ],
      rows_ctrl: [
        { sum_rezv_crdt_ang_act: 560, sum_rezv_crdt_bug_act: 560,
          sum_rezv_crdt_ang_af_rvz_prc: 0, sum_rezv_crdt_bug_af_rvz_prc: 0 },
      ],
    });
    const r1Creata = makeDfRow({
      id: DF_R1_ID, status: 'draft', revizie_nr: 1,
      parent_df_id: DF_ID, este_revizie: true,
      revizie_motiv: 'definitivare procedura',
    });

    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ ...r0Aprobat, aprobat: true }] })
      .mockResolvedValueOnce({ rows: [{ compartiment: '' }] }) // loadActorComp (FEATURE 3.B)
      .mockResolvedValueOnce({ rows: [{ max_rev: 0 }] })
      .mockResolvedValueOnce({ rows: [r1Creata] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(createTestApp())
      .post(`/api/formulare-df/${DF_ID}/revizuieste`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({ motiv: 'definitivare procedura' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.df.revizie_nr).toBe(1);
    expect(res.body.df.parent_df_id).toBe(DF_ID);

    const insertCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('INSERT INTO formulare_df')
    );
    expect(insertCall).toBeDefined();
    const params = insertCall[1] || [];
    const rowsValParam = params.find(p =>
      typeof p === 'string' && p.includes('valt_rev_prec') && p.includes('560')
    );
    expect(rowsValParam).toBeDefined();
    const rowsValParsed = JSON.parse(rowsValParam);
    expect(rowsValParsed[0].valt_rev_prec).toBe(560);
    expect(rowsValParsed[0].influente).toBe(0);
  });

  it('200 — UPDATE alop_instances re-link la noua revizie cu df_flow_id=NULL', async () => {
    const r0Aprobat = makeDfRow({
      status: 'aprobat', flow_id: FLOW_ID,
      rows_val: [{ valt_actualiz: 100, valt_rev_prec: 0, influente: 100 }],
      rows_ctrl: [{}],
    });
    const r1 = makeDfRow({ id: DF_R1_ID, revizie_nr: 1, parent_df_id: DF_ID });

    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ ...r0Aprobat, aprobat: true }] })
      .mockResolvedValueOnce({ rows: [{ compartiment: '' }] }) // loadActorComp (FEATURE 3.B)
      .mockResolvedValueOnce({ rows: [{ max_rev: 0 }] })
      .mockResolvedValueOnce({ rows: [r1] })
      .mockResolvedValueOnce({ rows: [] });

    await request(createTestApp())
      .post(`/api/formulare-df/${DF_ID}/revizuieste`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({ motiv: 'test' });

    const alopUpdate = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('UPDATE alop_instances') && String(c[0]).includes('df_flow_id=NULL')
    );
    expect(alopUpdate).toBeDefined();
    expect(alopUpdate[1]).toEqual([DF_R1_ID, DF_ID, 1]);
  });

  it('400 — refuză /revizuieste pe DF cu status=draft (neaprobat fără flag)', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [{ ...makeDfRow({ status: 'draft' }), aprobat: false }] });

    const res = await request(createTestApp())
      .post(`/api/formulare-df/${DF_ID}/revizuieste`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({ motiv: 'test' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('aprobate sau neaprobate');
  });

  it('200 — permite /revizuieste pe DF cu status=neaprobat (refuz anterior)', async () => {
    const dfNeaprobat = makeDfRow({ status: 'neaprobat', flow_id: 'FLOW_OLD' });
    const r1 = makeDfRow({ id: DF_R1_ID, revizie_nr: 1, parent_df_id: DF_ID });

    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ ...dfNeaprobat, aprobat: false }] })
      .mockResolvedValueOnce({ rows: [{ compartiment: '' }] }) // loadActorComp (FEATURE 3.B)
      .mockResolvedValueOnce({ rows: [{ max_rev: 0 }] })
      .mockResolvedValueOnce({ rows: [r1] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(createTestApp())
      .post(`/api/formulare-df/${DF_ID}/revizuieste`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({ motiv: 'reluare după refuz' });

    expect(res.status).toBe(200);
  });

  it('404 — DF negăsit', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(createTestApp())
      .post(`/api/formulare-df/${DF_ID}/revizuieste`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({ motiv: 'test' });

    expect(res.status).toBe(404);
  });
});
