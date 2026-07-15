/**
 * v3.9.498 (Issue R-B) — POST /api/alop/:id/cancel
 * Block cancel când ALOP are DF emis (df_id setat și DF ne-șters).
 *
 * Acoperire:
 *   ✓ ALOP cu df_id setat + DF activ → 409 cancel_blocked_df_exists
 *   ✓ ALOP cu df_id NULL → cancel permis (200)
 *   ✓ ALOP cu df_id setat dar DF deleted_at IS NOT NULL → cancel permis
 *     (DF șters logic, nu mai e "emis")
 *   ✓ ALOP completed → 409 (regression: comportament vechi păstrat)
 *   ✓ Permission check (canDestroyOnly): non-creator/non-admin → 403
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

vi.mock('../../db/index.mjs', () => ({
  pool:             { query: vi.fn() },
  DB_READY:         true,
  requireDb:        vi.fn(() => false),
  saveFlow:         vi.fn().mockResolvedValue(undefined),
  getFlowData:      vi.fn(),
  writeAuditEvent:  vi.fn().mockResolvedValue(undefined),
  getDefaultOrgId:  vi.fn().mockResolvedValue(1),
  getUserMapForOrg: vi.fn().mockResolvedValue({}),
  DB_LAST_ERROR:    null,
}));

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
}));

vi.mock('../../services/authz-formular.mjs', () => ({
  canDestroyOnly: vi.fn((actor, doc) => {
    if (['admin','org_admin'].includes(actor.role)) return { allowed: true, role: 'admin' };
    if (doc.created_by === actor.userId) return { allowed: true, role: 'creator' };
    return { allowed: false, reason: 'forbidden_destroy_creator_only' };
  }),
  canEditFormular: vi.fn().mockResolvedValue({ allowed: true }),
  canEditAlop: vi.fn().mockResolvedValue({ allowed: true }),
  loadActorComp: vi.fn().mockResolvedValue(''),
  loadActorCompAndCab: vi.fn().mockResolvedValue({ actorComp: '', cabComp: '' }),
  isCabDept: vi.fn(() => false),
}));

vi.mock('../../middleware/csrf.mjs', () => ({
  csrfMiddleware: (req, res, next) => next(),
}));

vi.mock('../../middleware/require-module.mjs', () => ({
  requireModule: () => (_req, _res, next) => next(),
}));

import * as dbModule from '../../db/index.mjs';
import alopRouter from '../../routes/alop.mjs';

const ALOP_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const DF_ID   = 'ddddffff-0000-0000-0000-0000000000A1';

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-vitest-docflowai-2025';

function makeAuthCookie(userId = 1, role = 'user', orgId = 1) {
  const payload = { email: 'test@x.ro', role, orgId, userId };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
  return `auth_token=${token}`;
}

function createTestApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use('/', alopRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbModule.pool.query.mockReset();
  dbModule.pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('cancel ALOP cu DF emis → 409', () => {
  it('df_id setat + DF activ (status=draft) → 409 cancel_blocked_df_exists', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1 }], rowCount: 1 })  // SELECT created_by
      .mockResolvedValueOnce({                                              // SELECT df_id JOIN fd
        rows: [{ df_id: DF_ID, nr_unic_inreg: 'DF-2026-001', df_status: 'draft' }],
        rowCount: 1
      });

    const res = await request(createTestApp())
      .post(`/api/alop/${ALOP_ID}/cancel`)
      .set('Cookie', makeAuthCookie());

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cancel_blocked_df_exists');
    expect(res.body.df_id).toBe(DF_ID);
    expect(res.body.df_nr).toBe('DF-2026-001');
    expect(res.body.df_status).toBe('draft');
    // Verificăm că NU s-a încercat UPDATE-ul de cancel
    const updateCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes("status='cancelled'")
    );
    expect(updateCall).toBeUndefined();
  });

  it('df_id setat + DF în transmis_flux → 409', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ df_id: DF_ID, nr_unic_inreg: 'DF-2026-002', df_status: 'transmis_flux' }],
        rowCount: 1
      });

    const res = await request(createTestApp())
      .post(`/api/alop/${ALOP_ID}/cancel`)
      .set('Cookie', makeAuthCookie());

    expect(res.status).toBe(409);
    expect(res.body.df_status).toBe('transmis_flux');
  });
});

describe('cancel ALOP fără DF → 200', () => {
  it('df_id NULL → cancel permis', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ df_id: null, nr_unic_inreg: null, df_status: null }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: ALOP_ID, status: 'cancelled' }], rowCount: 1 });

    const res = await request(createTestApp())
      .post(`/api/alop/${ALOP_ID}/cancel`)
      .set('Cookie', makeAuthCookie());

    expect(res.status).toBe(200);
    expect(res.body.alop.status).toBe('cancelled');
  });

  it('df_id setat dar DF soft-deleted (df_status NULL via LEFT JOIN) → cancel permis', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({                                              // LEFT JOIN găsește DF dar deleted_at filtrează → df_status=NULL
        rows: [{ df_id: DF_ID, nr_unic_inreg: null, df_status: null }],
        rowCount: 1
      })
      .mockResolvedValueOnce({ rows: [{ id: ALOP_ID, status: 'cancelled' }], rowCount: 1 });

    const res = await request(createTestApp())
      .post(`/api/alop/${ALOP_ID}/cancel`)
      .set('Cookie', makeAuthCookie());

    expect(res.status).toBe(200);
  });
});

describe('regressions — comportament vechi păstrat', () => {
  it('ALOP completed → 409 cancel_blocked (regression check)', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ df_id: null, df_status: null }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // UPDATE matches 0 (status='completed')

    const res = await request(createTestApp())
      .post(`/api/alop/${ALOP_ID}/cancel`)
      .set('Cookie', makeAuthCookie());

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cancel_blocked');
  });

  it('non-creator non-admin → 403', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 999 }], rowCount: 1 }); // alt user

    const res = await request(createTestApp())
      .post(`/api/alop/${ALOP_ID}/cancel`)
      .set('Cookie', makeAuthCookie(1, 'user', 1)); // userId=1, role=user

    expect(res.status).toBe(403);
  });
});
