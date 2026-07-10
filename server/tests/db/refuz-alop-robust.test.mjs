/**
 * Prompt 74 (B2): refuz flux → DF „neaprobat" + ALOP actualizat ROBUST prin df_flow_id.
 *
 * Root cause: handler-ul vechi rezolva DF-ul EXCLUSIV prin formulare_df.flow_id +
 * status='transmis_flux'. Pentru DF-uri lansate pe calea ALOP (split-path:
 * status='completed', fd.flow_id NULL), condiția nu prindea → ALOP rămânea „Pe flux".
 * Fix: rezolvare prin fd.flow_id=$1 SAU alop.df_flow_id=$1. Acoperă:
 *  (1) R0 split-path (DF completed, fd.flow_id NULL, ALOP df_flow_id=flow) → neaprobat,
 *      df_flow_id NULL, df_id PĂSTRAT, audit 'neaprobat' scris.
 *  (2) R0 normal (DF transmis_flux, fd.flow_id=flow) → identic.
 *  (3) R1 cu parent aprobat → ALOP restore la parent (df_id=parent, df_flow_id=parent.flow_id).
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedAlop, getAlop, getDf } from '../helpers/db-real.mjs';

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

// Flux cu un singur semnatar 'current' cu token cunoscut.
async function seedFlowWithSigner(id, { orgId = 1, token = 'tok-1' } = {}) {
  const data = {
    status: 'in_progress', completed: false, orgId,
    initEmail: 'p1@x.ro', docName: 'Doc test',
    signers: [{ order: 1, name: 'Semnatar', email: 's1@x.ro', rol: 'APROBAT', status: 'current', token }],
  };
  await pool.query(`INSERT INTO flows (id, data, org_id) VALUES ($1,$2::jsonb,$3)`,
    [id, JSON.stringify(data), orgId]);
  return id;
}

async function auditFor(dfId, eventType) {
  const { rows } = await pool.query(
    `SELECT * FROM formulare_audit WHERE form_type='df' AND form_id=$1 AND event_type=$2`,
    [dfId, eventType]);
  return rows;
}

const d = describe.skipIf(!hasTestDb());

d('POST /flows/:flowId/refuse — DF neaprobat + ALOP robust prin df_flow_id (prompt 74, B2)', () => {
  let app, orgId, userId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    ({ orgId, userId } = await seedOrgUser({ role: 'user' }));
    app = buildApp();
  });
  afterAll(() => pool.end());

  it('(1) R0 split-path (DF completed, fd.flow_id NULL) → neaprobat, df_flow_id NULL, df_id păstrat, audit', async () => {
    const flowId = await seedFlowWithSigner('flow-split-1', { orgId });
    // split-path: DF completed, FĂRĂ flow_id
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'completed', flowId: null });
    const alopId = await seedAlop({ orgId, createdBy: userId, status: 'lichidare',
      dfId, dfFlowId: flowId, dfCompletedAt: new Date().toISOString() });

    const res = await request(app).post(`/flows/${flowId}/refuse`).send({ token: 'tok-1', reason: 'nu e bine' });
    expect(res.status).toBe(200);
    expect(res.body.refused).toBe(true);

    expect((await getDf(dfId)).status).toBe('neaprobat');
    const a = await getAlop(alopId);
    expect(a.df_flow_id).toBeNull();
    expect(a.df_completed_at).toBeNull();
    expect(a.df_id).toBe(dfId); // PĂSTRAT (B2)

    const audit = await auditFor(dfId, 'neaprobat');
    expect(audit.length).toBe(1);
    expect(audit[0].to_status).toBe('neaprobat');
    expect(audit[0].from_status).toBe('completed');
  });

  it('(2) R0 normal (DF transmis_flux, fd.flow_id=flow) → neaprobat, df_id păstrat, flux curățat', async () => {
    const flowId = await seedFlowWithSigner('flow-norm-1', { orgId });
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'transmis_flux', flowId });
    const alopId = await seedAlop({ orgId, createdBy: userId, status: 'lichidare',
      dfId, dfFlowId: flowId, dfCompletedAt: new Date().toISOString() });

    const res = await request(app).post(`/flows/${flowId}/refuse`).send({ token: 'tok-1', reason: 'greșit' });
    expect(res.status).toBe(200);

    expect((await getDf(dfId)).status).toBe('neaprobat');
    const a = await getAlop(alopId);
    expect(a.df_flow_id).toBeNull();
    expect(a.df_id).toBe(dfId);
    expect((await auditFor(dfId, 'neaprobat')).length).toBe(1);
  });

  it('(3) R1 cu parent aprobat → ALOP restore la parent (df_id=parent, df_flow_id=parent.flow_id)', async () => {
    const parentFlowId = await seedFlowWithSigner('flow-parent-3', { orgId, token: 'tok-p' });
    const childFlowId = await seedFlowWithSigner('flow-child-3', { orgId, token: 'tok-1' });
    const parentId = await seedDf({ orgId, createdBy: userId, status: 'aprobat', flowId: parentFlowId, nrUnic: 'DF-2026-003' });
    const childId = await seedDf({ orgId, createdBy: userId, status: 'transmis_flux', flowId: childFlowId,
      nrUnic: 'DF-2026-003', revizieNr: 1, parentDfId: parentId });
    const alopId = await seedAlop({ orgId, createdBy: userId, status: 'lichidare',
      dfId: childId, dfFlowId: childFlowId, dfCompletedAt: new Date().toISOString() });

    const res = await request(app).post(`/flows/${childFlowId}/refuse`).send({ token: 'tok-1', reason: 'revizie greșită' });
    expect(res.status).toBe(200);

    expect((await getDf(childId)).status).toBe('neaprobat');
    const a = await getAlop(alopId);
    expect(a.df_id).toBe(parentId);
    expect(a.df_flow_id).toBe(parentFlowId);
    expect(a.df_completed_at).not.toBeNull();
  });
});
