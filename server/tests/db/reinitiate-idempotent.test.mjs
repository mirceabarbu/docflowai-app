/**
 * #124f: POST /flows/:flowId/reinitiate devine IDEMPOTENT — citește `data.reinitiatedAs`
 * (setat la prima reinițiere) în loc de a-l lăsa nescris. Al doilea clic pe „Reinițiază"
 * pe același părinte nu mai creează un al doilea flux copil; întoarce pointerul existent
 * `alreadyReinitiated:true`. Dacă copilul e mort (anulat/soft-șters), garda permite o
 * reinițiere nouă. Autorizarea rămâne verificată ÎNAINTEA gărzii de idempotență.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';

import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { hasTestDb, migrate, truncateAll, pool, makeAuthCookie } from '../helpers/db-real.mjs';

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
  // stampFooterOnPdf/PDFLib nedefinite intenționat → ramura de footer se sare (fără PDF în test)
});

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use('/', lifecycleRouter);
  return app;
}

// Flux standalone (fără rând în formulare_df/formulare_ord) cu un semnatar refuzat
// (non-APROBAT) + unul rămas → reinițiabil în principiu.
async function seedRefusedFlow(id) {
  const signers = [
    { name: 'A', email: 'a@x.ro', rol: 'AVIZAT', status: 'refused' },
    { name: 'B', email: 'b@x.ro', rol: 'AVIZAT', status: 'pending' },
  ];
  await pool.query(
    `INSERT INTO flows (id, data, org_id) VALUES ($1, $2::jsonb, $3)`,
    [id, JSON.stringify({ status: 'refused', completed: false, orgId: 1, initEmail: 'p1@x.ro',
      docName: 'Doc', institutie: 'Inst', flowType: 'ancore', signers }), 1]
  );
  return id;
}
async function countFlows() {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM flows`);
  return rows[0].n;
}
async function getFlowRow(id) {
  const { rows } = await pool.query(`SELECT data FROM flows WHERE id=$1`, [id]);
  return rows[0]?.data || null;
}
async function countChildrenOf(parentId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM flows WHERE data->>'parentFlowId' = $1`, [parentId]
  );
  return rows[0].n;
}

const d = describe.skipIf(!hasTestDb());

// Pool-ul e un singleton pe fișier — o singură închidere după toate suitele.
afterAll(async () => { if (hasTestDb()) await pool.end(); });

d('#124f — reinitiate idempotent (reinitiatedAs)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await pool.query(
      `INSERT INTO organizations (name) VALUES ('Org Test')`
    );
    await pool.query(
      `INSERT INTO users (email, password_hash, nume, role, org_id) VALUES ($1, 'x', 'Test', 'user', 1)`,
      ['p1@x.ro']
    );
    app = buildApp();
  });
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1, email: 'p1@x.ro' });

  it('(1) prima reinițiere ⇒ 200, alreadyReinitiated absent, +1 flux, reinitiatedAs setat pe părinte', async () => {
    const flowId = await seedRefusedFlow('flow-parent-1');
    const before = await countFlows();
    const res = await request(app).post(`/flows/${flowId}/reinitiate`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.newFlowId).toBeTruthy();
    expect(res.body.alreadyReinitiated).toBeFalsy();
    expect(await countFlows()).toBe(before + 1);
    const parent = await getFlowRow(flowId);
    expect(parent.reinitiatedAs).toBe(res.body.newFlowId);
  });

  it('(2) a doua reinițiere pe același părinte ⇒ 200, newFlowId identic, alreadyReinitiated:true, ZERO flux nou', async () => {
    const flowId = await seedRefusedFlow('flow-parent-2');
    const res1 = await request(app).post(`/flows/${flowId}/reinitiate`).set('Cookie', cookie());
    expect(res1.status).toBe(200);
    const firstChildId = res1.body.newFlowId;
    const afterFirst = await countFlows();

    const res2 = await request(app).post(`/flows/${flowId}/reinitiate`).set('Cookie', cookie());
    expect(res2.status).toBe(200);
    expect(res2.body.ok).toBe(true);
    expect(res2.body.newFlowId).toBe(firstChildId);
    expect(res2.body.alreadyReinitiated).toBe(true);
    expect(await countFlows()).toBe(afterFirst); // neschimbat
    expect(await countChildrenOf(flowId)).toBe(1); // un singur copil
  });

  it('(3) copil ANULAT ⇒ se permite reinițiere nouă, reinitiatedAs pointează la cel nou', async () => {
    const flowId = await seedRefusedFlow('flow-parent-3');
    const res1 = await request(app).post(`/flows/${flowId}/reinitiate`).set('Cookie', cookie());
    const firstChildId = res1.body.newFlowId;
    await pool.query(
      `UPDATE flows SET data = jsonb_set(data, '{status}', '"cancelled"') WHERE id=$1`,
      [firstChildId]
    );
    const before = await countFlows();

    const res2 = await request(app).post(`/flows/${flowId}/reinitiate`).set('Cookie', cookie());
    expect(res2.status).toBe(200);
    expect(res2.body.alreadyReinitiated).toBeFalsy();
    expect(res2.body.newFlowId).not.toBe(firstChildId);
    expect(await countFlows()).toBe(before + 1);
    const parent = await getFlowRow(flowId);
    expect(parent.reinitiatedAs).toBe(res2.body.newFlowId);
  });

  it('(4) copil SOFT-ȘTERS ⇒ se permite reinițiere nouă (ca și copil anulat)', async () => {
    const flowId = await seedRefusedFlow('flow-parent-4');
    const res1 = await request(app).post(`/flows/${flowId}/reinitiate`).set('Cookie', cookie());
    const firstChildId = res1.body.newFlowId;
    await pool.query(`UPDATE flows SET deleted_at = NOW() WHERE id=$1`, [firstChildId]);
    const before = await countFlows();

    const res2 = await request(app).post(`/flows/${flowId}/reinitiate`).set('Cookie', cookie());
    expect(res2.status).toBe(200);
    expect(res2.body.alreadyReinitiated).toBeFalsy();
    expect(res2.body.newFlowId).not.toBe(firstChildId);
    expect(await countFlows()).toBe(before + 1);
  });

  it('(5) autorizarea are prioritate față de idempotență ⇒ actor neîndreptățit primește 403, nu 200', async () => {
    const flowId = await seedRefusedFlow('flow-parent-5');
    await request(app).post(`/flows/${flowId}/reinitiate`).set('Cookie', cookie());
    const before = await countFlows();

    const strangerCookie = makeAuthCookie({ userId: 999, role: 'user', orgId: 1, email: 'stranger@x.ro' });
    const res = await request(app).post(`/flows/${flowId}/reinitiate`).set('Cookie', strangerCookie);
    expect(res.status).toBe(403);
    expect(res.body.newFlowId).toBeUndefined();
    expect(await countFlows()).toBe(before); // niciun efect secundar
  });

  it('(6) non-regresie — flux refuzat FĂRĂ reinitiatedAs se reinițiază exact ca înainte', async () => {
    const flowId = await seedRefusedFlow('flow-parent-6');
    const before = await countFlows();
    const res = await request(app).post(`/flows/${flowId}/reinitiate`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.newFlowId).toBeTruthy();
    expect(res.body.alreadyReinitiated).toBeFalsy();
    expect(await countFlows()).toBe(before + 1);
  });
});
