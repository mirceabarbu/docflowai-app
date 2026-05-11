/**
 * Integration tests — POST /api/opme/import (pachet A).
 *
 * Acoperire:
 *   ✓ 401 fără auth
 *   ✓ 403 fără rol P2/admin
 *   ✓ 403 CSRF lipsă
 *   ✓ 201 upload PDF F1129 valid → lines_count=45 + INSERT-uri executate
 *   ✓ 409 re-upload același fișier (idempotent prin file_hash)
 *   ✓ 400 PDF non-XFA (creat ad-hoc cu pdf-lib)
 *   ✓ 413 fișier > 5 MB
 *   ✓ Tenant isolation: două org diferite cu același file_hash → ambele intră
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';

const TEST_JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-vitest-docflowai-2025';

// ── Mock pool (query + connect pentru tranzacții) ────────────────────────────
const mockClientQuery   = vi.fn();
const mockClientRelease = vi.fn();
const mockClient = { query: mockClientQuery, release: mockClientRelease };

vi.mock('../../db/index.mjs', () => {
  const mockQuery   = vi.fn();
  const mockConnect = vi.fn();
  return { pool: { query: mockQuery, connect: mockConnect } };
});

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
}));

import * as dbModule from '../../db/index.mjs';
import opmeRouter   from '../../routes/opme.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, '../fixtures/f1129_sample.pdf');

const CSRF = 'csrf-test-token';

function makeToken(overrides = {}) {
  return jwt.sign(
    { userId: 1, email: 'p2@primaria.ro', role: 'admin', orgId: 1, ...overrides },
    TEST_JWT_SECRET, { expiresIn: '2h' }
  );
}
function authCookie(token) { return `auth_token=${token}; csrf_token=${CSRF}`; }

function makeApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(cookieParser());
  app.use((req, _res, next) => { req.requestId = 'test-req'; next(); });
  app.use('/', opmeRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  dbModule.pool.connect.mockResolvedValue(mockClient);
  dbModule.pool.query.mockResolvedValue({ rows: [] });
  mockClientQuery.mockReset();
  mockClientRelease.mockReset();
});

// Helper: setup mock pool pentru happy path (no duplicate, INSERT returnează id).
function setupSuccessMocks(importId = 'imp-uuid-1') {
  // Pasul 1: SELECT duplicate check (din pool.query) → empty
  dbModule.pool.query.mockResolvedValueOnce({ rows: [] });
  // Pasul 2..5: tranzacția pe client
  mockClientQuery
    .mockResolvedValueOnce({ rows: [] })                                   // BEGIN
    .mockResolvedValueOnce({ rows: [{ id: importId, created_at: new Date() }] }) // INSERT opme_imports RETURNING
    .mockResolvedValueOnce({ rows: [] })                                   // INSERT opme_lines (UNNEST)
    .mockResolvedValueOnce({ rows: [] });                                  // COMMIT
}

describe('POST /api/opme/import — auth & CSRF', () => {
  it('401 fără auth_token (cu CSRF valid)', async () => {
    // requireAuth respinge înainte să citim body-ul; nu atașăm fișier
    // (altfel supertest e gata să streameze MB-uri de multipart înainte
    // ca Express să trimită 401, ceea ce produce ECONNABORTED pe socket).
    const r = await request(makeApp())
      .post('/api/opme/import')
      .set('Cookie', `csrf_token=${CSRF}`)
      .set('X-CSRF-Token', CSRF)
      .set('Content-Type', 'multipart/form-data; boundary=----xtest')
      .send('------xtest--\r\n');
    expect(r.status).toBe(401);
  });

  it('403 dacă userul nu e asignat ca responsabil_cab', async () => {
    // pool.query default returns empty rows → gating query returns false
    const tok = makeToken({ role: 'user' });
    const r = await request(makeApp())
      .post('/api/opme/import')
      .set('Cookie', authCookie(tok))
      .set('X-CSRF-Token', CSRF)
      .set('Content-Type', 'multipart/form-data; boundary=----xtest')
      .send('------xtest--\r\n');
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('forbidden');
  });

  it('403 csrf lipsă (header X-CSRF-Token absent)', async () => {
    const tok = makeToken();
    const r = await request(makeApp())
      .post('/api/opme/import')
      .set('Cookie', authCookie(tok))
      .set('Content-Type', 'multipart/form-data; boundary=----xtest')
      .send('------xtest--\r\n');
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('csrf_invalid');
  });

  it('admite responsabil_cab asignat în alop_sabloane', async () => {
    // Gating query returns a row → allowed
    dbModule.pool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    setupSuccessMocks();
    const tok = makeToken({ role: 'user' });
    const r = await request(makeApp())
      .post('/api/opme/import')
      .set('Cookie', authCookie(tok))
      .set('X-CSRF-Token', CSRF)
      .attach('file', FIXTURE);
    expect(r.status).toBe(201);
  });
});

describe('POST /api/opme/import — happy path', () => {
  it('201 cu fixture-ul real F1129 → lines_count=45', async () => {
    setupSuccessMocks('imp-real-1');
    const tok = makeToken();
    const r = await request(makeApp())
      .post('/api/opme/import')
      .set('Cookie', authCookie(tok))
      .set('X-CSRF-Token', CSRF)
      .attach('file', FIXTURE);
    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
    expect(r.body.import_id).toBe('imp-real-1');
    expect(r.body.lines_count).toBe(45);
    expect(r.body.header.suma_totala).toBeCloseTo(215901.00, 2);
    expect(r.body.header.cif_platitor).toBe('4646897');

    // Verificăm că s-au făcut: BEGIN, INSERT imports, INSERT lines, COMMIT.
    const calls = mockClientQuery.mock.calls;
    expect(calls[0][0]).toMatch(/^BEGIN/);
    expect(calls[1][0]).toMatch(/INSERT INTO opme_imports/i);
    expect(calls[2][0]).toMatch(/INSERT INTO opme_lines[\s\S]*UNNEST/i);
    expect(calls[3][0]).toMatch(/^COMMIT/);

    // Și parametrii INSERT imports trebuie să conțină org_id=1, uploaded_by=1, file_hash hex.
    const insertImportsParams = calls[1][1];
    expect(insertImportsParams[0]).toBe(1);   // org_id
    expect(insertImportsParams[1]).toBe(1);   // uploaded_by
    expect(insertImportsParams[2]).toMatch(/^[a-f0-9]{64}$/); // file_hash sha256
  });
});

describe('POST /api/opme/import — idempotent (duplicate_import)', () => {
  it('409 dacă același (org_id, file_hash) există deja', async () => {
    // Duplicate check întoarce un rând existent.
    const existingId = 'imp-existing-1';
    const createdAt  = new Date();
    dbModule.pool.query.mockResolvedValueOnce({ rows: [{ id: existingId, created_at: createdAt }] });

    const tok = makeToken();
    const r = await request(makeApp())
      .post('/api/opme/import')
      .set('Cookie', authCookie(tok))
      .set('X-CSRF-Token', CSRF)
      .attach('file', FIXTURE);

    expect(r.status).toBe(409);
    expect(r.body.error).toBe('duplicate_import');
    expect(r.body.existing_import_id).toBe(existingId);
    // Tranzacția NU trebuie să pornească
    expect(mockClientQuery).not.toHaveBeenCalled();
  });
});

describe('POST /api/opme/import — validări fișier', () => {
  it('400 OPME_NOT_XFA pe PDF normal fără AcroForm', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] }); // duplicate check empty
    const blank = await PDFDocument.create();
    blank.addPage([300, 300]);
    const blankBytes = Buffer.from(await blank.save());

    const tok = makeToken();
    const r = await request(makeApp())
      .post('/api/opme/import')
      .set('Cookie', authCookie(tok))
      .set('X-CSRF-Token', CSRF)
      .attach('file', blankBytes, 'blank.pdf');

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('OPME_NOT_XFA');
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it('413 dacă fișierul depășește 5 MB', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 1024); // 5 MB + 1 KB
    const tok = makeToken();
    const r = await request(makeApp())
      .post('/api/opme/import')
      .set('Cookie', authCookie(tok))
      .set('X-CSRF-Token', CSRF)
      .attach('file', big, 'big.pdf');
    expect(r.status).toBe(413);
    expect(r.body.error).toBe('file_too_large');
  });
});

describe('POST /api/opme/import — tenant isolation', () => {
  it('același fișier importat de două org diferite → fiecare are propriul import (file_hash unic per org)', async () => {
    // Org 1
    setupSuccessMocks('imp-org1');
    let r = await request(makeApp())
      .post('/api/opme/import')
      .set('Cookie', authCookie(makeToken({ orgId: 1, userId: 10 })))
      .set('X-CSRF-Token', CSRF)
      .attach('file', FIXTURE);
    expect(r.status).toBe(201);
    expect(r.body.import_id).toBe('imp-org1');
    const dupCallOrg1 = dbModule.pool.query.mock.calls[0];
    expect(dupCallOrg1[1][0]).toBe(1); // org_id în query duplicate

    vi.clearAllMocks();
    dbModule.pool.connect.mockResolvedValue(mockClient);

    // Org 2 — același file_hash, dar org diferit → check duplicate trece, INSERT reușește
    setupSuccessMocks('imp-org2');
    r = await request(makeApp())
      .post('/api/opme/import')
      .set('Cookie', authCookie(makeToken({ orgId: 2, userId: 20 })))
      .set('X-CSRF-Token', CSRF)
      .attach('file', FIXTURE);
    expect(r.status).toBe(201);
    expect(r.body.import_id).toBe('imp-org2');
    const dupCallOrg2 = dbModule.pool.query.mock.calls[0];
    expect(dupCallOrg2[1][0]).toBe(2); // org_id în query duplicate
  });
});
