/**
 * Fix 13 (caracterizare): lista ORD (`GET /api/formulare-ord`) expune un `display_status`
 * derivat, READ-ONLY — asimetria DF↔ORD (ORD rămâne `completed` la trimiterea pe flux,
 * `linkFlowSetsStatus: null`) face ca o ORD pe flux activ nefinalizat să arate „Trimis flux"
 * în UI, fără să schimbe coloana `status` brută sau vreo tranziție de lifecycle.
 *
 * Predicatul de "flux finalizat" e EXACT negarea celui din GET /:id (`aprobat`), refolosit
 * pentru consistență.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedOrd, makeAuthCookie } from '../helpers/db-real.mjs';

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

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '50mb' }));
  app.use(cookieParser());
  app.use('/', formulareDbRouter);
  return app;
}

// flux generic cu status/completed/deletedAt arbitrare (oglindește seedFlowD din
// soft-delete-flow-pointer.test.mjs — testul ăsta are nevoie de control fin pe deleted_at).
async function seedFlowX(id, { status = 'in_progress', completed = false, deletedAt = null } = {}) {
  await pool.query(
    `INSERT INTO flows (id, data, org_id, deleted_at) VALUES ($1, $2::jsonb, $3, $4)`,
    [id, JSON.stringify({ status, completed, orgId: 1, initEmail: 'p1@x.ro', docName: 'Doc' }), 1, deletedAt]
  );
  return id;
}

function findRow(body, id) { return body.documents.find(d => d.id === id); }

const d = describe.skipIf(!hasTestDb());

d('GET /api/formulare-ord — display_status derivat (fix 13)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await seedOrgUser({ role: 'user', email: 'p1@x.ro' }); app = buildApp(); });
  afterAll(() => pool.end());
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1, email: 'p1@x.ro' });

  it('ORD completed + flux activ NEfinalizat → display_status=transmis_flux (status brut neschimbat)', async () => {
    const flowId = await seedFlowX('flow-ord-active', { status: 'in_progress', completed: false });
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId });

    const res = await request(app).get('/api/formulare-ord').set('Cookie', cookie());
    expect(res.status).toBe(200);
    const row = findRow(res.body, ordId);
    expect(row.display_status).toBe('transmis_flux');
    expect(row.status).toBe('completed'); // coloana brută — lifecycle neatins
  });

  it('ORD aprobat (flux finalizat) → display_status=aprobat', async () => {
    const flowId = await seedFlowX('flow-ord-done', { status: 'completed', completed: true });
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'aprobat', flowId });

    const res = await request(app).get('/api/formulare-ord').set('Cookie', cookie());
    expect(res.status).toBe(200);
    const row = findRow(res.body, ordId);
    expect(row.display_status).toBe('aprobat');
    expect(row.status).toBe('aprobat');
  });

  it('ORD completed fără flux → display_status=completed', async () => {
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId: null });

    const res = await request(app).get('/api/formulare-ord').set('Cookie', cookie());
    expect(res.status).toBe(200);
    const row = findRow(res.body, ordId);
    expect(row.display_status).toBe('completed');
    expect(row.status).toBe('completed');
  });

  it('ORD completed pe flux ȘTERS (soft-delete) → display_status=completed (NU transmis_flux)', async () => {
    const flowId = await seedFlowX('flow-ord-deleted', { status: 'in_progress', completed: false, deletedAt: new Date().toISOString() });
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId });

    const res = await request(app).get('/api/formulare-ord').set('Cookie', cookie());
    expect(res.status).toBe(200);
    const row = findRow(res.body, ordId);
    expect(row.display_status).toBe('completed');
    expect(row.status).toBe('completed');
  });
});
