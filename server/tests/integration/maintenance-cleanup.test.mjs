/**
 * Integration tests — maintenance cleanup + attachment Drive fallback.
 *
 * Acoperire:
 *   POST /admin/db/cleanup-orphans
 *     ✓ nullifiază data BYTEA pe atașamente arhivate (drive_file_id setat)
 *     ✓ UPDATE-ul de nullify e gardat pe drive_file_id IS NOT NULL (DB-only NEatins)
 *     ✓ răspunsul include archivedAttsNullified ca number
 *   GET /flows/:flowId/attachments/:attId
 *     ✓ data=NULL + drive_file_id setat → streamează din Drive
 *     ✓ data=NULL + drive_file_id=NULL → 404 attachment_data_missing
 *     ✓ streamFromDrive aruncă → 502 drive_unavailable
 *
 * Pattern: mock pool/logger/drive (vezi opme-import.test.mjs), auth + csrf reale.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

const TEST_JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-vitest-docflowai-2025';
const CSRF = 'csrf-test-token';

// ── Mocks ────────────────────────────────────────────────────────────────────
vi.mock('../../db/index.mjs', () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
  DB_READY: true,
  DB_LAST_ERROR: null,
  requireDb: () => false,                    // DB ready → nu scurtcircuitează
  invalidateOrgUserCache: vi.fn(),
  saveFlow: vi.fn(),
  getFlowData: vi.fn(),
  getDefaultOrgId: vi.fn(),
  getUserMapForOrg: vi.fn(),
  writeAuditEvent: vi.fn(),
}));

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
}));

vi.mock('../../drive.mjs', () => ({
  streamFromDrive: vi.fn(),
  getBufferFromDrive: vi.fn(),
  verifyDrive: vi.fn(),
  archiveFlow: vi.fn(),
}));

// maintenance.mjs importă whatsapp/mailer/emailTemplates la load — stub-uim
vi.mock('../../whatsapp.mjs', () => ({ verifyWhatsApp: vi.fn(), sendWaSignRequest: vi.fn() }));
vi.mock('../../mailer.mjs', () => ({ sendSignerEmail: vi.fn(), verifySmtp: vi.fn() }));
vi.mock('../../emailTemplates.mjs', () => ({ emailCredentials: vi.fn() }));

import * as dbModule    from '../../db/index.mjs';
import * as driveModule from '../../drive.mjs';
import maintenanceRouter from '../../routes/admin/maintenance.mjs';
import attachmentsRouter from '../../routes/flows/attachments.mjs';

function makeAdminToken(overrides = {}) {
  return jwt.sign(
    { userId: 1, email: 'admin@primaria.ro', role: 'admin', orgId: 1, ...overrides },
    TEST_JWT_SECRET, { expiresIn: '2h' }
  );
}
function adminCookie(token) { return `auth_token=${token}; csrf_token=${CSRF}`; }

function makeApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(cookieParser());
  app.use('/', maintenanceRouter);
  app.use('/', attachmentsRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  dbModule.pool.query.mockResolvedValue({ rows: [] });
  dbModule.pool.connect.mockResolvedValue({
    query: vi.fn().mockResolvedValue({}),
    release: vi.fn(),
  });
  // v3.9.603: authz la nivel de obiect pe GET attachments → adminul trebuie să fie same-org.
  // orgId=1 = org-ul adminului din makeAdminToken (same-org admin, scenariu real).
  dbModule.getFlowData.mockResolvedValue({ flowId: 'flow-1', orgId: 1, signers: [] }); // flux există → trece de guard
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/db/cleanup-orphans — nullify atașamente arhivate
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /admin/db/cleanup-orphans — nullify atașamente arhivate', () => {
  // Ordinea query-urilor pe pool.query (VACUUM rulează separat pe client dedicat):
  //   1 beforeR, 2 delPdfs, 3 delAtts, 4 nullifyArchived, 5 afterR
  function mockCleanupSequence({ archivedWithData = 1, nullifiedRows = 1 } = {}) {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [{                      // 1 beforeR
        db_bytes: 1_000_000, pdfs_bytes: 500_000, att_bytes: 300_000,
        orphan_pdfs: 0, orphan_atts: 0, archived_atts_with_data: archivedWithData,
      }] })
      .mockResolvedValueOnce({ rowCount: 0 })                // 2 delPdfs
      .mockResolvedValueOnce({ rowCount: 0 })                // 3 delAtts
      .mockResolvedValueOnce({ rowCount: nullifiedRows })    // 4 nullifyArchived
      .mockResolvedValueOnce({ rows: [{                      // 5 afterR
        db_bytes: 700_000, pdfs_bytes: 400_000, att_bytes: 100_000,
      }] });
  }

  it('VACUUM rulează pe client dedicat cu statement_timeout extins (fix v3.9.533)', async () => {
    mockCleanupSequence({ archivedWithData: 0, nullifiedRows: 0 });
    const client = { query: vi.fn().mockResolvedValue({}), release: vi.fn() };
    dbModule.pool.connect.mockResolvedValue(client);

    const res = await request(makeApp())
      .post('/admin/db/cleanup-orphans')
      .set('Cookie', adminCookie(makeAdminToken()))
      .set('X-CSRF-Token', CSRF);

    expect(res.status).toBe(200);
    expect(dbModule.pool.connect).toHaveBeenCalled();

    const clientSql = client.query.mock.calls.map(c => String(c[0]));
    expect(clientSql.some(s => /SET\s+statement_timeout/i.test(s))).toBe(true);
    expect(clientSql.some(s => /VACUUM\s+FULL\s+flows_pdfs/i.test(s))).toBe(true);
    expect(clientSql.some(s => /VACUUM\s+FULL\s+flow_attachments/i.test(s))).toBe(true);
    expect(client.release).toHaveBeenCalled();
    const pooledVacuum = dbModule.pool.query.mock.calls
      .map(c => String(c[0]))
      .some(s => /VACUUM\s+FULL/i.test(s));
    expect(pooledVacuum).toBe(false);
  });

  it('nullifiază data BYTEA pe atașamente cu drive_file_id setat', async () => {
    mockCleanupSequence({ archivedWithData: 3, nullifiedRows: 3 });
    const res = await request(makeApp())
      .post('/admin/db/cleanup-orphans')
      .set('Cookie', adminCookie(makeAdminToken()))
      .set('X-CSRF-Token', CSRF);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.archivedAttsNullified).toBe(3);
    expect(res.body.attachmentsNullified).toBe(3);

    // UPDATE-ul de nullify a fost emis, cu SET data=NULL
    const nullifySql = dbModule.pool.query.mock.calls
      .map(c => String(c[0]))
      .find(sql => /UPDATE\s+flow_attachments/i.test(sql) && /SET\s+data\s*=\s*NULL/i.test(sql));
    expect(nullifySql).toBeTruthy();
  });

  it('UPDATE-ul de nullify e gardat pe drive_file_id IS NOT NULL (atașamentele DB-only rămân neatinse)', async () => {
    mockCleanupSequence({ archivedWithData: 0, nullifiedRows: 0 });
    const res = await request(makeApp())
      .post('/admin/db/cleanup-orphans')
      .set('Cookie', adminCookie(makeAdminToken()))
      .set('X-CSRF-Token', CSRF);

    expect(res.status).toBe(200);
    const nullifySql = dbModule.pool.query.mock.calls
      .map(c => String(c[0]))
      .find(sql => /UPDATE\s+flow_attachments/i.test(sql) && /SET\s+data\s*=\s*NULL/i.test(sql));
    expect(nullifySql).toBeTruthy();
    // Garda care protejează atașamentele fără drive_file_id (DB-only):
    expect(nullifySql).toMatch(/drive_file_id\s+IS\s+NOT\s+NULL/i);
    expect(nullifySql).toMatch(/data\s+IS\s+NOT\s+NULL/i);
    // Pe DB goală nu s-a nullificat nimic:
    expect(res.body.archivedAttsNullified).toBe(0);
  });

  it('răspunsul include archivedAttsNullified ca number', async () => {
    mockCleanupSequence({ archivedWithData: 0, nullifiedRows: 0 });
    const res = await request(makeApp())
      .post('/admin/db/cleanup-orphans')
      .set('Cookie', adminCookie(makeAdminToken()))
      .set('X-CSRF-Token', CSRF);

    expect(res.status).toBe(200);
    expect(typeof res.body.archivedAttsNullified).toBe('number');
    expect(typeof res.body.attachmentsNullified).toBe('number');
  });

  it('403 pentru non-admin', async () => {
    const res = await request(makeApp())
      .post('/admin/db/cleanup-orphans')
      .set('Cookie', adminCookie(makeAdminToken({ role: 'org_admin' })))
      .set('X-CSRF-Token', CSRF);
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /flows/:flowId/attachments/:attId — fallback Drive când BYTEA e nullificat
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /flows/:flowId/attachments/:attId — fallback Drive', () => {
  const FLOW = 'flow-1';
  const ATT  = '7';

  it('când data=NULL și drive_file_id setat, streamează din Drive', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [{
      filename: 'contract.pdf', mime_type: 'application/pdf',
      data: null, drive_file_id: 'mock_drive_id',
    }] });
    driveModule.streamFromDrive.mockImplementation(async (fileId, res) => {
      res.end(Buffer.from('DRIVE_STREAM_OK'));
    });

    const res = await request(makeApp())
      .get(`/flows/${FLOW}/attachments/${ATT}`)
      .set('Cookie', adminCookie(makeAdminToken()))
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', c => chunks.push(Buffer.from(c)));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(driveModule.streamFromDrive).toHaveBeenCalledWith('mock_drive_id', expect.anything());
    expect(res.body.toString()).toBe('DRIVE_STREAM_OK');
  });

  it('când data=NULL și drive_file_id=NULL, returnează 404 attachment_data_missing', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [{
      filename: 'x.pdf', mime_type: 'application/pdf',
      data: null, drive_file_id: null,
    }] });

    const res = await request(makeApp())
      .get(`/flows/${FLOW}/attachments/${ATT}`)
      .set('Cookie', adminCookie(makeAdminToken()));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('attachment_data_missing');
    expect(driveModule.streamFromDrive).not.toHaveBeenCalled();
  });

  it('când Drive streamFromDrive aruncă, returnează 502 drive_unavailable', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [{
      filename: 'arhivat.pdf', mime_type: 'application/pdf',
      data: null, drive_file_id: 'mock_drive_id',
    }] });
    driveModule.streamFromDrive.mockRejectedValue(new Error('Drive 503'));

    const res = await request(makeApp())
      .get(`/flows/${FLOW}/attachments/${ATT}`)
      .set('Cookie', adminCookie(makeAdminToken()));

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('drive_unavailable');
  });
});
