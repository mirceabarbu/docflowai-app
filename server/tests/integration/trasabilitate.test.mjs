/**
 * Integration tests — Trasabilitate (arbore DF↔ALOP↔ORD)
 *
 * Acoperire:
 *   ✓ 401 fără autentificare
 *   ✓ 400 type invalid
 *   ✓ 400 id non-UUID
 *   ✓ 404 root nu există
 *   ✓ 200 DF root cu reviziile + ALOP-uri + cicluri arhivate
 *   ✓ 200 ORD root cu DF parent + ALOP + cicluri
 *   ✓ 500 când BD aruncă eroare
 *   ✓ Multi-tenant: orgId din JWT propagat în query ($1)
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request      from 'supertest';
import express      from 'express';
import cookieParser from 'cookie-parser';
import jwt          from 'jsonwebtoken';

vi.mock('../../db/index.mjs', () => {
  const mockQuery = vi.fn();
  return { pool: { query: mockQuery } };
});

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
}));

import * as dbModule         from '../../db/index.mjs';
import trasabilitateRouter   from '../../routes/trasabilitate.mjs';

const TEST_JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-vitest-docflowai-2025';
const VALID_UUID  = '550e8400-e29b-41d4-a716-446655440000';
const VALID_UUID2 = '550e8400-e29b-41d4-a716-446655440001';

function makeToken(overrides = {}) {
  return jwt.sign(
    { userId: 1, email: 'init@primaria.ro', role: 'user', orgId: 1, nume: 'Test', ...overrides },
    TEST_JWT_SECRET,
    { expiresIn: '2h' }
  );
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((req, _res, next) => { req.requestId = 'test-req'; next(); });
  app.use('/api/trasabilitate', trasabilitateRouter);
  return app;
}

describe('GET /api/trasabilitate/:type/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = TEST_JWT_SECRET;
  });

  it('401 fără autentificare', async () => {
    const app = makeApp();
    const r = await request(app).get(`/api/trasabilitate/df/${VALID_UUID}`);
    expect(r.status).toBe(401);
  });

  it('400 type invalid (alt cuvânt decât df/ord)', async () => {
    const app = makeApp();
    const r = await request(app)
      .get(`/api/trasabilitate/foo/${VALID_UUID}`)
      .set('Cookie', `auth_token=${makeToken()}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_type');
  });

  it('400 id non-UUID', async () => {
    const app = makeApp();
    const r = await request(app)
      .get('/api/trasabilitate/df/not-a-uuid')
      .set('Cookie', `auth_token=${makeToken()}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_id');
  });

  it('404 când root DF nu există în BD', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp();
    const r = await request(app)
      .get(`/api/trasabilitate/df/${VALID_UUID}`)
      .set('Cookie', `auth_token=${makeToken()}`);
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('not_found');
  });

  it('200 DF root cu 2 revizii, 1 ALOP cu 1 ciclu arhivat + ORD curent', async () => {
    // Q1 — root DF + nr_unic_inreg
    dbModule.pool.query.mockResolvedValueOnce({
      rows: [{ id: VALID_UUID, nr_unic_inreg: 'DF-2025-00125' }]
    });
    // Q2 — toate reviziile DF (R0 + R1)
    dbModule.pool.query.mockResolvedValueOnce({
      rows: [
        { id: VALID_UUID, nr_unic_inreg: 'DF-2025-00125', titlu: 'DF Mobilier',
          revizie_nr: 0, este_revizie: false, status: 'completed', flow_id: 'flow-r0',
          aprobat: true, created_at: '2025-12-01', updated_at: '2025-12-05' },
        { id: VALID_UUID2, nr_unic_inreg: 'DF-2025-00125', titlu: 'DF Mobilier',
          revizie_nr: 1, este_revizie: true, status: 'completed', flow_id: 'flow-r1',
          aprobat: true, created_at: '2026-02-01', updated_at: '2026-02-08' },
      ]
    });
    // Q3 — 1 ALOP cu ord_id (curent)
    dbModule.pool.query.mockResolvedValueOnce({
      rows: [{
        id: 'alop-uuid-1', titlu: 'Achiziție mobilier Q1 2026',
        status: 'completed', valoare_totala: '50000.00', suma_totala_platita: '30000.00',
        ciclu_curent: 2, df_id: VALID_UUID2, ord_id: 'ord-curent-uuid',
        df_valoare: '60000.00',
        lichidare_confirmed_at: '2026-04-10', lichidare_nr_factura: 'F-22',
        lichidare_nr_pv: 'PV-15',
        plata_confirmed_at: null, plata_nr_ordin: null, plata_suma_efectiva: null,
        created_at: '2026-02-10', completed_at: null, cancelled_at: null,
        cancelled_reason: null,
        ord_curent_nr_unic_inreg: 'ORD-2026-042',
        ord_curent_nr_ordonant_pl: 'OP-2026-777',
        ord_curent_titlu: 'Mobilex SRL',
        ord_curent_status: 'completed', ord_curent_flow_id: 'ord-flow', ord_curent_aprobat: true,
      }]
    });
    // Q4 — 1 ciclu arhivat
    dbModule.pool.query.mockResolvedValueOnce({
      rows: [{
        id: 'ciclu-uuid-1', alop_id: 'alop-uuid-1', ciclu_nr: 1,
        ord_id: 'ord-arhivat-uuid', status: 'completed',
        lichidare_confirmed_at: '2026-03-05', lichidare_nr_factura: 'F-12',
        lichidare_data_factura: '2026-03-04', lichidare_nr_pv: 'PV-08',
        lichidare_data_pv: '2026-03-04', lichidare_notes: null,
        plata_confirmed_at: '2026-03-15', plata_nr_ordin: 'OP-321',
        plata_data: '2026-03-15', plata_suma_efectiva: '15000.00',
        plata_observatii: null,
        ord_nr_unic_inreg: 'ORD-2026-001',
        ord_nr_ordonant_pl: 'OP-2026-111',
        ord_titlu: 'Mobilex SRL',
        ord_status: 'completed', ord_flow_id: 'ord-arh-flow', ord_aprobat: true,
      }]
    });

    const app = makeApp();
    const r = await request(app)
      .get(`/api/trasabilitate/df/${VALID_UUID}`)
      .set('Cookie', `auth_token=${makeToken()}`);

    expect(r.status).toBe(200);
    expect(r.body.root_type).toBe('df');
    expect(r.body.root_id).toBe(VALID_UUID);
    expect(r.body.df_revizii).toHaveLength(2);
    expect(r.body.df_revizii[0].is_root_df).toBe(true);  // R0 e root
    expect(r.body.df_revizii[1].is_root_df).toBe(false); // R1 NU e root
    expect(r.body.alopuri).toHaveLength(1);
    expect(r.body.alopuri[0].titlu).toBe('Achiziție mobilier Q1 2026');
    expect(r.body.alopuri[0].valoare_totala).toBe(50000); // Number, not string
    expect(r.body.alopuri[0].df_valoare).toBe(60000);     // SUM(valt_actualiz) al DF activ, ca Number
    expect(r.body.alopuri[0].ord_curent).not.toBeNull();
    expect(r.body.alopuri[0].ord_curent.nr_unic_inreg).toBe('ORD-2026-042');
    // Trasabilitatea expune numărul propriu al ORD (nr_ordonant_pl), distinct de numărul DF
    expect(r.body.alopuri[0].ord_curent.nr_ordonant_pl).toBe('OP-2026-777');
    expect(r.body.alopuri[0].cicluri_arhivate).toHaveLength(1);
    expect(r.body.alopuri[0].cicluri_arhivate[0].ord_nr_unic_inreg).toBe('ORD-2026-001');
    expect(r.body.alopuri[0].cicluri_arhivate[0].ord_nr_ordonant_pl).toBe('OP-2026-111');
    expect(r.body.alopuri[0].cicluri_arhivate[0].plata_suma_efectiva).toBe(15000);
  });

  it('200 ORD root: marchează corect is_root_ord pe ciclul/ord-ul curent corect', async () => {
    const ORD_ROOT = VALID_UUID;
    // Q1 — root ORD + df_id parent
    dbModule.pool.query.mockResolvedValueOnce({
      rows: [{ id: ORD_ROOT, df_id: 'df-uuid', df_nr_unic_inreg: 'DF-2025-00125' }]
    });
    // Q2 — 1 revizie DF
    dbModule.pool.query.mockResolvedValueOnce({
      rows: [{ id: 'df-uuid', nr_unic_inreg: 'DF-2025-00125', titlu: 'DF',
               revizie_nr: 0, este_revizie: false, status: 'completed',
               flow_id: 'fl', aprobat: true,
               created_at: '2025-12-01', updated_at: '2025-12-05' }]
    });
    // Q3 — 1 ALOP cu ord_id = ORD root (deci is_root_ord pe ord_curent)
    dbModule.pool.query.mockResolvedValueOnce({
      rows: [{
        id: 'alop-1', titlu: 'A', status: 'in_progress',
        valoare_totala: null, suma_totala_platita: null, ciclu_curent: 1,
        df_id: 'df-uuid', ord_id: ORD_ROOT,
        lichidare_confirmed_at: null, lichidare_nr_factura: null, lichidare_nr_pv: null,
        plata_confirmed_at: null, plata_nr_ordin: null, plata_suma_efectiva: null,
        created_at: '2026-02-10', completed_at: null, cancelled_at: null,
        cancelled_reason: null,
        ord_curent_nr_unic_inreg: 'ORD-CUR', ord_curent_titlu: 'Furniz X',
        ord_curent_status: 'draft', ord_curent_flow_id: null, ord_curent_aprobat: false,
      }]
    });
    // Q4 — niciun ciclu arhivat
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] });

    const app = makeApp();
    const r = await request(app)
      .get(`/api/trasabilitate/ord/${ORD_ROOT}`)
      .set('Cookie', `auth_token=${makeToken()}`);

    expect(r.status).toBe(200);
    expect(r.body.root_type).toBe('ord');
    expect(r.body.df_revizii[0].is_root_df).toBe(false);
    expect(r.body.df_revizii[0].is_root_df_link).toBe(true); // DF e legat la ORD root
    expect(r.body.alopuri[0].ord_curent.is_root_ord).toBe(true); // ORD root = ord curent
    expect(r.body.alopuri[0].cicluri_arhivate).toHaveLength(0);
  });

  it('multi-tenant: orgId din JWT propagat ca $1 în Q1', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp();
    await request(app)
      .get(`/api/trasabilitate/df/${VALID_UUID}`)
      .set('Cookie', `auth_token=${makeToken({ orgId: 42 })}`);
    const callArgs = dbModule.pool.query.mock.calls[0];
    // Q1 pentru DF: SELECT ... FROM formulare_df WHERE id=$1 AND org_id=$2
    expect(callArgs[1]).toEqual([VALID_UUID, 42]);
  });

  it('500 când BD aruncă eroare', async () => {
    dbModule.pool.query.mockRejectedValueOnce(new Error('db down'));
    const app = makeApp();
    const r = await request(app)
      .get(`/api/trasabilitate/df/${VALID_UUID}`)
      .set('Cookie', `auth_token=${makeToken()}`);
    expect(r.status).toBe(500);
    expect(r.body.error).toBe('server_error');
  });
});
