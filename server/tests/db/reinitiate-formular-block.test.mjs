/**
 * #114 (varianta B): POST /flows/:flowId/reinitiate e BLOCAT pe fluxuri legate de un formular
 * (DF/ORD) — 409 `formular_linked_flow` fără să creeze un flux nou. Reinițierea nu relinkează
 * formularul, deci un flux nou ar fi orfan; traseul corect e prin ALOP. Fluxurile standalone
 * (nelegate) se reinițiază ca înainte (non-regresie).
 *
 * Plus: migrația 104 de VINDECARE eliberează ALOP-urile 'ordonantare' cu ord_flow_id spre un
 * flux mort (refuzat/anulat/soft-șters), idempotent.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';

import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedOrd, seedDf, seedAlop, getAlop, makeAuthCookie } from '../helpers/db-real.mjs';

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

// Flux cu un semnatar refuzat (non-APROBAT) + unul rămas → reinițiabil în principiu.
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

const d = describe.skipIf(!hasTestDb());

// Pool-ul e un singleton pe fișier — o singură închidere după toate suitele.
afterAll(async () => { if (hasTestDb()) await pool.end(); });

d('#114 — reinițiere blocată pe fluxuri de formular', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await seedOrgUser({ role: 'user' }); app = buildApp(); });
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1, email: 'p1@x.ro' });

  it('(7) flux legat de ORD ⇒ 409 formular_linked_flow, fără flux nou', async () => {
    const flowId = await seedRefusedFlow('flow-ord-rei');
    await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId });
    const before = await countFlows();
    const res = await request(app).post(`/flows/${flowId}/reinitiate`).set('Cookie', cookie());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('formular_linked_flow');
    expect(res.body.message).toMatch(/Ordonanțări de Plată/);
    expect(await countFlows()).toBe(before); // niciun flux nou
  });

  it('(8) flux legat de DF ⇒ 409 formular_linked_flow', async () => {
    const flowId = await seedRefusedFlow('flow-df-rei');
    await seedDf({ orgId: 1, createdBy: 1, status: 'transmis_flux', flowId });
    const before = await countFlows();
    const res = await request(app).post(`/flows/${flowId}/reinitiate`).set('Cookie', cookie());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('formular_linked_flow');
    expect(res.body.message).toMatch(/Document de Fundamentare/);
    expect(await countFlows()).toBe(before);
  });

  it('(9) flux standalone (nelegat) ⇒ reinițierea funcționează (non-regresie)', async () => {
    const flowId = await seedRefusedFlow('flow-standalone-rei');
    const before = await countFlows();
    const res = await request(app).post(`/flows/${flowId}/reinitiate`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.newFlowId).toBeTruthy();
    expect(await countFlows()).toBe(before + 1); // flux nou creat
  });
});

// SQL canonic al migrației 104 (vindecare unică). Rulat aici după seed pentru a dovedi
// efectul; idempotent prin propriul WHERE.
const HEAL_SQL = `
  UPDATE alop_instances a
     SET ord_flow_id = NULL, ord_completed_at = NULL, updated_at = NOW()
    FROM flows f
   WHERE f.id::text = a.ord_flow_id
     AND a.status = 'ordonantare'
     AND a.cancelled_at IS NULL
     AND ( f.deleted_at IS NOT NULL
        OR f.data->>'status' = 'cancelled'
        OR f.data->>'status' = 'refused' )
`;

d('#114 — migrația 104 vindecare pointer ORD mort', () => {
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await seedOrgUser({ role: 'user' }); });

  async function seedFlow(id, status) {
    await pool.query(`INSERT INTO flows (id, data, org_id) VALUES ($1, $2::jsonb, $3)`,
      [id, JSON.stringify({ status, completed: status === 'completed', orgId: 1, signers: [] }), 1]);
    return id;
  }

  it('(10) ALOP ordonantare cu flux refuzat ⇒ ord_flow_id NULL; flux activ neatins; a 2-a rulare = 0', async () => {
    const deadFlow = await seedFlow('flow-dead', 'refused');
    const liveFlow = await seedFlow('flow-live', 'active');
    const ordDead = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId: deadFlow });
    const ordLive = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId: liveFlow, nrOrd: 'ORD-2026-002' });
    const alopDead = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', ordId: ordDead,
      ordFlowId: deadFlow, ordCompletedAt: new Date().toISOString() });
    const alopLive = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', ordId: ordLive, ordFlowId: liveFlow });

    const r1 = await pool.query(HEAL_SQL);
    expect(r1.rowCount).toBe(1); // doar ALOP-ul cu flux mort

    expect((await getAlop(alopDead)).ord_flow_id).toBeNull();
    expect((await getAlop(alopDead)).ord_completed_at).toBeNull();
    expect((await getAlop(alopLive)).ord_flow_id).toBe(liveFlow); // flux activ neatins

    const r2 = await pool.query(HEAL_SQL);
    expect(r2.rowCount).toBe(0); // idempotent
  });
});
