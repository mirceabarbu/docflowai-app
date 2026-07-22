/**
 * DocFlowAI — Integration tests: GET /api/formulare/list
 *
 * Acoperire:
 *   DF — filtru comp aplicat:
 *     ✓ SQL conține u1.compartiment=... (NU fd.compartiment_specialitate)
 *   DF — filtru p2 aplicat:
 *     ✓ SQL conține u2.email ILIKE + u2.nume ILIKE
 *   DF — SELECT conține initiator_comp:
 *     ✓ u1.compartiment AS initiator_comp prezent în SQL
 *   ORD — filtru comp aplicat:
 *     ✓ SQL conține u1.compartiment=... (anterior era ignorat)
 *   ORD — filtru p2 aplicat:
 *     ✓ SQL conține u2.email ILIKE + u2.nume ILIKE
 *   ORD — SELECT conține initiator_comp:
 *     ✓ u1.compartiment AS initiator_comp prezent în SQL
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

// ── Mock-uri ESM ──────────────────────────────────────────────────────────────

vi.mock('../../db/index.mjs', () => {
  const mockQuery = vi.fn();
  return {
    pool:          { query: mockQuery },
    DB_READY:      true,
    requireDb:     vi.fn(() => false),
    DB_LAST_ERROR: null,
    writeAuditEvent: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../middleware/logger.mjs', () => ({
  logger: {
    info:  vi.fn(), warn:  vi.fn(), error: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  },
  redactUrl: (u) => u,
}));

vi.mock('../../middleware/csrf.mjs', () => ({
  csrfMiddleware: (_req, _res, next) => next(),
}));

// ── Importuri după mock-uri ───────────────────────────────────────────────────

import * as dbModule from '../../db/index.mjs';
import { formulareDbRouter } from '../../routes/formulare/index.mjs';

// ── App Express minimală ──────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-vitest-docflowai-2025';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(formulareDbRouter);
  return app;
}

const app = makeApp();

// Admin token — sare peste sub-query compartiment user (isAdmin=true)
function makeAdminToken(overrides = {}) {
  return jwt.sign(
    { userId: 99, email: 'superadmin@docflowai.ro', role: 'admin', orgId: null, nume: 'Admin', ...overrides },
    JWT_SECRET, { expiresIn: '2h' }
  );
}

const ADMIN_TOKEN = makeAdminToken();

// Rând fals returnat de DB — include câmpurile noi
const FAKE_ROW = {
  id: 'dddd0001-0000-0000-0000-000000000001',
  status: 'draft',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  nr: 'DF-001',
  titlu: 'Test DF',
  created_by: 1,
  flow_id: null,
  revizie_nr: 0,
  este_revizie: false,
  has_newer_revision: false,
  aprobat: false,
  initiator: 'Ion Popescu',
  initiator_comp: 'Compartiment Buget',
  p2: 'Maria Ionescu',
  updated_by_nume: null,
  isP1: true,
  total: '1',
};

// Helper: capturează SQL + params din primul apel pool.query care primește array
function captureListQuery() {
  let capturedSql = '';
  let capturedParams = [];
  dbModule.pool.query.mockImplementation((sql, params) => {
    capturedSql = sql;
    capturedParams = params || [];
    return Promise.resolve({ rows: [FAKE_ROW] });
  });
  return { getSql: () => capturedSql, getParams: () => capturedParams };
}

describe('GET /api/formulare/list', () => {
  beforeEach(() => {
    dbModule.pool.query.mockReset();
  });

  // ── DF ────────────────────────────────────────────────────────────────────

  describe('DF — filtru comp', () => {
    it('SQL conține u1.compartiment= (NU fd.compartiment_specialitate)', async () => {
      const { getSql, getParams } = captureListQuery();

      await request(app)
        .get('/api/formulare/list?type=df&comp=Buget')
        .set('Cookie', `auth_token=${ADMIN_TOKEN}`)
        .expect(200);

      const sql = getSql();
      expect(sql).toContain('u1.compartiment=');
      expect(sql).not.toContain('fd.compartiment_specialitate');
      // Valoarea filtrului e în params
      expect(getParams()).toContain('Buget');
    });
  });

  describe('DF — filtru p2', () => {
    it('SQL conține u2.email ILIKE și u2.nume ILIKE', async () => {
      const { getSql, getParams } = captureListQuery();

      await request(app)
        .get('/api/formulare/list?type=df&p2=Maria')
        .set('Cookie', `auth_token=${ADMIN_TOKEN}`)
        .expect(200);

      const sql = getSql();
      expect(sql).toContain('u2.email ILIKE');
      expect(sql).toContain('u2.nume ILIKE');
      // Valoarea e trimisă ca %Maria%
      expect(getParams().some(p => typeof p === 'string' && p.includes('Maria'))).toBe(true);
    });
  });

  describe('DF — SELECT include initiator_comp', () => {
    it('SQL conține u1.compartiment AS initiator_comp', async () => {
      const { getSql } = captureListQuery();

      await request(app)
        .get('/api/formulare/list?type=df')
        .set('Cookie', `auth_token=${ADMIN_TOKEN}`)
        .expect(200);

      expect(getSql()).toContain('u1.compartiment AS initiator_comp');
    });

    it('răspunsul include câmpul initiator_comp', async () => {
      dbModule.pool.query.mockResolvedValueOnce({ rows: [FAKE_ROW] });

      const res = await request(app)
        .get('/api/formulare/list?type=df')
        .set('Cookie', `auth_token=${ADMIN_TOKEN}`)
        .expect(200);

      expect(res.body.rows[0]).toHaveProperty('initiator_comp', 'Compartiment Buget');
    });
  });

  // ── ORD ───────────────────────────────────────────────────────────────────

  describe('ORD — filtru comp', () => {
    it('SQL conține u1.compartiment= (anterior era ignorat)', async () => {
      const { getSql, getParams } = captureListQuery();

      await request(app)
        .get('/api/formulare/list?type=ord&comp=Financiar')
        .set('Cookie', `auth_token=${ADMIN_TOKEN}`)
        .expect(200);

      const sql = getSql();
      expect(sql).toContain('u1.compartiment=');
      expect(getParams()).toContain('Financiar');
    });
  });

  describe('ORD — filtru p2', () => {
    it('SQL conține u2.email ILIKE și u2.nume ILIKE', async () => {
      const { getSql, getParams } = captureListQuery();

      await request(app)
        .get('/api/formulare/list?type=ord&p2=test')
        .set('Cookie', `auth_token=${ADMIN_TOKEN}`)
        .expect(200);

      const sql = getSql();
      expect(sql).toContain('u2.email ILIKE');
      expect(sql).toContain('u2.nume ILIKE');
      expect(getParams().some(p => typeof p === 'string' && p.includes('test'))).toBe(true);
    });
  });

  describe('ORD — SELECT include initiator_comp', () => {
    it('SQL conține u1.compartiment AS initiator_comp', async () => {
      const { getSql } = captureListQuery();

      await request(app)
        .get('/api/formulare/list?type=ord')
        .set('Cookie', `auth_token=${ADMIN_TOKEN}`)
        .expect(200);

      expect(getSql()).toContain('u1.compartiment AS initiator_comp');
    });
  });

  // ── Filtru Nr. ────────────────────────────────────────────────────────────

  describe('DF — filtru nr', () => {
    it('SQL conține fd.nr_unic_inreg ILIKE cu valoarea wrap-ată în %...%', async () => {
      const { getSql, getParams } = captureListQuery();

      await request(app)
        .get('/api/formulare/list?type=df&nr=12')
        .set('Cookie', `auth_token=${ADMIN_TOKEN}`)
        .expect(200);

      expect(getSql()).toContain('fd.nr_unic_inreg ILIKE');
      expect(getParams().some(p => typeof p === 'string' && p === '%12%')).toBe(true);
    });

    it('nr combinat cu status — ambele condiții prezente în SQL', async () => {
      const { getSql, getParams } = captureListQuery();

      await request(app)
        .get('/api/formulare/list?type=df&nr=ABC&status=draft')
        .set('Cookie', `auth_token=${ADMIN_TOKEN}`)
        .expect(200);

      const sql = getSql();
      expect(sql).toContain('fd.nr_unic_inreg ILIKE');
      expect(sql).toContain("fd.status=");
      expect(getParams()).toContain('draft');
      expect(getParams().some(p => p === '%ABC%')).toBe(true);
    });
  });

  describe('ORD — filtru nr', () => {
    it('SQL conține fo.nr_ordonant_pl ILIKE cu valoarea wrap-ată în %...%', async () => {
      const { getSql, getParams } = captureListQuery();

      await request(app)
        .get('/api/formulare/list?type=ord&nr=ABC')
        .set('Cookie', `auth_token=${ADMIN_TOKEN}`)
        .expect(200);

      expect(getSql()).toContain('fo.nr_ordonant_pl ILIKE');
      expect(getParams().some(p => typeof p === 'string' && p === '%ABC%')).toBe(true);
    });
  });
});

// ── #105d — contract org-scope (platform-admin vs. org-scoped) ────────────────
function tok105d(role, orgId, userId = 77) {
  return jwt.sign({ userId, email: `${role}@x.ro`, role, orgId, nume: role }, JWT_SECRET, { expiresIn: '2h' });
}

describe('#105d — org-scope /api/formulare/list (shared)', () => {
  beforeEach(() => { dbModule.pool.query.mockReset(); });

  it('platform-admin (admin fără org_id) → fără scopare org (vede tot)', async () => {
    const { getSql } = captureListQuery();
    await request(app).get('/api/formulare/list?type=df')
      .set('Cookie', `auth_token=${tok105d('admin', null, 99)}`).expect(200);
    expect(getSql()).not.toContain('fd.org_id=$');
  });

  it('admin CU org_id → scopat pe org, DAR fără filtru de compartiment (vede tot org-ul)', async () => {
    const { getSql, getParams } = captureListQuery();
    await request(app).get('/api/formulare/list?type=df')
      .set('Cookie', `auth_token=${tok105d('admin', 1, 5)}`).expect(200);
    expect(getSql()).toContain('fd.org_id=$1');
    expect(getParams()).toContain(1);
    expect(getSql()).not.toContain('TRIM(uc.compartiment)');
  });

  it('org_admin → scopat pe org, fără compartiment', async () => {
    const { getSql, getParams } = captureListQuery();
    await request(app).get('/api/formulare/list?type=df')
      .set('Cookie', `auth_token=${tok105d('org_admin', 2, 6)}`).expect(200);
    expect(getSql()).toContain('fd.org_id=$1');
    expect(getParams()).toContain(2);
    expect(getSql()).not.toContain('TRIM(uc.compartiment)');
  });

  it('user obișnuit → scopat pe org (non-manager)', async () => {
    const { getSql, getParams } = captureListQuery();
    await request(app).get('/api/formulare/list?type=df')
      .set('Cookie', `auth_token=${tok105d('user', 2, 7)}`).expect(200);
    expect(getSql()).toContain('fd.org_id=$1');
    expect(getParams()).toContain(2);
  });
});

describe('#105d — org-scope /api/formulare-df (listă paralelă)', () => {
  beforeEach(() => { dbModule.pool.query.mockReset(); });

  it('platform-admin → orgFilter gol (fără fd.org_id = $1)', async () => {
    const { getSql } = captureListQuery();
    await request(app).get('/api/formulare-df')
      .set('Cookie', `auth_token=${tok105d('admin', null, 99)}`).expect(200);
    expect(getSql()).not.toContain('fd.org_id = $1');
  });

  it('admin CU org_id → scopat pe org (ca org_admin)', async () => {
    const { getSql, getParams } = captureListQuery();
    await request(app).get('/api/formulare-df')
      .set('Cookie', `auth_token=${tok105d('admin', 1, 5)}`).expect(200);
    expect(getSql()).toContain('fd.org_id = $1');
    expect(getParams()).toContain(1);
  });

  it('user obișnuit → ramura compartiment (u_p1.compartiment prezent)', async () => {
    const { getSql } = captureListQuery();
    await request(app).get('/api/formulare-df')
      .set('Cookie', `auth_token=${tok105d('user', 2, 7)}`).expect(200);
    expect(getSql()).toContain('u_p1.compartiment');
  });
});
