/**
 * #113a — POST /flows/:flowId/admin-cancel: undo administrativ al unui flux FINALIZAT.
 *
 * Rulează rutele REALE peste Postgres real (lifecycle.mjs + alop.mjs + formulare).
 * Acoperă gărzile (financiar/istoric/status/authz/motiv), efectul pe DB (soft-delete +
 * desfacere legături DF/ORD↔ALOP, plata→ordonantare) și — cazul CEL MAI IMPORTANT —
 * non-regresia capcanei: după admin-cancel, `ord_aprobat` devine false ⇒ auto-tranziția
 * lazy din GET /api/alop/:id NU mai poate reînvia ALOP-ul la 'plata'.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedAlop, getAlop, getDf, makeAuthCookie } from '../helpers/db-real.mjs';

// Mock-uri ortogonale (NU db) — aceeași strategie ca alop-cancel-flow-pointer.test.mjs.
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
  app.use('/', alopRouter);
  return app;
}

// Flux FINALIZAT: completed:true + orgId în data (authz-ul citește data.orgId).
async function seedCompletedFlow(id, orgId = 1) {
  await pool.query(
    `INSERT INTO flows (id, data, org_id) VALUES ($1, $2::jsonb, $3)`,
    [id, JSON.stringify({ flowId: id, status: 'completed', completed: true, orgId, initEmail: 'p1@x.ro', docName: 'Doc final', signers: [] }), orgId]
  );
  return id;
}
async function getFlowRow(id) {
  const { rows } = await pool.query(`SELECT id, deleted_at, data FROM flows WHERE id=$1`, [id]);
  return rows[0];
}

const d = describe.skipIf(!hasTestDb());

d('POST /flows/:flowId/admin-cancel — undo flux finalizat (#113a)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'org_admin' }); // userId=1, orgId=1, org_admin
    app = buildApp();
  });
  afterAll(() => pool.end());

  const adminCookie = () => makeAuthCookie({ userId: 1, role: 'org_admin', orgId: 1, email: 'p1@x.ro' });
  const REASON = 'ORD semnat doar de inițiator, neconform — desfacere.';

  it('(1) org_admin same-org, ORD finalizat, motiv valid → 200 + DB desfăcut', async () => {
    const flowId = await seedCompletedFlow('flow-ac-1');
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'plata', ordId, ordFlowId: flowId, ordCompletedAt: new Date().toISOString() });

    const res = await request(app).post(`/flows/${flowId}/admin-cancel`)
      .set('Cookie', adminCookie()).send({ reason: REASON });
    expect(res.status).toBe(200);

    const { rows: ord } = await pool.query(`SELECT flow_id FROM formulare_ord WHERE id=$1`, [ordId]);
    expect(ord[0].flow_id).toBeNull(); // AMBELE pointere golite (capcana)
    const a = await getAlop(alopId);
    expect(a.ord_flow_id).toBeNull();
    expect(a.ord_completed_at).toBeNull();
    expect(a.status).toBe('ordonantare'); // plata → ordonantare (migrația 103)
    const f = await getFlowRow(flowId);
    expect(f.deleted_at).not.toBeNull(); // soft-delete
    expect(f.data.status).toBe('cancelled');
    expect(f.data.adminCancelled).toBe(true);
  });

  it('(2) NON-REGRESIE capcană: după admin-cancel, ord_aprobat=false ⇒ NU revine la plata la GET', async () => {
    const flowId = await seedCompletedFlow('flow-ac-2');
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'plata', ordId, ordFlowId: flowId, ordCompletedAt: new Date().toISOString() });

    const res = await request(app).post(`/flows/${flowId}/admin-cancel`)
      .set('Cookie', adminCookie()).send({ reason: REASON });
    expect(res.status).toBe(200);

    // GET rulează logica reală de lazy-transition; dacă pointerii n-ar fi goliți, ar sări la plata.
    const det = await request(app).get(`/api/alop/${alopId}`).set('Cookie', adminCookie());
    expect(det.status).toBe(200);
    expect(det.body.alop.ord_aprobat).toBe(false);
    expect(det.body.alop.status).toBe('ordonantare'); // rămâne, NU revine la plata
    expect((await getAlop(alopId)).status).toBe('ordonantare');
  });

  it('(3) plata_confirmed_at setat → 409 payment_confirmed, zero scrieri', async () => {
    const flowId = await seedCompletedFlow('flow-ac-3');
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'plata', ordId, ordFlowId: flowId });
    await pool.query(`UPDATE alop_instances SET plata_confirmed_at=NOW() WHERE id=$1`, [alopId]);

    const res = await request(app).post(`/flows/${flowId}/admin-cancel`)
      .set('Cookie', adminCookie()).send({ reason: REASON });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('payment_confirmed');
    // Zero scrieri:
    expect((await getFlowRow(flowId)).deleted_at).toBeNull();
    expect((await getAlop(alopId)).status).toBe('plata');
    const { rows: ord } = await pool.query(`SELECT flow_id FROM formulare_ord WHERE id=$1`, [ordId]);
    expect(ord[0].flow_id).toBe(flowId);
  });

  it('(4) cicluri arhivate prezente → 409 has_archived_cycles', async () => {
    const flowId = await seedCompletedFlow('flow-ac-4');
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'plata', ordId, ordFlowId: flowId });
    await pool.query(
      `INSERT INTO alop_ord_cicluri (alop_id, org_id, ciclu_nr, status) VALUES ($1, 1, 1, 'completed')`,
      [alopId]
    );
    const res = await request(app).post(`/flows/${flowId}/admin-cancel`)
      .set('Cookie', adminCookie()).send({ reason: REASON });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('has_archived_cycles');
    expect((await getFlowRow(flowId)).deleted_at).toBeNull();
  });

  it('(5) flux NEfinalizat → 409 not_completed', async () => {
    const flowId = 'flow-ac-5';
    await pool.query(
      `INSERT INTO flows (id, data, org_id) VALUES ($1, $2::jsonb, 1)`,
      [flowId, JSON.stringify({ flowId, status: 'pending', completed: false, orgId: 1, initEmail: 'p1@x.ro', docName: 'D', signers: [] })]
    );
    const res = await request(app).post(`/flows/${flowId}/admin-cancel`)
      .set('Cookie', adminCookie()).send({ reason: REASON });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_completed');
  });

  it('(6) reason lipsă / sub 10 caractere → 400 reason_required', async () => {
    const flowId = await seedCompletedFlow('flow-ac-6');
    const r1 = await request(app).post(`/flows/${flowId}/admin-cancel`).set('Cookie', adminCookie()).send({});
    expect(r1.status).toBe(400);
    expect(r1.body.error).toBe('reason_required');
    const r2 = await request(app).post(`/flows/${flowId}/admin-cancel`).set('Cookie', adminCookie()).send({ reason: 'scurt' });
    expect(r2.status).toBe(400);
    expect(r2.body.error).toBe('reason_required');
    expect((await getFlowRow(flowId)).deleted_at).toBeNull();
  });

  it('(7) utilizator simplu → 403; org_admin din ALTĂ org → 403', async () => {
    const flowId = await seedCompletedFlow('flow-ac-7');
    const userRes = await request(app).post(`/flows/${flowId}/admin-cancel`)
      .set('Cookie', makeAuthCookie({ userId: 1, role: 'user', orgId: 1, email: 'p1@x.ro' }))
      .send({ reason: REASON });
    expect(userRes.status).toBe(403);
    const otherOrgRes = await request(app).post(`/flows/${flowId}/admin-cancel`)
      .set('Cookie', makeAuthCookie({ userId: 9, role: 'org_admin', orgId: 2, email: 'other@x.ro' }))
      .send({ reason: REASON });
    expect(otherOrgRes.status).toBe(403);
    expect((await getFlowRow(flowId)).deleted_at).toBeNull();
  });

  it('(8) flux DF (nu ORD) → DF revine la completed, df_flow_id NULL', async () => {
    const flowId = await seedCompletedFlow('flow-ac-8');
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'transmis_flux', flowId });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId, dfFlowId: flowId, dfCompletedAt: new Date().toISOString() });

    const res = await request(app).post(`/flows/${flowId}/admin-cancel`)
      .set('Cookie', adminCookie()).send({ reason: REASON });
    expect(res.status).toBe(200);
    expect((await getDf(dfId)).status).toBe('completed');
    const a = await getAlop(alopId);
    expect(a.df_flow_id).toBeNull();
    expect(a.df_completed_at).toBeNull();
    expect(a.status).toBe('lichidare'); // DF nu schimbă statusul ALOP
    expect((await getFlowRow(flowId)).deleted_at).not.toBeNull();
  });

  it('(9) idempotență: al doilea apel → 409 already_cancelled', async () => {
    const flowId = await seedCompletedFlow('flow-ac-9');
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId });
    await seedAlop({ orgId: 1, createdBy: 1, status: 'plata', ordId, ordFlowId: flowId });

    const r1 = await request(app).post(`/flows/${flowId}/admin-cancel`).set('Cookie', adminCookie()).send({ reason: REASON });
    expect(r1.status).toBe(200);
    const r2 = await request(app).post(`/flows/${flowId}/admin-cancel`).set('Cookie', adminCookie()).send({ reason: REASON });
    expect(r2.status).toBe(409);
    expect(r2.body.error).toBe('already_cancelled');
  });
});
