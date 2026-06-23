/**
 * Fix D (caracterizare): soft-delete-ul fluxului nu mai lasă DF/ORD blocat „pe flux de semnare".
 *
 * Două straturi acoperite:
 *  (Layer 1 — SQL display) `flow_active`/`aprobat` exclud fluxurile soft-șterse (`f.deleted_at IS NULL`).
 *     Simulează un pointer mort (flux șters manual, flow_id încă setat — caz backfill/legacy) și
 *     verifică prin GET că documentul NU mai apare „pe flux".
 *  (Layer 2 — igienă date) `DELETE /flows/:flowId` (crud.mjs) curăță pointerii simetric cu cancel:
 *     formulare_{df,ord}.flow_id=NULL, alop_instances.{df,ord}_flow_id=NULL; DF 'transmis_flux'→'completed'.
 *  (Non-regresie) flux ACTIV nețters → flow_active rămâne true.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedAlop, getAlop, getDf, getOrd, makeAuthCookie } from '../helpers/db-real.mjs';

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
const crudMod = await import('../../routes/flows/crud.mjs');
const crudRouter = crudMod.default;
// DELETE-ul nu folosește deps injectate, dar injectăm stub-uri ca importul să fie complet.
crudMod._injectDeps({
  notify: async () => {}, fireWebhook: null, wsPush: () => {},
  PDFLib: null, stampFooterOnPdf: null, isSignerTokenExpired: () => false,
  newFlowId: () => 'x', buildSignerLink: () => '', stripSensitive: (x) => x,
  stripPdfB64: (x) => x, sendSignerEmail: async () => {},
});

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '50mb' }));
  app.use(cookieParser());
  app.use('/', crudRouter);
  app.use('/', formulareDbRouter);
  return app;
}

// flux cu initEmail/orgId — `p1@x.ro` e și initiatorul (isInit) și creatorul formularelor (poate vedea).
async function seedFlowD(id, { status = 'in_progress', completed = false, deletedAt = null } = {}) {
  await pool.query(
    `INSERT INTO flows (id, data, org_id, deleted_at) VALUES ($1, $2::jsonb, $3, $4)`,
    [id, JSON.stringify({ status, completed, orgId: 1, initEmail: 'p1@x.ro', docName: 'Doc' }), 1, deletedAt]
  );
  return id;
}

const d = describe.skipIf(!hasTestDb());

d('Soft-delete flux — DF/ORD nu mai rămân blocate „pe flux" (fix D)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await seedOrgUser({ role: 'user', email: 'p1@x.ro' }); app = buildApp(); });
  afterAll(() => pool.end());
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1, email: 'p1@x.ro' });

  // ── Layer 1: display SQL exclude fluxul șters (pointer mort, fără cleanup) ──────────────
  it('(L1-DF) flux soft-șters cu flow_id încă setat → GET DF: flow_active=false, aprobat=false', async () => {
    const flowId = await seedFlowD('flow-del-df', { status: 'completed', completed: true, deletedAt: new Date().toISOString() });
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', flowId });

    const res = await request(app).get(`/api/formulare-df/${dfId}`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.document.flow_active).toBe(false); // fluxul șters nu mai e activ
    expect(res.body.document.aprobat).toBe(false);     // și nu mai marchează documentul aprobat
  });

  it('(L1-ORD) flux soft-șters cu flow_id încă setat → GET ORD: flow_active=false, aprobat=false', async () => {
    const flowId = await seedFlowD('flow-del-ord', { status: 'completed', completed: true, deletedAt: new Date().toISOString() });
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId });

    const res = await request(app).get(`/api/formulare-ord/${ordId}`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.document.flow_active).toBe(false);
    expect(res.body.document.aprobat).toBe(false);
  });

  // ── Layer 2: DELETE handler curăță pointerii simetric cu cancel ─────────────────────────
  it('(L2-DF) DELETE flux → DF transmis_flux revine completed + flow_id NULL; ALOP df_flow_id NULL', async () => {
    const flowId = await seedFlowD('flow-d2-df', { status: 'in_progress' });
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'transmis_flux', flowId });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId, dfFlowId: flowId, dfCompletedAt: new Date().toISOString() });

    const res = await request(app).delete(`/flows/${flowId}`).set('Cookie', cookie());
    expect(res.status).toBe(200);

    const df = await getDf(dfId);
    expect(df.status).toBe('completed');
    expect(df.flow_id).toBeNull();
    const a = await getAlop(alopId);
    expect(a.df_flow_id).toBeNull();
    expect(a.df_completed_at).toBeNull();
  });

  it('(L2-ORD) DELETE flux → ORD flow_id NULL (fără reset status); ALOP ord_flow_id NULL', async () => {
    const flowId = await seedFlowD('flow-d2-ord', { status: 'in_progress' });
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', ordId, ordFlowId: flowId, ordCompletedAt: new Date().toISOString() });

    const res = await request(app).delete(`/flows/${flowId}`).set('Cookie', cookie());
    expect(res.status).toBe(200);

    const ord = await getOrd(ordId);
    expect(ord.flow_id).toBeNull();
    expect(ord.status).toBe('completed'); // ORD nu trece prin transmis_flux → status neschimbat
    const a = await getAlop(alopId);
    expect(a.ord_flow_id).toBeNull();
    expect(a.ord_completed_at).toBeNull();
  });

  // ── Non-regresie: fluxul activ nețters rămâne activ ────────────────────────────────────
  it('(NR) flux ACTIV nețters non-terminal → flow_active=true (guard real intact)', async () => {
    const flowId = await seedFlowD('flow-activ', { status: 'in_progress' });
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'transmis_flux', flowId });

    const res = await request(app).get(`/api/formulare-df/${dfId}`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.document.flow_active).toBe(true);
  });
});
