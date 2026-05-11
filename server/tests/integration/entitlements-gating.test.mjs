/**
 * DocFlowAI — Integration tests: requireModule gating pe POST endpoints (PASUL 3)
 *
 * Verifică că:
 *   ✓ POST creation blocat când entitlement-ul lipsește (403 module_disabled)
 *   ✓ DF/ORD au check dublu: alop ȘI df/ord — dacă alop e off → 403
 *   ✓ PUT pe existent e permis chiar dacă entitlement-ul e off (regula c)
 *   ✓ POST acțiuni pe existent (submit) e permis fără entitlement (regula c)
 *   ✓ Superadmin bypass — trece toate gările indiferent de entitlements
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

// ── Mocks ESM ────────────────────────────────────────────────────────────────
vi.mock('../../db/index.mjs', () => {
  const q = vi.fn();
  return {
    pool:          { query: q },
    DB_READY:      true,
    requireDb:     vi.fn(() => false),
    DB_LAST_ERROR: null,
    writeAuditEvent: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
  redactUrl: (u) => u,
}));

vi.mock('../../middleware/csrf.mjs', () => ({
  csrfMiddleware: (_req, _res, next) => next(),
}));

// Mock-uim entitlements la nivel de service — requireModule rămâne real (testăm gardă).
vi.mock('../../services/entitlements.mjs', () => ({
  isModuleEnabled: vi.fn(),
  getAllModulesForUser: vi.fn().mockResolvedValue({}),
  invalidate: vi.fn(),
  invalidateAll: vi.fn(),
  resolveDetailed: vi.fn(),
}));

vi.mock('../../services/authz-formular.mjs', () => ({
  loadActorComp: vi.fn().mockResolvedValue('Compartiment Test'),
  canEditFormular: vi.fn().mockResolvedValue({ allowed: true, role: 'comp' }),
  canEditAlop:     vi.fn().mockResolvedValue({ allowed: true, role: 'creator' }),
  canDestroyOnly:  vi.fn().mockResolvedValue({ allowed: true }),
}));

// ── Imports după mock-uri ────────────────────────────────────────────────────
import * as dbModule from '../../db/index.mjs';
import { isModuleEnabled } from '../../services/entitlements.mjs';
import { formulareDbRouter } from '../../routes/formulare-db.mjs';
import alopRouter from '../../routes/alop.mjs';
import clasa8Router from '../../routes/clasa8.mjs';
import supplierVerifyRouter from '../../routes/supplier-verify.mjs';

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-vitest-docflowai-2025';
const DF_ID = 'ddddffff-0000-0000-0000-000000000001';

function makeUserToken(overrides = {}) {
  return jwt.sign(
    { userId: 100, email: 'user@org.ro', role: 'user', orgId: 1, compartiment: 'Achiziții', ...overrides },
    JWT_SECRET, { expiresIn: '2h' }
  );
}

function makeSuperadminToken(overrides = {}) {
  return jwt.sign(
    { userId: 1, email: 'admin@docflowai.ro', role: 'admin', orgId: null, ...overrides },
    JWT_SECRET, { expiresIn: '2h' }
  );
}

function makeApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use('/', formulareDbRouter);
  app.use('/', alopRouter);
  app.use('/api/clasa8', clasa8Router);
  app.use('/api/verify', supplierVerifyRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbModule.pool.query.mockReset();
  dbModule.pool.query.mockResolvedValue({ rows: [] });
});

/** Setează isModuleEnabled să întoarcă valori per modul. */
function setModulesEnabled(map) {
  vi.mocked(isModuleEnabled).mockImplementation(async (_pool, ctx) => {
    return map[ctx.moduleKey] === true;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/formulare-df — gardă dublă alop + df
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/formulare-df — gardă requireModule(alop) + requireModule(df)', () => {
  it('403 module_disabled — user fără df activat', async () => {
    setModulesEnabled({ alop: true, df: false });
    const res = await request(makeApp())
      .post('/api/formulare-df')
      .set('Cookie', `auth_token=${makeUserToken()}`)
      .send({ nr_unic_inreg: 'X/1' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('module_disabled');
    expect(res.body.module).toBe('df');
  });

  it('403 module_disabled — user are df dar nu alop (umbrella)', async () => {
    setModulesEnabled({ alop: false, df: true });
    const res = await request(makeApp())
      .post('/api/formulare-df')
      .set('Cookie', `auth_token=${makeUserToken()}`)
      .send({ nr_unic_inreg: 'X/2' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('module_disabled');
    expect(res.body.module).toBe('alop');
  });

  it('200/201 — user are ambele entitlement-uri → trece gările', async () => {
    setModulesEnabled({ alop: true, df: true });
    // Sequence pentru handler-ul de creare DF (după ce trec gările):
    //  - SELECT existing (pe nr_unic) → empty
    //  - INSERT formulare_df → row
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [] }) // existing check
      .mockResolvedValueOnce({ rows: [{ id: DF_ID, status: 'draft' }] }); // INSERT

    const res = await request(makeApp())
      .post('/api/formulare-df')
      .set('Cookie', `auth_token=${makeUserToken()}`)
      .send({ nr_unic_inreg: 'X/3' });
    // Acceptăm orice 2xx — testul verifică doar că gările trec.
    expect(res.status).toBeLessThan(400);
  });

  it('superadmin bypass — fără apel isModuleEnabled, ajunge la handler', async () => {
    setModulesEnabled({}); // niciun modul activ — bypass-ul trebuie să sară peste
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: DF_ID, status: 'draft' }] });

    const res = await request(makeApp())
      .post('/api/formulare-df')
      .set('Cookie', `auth_token=${makeSuperadminToken()}`)
      .send({ nr_unic_inreg: 'X/4' });
    expect(res.status).toBeLessThan(400);
    expect(vi.mocked(isModuleEnabled)).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regula (c): PUT/submit pe document existent rămân accesibile fără entitlement
// ─────────────────────────────────────────────────────────────────────────────
describe('Regula (c) — acțiuni pe documente existente NU sunt blocate de entitlement', () => {
  it('PUT /api/formulare-df/:id — accesibil chiar fără df enabled', async () => {
    setModulesEnabled({ alop: false, df: false });
    // PUT-ul nu are requireModule — handler poate primi orice → SELECT, UPDATE
    // mockează un row existent pentru actualizare
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ id: DF_ID, org_id: 1, status: 'draft', created_by: 100, deleted_at: null }] })
      .mockResolvedValueOnce({ rows: [{ id: DF_ID, status: 'draft' }] });

    const res = await request(makeApp())
      .put(`/api/formulare-df/${DF_ID}`)
      .set('Cookie', `auth_token=${makeUserToken()}`)
      .send({ nr_unic_inreg: 'X/5' });
    // Acceptăm orice non-403-module_disabled — handler-ul poate răspunde 200/400/404
    // în funcție de logică, dar NU trebuie să fie 403 cu module_disabled.
    expect(res.body?.error).not.toBe('module_disabled');
  });

  it('POST /api/formulare-df/:id/submit — accesibil chiar fără df enabled', async () => {
    setModulesEnabled({ alop: false, df: false });
    dbModule.pool.query.mockResolvedValueOnce({
      rows: [{ id: DF_ID, org_id: 1, status: 'draft', created_by: 100, deleted_at: null }],
    });
    const res = await request(makeApp())
      .post(`/api/formulare-df/${DF_ID}/submit`)
      .set('Cookie', `auth_token=${makeUserToken()}`)
      .send({ assigned_to: 2 });
    expect(res.body?.error).not.toBe('module_disabled');
  });

  it('POST /api/formulare-df/:id/complete — accesibil fără df enabled', async () => {
    setModulesEnabled({ alop: false, df: false });
    dbModule.pool.query.mockResolvedValueOnce({
      rows: [{ id: DF_ID, org_id: 1, status: 'pending_p2', assigned_to: 100, deleted_at: null }],
    });
    const res = await request(makeApp())
      .post(`/api/formulare-df/${DF_ID}/complete`)
      .set('Cookie', `auth_token=${makeUserToken()}`)
      .send({});
    expect(res.body?.error).not.toBe('module_disabled');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/clasa8/buget/import — gardă clasa8
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/clasa8/buget/import — gardă requireModule(clasa8)', () => {
  it('403 — user fără clasa8 enabled', async () => {
    setModulesEnabled({ clasa8: false });
    const res = await request(makeApp())
      .post('/api/clasa8/buget/import')
      .set('Cookie', `auth_token=${makeUserToken()}`)
      .send({ rows: [{ cod_ssi: 'x', valoare: 1 }], filename: 'a.csv' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('module_disabled');
    expect(res.body.module).toBe('clasa8');
  });

  it('superadmin bypass — trece de gardă', async () => {
    setModulesEnabled({});
    // Răspundem rapid cu 400 pentru rows insuficient, dar important: nu 403 module_disabled.
    const res = await request(makeApp())
      .post('/api/clasa8/buget/import')
      .set('Cookie', `auth_token=${makeSuperadminToken()}`)
      .send({}); // body invalid → handler returnează 400 rows_required, dar NU module_disabled
    expect(res.body?.error).not.toBe('module_disabled');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/verify/coherence — gardă verif-furnizor
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/verify/coherence — gardă requireModule(verif-furnizor)', () => {
  it('403 — user fără verif-furnizor enabled', async () => {
    setModulesEnabled({ 'verif-furnizor': false });
    const res = await request(makeApp())
      .post('/api/verify/coherence')
      .set('Cookie', `auth_token=${makeUserToken()}`)
      .send({ cui: '12345678', iban: 'RO12RNCB0000000000000001', name: 'TestSRL' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('module_disabled');
    expect(res.body.module).toBe('verif-furnizor');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/alop — gardă alop
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/alop — gardă requireModule(alop)', () => {
  it('403 — user fără alop enabled', async () => {
    setModulesEnabled({ alop: false });
    const res = await request(makeApp())
      .post('/api/alop')
      .set('Cookie', `auth_token=${makeUserToken()}`)
      .send({ titlu: 'X', compartiment: 'A', valoare_totala: 100 });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('module_disabled');
    expect(res.body.module).toBe('alop');
  });
});
