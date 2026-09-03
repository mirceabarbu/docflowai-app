/**
 * #171: garda de reinițiere (#114) cheiată doar pe POINTER lăsa să treacă un flux ORFAN —
 * poartă `data.meta.dfId`/`ordId`, dar formularul n-a luat niciodată pointerul
 * (`formulare_X.flow_id` arată spre alt flux). `reinitiate` îi construia un copil cu
 * `{ ...data }`, deci cu ACELAȘI `meta` moștenit ⇒ al doilea flux viu pe același document,
 * exact ce refuză poarta de lansare (#170). Garda cheiază acum și pe `meta` (aceeași cheie
 * cu poarta #170), pointerul rămânând a doua condiție pentru fluxurile vechi fără `meta`.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';

import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedOrd, seedDf, makeAuthCookie } from '../helpers/db-real.mjs';

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

const lifecycleMod = await import('../../routes/flows/lifecycle.mjs');
const lifecycleRouter = lifecycleMod.default;
let _newFlowSeq = 0;
lifecycleMod._injectDeps({
  notify: async () => {}, fireWebhook: null, wsPush: () => {},
  newFlowId: () => `flow-new-${++_newFlowSeq}-${Math.random().toString(36).slice(2, 7)}`,
});

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use('/', lifecycleRouter);
  return app;
}

async function seedRefusedFlow(id, extraData = {}) {
  const signers = [
    { name: 'A', email: 'a@x.ro', rol: 'AVIZAT', status: 'refused' },
    { name: 'B', email: 'b@x.ro', rol: 'AVIZAT', status: 'pending' },
  ];
  await pool.query(
    `INSERT INTO flows (id, data, org_id) VALUES ($1, $2::jsonb, $3)`,
    [id, JSON.stringify({ status: 'refused', completed: false, orgId: 1, initEmail: 'p1@x.ro',
      docName: 'Doc', institutie: 'Inst', flowType: 'ancore', signers, ...extraData }), 1]
  );
  return id;
}
async function countFlows() {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM flows`);
  return rows[0].n;
}

const d = describe.skipIf(!hasTestDb());

afterAll(async () => { if (hasTestDb()) await pool.end(); });

d('#171 — reinițiere blocată pe orfan (meta fără pointer)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await seedOrgUser({ role: 'user' }); app = buildApp(); });
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1, email: 'p1@x.ro' });

  it('(1) orfan DF: meta.dfId fără pointer ⇒ 409 formular_linked_flow, fără flux nou', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'transmis_flux', flowId: 'flow-alt-owner-df' });
    const flowId = await seedRefusedFlow('flow-orfan-df', { meta: { dfId: String(dfId) } });
    const before = await countFlows();
    const res = await request(app).post(`/flows/${flowId}/reinitiate`).set('Cookie', cookie());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('formular_linked_flow');
    expect(res.body.message).toMatch(/Document de Fundamentare/);
    expect(await countFlows()).toBe(before);
  });

  it('(2) orfan ORD: meta.ordId fără pointer ⇒ 409 formular_linked_flow', async () => {
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId: 'flow-alt-owner-ord' });
    const flowId = await seedRefusedFlow('flow-orfan-ord', { meta: { ordId: String(ordId) } });
    const before = await countFlows();
    const res = await request(app).post(`/flows/${flowId}/reinitiate`).set('Cookie', cookie());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('formular_linked_flow');
    expect(res.body.message).toMatch(/Ordonanțări de Plată/);
    expect(await countFlows()).toBe(before);
  });

  it('(3) INVARIANT DE PRODUS — flux obișnuit (fără meta.dfId/ordId, fără pointer) se reinițiază', async () => {
    const flowId = await seedRefusedFlow('flow-obisnuit-rei');
    const before = await countFlows();
    const res = await request(app).post(`/flows/${flowId}/reinitiate`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.newFlowId).toBeTruthy();
    expect(await countFlows()).toBe(before + 1);
  });

  it('(4) actor neîndreptățit pe orfan DF ⇒ 403, nu 409 (autorizarea rămâne înaintea gărzii)', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'transmis_flux', flowId: 'flow-alt-owner-df2' });
    const flowId = await seedRefusedFlow('flow-orfan-df-unauth', { meta: { dfId: String(dfId) } });
    const strangerCookie = makeAuthCookie({ userId: 99, role: 'user', orgId: 1, email: 'stranger@x.ro' });
    const res = await request(app).post(`/flows/${flowId}/reinitiate`).set('Cookie', strangerCookie);
    expect(res.status).toBe(403);
  });

  it('(5) regresie #124f: orfan DF cu reinitiatedAs către copil viu ⇒ idempotent 200, fără flux nou', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'transmis_flux', flowId: 'flow-alt-owner-df3' });
    const childId = await seedRefusedFlow('flow-orfan-df-child', {});
    await pool.query(`UPDATE flows SET data = jsonb_set(data, '{status}', '"active"') WHERE id=$1`, [childId]);
    const parentId = await seedRefusedFlow('flow-orfan-df-parent', { meta: { dfId: String(dfId) }, reinitiatedAs: childId });
    const before = await countFlows();
    const res = await request(app).post(`/flows/${parentId}/reinitiate`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.alreadyReinitiated).toBe(true);
    expect(res.body.newFlowId).toBe(childId);
    expect(await countFlows()).toBe(before);
  });

  it('(6) ambele revendicate (dfId ȘI ordId) ⇒ 409 cu mesajul de ORD (precedența)', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'transmis_flux', flowId: 'flow-alt-owner-df4' });
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId: 'flow-alt-owner-ord4' });
    const flowId = await seedRefusedFlow('flow-orfan-both', { meta: { dfId: String(dfId), ordId: String(ordId) } });
    const res = await request(app).post(`/flows/${flowId}/reinitiate`).set('Cookie', cookie());
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/Ordonanțări de Plată/);
  });
});
