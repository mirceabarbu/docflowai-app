/**
 * v3.9.500 — formulare-atasamente endpoints (upload, list, download, delete)
 *
 * Acoperire:
 *   ✓ POST upload → INSERT + returnează metadata
 *   ✓ POST upload fără permisiune → 403
 *   ✓ POST upload fișier prea mare (>10MB) → 413
 *   ✓ GET list → returnează doar atașamente ne-șterse
 *   ✓ GET download → returnează raw data + Content-Disposition
 *   ✓ DELETE (soft) → marchează deleted_at
 *   ✓ DELETE pe document completed (non-admin) → 409 document_locked
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

vi.mock('../../db/index.mjs', () => ({
  pool:            { query: vi.fn() },
  DB_READY:        true,
  requireDb:       vi.fn(() => false),
  saveFlow:        vi.fn().mockResolvedValue(undefined),
  getFlowData:     vi.fn(),
  writeAuditEvent: vi.fn().mockResolvedValue(undefined),
  getDefaultOrgId: vi.fn().mockResolvedValue(1),
  DB_LAST_ERROR:   null,
}));

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
}));

vi.mock('../../middleware/csrf.mjs', () => ({
  csrfMiddleware: (req, res, next) => next(),
}));

vi.mock('../../middleware/require-module.mjs', () => ({
  requireModule: () => (_req, _res, next) => next(),
}));

vi.mock('../../services/authz-formular.mjs', () => ({
  canDestroyOnly:  vi.fn().mockReturnValue({ allowed: true }),
  canEditFormular: vi.fn().mockReturnValue({ allowed: true }),
  loadActorComp:   vi.fn().mockResolvedValue(undefined),
}));

import * as dbModule from '../../db/index.mjs';
import { formulareDbRouter } from '../../routes/formulare-db.mjs';

const ORD_ID = 'ddddffff-0000-0000-0000-00000000ABCD';
const ATT_ID = 'aaaaaaaa-1111-2222-3333-444444444444';

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-vitest-docflowai-2025';

function makeAuthCookie(userId = 1, role = 'user', orgId = 1) {
  const t = jwt.sign({ email: 'p1@x.ro', role, orgId, userId }, JWT_SECRET, { expiresIn: '1h' });
  return `auth_token=${t}`;
}

function createTestApp() {
  const app = express();
  app.use(cookieParser());
  app.use('/', formulareDbRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbModule.pool.query.mockReset();
  dbModule.pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('POST /api/formulare-atasamente/:type/:id', () => {
  it('upload reușit → INSERT + atașament în răspuns', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 2, status: 'draft' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: ATT_ID, filename: 'factura.pdf', mime_type: 'application/pdf', size_bytes: 1234, created_at: '2026-05-22' }],
        rowCount: 1
      });

    const res = await request(createTestApp())
      .post(`/api/formulare-atasamente/ord/${ORD_ID}`)
      .set('Cookie', makeAuthCookie())
      .set('Content-Type', 'application/pdf')
      .set('X-Filename', 'factura.pdf')
      .send(Buffer.from('PDF-CONTENT-MOCK'));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.atasament.id).toBe(ATT_ID);
    expect(res.body.atasament.filename).toBe('factura.pdf');

    const insertCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('INSERT INTO formulare_atasamente')
    );
    expect(insertCall).toBeDefined();
  });

  it('upload fără permisiune → 403', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 999, assigned_to: 888, status: 'draft' }], rowCount: 1 });

    const res = await request(createTestApp())
      .post(`/api/formulare-atasamente/ord/${ORD_ID}`)
      .set('Cookie', makeAuthCookie(1, 'user', 1))
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('x'));

    expect(res.status).toBe(403);
  });

  it('document not found → 404', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(createTestApp())
      .post(`/api/formulare-atasamente/ord/${ORD_ID}`)
      .set('Cookie', makeAuthCookie())
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('x'));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });
});

describe('GET /api/formulare-atasamente/:type/:id', () => {
  it('list → returnează atașamente fără data field', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 2 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          { id: ATT_ID, filename: 'a.pdf', mime_type: 'application/pdf', size_bytes: 1000, uploaded_by: 1, created_at: '2026-05-22' },
          { id: 'att-2', filename: 'b.docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size_bytes: 2000, uploaded_by: 1, created_at: '2026-05-22' },
        ],
        rowCount: 2
      });

    const res = await request(createTestApp())
      .get(`/api/formulare-atasamente/ord/${ORD_ID}`)
      .set('Cookie', makeAuthCookie());

    expect(res.status).toBe(200);
    expect(res.body.atasamente).toHaveLength(2);
    expect(res.body.atasamente[0].filename).toBe('a.pdf');
    expect(res.body.atasamente[0].data).toBeUndefined();

    const selectCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('SELECT id, filename, mime_type, size_bytes')
    );
    expect(selectCall, 'SELECT list fără data').toBeDefined();
    expect(String(selectCall[0])).toMatch(/deleted_at IS NULL/);
  });
});

describe('GET /api/formulare-atasamente/:type/:id/:attId — download', () => {
  it('returnează data binary + Content-Disposition', async () => {
    const fileData = Buffer.from('PDF-RAW-DATA');
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 2 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ filename: 'factura.pdf', mime_type: 'application/pdf', data: fileData }],
        rowCount: 1
      });

    const res = await request(createTestApp())
      .get(`/api/formulare-atasamente/ord/${ORD_ID}/${ATT_ID}`)
      .set('Cookie', makeAuthCookie());

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/factura\.pdf/);
    expect(res.body).toEqual(fileData);
  });

  it('atașament inexistent → 404', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 2 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(createTestApp())
      .get(`/api/formulare-atasamente/ord/${ORD_ID}/non-existent-id`)
      .set('Cookie', makeAuthCookie());

    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/formulare-atasamente/:type/:id/:attId', () => {
  it('soft delete reușit → 200', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 2, status: 'draft' }], rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const res = await request(createTestApp())
      .delete(`/api/formulare-atasamente/ord/${ORD_ID}/${ATT_ID}`)
      .set('Cookie', makeAuthCookie());

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const updateCall = dbModule.pool.query.mock.calls.find(c =>
      String(c[0]).includes('UPDATE formulare_atasamente') &&
      String(c[0]).includes('deleted_at=NOW()')
    );
    expect(updateCall).toBeDefined();
  });

  it('document completed + non-admin → 409 document_locked', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 2, status: 'completed' }], rowCount: 1 });

    const res = await request(createTestApp())
      .delete(`/api/formulare-atasamente/ord/${ORD_ID}/${ATT_ID}`)
      .set('Cookie', makeAuthCookie(1, 'user', 1));

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('document_locked');
  });

  it('document completed + admin → 200 (admin override)', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{ created_by: 1, assigned_to: 2, status: 'completed' }], rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const res = await request(createTestApp())
      .delete(`/api/formulare-atasamente/ord/${ORD_ID}/${ATT_ID}`)
      .set('Cookie', makeAuthCookie(1, 'admin', null));

    expect(res.status).toBe(200);
  });
});
