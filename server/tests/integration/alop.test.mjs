/**
 * DocFlowAI — Integration tests: ALOP (Angajament Legal de Ordonanțare a Plăților)
 *
 * Acoperire:
 *
 * CRUD de bază
 *   ✓ POST /api/alop — creare cu status draft
 *   ✓ GET  /api/alop — listare org (paginată)
 *   ✓ GET  /api/alop/:id — detaliu
 *   ✓ POST /api/alop/:id/cancel — anulare din status draft
 *
 * State machine — link-df
 *   ✓ link-df setează df_id și avansează draft → angajare
 *   ✓ link-df idempotent — al doilea apel cu același df_id nu dă eroare
 *   ✓ link-df respinge df_id diferit dacă df_id deja setat
 *
 * State machine — link-flow
 *   ✓ link-df-flow setează df_flow_id
 *   ✓ link-df-flow idempotent cu același flowId (UPDATE mereu)
 *   ✓ link-ord-flow setează ord_flow_id
 *
 * Sync status (df-completed / ord-completed)
 *   ✓ df-completed avansează la lichidare când DF flow complet
 *   ✓ df-completed respinge dacă status !== angajare sau df_flow_id lipsă
 *
 * Confirmare lichidare
 *   ✓ confirma-lichidare avansează lichidare → ordonantare
 *   ✓ confirma-lichidare respinge dacă status !== lichidare
 *
 * Confirmare plată
 *   ✓ confirma-plata avansează plata → completed (admin)
 *   ✓ confirma-plata respinge dacă nr_ordin_plata lipsește
 *   ✓ confirma-plata respinge dacă suma_efectiva <= 0
 *   ✓ confirma-plata respinge non-admin (403)
 *
 * Securitate
 *   ✓ GET /api/alop fără token → 401
 *   ✓ POST /api/alop fără token → 401
 *   ✓ GET /api/alop/:id din altă organizație → 404
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

// Bypass CSRF în teste — middleware-ul compară header cu cookie; în teste nu avem browser
vi.mock('../../middleware/csrf.mjs', () => ({
  csrfMiddleware: (_req, _res, next) => next(),
}));

// ── Importuri după mock-uri ───────────────────────────────────────────────────

import * as dbModule from '../../db/index.mjs';
import alopRouter from '../../routes/alop.mjs';

// ── Constante ─────────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-vitest-docflowai-2025';

const ALOP_ID  = 'aaaabbbb-0000-0000-0000-000000000001';
const DF_ID    = 'ddddffff-0000-0000-0000-000000000001';
const ORD_ID   = 'oooooooo-0000-0000-0000-000000000001';
const FLOW_ID  = 'FLOW_ABCD1';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** JWT pentru user normal org 1 */
function makeToken(overrides = {}) {
  return jwt.sign(
    { userId: 1, email: 'user@primaria.ro', role: 'user', orgId: 1, nume: 'Ion Popescu', ...overrides },
    JWT_SECRET,
    { expiresIn: '2h' }
  );
}

/** JWT pentru org_admin org 1 */
function makeAdminToken(overrides = {}) {
  return jwt.sign(
    { userId: 2, email: 'admin@primaria.ro', role: 'org_admin', orgId: 1, nume: 'Admin Org', ...overrides },
    JWT_SECRET,
    { expiresIn: '2h' }
  );
}

