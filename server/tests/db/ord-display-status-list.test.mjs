/**
 * Fix 13/14/15: lista ORD (`GET /api/formulare/list?type=ord`) expune `display_status` derivat.
 * Endpoint-ul REAL al listei din UI — shared.mjs ramura ORD, alias `f` pentru flows.
 * Predicatul de "flux activ" e IDENTIC cu `flow_active` din GET /:id — NULL-safe via
 * `IS DISTINCT FROM` (NU negarea lui `aprobat`, care cădea pe NULL când `data.completed`
 * lipsea, ca pe un flux real în curs).
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

// flux generic cu status/completed/deletedAt arbitrare.
// `completed` nespecificat → cheia e OMISĂ din `data` (ca un flux real în curs, unde
// `data.completed` nu există deloc — capcana NULL care a produs fix 14).
async function seedFlowX(id, { status = 'in_progress', completed, deletedAt = null } = {}) {
  const data = { status, orgId: 1, initEmail: 'p1@x.ro', docName: 'Doc' };
  if (completed !== undefined) data.completed = completed;
  await pool.query(
    `INSERT INTO flows (id, data, org_id, deleted_at) VALUES ($1, $2::jsonb, $3, $4)`,
    [id, JSON.stringify(data), 1, deletedAt]
  );
  return id;
}

function findRow(body, id) { return body.rows.find(d => d.id === id); }

const d = describe.skipIf(!hasTestDb());

d('GET /api/formulare/list?type=ord — display_status derivat (fix 15)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await seedOrgUser({ role: 'user', email: 'p1@x.ro' }); app = buildApp(); });
  afterAll(() => pool.end());
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1, email: 'p1@x.ro' });

  it('ORD completed + flux activ NEfinalizat (data.completed absent, ca un flux real în curs) → display_status=transmis_flux (status brut neschimbat)', async () => {
    const flowId = await seedFlowX('flow-ord-active', { status: 'pending' });
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId });

    const res = await request(app).get('/api/formulare/list?type=ord').set('Cookie', cookie());
    expect(res.status).toBe(200);
    const row = findRow(res.body, ordId);
    expect(row.display_status).toBe('transmis_flux');
    expect(row.status).toBe('completed'); // coloana brută — lifecycle neatins
  });

  it('ORD completed + flux cu data.completed=true (fără status) → display_status=completed (NU transmis_flux)', async () => {
    const flowId = await seedFlowX('flow-ord-completed-flag', { completed: true });
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId });

    const res = await request(app).get('/api/formulare/list?type=ord').set('Cookie', cookie());
    expect(res.status).toBe(200);
    const row = findRow(res.body, ordId);
    expect(row.display_status).toBe('completed');
    expect(row.status).toBe('completed');
  });

  it('ORD completed + flux cu status=cancelled → display_status=completed (NU transmis_flux)', async () => {
    const flowId = await seedFlowX('flow-ord-cancelled', { status: 'cancelled' });
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId });

    const res = await request(app).get('/api/formulare/list?type=ord').set('Cookie', cookie());
    expect(res.status).toBe(200);
    const row = findRow(res.body, ordId);
    expect(row.display_status).toBe('completed');
    expect(row.status).toBe('completed');
  });

  it('ORD completed fără flux → display_status=completed', async () => {
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId: null });

    const res = await request(app).get('/api/formulare/list?type=ord').set('Cookie', cookie());
    expect(res.status).toBe(200);
    const row = findRow(res.body, ordId);
    expect(row.display_status).toBe('completed');
    expect(row.status).toBe('completed');
  });

  it('ORD completed pe flux ȘTERS (soft-delete) → display_status=completed (NU transmis_flux)', async () => {
    const flowId = await seedFlowX('flow-ord-deleted', { status: 'in_progress', completed: false, deletedAt: new Date().toISOString() });
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId });

    const res = await request(app).get('/api/formulare/list?type=ord').set('Cookie', cookie());
    expect(res.status).toBe(200);
    const row = findRow(res.body, ordId);
    expect(row.display_status).toBe('completed');
    expect(row.status).toBe('completed');
  });
});
