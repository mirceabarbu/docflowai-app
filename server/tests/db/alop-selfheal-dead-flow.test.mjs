/**
 * #114 (caracterizare): self-heal #2 (ord_flow_id back-fill din formulare_ord.flow_id)
 * NU mai învie fluxuri MOARTE — refuzat / anulat / soft-șters / inexistent.
 *
 * Bug (prod ORD 41011, 23.07): flux ORD refuzat → handlerul #77 curăță ord_flow_id pe ALOP,
 * dar formulare_ord.flow_id rămâne (paritate DF). Self-heal #2 se declanșa exact pe starea
 * rămasă (status='ordonantare' && ord_id && !ord_flow_id) și repopula pointerul mort — garda
 * veche verifica DOAR 'cancelled'. Fix: flux „mort" = anulat, refuzat, soft-șters SAU inexistent.
 *
 * Un flux VIU (activ sau completat) trebuie să repopuleze în continuare — self-heal-ul își
 * păstrează scopul real (link-ord-flow ratat).
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedOrd, seedAlop, getAlop, makeAuthCookie } from '../helpers/db-real.mjs';

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

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use('/', alopRouter);
  return app;
}

// Flux cu status arbitrar (+ deleted_at opțional). NU declanșează auto-tranziții nedorite.
async function seedFlow(id, { status = 'active', completed = false, deletedAt = null } = {}) {
  await pool.query(
    `INSERT INTO flows (id, data, org_id, deleted_at) VALUES ($1, $2::jsonb, $3, $4)`,
    [id, JSON.stringify({ status, completed, orgId: 1, initEmail: 'p1@x.ro', docName: 'Doc', signers: [] }), 1, deletedAt]
  );
  return id;
}

const d = describe.skipIf(!hasTestDb());

d('#114 — self-heal #2 nu învie fluxuri moarte', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await seedOrgUser({ role: 'user' }); app = buildApp(); });
  afterAll(() => pool.end());
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1, email: 'p1@x.ro' });

  // ALOP 'ordonantare' cu ord_id setat dar ord_flow_id NULL, iar formulare_ord.flow_id → flux.
  async function seedScenario(flowStatus) {
    const flowId = `flow-${flowStatus.status || flowStatus}-${Math.random().toString(36).slice(2, 7)}`;
    let ordFlow = flowId;
    if (flowStatus === '__missing__') {
      ordFlow = 'flow-inexistent-xyz'; // NU se inserează niciun rând în flows
    } else {
      await seedFlow(flowId, typeof flowStatus === 'string' ? { status: flowStatus } : flowStatus);
    }
    const isCompleted = typeof flowStatus === 'object' ? flowStatus.completed : flowStatus === 'completed';
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: isCompleted ? 'completed' : 'transmis_flux', flowId: ordFlow });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', ordId, ordFlowId: null });
    return { alopId, ordFlow };
  }

  it('(1) flux REFUZAT ⇒ ord_flow_id rămâne NULL (cazul central)', async () => {
    const { alopId } = await seedScenario('refused');
    const det = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie());
    expect(det.status).toBe(200);
    expect(det.body.alop.ord_flow_id).toBeNull();
    expect((await getAlop(alopId)).ord_flow_id).toBeNull();
  });

  it('(2) flux ANULAT ⇒ NULL (non-regresie garda veche)', async () => {
    const { alopId } = await seedScenario('cancelled');
    const det = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie());
    expect(det.body.alop.ord_flow_id).toBeNull();
    expect((await getAlop(alopId)).ord_flow_id).toBeNull();
  });

  it('(3) flux SOFT-ȘTERS ⇒ NULL', async () => {
    const { alopId } = await seedScenario({ status: 'active', deletedAt: new Date().toISOString() });
    const det = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie());
    expect(det.body.alop.ord_flow_id).toBeNull();
    expect((await getAlop(alopId)).ord_flow_id).toBeNull();
  });

  it('(4) flow_id către un id INEXISTENT ⇒ NULL', async () => {
    const { alopId } = await seedScenario('__missing__');
    const det = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie());
    expect(det.body.alop.ord_flow_id).toBeNull();
    expect((await getAlop(alopId)).ord_flow_id).toBeNull();
  });

  it('(5) flux ACTIV nefinalizat ⇒ ord_flow_id SE repopulează (scopul real al self-heal)', async () => {
    const { alopId, ordFlow } = await seedScenario('active');
    const det = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie());
    expect(det.status).toBe(200);
    expect(det.body.alop.ord_flow_id).toBe(ordFlow);
    const a = await getAlop(alopId);
    expect(a.ord_flow_id).toBe(ordFlow);
    expect(a.status).toBe('ordonantare'); // nu trece la plata pe flux nefinalizat
  });

  it('(6) flux COMPLETAT ⇒ repopulează ȘI trece la plata (comportament existent)', async () => {
    const { alopId, ordFlow } = await seedScenario({ status: 'completed', completed: true });
    const det = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie());
    expect(det.status).toBe(200);
    expect(det.body.alop.ord_flow_id).toBe(ordFlow);
    const a = await getAlop(alopId);
    expect(a.ord_flow_id).toBe(ordFlow);
    expect(a.status).toBe('plata');
  });
});