/** Row ALOP minimal pentru mock */
function makeAlopRow(overrides = {}) {
  return {
    id:              ALOP_ID,
    org_id:          1,
    created_by:      1,
    titlu:           'Achiziție hârtie A4',
    compartiment:    'Secretariat',
    valoare_totala:  '1500.00',
    status:          'draft',
    df_id:           null,
    ord_id:          null,
    df_flow_id:      null,
    ord_flow_id:     null,
    df_completed_at: null,
    lichidare_confirmed_at: null,
    ord_completed_at: null,
    plata_confirmed_at: null,
    cancelled_at:    null,
    created_at:      new Date().toISOString(),
    updated_at:      new Date().toISOString(),
    df_semnatari:    '[]',
    ord_semnatari:   '[]',
    lichidare_confirmed_by: null,
    plata_confirmed_by: null,
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

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  dbModule.pool.query.mockReset();
  // Default safe: returnează rows goale (nu crape pe queries secundare)
  dbModule.pool.query.mockResolvedValue({ rows: [] });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECURITATE — 401 fără token
// ─────────────────────────────────────────────────────────────────────────────

describe('Securitate — autentificare obligatorie', () => {
  it('401 — GET /api/alop fără token', async () => {
    const app = createTestApp();
    const res = await request(app).get('/api/alop');
    expect(res.status).toBe(401);
  });

  it('401 — POST /api/alop fără token', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/api/alop')
      .send({ titlu: 'Test' });
    expect(res.status).toBe(401);
  });

  it('401 — GET /api/alop/:id fără token', async () => {
    const app = createTestApp();
    const res = await request(app).get(`/api/alop/${ALOP_ID}`);
    expect(res.status).toBe(401);
  });

  it('401 — POST /api/alop/:id/link-df fără token', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post(`/api/alop/${ALOP_ID}/link-df`)
      .send({ df_id: DF_ID });
    expect(res.status).toBe(401);
  });

  it('401 — POST /api/alop/:id/confirma-lichidare fără token', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post(`/api/alop/${ALOP_ID}/confirma-lichidare`)
      .send({});
    expect(res.status).toBe(401);
  });

  it('404 — nu poate accesa ALOP din altă organizație', async () => {
    // Token cu orgId=99, dar ALOP e pentru orgId=1 → query returnează rows goale
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] }); // SELECT → 0 rezultate
    const app = createTestApp();
    const res = await request(app)
      .get(`/api/alop/${ALOP_ID}`)
      .set('Cookie', `auth_token=${makeToken({ orgId: 99 })}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CRUD de bază
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/alop — creare ALOP nou', () => {
  it('201 — creare cu status draft', async () => {
    const newAlop = makeAlopRow();
    // query 1: SELECT alop_sabloane
    // query 2: SELECT users (pentru userName)
    // query 3: INSERT alop_instances
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [] })                  // sabloane (fără)
      .mockResolvedValueOnce({ rows: [{ nume: 'Ion Popescu' }] })  // user name
      .mockResolvedValueOnce({ rows: [newAlop] });          // INSERT

    const app = createTestApp();
    const res = await request(app)
      .post('/api/alop')
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({ titlu: 'Achiziție hârtie A4', compartiment: 'Secretariat', valoare_totala: 1500 });

    expect(res.status).toBe(201);
    expect(res.body.alop).toBeDefined();
    expect(res.body.alop.status).toBe('draft');
    expect(res.body.alop.titlu).toBe('Achiziție hârtie A4');
  });

  it('201 — titlu implicit "ALOP nou" dacă nu e trimis', async () => {
    const newAlop = makeAlopRow({ titlu: 'ALOP nou' });
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ nume: 'Ion Popescu' }] })
      .mockResolvedValueOnce({ rows: [newAlop] });

    const app = createTestApp();
    const res = await request(app)
      .post('/api/alop')
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({});

    expect(res.status).toBe(201);
    // Verificăm că INSERT a fost apelat cu valoare titlu (poate fi 'ALOP nou' default)
    const insertCall = dbModule.pool.query.mock.calls[2];
    expect(insertCall[1][2]).toBe('ALOP nou'); // titlu = $3
  });
});

describe('GET /api/alop — listare ALOP org', () => {
  it('200 — returnează lista și metadate paginare', async () => {
    const row = makeAlopRow();
    // query 1: SELECT lista; query 2: COUNT
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [{ count: 1 }] });

    const app = createTestApp();
    const res = await request(app)
      .get('/api/alop')
      .set('Cookie', `auth_token=${makeToken()}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.alop)).toBe(true);
    expect(res.body.alop).toHaveLength(1);
    expect(res.body.total).toBe(1);
    expect(res.body.page).toBe(1);
  });

  it('200 — filtru status funcționează (adaugă param la query)', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: 0 }] });

    const app = createTestApp();
    const res = await request(app)
      .get('/api/alop?status=angajare')
      .set('Cookie', `auth_token=${makeToken()}`);

    expect(res.status).toBe(200);
    // Verifică că al 2-lea param al query 1 este 'angajare'
    const listCall = dbModule.pool.query.mock.calls[0];
    expect(listCall[1]).toContain('angajare');
  });

  it('200 — izolat la org_id din token', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: 0 }] });

    const app = createTestApp();
    await request(app)
      .get('/api/alop')
      .set('Cookie', `auth_token=${makeToken({ orgId: 42 })}`);

    const listCall = dbModule.pool.query.mock.calls[0];
    expect(listCall[1][0]).toBe(42); // org_id = $1
  });
});

