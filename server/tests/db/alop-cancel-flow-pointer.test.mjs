/**
 * Fix 9 (caracterizare): POST /flows/:flowId/cancel curăță pointerul ALOP simetric DF↔ORD.
 *
 * Înainte de fix, cancel-ul fluxului trata DOAR DF (df_flow_id), iar ORD rămânea cu
 * alop_instances.ord_flow_id agățat de fluxul anulat (pointer mort). Acoperă:
 *  (1) ORD legat de flux → cancel flux → ord_flow_id/ord_completed_at devin NULL pe ALOP;
 *      formulare_ord.flow_id RĂMÂNE (paritate DF) iar flow_active devine false (form deblocat);
 *      self-heal #2 NU re-populează ord_flow_id dintr-un flux 'cancelled' (durabil la GET).
 *  (2) Paritate DF: cancel readuce DF 'transmis_flux' → 'completed' și curăță df_flow_id.
 *  (3) Cancel pe flux fără ORD/DF legat → 200 no-op, fără eroare.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedAlop, getAlop, getDf, makeAuthCookie } from '../helpers/db-real.mjs';

// Mock-uri ortogonale (NU db) — aceeași strategie ca helpers/app.mjs.
vi.mock('../../middleware/csrf.mjs', () => ({ csrfMiddleware: (_req, _res, next) => next() }));
vi.mock('../../middleware/require-module.mjs', () => ({
  requireModule: () => (_req, _res, next) => next(),
  default: () => (_req, _res, next) => next(),
}));
vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  redactUrl: (u) => u,
}));

const { formulareDbRouter } = await import('../../routes/formulare/index.mjs');
const alopRouter = (await import('../../routes/alop.mjs')).default;
const lifecycleMod = await import('../../routes/flows/lifecycle.mjs');
const lifecycleRouter = lifecycleMod.default;
lifecycleMod._injectDeps({ notify: async () => {}, fireWebhook: null, wsPush: () => {} });

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use('/', lifecycleRouter);
  app.use('/', formulareDbRouter);
  app.use('/', alopRouter);
  return app;
}

async function seedFlow(id, status = 'in_progress') {
  await pool.query(
    `INSERT INTO flows (id, data, org_id) VALUES ($1, $2::jsonb, $3)`,
    [id, JSON.stringify({ status, completed: false, orgId: 1, initEmail: 'p1@x.ro', docName: 'Doc' }), 1]
  );
  return id;
}

const d = describe.skipIf(!hasTestDb());

d('POST /flows/:flowId/cancel — cleanup pointer ALOP simetric DF↔ORD (fix 9)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await seedOrgUser({ role: 'user' }); app = buildApp(); });
  afterAll(() => pool.end());
  // initiatorul (isInit) — poate anula fluxul fără a fi admin
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1, email: 'p1@x.ro' });

  it('(1) ORD legat de flux → cancel → ord_flow_id NULL pe ALOP, durabil la GET, flow_active false', async () => {
    const flowId = await seedFlow('flow-ord-1');
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', ordId, ordFlowId: flowId, ordCompletedAt: new Date().toISOString() });

    const res = await request(app).post(`/flows/${flowId}/cancel`).set('Cookie', cookie());
    expect(res.status).toBe(200);

    // Pointerul ALOP curățat, dar legătura formularului rămâne (paritate DF)
    const a1 = await getAlop(alopId);
    expect(a1.ord_flow_id).toBeNull();
    expect(a1.ord_completed_at).toBeNull();
    const { rows: ord } = await pool.query(`SELECT flow_id FROM formulare_ord WHERE id=$1`, [ordId]);
    expect(ord[0].flow_id).toBe(flowId); // NU se șterge — self-heal #2 e gardat pe 'cancelled'

    // Durabilitate: GET /api/alop nu re-populează ord_flow_id dintr-un flux anulat
    const det = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie());
    expect(det.status).toBe(200);
    expect(det.body.alop.ord_flow_id).toBeNull();
    const a2 = await getAlop(alopId);
    expect(a2.ord_flow_id).toBeNull();

    // Formularul ORD se deblochează (flow_active=false fiindcă fluxul e cancelled)
    const ordDet = await request(app).get(`/api/formulare-ord/${ordId}`).set('Cookie', cookie());
    expect(ordDet.status).toBe(200);
    expect(ordDet.body.document.flow_active).toBe(false);
  });

  it('(2) Paritate DF: cancel readuce DF transmis_flux → completed și curăță df_flow_id', async () => {
    const flowId = await seedFlow('flow-df-1');
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'transmis_flux', flowId });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId, dfFlowId: flowId, dfCompletedAt: new Date().toISOString() });

    const res = await request(app).post(`/flows/${flowId}/cancel`).set('Cookie', cookie());
    expect(res.status).toBe(200);

    expect((await getDf(dfId)).status).toBe('completed');
    const a = await getAlop(alopId);
    expect(a.df_flow_id).toBeNull();
    expect(a.df_completed_at).toBeNull();
  });

  it('(3) Cancel pe flux fără ORD/DF legat → 200 no-op, fără eroare', async () => {
    const flowId = await seedFlow('flow-plain-1');
    const res = await request(app).post(`/flows/${flowId}/cancel`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
