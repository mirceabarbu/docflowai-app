/**
 * DocFlowAI — Integration tests: Admin, Analytics, Audit (v4)
 *
 * Acoperire:
 *   ✓ GET  /api/admin/organizations → lista orgs
 *   ✓ PATCH /api/admin/organizations/:id → update compartimente
 *   ✓ GET  /api/analytics/summary → structura corectă
 *   ✓ GET  /api/audit/flows/:id → audit events pentru flow
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request      from 'supertest';
import express      from 'express';
import cookieParser from 'cookie-parser';
import jwt          from 'jsonwebtoken';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../db/index.mjs', () => ({
  pool: { query: vi.fn() },
}));

vi.mock('../../db/queries/audit.mjs', () => ({
  logAuditEvent:           vi.fn().mockResolvedValue(undefined),
  listAuditEventsForOrg:   vi.fn().mockResolvedValue({ items: [], meta: {} }),
  listAuditEventsForFlow:  vi.fn().mockResolvedValue([]),
}));

vi.mock('../../middleware/logger.mjs', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  },
  requestLogger: (_req, _res, next) => next(),
}));

// Mock notification service so user creation doesn't hit real email
vi.mock('../../modules/notifications/service.mjs', () => ({
  notify: vi.fn().mockResolvedValue(undefined),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { pool }          from '../../db/index.mjs';
import adminOrgsRouter   from '../../modules/admin/organizations.mjs';
import analyticsRouter   from '../../modules/analytics/routes.mjs';
import auditRouter       from '../../modules/audit/routes.mjs';
import { errorHandler }  from '../../middleware/errorHandler.mjs';

// ── Constants ─────────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET;
const ORG_ID     = 10;
const USER_ID    = 1;

function makeToken(overrides = {}) {
  return jwt.sign(
    {
      sub: USER_ID, email: 'admin@test.com', org_id: ORG_ID,
      role: 'admin', name: 'Super Admin', ver: 1, tv: 1,
      ...overrides,
    },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/admin/organizations', adminOrgsRouter);
  app.use('/api/analytics',           analyticsRouter);
  app.use('/api/audit',               auditRouter);
  app.use(errorHandler);
  return app;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => { vi.clearAllMocks(); });

// ── Admin: Organizations ──────────────────────────────────────────────────────

describe('GET /api/admin/organizations', () => {
  it('returns organization list for superadmin', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: 1, name: 'Primăria Iași', slug: 'prim-iasi', status: 'active', plan: 'pro' },
        { id: 2, name: 'Primăria Cluj', slug: 'prim-cluj', status: 'active', plan: 'starter' },
      ],
    });

    const res = await request(createApp())
      .get('/api/admin/organizations')
      .set('Cookie', `dfai_token=${makeToken({ role: 'admin' })}`);

    expect(res.status).toBe(200);
    expect(res.body.organizations).toHaveLength(2);
    expect(res.body.organizations[0].name).toBe('Primăria Iași');
  });

  it('returns 403 for non-admin user', async () => {
    const res = await request(createApp())
      .get('/api/admin/organizations')
      .set('Cookie', `dfai_token=${makeToken({ role: 'user' })}`);

    expect(res.status).toBe(403);
  });

  it('returns 401 without auth', async () => {
    const res = await request(createApp()).get('/api/admin/organizations');
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/admin/organizations/:id', () => {
  it('updates compartimente for org', async () => {
    const updated = {
      id: ORG_ID, name: 'Primăria X', slug: 'prim-x', status: 'active',
      plan: 'pro', compartimente: ['Juridic', 'Financiar', 'IT'],
    };
    pool.query.mockResolvedValueOnce({ rows: [updated] });

    const res = await request(createApp())
      .patch(`/api/admin/organizations/${ORG_ID}`)
      .set('Cookie', `dfai_token=${makeToken({ role: 'admin' })}`);

    expect(res.status).toBe(200);
    expect(res.body.organization.compartimente).toEqual(['Juridic', 'Financiar', 'IT']);
  });

  it('org_admin can update own org', async () => {
    const updated = { id: ORG_ID, name: 'Primăria Y', compartimente: [] };
    pool.query.mockResolvedValueOnce({ rows: [updated] });

    const res = await request(createApp())
      .patch(`/api/admin/organizations/${ORG_ID}`)
      .set('Cookie', `dfai_token=${makeToken({ role: 'org_admin', org_id: ORG_ID })}`);

    expect(res.status).toBe(200);
  });

  it('org_admin cannot update another org', async () => {
    const res = await request(createApp())
      .patch('/api/admin/organizations/999')
      .set('Cookie', `dfai_token=${makeToken({ role: 'org_admin', org_id: ORG_ID })}`);

    expect(res.status).toBe(403);
  });

  it('returns 404 when org not found', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(createApp())
      .patch(`/api/admin/organizations/${ORG_ID}`)
      .set('Cookie', `dfai_token=${makeToken({ role: 'admin' })}`);

    expect(res.status).toBe(404);
  });
});

// ── Analytics ─────────────────────────────────────────────────────────────────

describe('GET /api/analytics/summary', () => {
  it('returns correct summary structure', async () => {
    // 1. flows aggregate query
    pool.query.mockResolvedValueOnce({
      rows: [{
        total: '42', completed: '30', refused: '5',
        cancelled: '3', in_progress: '3', draft: '1',
        avg_completion_hours: '2.5',
      }],
    });
    // 2. signing aggregate
    pool.query.mockResolvedValueOnce({
      rows: [
        { provider_code: 'sts-cloud', total: '20', completed: '18', failed: '2' },
        { provider_code: 'local-upload', total: '10', completed: '9', failed: '1' },
      ],
    });
    // 3. forms aggregate
    pool.query.mockResolvedValueOnce({
      rows: [{ code: 'ALOP-2024', name: 'ALOP', count: '5' }],
    });
    // 4. users aggregate
    pool.query.mockResolvedValueOnce({
      rows: [{ total: '15', active: '13' }],
    });
    // 5. recent_activity
    pool.query.mockResolvedValueOnce({
      rows: [
        { date: '2024-01-01', flows_created: '3', flows_completed: '2' },
        { date: '2024-01-02', flows_created: '1', flows_completed: '1' },
      ],
    });

    const res = await request(createApp())
      .get('/api/analytics/summary')
      .set('Cookie', `dfai_token=${makeToken({ role: 'admin' })}`);

    expect(res.status).toBe(200);

    // Validate top-level keys
    expect(res.body).toHaveProperty('flows');
    expect(res.body).toHaveProperty('signing');
    expect(res.body).toHaveProperty('forms');
    expect(res.body).toHaveProperty('users');
    expect(res.body).toHaveProperty('recent_activity');

    // Validate flows
    expect(res.body.flows.total).toBe(42);
    expect(res.body.flows.completed).toBe(30);

    // Validate signing
    expect(res.body.signing.total).toBe(30);
    expect(res.body.signing.by_provider['sts-cloud']).toBe(20);
    expect(res.body.signing.success_rate).toBeTypeOf('number');

    // Validate forms
    expect(res.body.forms.by_template).toHaveLength(1);
    expect(res.body.forms.by_template[0].code).toBe('ALOP-2024');

    // Validate users
    expect(res.body.users.total).toBe(15);
    expect(res.body.users.active).toBe(13);

    // Validate recent activity
    expect(res.body.recent_activity).toHaveLength(2);
    expect(res.body.recent_activity[0].date).toBe('2024-01-01');

    // Validate avg_completion_hours
    expect(res.body.avg_completion_hours).toBe(2.5);
  });

  it('returns 403 for non-admin', async () => {
    const res = await request(createApp())
      .get('/api/analytics/summary')
      .set('Cookie', `dfai_token=${makeToken({ role: 'user' })}`);

    expect(res.status).toBe(403);
  });
});

// ── Audit ─────────────────────────────────────────────────────────────────────

describe('GET /api/audit/flows/:flow_id', () => {
  it('returns audit events for a flow in same org', async () => {
    // 1. Flow ownership check
    pool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] });
    // 2. Audit events query
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: 1, flow_id: 'flow-abc', event_type: 'flow.created',  ok: true, created_at: new Date('2024-01-01') },
        { id: 2, flow_id: 'flow-abc', event_type: 'flow.completed', ok: true, created_at: new Date('2024-01-02') },
      ],
    });

    const res = await request(createApp())
      .get('/api/audit/flows/flow-abc')
      .set('Cookie', `dfai_token=${makeToken({ role: 'admin' })}`);

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(2);
    expect(res.body.events[0].event_type).toBe('flow.created');
  });

  it('returns 404 when flow does not exist', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });  // flow not found

    const res = await request(createApp())
      .get('/api/audit/flows/no-such-flow')
      .set('Cookie', `dfai_token=${makeToken({ role: 'admin' })}`);

    expect(res.status).toBe(404);
  });

  it('returns 403 when flow belongs to different org', async () => {
    // Flow belongs to org 999, user is in org 10
    pool.query.mockResolvedValueOnce({ rows: [{ org_id: 999 }] });

    const res = await request(createApp())
      .get('/api/audit/flows/flow-other-org')
      .set('Cookie', `dfai_token=${makeToken({ role: 'org_admin', org_id: ORG_ID })}`);

    expect(res.status).toBe(403);
  });

  it('returns 401 without auth', async () => {
    const res = await request(createApp()).get('/api/audit/flows/flow-abc');
    expect(res.status).toBe(401);
  });
});