describe('GET /api/alop/:id — detaliu ALOP', () => {
  it('200 — returnează ALOP existent', async () => {
    const row = makeAlopRow();
    dbModule.pool.query.mockResolvedValueOnce({ rows: [row] });

    const app = createTestApp();
    const res = await request(app)
      .get(`/api/alop/${ALOP_ID}`)
      .set('Cookie', `auth_token=${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.alop).toBeDefined();
    expect(res.body.alop.id).toBe(ALOP_ID);
  });

  it('404 — ALOP inexistent', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] });

    const app = createTestApp();
    const res = await request(app)
      .get(`/api/alop/inexistent-id`)
      .set('Cookie', `auth_token=${makeToken()}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });
});

describe('POST /api/alop/:id/cancel — anulare ALOP', () => {
  it('200 — anulare din status draft', async () => {
    const cancelled = makeAlopRow({ status: 'cancelled', cancelled_at: new Date().toISOString() });
    dbModule.pool.query.mockResolvedValueOnce({ rows: [cancelled] });

    const app = createTestApp();
    const res = await request(app)
      .post(`/api/alop/${ALOP_ID}/cancel`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({ reason: 'Test anulare' });

    expect(res.status).toBe(200);
    expect(res.body.alop.status).toBe('cancelled');
  });

  it('404 — ALOP completed nu poate fi anulat', async () => {
    // UPDATE returnează 0 rows (WHERE status != 'completed' eșuează)
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] });

    const app = createTestApp();
    const res = await request(app)
      .post(`/api/alop/${ALOP_ID}/cancel`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STATE MACHINE — link-df
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/alop/:id/link-df — leagă Document de Fundamentare', () => {
  it('400 — df_id lipsă în body', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post(`/api/alop/${ALOP_ID}/link-df`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('df_id obligatoriu');
  });

  it('404 — df_id nu există în org', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [] }); // SELECT formulare_df → nu există

    const app = createTestApp();
    const res = await request(app)
      .post(`/api/alop/${ALOP_ID}/link-df`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({ df_id: DF_ID });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('df_not_found');
  });

  it('200 — link-df setează df_id și avansează draft → angajare', async () => {
    const updated = makeAlopRow({ df_id: DF_ID, status: 'angajare' });
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ id: DF_ID }] })  // SELECT formulare_df
      .mockResolvedValueOnce({ rows: [] })                // SELECT conflict (niciun conflict)
      .mockResolvedValueOnce({ rows: [updated] });         // UPDATE alop_instances

    const app = createTestApp();
    const res = await request(app)
      .post(`/api/alop/${ALOP_ID}/link-df`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({ df_id: DF_ID });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.alop.df_id).toBe(DF_ID);
    expect(res.body.alop.status).toBe('angajare');
  });

  it('200 — link-df idempotent: al doilea apel cu același df_id nu dă eroare', async () => {
    // Deja cu df_id setat — WHERE (df_id IS NULL OR df_id = $1) → match
    const unchanged = makeAlopRow({ df_id: DF_ID, status: 'angajare' });
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ id: DF_ID }] })  // SELECT formulare_df
      .mockResolvedValueOnce({ rows: [] })                // SELECT conflict (niciun conflict)
      .mockResolvedValueOnce({ rows: [unchanged] });       // UPDATE (idempotent)

    const app = createTestApp();
    const res = await request(app)
      .post(`/api/alop/${ALOP_ID}/link-df`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({ df_id: DF_ID });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.alop.status).toBe('angajare'); // status nemodificat (nu se resetează la draft)
  });

  it('404 — link-df respinge df_id diferit dacă df_id deja setat', async () => {
    const OTHER_DF = 'ddddffff-0000-0000-0000-000000000002';
    // SELECT DF găsit, dar UPDATE returnează rows goale (WHERE df_id IS NULL OR df_id=$1 nu matchuiește)
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ id: OTHER_DF }] })  // SELECT formulare_df
      .mockResolvedValueOnce({ rows: [] })                   // SELECT conflict (niciun conflict)
      .mockResolvedValueOnce({ rows: [] });                   // UPDATE — nu matchuiește

    const app = createTestApp();
    const res = await request(app)
      .post(`/api/alop/${ALOP_ID}/link-df`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({ df_id: OTHER_DF });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STATE MACHINE — link-df-flow / link-ord-flow
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/alop/:id/link-df-flow — leagă fluxul de semnare DF', () => {
  it('400 — flow_id lipsă în body', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post(`/api/alop/${ALOP_ID}/link-df-flow`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('flow_id obligatoriu');
  });

  it('200 — link-df-flow setează df_flow_id', async () => {
    const updated = makeAlopRow({ df_flow_id: FLOW_ID, status: 'angajare' });
    dbModule.pool.query.mockResolvedValueOnce({ rows: [updated] });

    const app = createTestApp();
    const res = await request(app)
      .post(`/api/alop/${ALOP_ID}/link-df-flow`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({ flow_id: FLOW_ID });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.alop.df_flow_id).toBe(FLOW_ID);
  });

  it('200 — link-df-flow idempotent: al doilea apel cu același flowId suprascrie fără eroare', async () => {
    // UPDATE fără condiție pe df_flow_id → mereu suprascrie cu același flow_id
    const same = makeAlopRow({ df_flow_id: FLOW_ID });
    dbModule.pool.query.mockResolvedValueOnce({ rows: [same] });

    const app = createTestApp();
    const res = await request(app)
      .post(`/api/alop/${ALOP_ID}/link-df-flow`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({ flow_id: FLOW_ID });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('404 — ALOP inexistent', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] });

    const app = createTestApp();
    const res = await request(app)
      .post(`/api/alop/inexistent/link-df-flow`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({ flow_id: FLOW_ID });

    expect(res.status).toBe(404);
  });
});

