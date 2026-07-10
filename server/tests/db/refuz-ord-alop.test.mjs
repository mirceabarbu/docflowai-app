/**
 * Prompt 77: refuz flux ORD → curăță ord_flow_id (re-lansare disponibilă) + audit.
 *
 * Geamănul lui #74 (DF), dar funcțional: handler-ul vechi trata doar DF-ul; la
 * refuz ORD, alop.ord_flow_id rămânea setat → capabilitatea rămânea blocată pe
 * „Marchează ORD semnat complet" (pentru un flux refuzat), userul nu putea re-lansa.
 *
 * Fix: rezolvare robustă prin alop.ord_flow_id=$1 → curăță ord_flow_id +
 * ord_completed_at → phase_action redevine 'genereaza_lanseaza_ord'. Audit
 * 'flux_refuzat' pe ORD. Statusul documentului ORD rămâne (re-lansare curată).
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedOrd, seedAlop, getAlop, getOrd } from '../helpers/db-real.mjs';
import { computeAlopCapabilities } from '../../services/alop-capabilities.mjs';

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  redactUrl: (u) => u,
}));

const signingMod = await import('../../routes/flows/signing.mjs');
const signingRouter = signingMod.default;
signingMod._injectDeps({
  notify: async () => {},
  fireWebhook: null,
  wsPush: () => {},
  isSignerTokenExpired: () => false,
  stripPdfB64: (d) => d,
});

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use('/', signingRouter);
  return app;
}

async function seedFlowWithSigner(id, { orgId = 1, token = 'tok-1' } = {}) {
  const data = {
    status: 'in_progress', completed: false, orgId,
    initEmail: 'p1@x.ro', docName: 'Doc ORD test',
    signers: [{ order: 1, name: 'Semnatar', email: 's1@x.ro', rol: 'APROBAT', status: 'current', token }],
  };
  await pool.query(`INSERT INTO flows (id, data, org_id) VALUES ($1,$2::jsonb,$3)`,
    [id, JSON.stringify(data), orgId]);
  return id;
}

async function auditForOrd(ordId, eventType) {
  const { rows } = await pool.query(
    `SELECT * FROM formulare_audit WHERE form_type='ord' AND form_id=$1 AND event_type=$2`,
    [ordId, eventType]);
  return rows;
}

const d = describe.skipIf(!hasTestDb());

d('POST /flows/:flowId/refuse — ORD curăță ord_flow_id + audit (prompt 77)', () => {
  let app, orgId, userId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    ({ orgId, userId } = await seedOrgUser({ role: 'user' }));
    app = buildApp();
  });
  afterAll(() => pool.end());

  it('refuz ORD → ord_flow_id NULL, ord_completed_at NULL, audit flux_refuzat, capabilitatea redevine genereaza_lanseaza_ord', async () => {
    const flowId = await seedFlowWithSigner('flow-ord-1', { orgId });
    const ordId = await seedOrd({ orgId, createdBy: userId, status: 'completed', nrOrd: 'ORD-2026-001' });
    const alopId = await seedAlop({ orgId, createdBy: userId, status: 'ordonantare',
      ordId, ordFlowId: flowId });

    // Pre-refuz: fluxul e activ → capabilitatea e „marcheaza_ord_semnat"
    const before = await getAlop(alopId);
    expect(computeAlopCapabilities(before, { userId, role: 'user', orgId }).phase_action)
      .toBe('marcheaza_ord_semnat');

    const res = await request(app).post(`/flows/${flowId}/refuse`).send({ token: 'tok-1', reason: 'ORD greșit' });
    expect(res.status).toBe(200);
    expect(res.body.refused).toBe(true);

    const a = await getAlop(alopId);
    expect(a.ord_flow_id).toBeNull();
    expect(a.ord_completed_at).toBeNull();
    expect(a.ord_id).toBe(ordId); // ORD-ul rămâne, regenerabil

    // Statusul documentului ORD rămâne neatins (re-lansare curată)
    expect((await getOrd(ordId)).status).toBe('completed');

    const audit = await auditForOrd(ordId, 'flux_refuzat');
    expect(audit.length).toBe(1);

    // Capabilitatea redevine „genereaza_lanseaza_ord"
    expect(computeAlopCapabilities(a, { userId, role: 'user', orgId }).phase_action)
      .toBe('genereaza_lanseaza_ord');
  });
});
