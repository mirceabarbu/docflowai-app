/**
 * E2E test — OPME F1129 flux complet: upload → match → retro → export CSV.
 *
 * Un singur scenariu mare cu DB mock-uit handler-based (pattern identic cu
 * opme-matching.test.mjs). Acoperire:
 *   ✓ Upload F1129 → match report cu matched + unmatched
 *   ✓ ALOP auto-confirmat (sumă egală, status=plata)
 *   ✓ audit_log INSERT executat (best-effort)
 *   ✓ tryAutoConfirmAlop — absorbție retro pentru ALOP ajuns în plata după upload
 *   ✓ GET export.csv — 200, Content-Type, BOM UTF-8
 *   ✓ POST rematch — idempotent, zero deltas
 *   ✓ POST rematch-all — procesare la nivel de org
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-vitest-docflowai-2025';
const CSRF = 'csrf-test-token';

vi.mock('../../db/index.mjs', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
}));

import * as dbModule from '../../db/index.mjs';
import opmeRouter from '../../routes/opme.mjs';
import { tryAutoConfirmAlop } from '../../services/opme-matcher.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, '../fixtures/f1129_sample.pdf');

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
  app.use('/', opmeRouter);
  return app;
}

function H(matchFn, responder) {
  const match = typeof matchFn === 'string'
    ? (sql) => sql.includes(matchFn)
    : matchFn;
  return { match, respond: responder };
}

function installClientHandlers(handlers) {
  const client = {
    query: vi.fn(async (sql, params = []) => {
      const h = handlers.find(x => x.match(sql, params));
      if (!h) return { rows: [] };
      return await h.respond(sql, params);
    }),
    release: vi.fn(),
  };
  dbModule.pool.connect.mockResolvedValue(client);
  return client;
}

function installPoolHandlers(handlers) {
  dbModule.pool.query.mockImplementation(async (sql, params = []) => {
    const h = handlers.find(x => x.match(sql, params));
    if (!h) return { rows: [] };
    return await h.respond(sql, params);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  dbModule.pool.query.mockResolvedValue({ rows: [] });
});

const TRIPLET_A = { cod: 'AAB2FMGM4HG', ind: 'AAB', cif: '2801201082577' };
const TRIPLET_B = { cod: 'BBC3GNHN5IH', ind: 'BBC', cif: '1234567890123' };

function makePendingLines() {
  const triplete = [
    [TRIPLET_A.cod, TRIPLET_A.ind, TRIPLET_A.cif, 4061.00],
    [TRIPLET_B.cod, TRIPLET_B.ind, TRIPLET_B.cif, 1000.00],
    ['CCD4HOIO6JI', 'CCD', '2345678901234', 500.00],
    ['DDE5IPJP7KJ', 'DDE', '3456789012345', 250.00],
  ];
  const lines = [];
  for (let i = 0; i < 45; i++) {
    const t = triplete[i % triplete.length];
    lines.push({
      id: `L-${i + 1}`,
      cod_angajament: t[0],
      indicator_angajament: t[1],
      cif_beneficiar: t[2],
      suma_op: t[3],
      nr_op: String(1310 + i),
    });
  }
  return lines;
}

describe('OPME E2E — flux complet F1129 → ALOP confirmat → export CSV', () => {
  it('scenariu complet: upload → match → retro → export → rematch idempotent', async () => {
    const importId = 'imp-e2e-1';
    const alopA = 'alop-a-plata';
    const tripletToAlop = new Map();
    const tripletToSum = new Map();
    let auditInserted = false;
    let confirmCalled = false;

    // Pre-compute sums per triplet
    const allLines = makePendingLines();
    for (const l of allLines) {
      const key = `${l.cod_angajament}|${l.indicator_angajament}|${l.cif_beneficiar}`;
      tripletToSum.set(key, (tripletToSum.get(key) || 0) + Number(l.suma_op));
    }
    // ALOP-A matches TRIPLET_A; B is on alt cif → unmatched
    tripletToAlop.set(`${TRIPLET_A.cod}|${TRIPLET_A.ind}|${TRIPLET_A.cif}`, alopA);

    installClientHandlers([
      H('BEGIN', async () => ({ rows: [] })),
      H('INSERT INTO opme_imports', async () => ({
        rows: [{ id: importId, created_at: new Date() }]
      })),
      H('INSERT INTO opme_lines', async () => ({ rows: [] })),
      H('COMMIT', async () => ({ rows: [] })),

      // Matcher: header
      H(s => s.includes('FROM opme_imports') && s.includes('WHERE id = $1') && !s.includes('ANY'),
        async () => ({
          rows: [{ id: importId, org_id: 1, uploaded_by: 1, nr_document: '0130', data_op: new Date('2026-05-06') }]
        })),
      // Matcher: pending lines
      H(s => s.includes('FROM opme_lines') && s.includes('WHERE opme_import_id ='),
        async () => ({ rows: makePendingLines() })),
      // Candidate query: only TRIPLET_A has a matching ALOP
      H(s => s.includes('FROM alop_instances') && s.includes("a.status = 'plata'") && s.includes('alop_id'),
        async (_sql, params) => {
          const [_org, cif, cod, ind] = params;
          const key = `${cod}|${ind}|${cif}`;
          if (tripletToAlop.has(key)) {
            return { rows: [{ alop_id: tripletToAlop.get(key) }] };
          }
          return { rows: [] };
        }),
      // Expected sum
      H(s => s.includes("SELECT COALESCE(SUM(NULLIF(r->>'suma_ordonantata_plata'"),
        async (_sql, params) => {
          const alopId = params[0];
          let total = 0;
          for (const [key, aid] of tripletToAlop.entries()) {
            if (aid === alopId) total = tripletToSum.get(key) || 0;
          }
          return { rows: [{ expected: total }] };
        }),
      // Pool of pending lines
      H(s => s.includes("match_status IN ('pending','unmatched','partial')"),
        async (_sql, params) => {
          const [_org, cod, ind, cif] = params;
          const key = `${cod}|${ind}|${cif}`;
          const lines = makePendingLines().filter(l =>
            l.cod_angajament === cod && l.indicator_angajament === ind && l.cif_beneficiar === cif
          ).map(l => ({ id: l.id, suma_op: l.suma_op, nr_op: l.nr_op, opme_import_id: importId }));
          return { rows: lines };
        }),
      // Import lookup (date/nr)
      H(s => s.includes('FROM opme_imports') && s.includes('WHERE id = ANY'),
        async () => ({ rows: [{ data_op: new Date('2026-05-06'), nr_documents: '0130' }] })),
      // Confirm ALOP
      H(s => s.includes('UPDATE alop_instances') && s.includes('plata_confirmed_at=NOW()'),
        async (_sql, params) => { confirmCalled = true; return { rows: [{ id: params[6], status: 'completed' }] }; }),
      // Audit log INSERT
      H(s => s.includes('INSERT INTO audit_log') && s.includes('plata_auto_opme'),
        async () => { auditInserted = true; return { rows: [] }; }),
      // UPDATE opme_lines
      H('UPDATE opme_lines', async () => ({ rows: [] })),
    ]);

    // ── 1. Upload + matcher ────────────────────────────────────────────────
    const res = await request(makeApp())
      .post('/api/opme/import')
      .set('Cookie', authCookie(makeToken()))
      .set('X-CSRF-Token', CSRF)
      .attach('file', FIXTURE);

    expect(res.status).toBe(201);
    expect(res.body.lines_count).toBe(45);
    expect(res.body.match_report).toBeTruthy();

    // ALOP-A confirmat (TRIPLET_A matched); restul unmatched/partial
    expect(res.body.match_report.confirmed_alopuri).toContain(alopA);
    expect(res.body.match_report.unmatched).toBeGreaterThan(0);

    // ── 2. audit_log a fost apelat ─────────────────────────────────────────
    expect(auditInserted).toBe(true);

    // ── 3. applyPlataConfirmedSideEffects apelat ───────────────────────────
    expect(confirmCalled).toBe(true);
  }, 30_000);

  it('tryAutoConfirmAlop — absorbție retro pe ALOP ajuns în plata', async () => {
    let confirmed = false;
    let auditInserted = false;

    installClientHandlers([
      H('BEGIN', async () => ({ rows: [] })),
      H('COMMIT', async () => ({ rows: [] })),
      // ALOP in plata cu TRIPLET_A
      H(s => s.includes('FROM alop_instances') && s.includes('LEFT JOIN formulare_ord') && s.includes('WHERE a.id = $1'),
        async () => ({ rows: [{
          id: 'alop-retro', org_id: 1, status: 'plata',
          plata_confirmed_at: null, created_by: 1, ord_id: 'ord-1',
          cif_beneficiar: TRIPLET_A.cif,
          ord_rows: [{
            cod_angajament: TRIPLET_A.cod,
            indicator_angajament: TRIPLET_A.ind,
            suma_ordonantata_plata: '4061.00',
          }],
        }] })),
      H(s => s.includes("SELECT COALESCE(SUM(NULLIF(r->>'suma_ordonantata_plata'"),
        async () => ({ rows: [{ expected: 4061 }] })),
      // Pending OPME lines (from prior import)
      H(s => s.includes("match_status IN ('pending','unmatched','partial')"),
        async () => ({ rows: [
          { id: 'L-OLD', suma_op: 4061, nr_op: '1310', opme_import_id: 'imp-old' }
        ] })),
      H(s => s.includes('FROM opme_imports') && s.includes('WHERE id = ANY'),
        async () => ({ rows: [{ data_op: new Date('2026-04-01'), nr_documents: '0099' }] })),
      H(s => s.includes('UPDATE alop_instances') && s.includes('plata_confirmed_at=NOW()'),
        async () => { confirmed = true; return { rows: [{ id: 'alop-retro' }] }; }),
      H(s => s.includes('INSERT INTO audit_log') && s.includes('plata_auto_opme'),
        async () => { auditInserted = true; return { rows: [] }; }),
      H('UPDATE opme_lines', async () => ({ rows: [] })),
    ]);

    const out = await tryAutoConfirmAlop('alop-retro', { actorUserId: 1 });
    expect(out.confirmed).toBe(true);
    expect(out.reason).toBe('matched');
    expect(confirmed).toBe(true);
    expect(auditInserted).toBe(true);
  }, 30_000);

  it('GET export.csv — BOM UTF-8 + header + Content-Type', async () => {
    installPoolHandlers([
      H('FROM opme_imports WHERE id', async () => ({
        rows: [{ nr_document: '0130', data_op: '2026-05-06' }]
      })),
      H('FROM opme_lines l', async () => ({
        rows: [
          {
            nr_op: '1310', cod_angajament: 'AAB2FMGM4HG', indicator_angajament: 'AAB',
            cif_beneficiar: '2801201082577', den_beneficiar: 'SC TEST SRL',
            iban_beneficiar: 'RO12TREZ1234', suma_op: 4061.00,
            explicatii: 'Test linie', match_status: 'auto', match_notes: null,
            matched_alop_id: 'alop-a', alop_titlu: 'Contract X', df_nr: 'DF-001',
          },
        ],
      })),
    ]);

    const res = await request(makeApp())
      .get('/api/opme/imports/imp-csv/export.csv')
      .set('Cookie', authCookie(makeToken()));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/opme_0130/);
    // BOM UTF-8 = EF BB BF
    const body = res.text;
    expect(body.charCodeAt(0)).toBe(0xFEFF);
    expect(body).toContain('nr_op,cod_angajament');
    expect(body).toContain('4061,00');
    expect(body).toContain('AAB2FMGM4HG');
  }, 30_000);

  it('POST rematch — idempotent pe import procesat', async () => {
    const importId = 'imp-rematch';
    installPoolHandlers([
      // Tenant check
      H(s => s.includes('FROM opme_imports WHERE id') && !s.includes('DISTINCT'),
        async () => ({ rows: [{ id: importId }] })),
      // Reset unmatched/ambiguous/partial lines to pending
      H(s => s.includes('UPDATE opme_lines') && s.includes("match_status='pending'"),
        async () => ({ rows: [] })),
    ]);

    // Matcher has own client
    installClientHandlers([
      H('BEGIN', async () => ({ rows: [] })),
      H('COMMIT', async () => ({ rows: [] })),
      // Import header
      H(s => s.includes('FROM opme_imports') && s.includes('WHERE id = $1'),
        async () => ({ rows: [{ id: importId, org_id: 1, uploaded_by: 1, nr_document: '0130', data_op: new Date() }] })),
      // Zero pending lines (all already auto)
      H(s => s.includes('FROM opme_lines') && s.includes('WHERE opme_import_id'),
        async () => ({ rows: [] })),
    ]);

    const res = await request(makeApp())
      .post(`/api/opme/imports/${importId}/rematch`)
      .set('Cookie', authCookie(makeToken()))
      .set('X-CSRF-Token', CSRF);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.match_report.matched).toBe(0);
    expect(res.body.match_report.unmatched).toBe(0);
  }, 30_000);

  it('POST rematch-all — procesează multiple importuri', async () => {
    installPoolHandlers([
      // List imports with pending lines
      H(s => s.includes('SELECT DISTINCT i.id'),
        async () => ({ rows: [{ id: 'imp-1' }, { id: 'imp-2' }] })),
      // Reset lines (called per import)
      H(s => s.includes('UPDATE opme_lines') && s.includes("match_status='pending'"),
        async () => ({ rows: [] })),
    ]);

    installClientHandlers([
      H('BEGIN', async () => ({ rows: [] })),
      H('COMMIT', async () => ({ rows: [] })),
      // Each import has zero pending lines after reset (matcher returns empty)
      H(s => s.includes('FROM opme_imports') && s.includes('WHERE id = $1'),
        async (_sql, params) => ({
          rows: [{ id: params[0], org_id: 1, uploaded_by: 1, nr_document: '0', data_op: new Date() }]
        })),
      H(s => s.includes('FROM opme_lines') && s.includes('WHERE opme_import_id'),
        async () => ({ rows: [] })),
    ]);

    const res = await request(makeApp())
      .post('/api/opme/rematch-all')
      .set('Cookie', authCookie(makeToken()))
      .set('X-CSRF-Token', CSRF);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.processed).toBe(2);
    expect(res.body.total_confirmed).toBe(0);
    expect(res.body.summary).toHaveLength(2);
  }, 30_000);

  it('POST rematch-all — 403 pentru non-admin (chiar cu asignare P2)', async () => {
    // rematch-all is admin-only, P2 assignment is not enough
    const res = await request(makeApp())
      .post('/api/opme/rematch-all')
      .set('Cookie', authCookie(makeToken({ role: 'user' })))
      .set('X-CSRF-Token', CSRF);

    expect(res.status).toBe(403);
  }, 30_000);

  it('GET export.csv — 403 fără asignare P2 (assigned_to)', async () => {
    // pool.query default returns empty → gating denies
    const res = await request(makeApp())
      .get('/api/opme/imports/imp-csv/export.csv')
      .set('Cookie', authCookie(makeToken({ role: 'user' })));

    expect(res.status).toBe(403);
  }, 30_000);
});