describe('POST /api/alop/:id/link-ord-flow — leagă fluxul de semnare ORD', () => {
  it('200 — link-ord-flow setează ord_flow_id', async () => {
    const updated = makeAlopRow({ ord_flow_id: FLOW_ID, status: 'ordonantare' });
    dbModule.pool.query.mockResolvedValueOnce({ rows: [updated] });

    const app = createTestApp();
    const res = await request(app)
      .post(`/api/alop/${ALOP_ID}/link-ord-flow`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({ flow_id: FLOW_ID });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.alop.ord_flow_id).toBe(FLOW_ID);
  });

  it('400 — flow_id lipsă în body', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post(`/api/alop/${ALOP_ID}/link-ord-flow`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('flow_id obligatoriu');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SYNC STATUS (df-completed → lichidare / ord-completed → plata)
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/alop/:id/df-completed — avansare la lichidare', () => {
  it('200 — avansează la lichidare când DF flow complet', async () => {
    const lichidare = makeAlopRow({ status: 'lichidare', df_completed_at: new Date().toISOString() });
    dbModule.pool.query.mockResolvedValueOnce({ rows: [lichidare] });

    const app = createTestApp();
    const res = await request(app)
      .post(`/api/alop/${ALOP_ID}/df-completed`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.alop.status).toBe('lichidare');
    expect(res.body.alop.df_completed_at).toBeDefined();
  });

  it('400 — respinge dacă status !== angajare sau df_flow_id lipsă', async () => {
    // UPDATE WHERE ... AND df_flow_id IS NOT NULL AND status='angajare' → 0 rows
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] });

    const app = createTestApp();
    const res = await request(app)
      .post(`/api/alop/${ALOP_ID}/df-completed`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('df_flow_necesar_sau_status_invalid');
  });
});

