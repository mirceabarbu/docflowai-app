/**
 * DocFlowAI — Integration tests: gating P1-comp / P2-comp / flow_viewer pe DF + ORD
 *
 * Spec (PROMPT B):
 *   - View+Edit Sec.A: compartimentul creatorului (P1-comp, role 'comp')
 *   - View+Edit Sec.B: compartimentul assigned_to / Responsabil CAB (P2-comp, role 'p2_comp')
 *   - View-only: semnatari flux (flow_viewer), admin, org_admin
 *
 * Acoperire:
 *   ✓ LIST DF/ORD — clauza WHERE include filtru P1-comp + P2-comp + param actorComp
 *   ✓ DETAIL DF/ORD — flow_viewer (semnatar flux) vede; P2-comp vede; unrelated 403
 *   ✓ PUT DF/ORD — P2-comp scrie DOAR câmpurile Sec.B (P1 fields ignorate)
 *   ✓ /complete DF/ORD — P2-comp poate finaliza; unrelated 403
 *
 * Stil: mock pe pool.query (vezi df-workflow.test.mjs) — secvențe deterministe.
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

const DF_ID  = 'ddddffff-0000-0000-0000-000000000010';
const ORD_ID = 'ddddffff-0000-0000-0000-000000000020';

// Convenții: P1 (creator) = id 1 / ComA, P2 (assigned_to) = id 2 / ComB
//            Userul de test = id 99, compartiment variabil.
function makeToken(overrides = {}) {
  return jwt.sign(
    { userId: 99, email: 'tester@primaria.ro', role: 'user', orgId: 1, nume: 'Tester', ...overrides },
    JWT_SECRET, { expiresIn: '2h' }
  );
}

function makeDfRow(overrides = {}) {
  return {
    id: DF_ID, org_id: 1, created_by: 1, assigned_to: 2, version: 1,
    status: 'pending_p2', revizie_nr: 0, nr_unic_inreg: '500/2026',
    flow_id: 'FLOW_DF', deleted_at: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeOrdRow(overrides = {}) {
  return {
    id: ORD_ID, org_id: 1, created_by: 1, assigned_to: 2, version: 1,
    status: 'pending_p2', nr_ordonant_pl: 'OP-77/2026', beneficiar: 'SC Test SRL',
    flow_id: 'FLOW_ORD', df_id: null, deleted_at: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
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

const R = rows => ({ rows });

beforeEach(() => {
  vi.clearAllMocks();
  dbModule.pool.query.mockReset();
  dbModule.pool.query.mockResolvedValue({ rows: [] });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. LIST — clauza WHERE conține filtru P1-comp + P2-comp
// ─────────────────────────────────────────────────────────────────────────────

describe('LIST DF/ORD — filtru compartiment P1 + P2', () => {
  it('GET /api/formulare-df — SQL include EXISTS pe comp creator + comp assigned, actorComp ca param', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce(R([{ compartiment: 'ComB' }]))   // _acRes (actorComp)
      .mockResolvedValueOnce(R([makeDfRow()]));               // lista

    const res = await request(createTestApp())
      .get('/api/formulare-df')
      .set('Cookie', `auth_token=${makeToken({ userId: 99 })}`);

    expect(res.status).toBe(200);
    const listCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('FROM formulare_df fd') && String(c[0]).includes('ORDER BY fd.updated_at DESC')
    );
    expect(listCall).toBeDefined();
    expect(String(listCall[0])).toContain('u_p1.id = fd.created_by');   // P1-comp
    expect(String(listCall[0])).toContain('u_p2.id = fd.assigned_to');  // P2-comp
    expect(listCall[1]).toEqual([1, 99, 'ComB']);                       // org, user, actorComp
  });

  it('GET /api/formulare-ord — SQL include EXISTS pe comp creator + comp assigned (fo.)', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce(R([{ compartiment: 'ComB' }]))
      .mockResolvedValueOnce(R([makeOrdRow()]));

    const res = await request(createTestApp())
      .get('/api/formulare-ord')
      .set('Cookie', `auth_token=${makeToken({ userId: 99 })}`);

    expect(res.status).toBe(200);
    const listCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('FROM formulare_ord fo') && String(c[0]).includes('ORDER BY fo.updated_at DESC')
    );
    expect(listCall).toBeDefined();
    expect(String(listCall[0])).toContain('u_p1.id = fo.created_by');
    expect(String(listCall[0])).toContain('u_p2.id = fo.assigned_to');
    expect(listCall[1]).toEqual([1, 99, 'ComB']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. DETAIL — canViewFormular (flow_viewer / p2_comp / unrelated)
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/formulare-df/:id — canViewFormular', () => {
  it('200 — semnatar flux (flow_viewer) vede DF deși nu e creator/assigned', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce(R([makeDfRow()]))                // SELECT doc
      .mockResolvedValueOnce(R([{ compartiment: '' }]))       // loadActorComp (gol → skip comp)
      .mockResolvedValueOnce(R([{}]));                        // _isInFlowSigners → semnatar

    const res = await request(createTestApp())
      .get(`/api/formulare-df/${DF_ID}`)
      .set('Cookie', `auth_token=${makeToken({ userId: 99 })}`);

    expect(res.status).toBe(200);
    expect(res.body.document.id).toBe(DF_ID);
  });

  it('200 — P2-comp (din compartimentul assigned_to) vede DF', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce(R([makeDfRow()]))                // SELECT doc
      .mockResolvedValueOnce(R([{ compartiment: 'ComB' }]))   // loadActorComp
      .mockResolvedValueOnce(R([]))                           // _userIsInComp(creator) → nu
      .mockResolvedValueOnce(R([{}]));                        // _userIsInComp(assigned) → da

    const res = await request(createTestApp())
      .get(`/api/formulare-df/${DF_ID}`)
      .set('Cookie', `auth_token=${makeToken({ userId: 99 })}`);

    expect(res.status).toBe(200);
    expect(res.body.document.id).toBe(DF_ID);
  });

  it('403 — user fără relație (alt comp, ne-creator, ne-assigned, ne-flux)', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce(R([makeDfRow()]))                // SELECT doc
      .mockResolvedValueOnce(R([{ compartiment: 'ComZ' }]))   // loadActorComp
      .mockResolvedValueOnce(R([]))                           // _userIsInComp(creator) → nu
      .mockResolvedValueOnce(R([]))                           // _userIsInComp(assigned) → nu
      .mockResolvedValueOnce(R([]));                          // _isInFlowSigners → nu

    const res = await request(createTestApp())
      .get(`/api/formulare-df/${DF_ID}`)
      .set('Cookie', `auth_token=${makeToken({ userId: 99 })}`);

    expect(res.status).toBe(403);
  });
});

describe('GET /api/formulare-ord/:id — canViewFormular (paritate)', () => {
  it('200 — P2-comp vede ORD', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce(R([makeOrdRow()]))
      .mockResolvedValueOnce(R([{ compartiment: 'ComB' }]))
      .mockResolvedValueOnce(R([]))
      .mockResolvedValueOnce(R([{}]));

    const res = await request(createTestApp())
      .get(`/api/formulare-ord/${ORD_ID}`)
      .set('Cookie', `auth_token=${makeToken({ userId: 99 })}`);

    expect(res.status).toBe(200);
    expect(res.body.document.id).toBe(ORD_ID);
  });

  it('403 — user fără relație', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce(R([makeOrdRow()]))
      .mockResolvedValueOnce(R([{ compartiment: 'ComZ' }]))
      .mockResolvedValueOnce(R([]))
      .mockResolvedValueOnce(R([]))
      .mockResolvedValueOnce(R([]));

    const res = await request(createTestApp())
      .get(`/api/formulare-ord/${ORD_ID}`)
      .set('Cookie', `auth_token=${makeToken({ userId: 99 })}`);

    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. PUT — P2-comp scrie DOAR Sec.B
// ─────────────────────────────────────────────────────────────────────────────

describe('PUT /api/formulare-df/:id — P2-comp limitat la Sec.B', () => {
  it('200 — P2-comp scrie câmp P2 (intrucat); câmpul P1 (cif) e ignorat', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce(R([makeDfRow()]))                // SELECT existing
      .mockResolvedValueOnce(R([{ compartiment: 'ComB' }]))   // loadActorComp
      .mockResolvedValueOnce(R([]))                           // _userIsInComp(creator) → nu
      .mockResolvedValueOnce(R([{}]))                         // _userIsInComp(assigned) → da → p2_comp
      .mockResolvedValueOnce(R([makeDfRow({ intrucat: 'motivare P2' })])); // UPDATE

    const res = await request(createTestApp())
      .put(`/api/formulare-df/${DF_ID}`)
      .set('Cookie', `auth_token=${makeToken({ userId: 99 })}`)
      .send({ cif: 'HACK_P1', intrucat: 'motivare P2' });

    expect(res.status).toBe(200);
    const updateCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('UPDATE formulare_df') && String(c[0]).includes('SET')
    );
    expect(updateCall).toBeDefined();
    expect(String(updateCall[0])).toContain('intrucat=');   // P2 field scris
    expect(String(updateCall[0])).not.toContain('cif=');    // P1 field NU
  });
});

describe('PUT /api/formulare-ord/:id — P2-comp limitat la Sec.B (rows)', () => {
  it('200 — P2-comp scrie rows; nr_ordonant_pl (P1) e ignorat', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce(R([makeOrdRow()]))               // SELECT existing
      .mockResolvedValueOnce(R([{ compartiment: 'ComB' }]))   // loadActorComp
      .mockResolvedValueOnce(R([]))                           // _userIsInComp(creator) → nu
      .mockResolvedValueOnce(R([{}]))                         // _userIsInComp(assigned) → da
      .mockResolvedValueOnce(R([makeOrdRow()]));              // UPDATE

    const res = await request(createTestApp())
      .put(`/api/formulare-ord/${ORD_ID}`)
      .set('Cookie', `auth_token=${makeToken({ userId: 99 })}`)
      .send({ rows: [{ a: 1 }], nr_ordonant_pl: 'HACK_NR' });

    expect(res.status).toBe(200);
    const updateCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('UPDATE formulare_ord') && String(c[0]).includes('SET')
    );
    expect(updateCall).toBeDefined();
    expect(String(updateCall[0])).toContain('rows=');            // P2 field scris
    expect(String(updateCall[0])).not.toContain('nr_ordonant_pl='); // P1 field NU
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. /complete — P2-comp poate finaliza; unrelated 403
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/formulare-df/:id/complete — P2-comp', () => {
  it('200 — P2-comp finalizează Sec.B', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce(R([makeDfRow()]))                // SELECT existing
      .mockResolvedValueOnce(R([{ compartiment: 'ComB' }]))   // loadActorComp
      .mockResolvedValueOnce(R([]))                           // _userIsInComp(creator) → nu
      .mockResolvedValueOnce(R([{}]))                         // _userIsInComp(assigned) → da
      .mockResolvedValueOnce(R([makeDfRow({ status: 'completed' })])); // UPDATE
    // restul (alop update, notif) → default { rows: [] }

    const res = await request(createTestApp())
      .post(`/api/formulare-df/${DF_ID}/complete`)
      .set('Cookie', `auth_token=${makeToken({ userId: 99 })}`)
      .send({ intrucat: 'gata' });

    expect(res.status).toBe(200);
    expect(res.body.document.status).toBe('completed');
  });

  it('403 — user fără relație nu poate finaliza', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce(R([makeDfRow()]))                // SELECT existing
      .mockResolvedValueOnce(R([{ compartiment: 'ComZ' }]))   // loadActorComp
      .mockResolvedValueOnce(R([]))                           // _userIsInComp(creator) → nu
      .mockResolvedValueOnce(R([]));                          // _userIsInComp(assigned) → nu

    const res = await request(createTestApp())
      .post(`/api/formulare-df/${DF_ID}/complete`)
      .set('Cookie', `auth_token=${makeToken({ userId: 99 })}`)
      .send({ intrucat: 'gata' });

    expect(res.status).toBe(403);
  });
});

describe('POST /api/formulare-ord/:id/complete — P2-comp (paritate)', () => {
  it('200 — P2-comp finalizează ORD', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce(R([makeOrdRow()]))
      .mockResolvedValueOnce(R([{ compartiment: 'ComB' }]))
      .mockResolvedValueOnce(R([]))
      .mockResolvedValueOnce(R([{}]))
      .mockResolvedValueOnce(R([makeOrdRow({ status: 'completed' })]));

    const res = await request(createTestApp())
      .post(`/api/formulare-ord/${ORD_ID}/complete`)
      .set('Cookie', `auth_token=${makeToken({ userId: 99 })}`)
      .send({ rows: [{ a: 1 }] });

    expect(res.status).toBe(200);
    expect(res.body.document.status).toBe('completed');
  });
});