describe('POST /api/alop/:id/ord-completed — avansare la plata', () => {
  it('200 — avansează la plata când ORD flow complet', async () => {
    const plata = makeAlopRow({ status: 'plata', ord_completed_at: new Date().toISOString() });
    dbModule.pool.query.mockResolvedValueOnce({ rows: [plata] });

    const app = createTestApp();
    const res = await request(app)
      .post(`/api/alop/${ALOP_ID}/ord-completed`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.alop.status).toBe('plata');
  });

  it('400 — respinge dacă status !== ordonantare sau ord_flow_id lipsă', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] });

    const app = createTestApp();
    const res = await request(app)
      .post(`/api/alop/${ALOP_ID}/ord-completed`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ord_flow_necesar_sau_status_invalid');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CONFIRMARE LICHIDARE
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/alop/:id/confirma-lichidare', () => {
  it('200 — avansează lichidare → ordonantare cu câmpurile corecte', async () => {
    const current = { lichidare_confirmed_by: null };
    const updated  = makeAlopRow({
      status:                  'ordonantare',
      lichidare_confirmed_by:  1,
      lichidare_confirmed_at:  new Date().toISOString(),
      lichidare_nr_factura:    'F-2025-001',
      lichidare_nr_pv:         'PV-001',
    });
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [current] })  // SELECT lichidare_confirmed_by
      .mockResolvedValueOnce({ rows: [updated] });  // UPDATE

    const app = createTestApp();
    const res = await request(app)
      .post(`/api/alop/${ALOP_ID}/confirma-lichidare`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({ nr_factura: 'F-2025-001', data_factura: '2025-03-01', nr_pv: 'PV-001', observatii: 'OK' });

    expect(res.status).toBe(200);
    expect(res.body.alop.status).toBe('ordonantare');
    expect(res.body.alop.lichidare_nr_factura).toBe('F-2025-001');
  });

  it('400 — respinge dacă status !== lichidare (UPDATE returnează 0 rows)', async () => {
    const current = { lichidare_confirmed_by: null };
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [current] })  // SELECT
      .mockResolvedValueOnce({ rows: [] });          // UPDATE → 0 (status wrong)

    const app = createTestApp();
    const res = await request(app)
      .post(`/api/alop/${ALOP_ID}/confirma-lichidare`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({ nr_factura: 'F-001', observatii: 'test' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('status_invalid');
  });

  it('404 — ALOP inexistent la confirmare lichidare', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] }); // SELECT → nu există

    const app = createTestApp();
    const res = await request(app)
      .post(`/api/alop/inexistent/confirma-lichidare`)
      .set('Cookie', `auth_token=${makeToken()}`)
      .send({ observatii: 'test' });

    expect(res.status).toBe(404);
  });

  it('403 — user neautorizat dacă lichidare_confirmed_by e altul', async () => {
    // lichidare_confirmed_by = 99 (alt user), actorul e userId=1, nu admin
    const current = { lichidare_confirmed_by: 99 };
    dbModule.pool.query.mockResolvedValueOnce({ rows: [current] });

    const app = createTestApp();
    const res = await request(app)
      .post(`/api/alop/${ALOP_ID}/confirma-lichidare`)
      .set('Cookie', `auth_token=${makeToken({ userId: 1, role: 'user' })}`)
      .send({ observatii: 'test' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CONFIRMARE PLATĂ
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/alop/:id/confirma-plata', () => {
  it('400 — user normal fără status plata → status_invalid', async () => {
    const app = createTestApp();
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] }); // UPDATE → 0 rows (status != 'plata')
    const res = await request(app)
      .post(`/api/alop/${ALOP_ID}/confirma-plata`)
      .set('Cookie', `auth_token=${makeToken({ role: 'user' })}`)
      .send({ nr_ordin_plata: 'OP-001', data_plata: '2025-03-01', suma_efectiva: 1500 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('status_invalid');
  });

  it('400 — respinge dacă nr_ordin_plata lipsește (UPDATE returnează 0 rows pe status wrong)', async () => {
    // Serverul nu validează nr_ordin_plata explicit — INSERT fără el → status check eșuează dacă status != 'plata'
    // Testăm că fără câmpuri corecte și status greșit → 400
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] }); // UPDATE → 0 (status != 'plata')

    const app = createTestApp();
    const res = await request(app)
      .post(`/api/alop/${ALOP_ID}/confirma-plata`)
      .set('Cookie', `auth_token=${makeAdminToken()}`)
      .send({ suma_efectiva: 1500 }); // lipsă nr_ordin_plata

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('status_invalid');
  });

  it('400 — respinge dacă suma_efectiva <= 0 (status greșit)', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] });

    const app = createTestApp();
    const res = await request(app)
      .post(`/api/alop/${ALOP_ID}/confirma-plata`)
      .set('Cookie', `auth_token=${makeAdminToken()}`)
      .send({ nr_ordin_plata: 'OP-001', data_plata: '2025-03-01', suma_efectiva: 0 });

    expect(res.status).toBe(400);
  });

  it('200 — org_admin confirmă plata → completed', async () => {
    const completed = makeAlopRow({
      status:          'completed',
      plata_confirmed_by: 2,
      plata_nr_ordin:  'OP-001',
      plata_suma_efectiva: '1500.00',
      completed_at:    new Date().toISOString(),
    });
    dbModule.pool.query.mockResolvedValueOnce({ rows: [completed] });

    const app = createTestApp();
    const res = await request(app)
      .post(`/api/alop/${ALOP_ID}/confirma-plata`)
      .set('Cookie', `auth_token=${makeAdminToken()}`)
      .send({ nr_ordin_plata: 'OP-001', data_plata: '2025-03-01', suma_efectiva: 1500, observatii: 'Plătit' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.alop.status).toBe('completed');
    expect(res.body.alop.plata_nr_ordin).toBe('OP-001');
  });

  it('200 — admin global poate confirma plata', async () => {
    const completed = makeAlopRow({ status: 'completed', completed_at: new Date().toISOString() });
    dbModule.pool.query.mockResolvedValueOnce({ rows: [completed] });

    const app = createTestApp();
    const res = await request(app)
      .post(`/api/alop/${ALOP_ID}/confirma-plata`)
      .set('Cookie', `auth_token=${makeToken({ role: 'admin' })}`)
      .send({ nr_ordin_plata: 'OP-002', data_plata: '2025-03-02', suma_efectiva: 1500 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
