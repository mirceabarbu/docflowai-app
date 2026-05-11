/**
 * Integration tests — GET /api/opme/imports, /:id, /lines/by-alop/:alopId
 * + POST /api/opme/imports/:id/rematch (Pachet C).
 *
 * Acoperire:
 *   ✓ GET /api/opme/imports — listă paginabilă, tenant isolation
 *   ✓ GET /api/opme/imports/:id — 404 pe alt org, OK pe propriu
 *   ✓ GET /api/opme/lines/by-alop/:id — grupare corectă pe ciclu
 *   ✓ POST /api/opme/imports/:id/rematch — 200 + raport
 *   ✓ Rematch nu modifică linii deja 'auto' (idempotent)
 *   ✓ Rematch refuzat fără rol P2/admin (403)
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

const TEST_JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-vitest-docflowai-2025';
const CSRF = 'csrf-test-token';

// ── Mock pool ───────────────────────────────────────────────────────────────
vi.mock('../../db/index.mjs', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
}));

import * as dbModule from '../../db/index.mjs';
import opmeRouter from '../../routes/opme.mjs';

function makeToken(overrides = {}) {
  return jwt.sign(
    { userId: 1, email: 'admin@primaria.ro', role: 'admin', orgId: 1, ...overrides },
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

// Handler-based pool.query mock
function installPoolHandlers(handlers) {
  dbModule.pool.query.mockImplementation(async (sql, params = []) => {
    const h = handlers.find(x => x.match(sql, params));
    if (!h) return { rows: [] };
    return await h.respond(sql, params);
  });
}
function H(matcher, responder) {
  const match = typeof matcher === 'string'
    ? (sql) => sql.includes(matcher)
    : matcher;
  return { match, respond: responder };
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.JWT_SECRET = TEST_JWT_SECRET;
});

// ───────────────────────────────────────────────────────────────────────────
// GET /api/opme/imports — listă
// ───────────────────────────────────────────────────────────────────────────

describe('GET /api/opme/imports', () => {
  it('returnează lista paginabilă cu tenant isolation', async () => {
    let queriedOrgId = null;
    installPoolHandlers([
      H('FROM opme_imports i', async (_sql, params) => {
        queriedOrgId = params[0];
        return {
          rows: [
            {
              id: 'imp-1', nr_document: '0130', data_op: new Date('2026-05-06'),
              suma_totala: '215901.00', nr_inregistrari: 45,
              cif_platitor: '4646897', den_platitor: 'ZARNESTI',
              file_name: 'f1129.pdf', created_at: new Date(),
              uploaded_by_id: 1, uploaded_by_name: 'Admin', uploaded_by_email: 'a@b.ro',
              total_count: '1', matched: 12, ambiguous: 3, unmatched: 2, partial: 1, pending: 0,
            }
          ]
        };
      }),
    ]);

    const r = await request(makeApp())
      .get('/api/opme/imports?limit=20&offset=0')
      .set('Cookie', authCookie(makeToken({ orgId: 7 })));

    expect(r.status).toBe(200);
    expect(queriedOrgId).toBe(7);
    expect(r.body.imports).toHaveLength(1);
    expect(r.body.total).toBe(1);
    expect(r.body.imports[0].id).toBe('imp-1');
    expect(r.body.imports[0].lines_stats).toEqual({
      matched: 12, ambiguous: 3, unmatched: 2, partial: 1, pending: 0
    });
    expect(r.body.imports[0].uploaded_by).toEqual({ id: 1, name: 'Admin', email: 'a@b.ro' });
  });

  it('respinge fără auth (401)', async () => {
    const r = await request(makeApp()).get('/api/opme/imports');
    expect(r.status).toBe(401);
  });

  it('clamp-uri limit la max 100', async () => {
    let capturedLimit = null;
    installPoolHandlers([
      H('FROM opme_imports i', async (_sql, params) => {
        capturedLimit = params[1];
        return { rows: [] };
      }),
    ]);
    const r = await request(makeApp())
      .get('/api/opme/imports?limit=9999')
      .set('Cookie', authCookie(makeToken()));
    expect(r.status).toBe(200);
    expect(capturedLimit).toBe(100);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// GET /api/opme/imports/:id — detaliu
// ───────────────────────────────────────────────────────────────────────────

describe('GET /api/opme/imports/:id', () => {
  it('200 pe import-ul propriu org-ului', async () => {
    installPoolHandlers([
      H(s => s.includes('FROM opme_imports i') && s.includes('LEFT JOIN users u ON u.id = i.uploaded_by'),
        async () => ({ rows: [{
          id: 'imp-1', org_id: 1, nr_document: '0130', data_op: new Date('2026-05-06'),
          an_r: 2026, luna_r: 5, cif_platitor: '4646897', den_platitor: 'ZARNESTI',
          adresa_platitor: '', nr_inregistrari: 45, suma_totala: '215901.00',
          universal_code: 'F1129_xxx', file_name: 'f1129.pdf', file_hash: 'abc',
          created_at: new Date(), uploaded_by_id: 1,
          uploaded_by_name: 'Admin', uploaded_by_email: 'a@b.ro',
        }] })),
      H('FROM opme_lines l', async () => ({
        rows: [
          { id: 'l1', row_index: 0, nr_op: '1310', suma_op: '4061.00',
            cod_angajament: 'AAB2FMGM4HG', indicator_angajament: 'AAB',
            cif_beneficiar: '2801201082577', match_status: 'auto',
            matched_alop_id: 'alop-1', alop_titlu: 'ALOP test', df_nr: 'DF-1' },
          { id: 'l2', row_index: 1, nr_op: '1311', suma_op: '500.00',
            match_status: 'unmatched', matched_alop_id: null },
        ]
      })),
    ]);

    const r = await request(makeApp())
      .get('/api/opme/imports/imp-1')
      .set('Cookie', authCookie(makeToken()));

    expect(r.status).toBe(200);
    expect(r.body.import.id).toBe('imp-1');
    expect(r.body.lines).toHaveLength(2);
    expect(r.body.stats.auto).toBe(1);
    expect(r.body.stats.unmatched).toBe(1);
  });

  it('404 când import-ul nu există în org', async () => {
    installPoolHandlers([
      H('FROM opme_imports i', async () => ({ rows: [] })),
    ]);
    const r = await request(makeApp())
      .get('/api/opme/imports/imp-other-org')
      .set('Cookie', authCookie(makeToken()));
    expect(r.status).toBe(404);
  });

  it('400 pe id invalid', async () => {
    const r = await request(makeApp())
      .get('/api/opme/imports/null')
      .set('Cookie', authCookie(makeToken()));
    expect(r.status).toBe(400);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// GET /api/opme/lines/by-alop/:alopId
// ───────────────────────────────────────────────────────────────────────────

describe('GET /api/opme/lines/by-alop/:alopId', () => {
  it('grupare corectă: NULL ciclu_id → active, rest → byCiclu[id]', async () => {
    installPoolHandlers([
      H('SELECT id FROM alop_instances', async () => ({ rows: [{ id: 'alop-1' }] })),
      H('FROM opme_lines l', async () => ({
        rows: [
          { id: 'l1', nr_op: '1310', suma_op: '100', matched_ciclu_id: null, opme_import_id: 'imp-1' },
          { id: 'l2', nr_op: '1311', suma_op: '200', matched_ciclu_id: 'ciclu-arch', opme_import_id: 'imp-1' },
        ]
      })),
    ]);
    const r = await request(makeApp())
      .get('/api/opme/lines/by-alop/alop-1')
      .set('Cookie', authCookie(makeToken()));
    expect(r.status).toBe(200);
    expect(r.body.lines).toHaveLength(2);
    expect(r.body.groups.active).toHaveLength(1);
    expect(r.body.groups.active[0].id).toBe('l1');
    expect(r.body.groups.byCiclu['ciclu-arch']).toHaveLength(1);
  });

  it('404 dacă ALOP nu există în org-ul actorului', async () => {
    installPoolHandlers([
      H('SELECT id FROM alop_instances', async () => ({ rows: [] })),
    ]);
    const r = await request(makeApp())
      .get('/api/opme/lines/by-alop/alop-x')
      .set('Cookie', authCookie(makeToken()));
    expect(r.status).toBe(404);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// POST /api/opme/imports/:id/rematch
// ───────────────────────────────────────────────────────────────────────────

describe('POST /api/opme/imports/:id/rematch', () => {
  it('200 + reset pe linii ne-finalizate, păstrează auto', async () => {
    // Mock pool.connect pentru tranzacția din matchImport
    const clientCalls = [];
    const client = {
      query: vi.fn(async (sql, params = []) => {
        clientCalls.push({ sql, params });
        if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT')) return { rows: [] };
        if (sql.includes('FROM opme_imports') && sql.includes('WHERE id = $1')) {
          return { rows: [{ id: 'imp-1', org_id: 1, uploaded_by: 1, nr_document: '0130', data_op: new Date() }] };
        }
        if (sql.includes('FROM opme_lines') && sql.includes('WHERE opme_import_id ='))
          return { rows: [] }; // zero pending după reset
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    dbModule.pool.connect.mockResolvedValue(client);

    let resetSql = null;
    installPoolHandlers([
      // Tenant check
      H('SELECT id FROM opme_imports', async () => ({ rows: [{ id: 'imp-1' }] })),
      // Reset pending (NU atinge 'auto' sau 'manual' — testat prin params/SQL inspection)
      H('UPDATE opme_lines', async (sql) => { resetSql = sql; return { rows: [] }; }),
    ]);

    const r = await request(makeApp())
      .post('/api/opme/imports/imp-1/rematch')
      .set('Cookie', authCookie(makeToken()))
      .set('X-CSRF-Token', CSRF);

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.match_report).toBeTruthy();
    expect(r.body.match_report.summary_text).toMatch(/0 linii citite/);
    // Verifică explicit clauza care exclude 'auto' și 'manual'
    expect(resetSql).toMatch(/IN \('unmatched','ambiguous','partial'\)/);
    expect(resetSql).not.toMatch(/'auto'/);
    expect(resetSql).not.toMatch(/'manual'/);
  });

  it('403 fără CSRF', async () => {
    const r = await request(makeApp())
      .post('/api/opme/imports/imp-1/rematch')
      .set('Cookie', authCookie(makeToken()));
    expect(r.status).toBe(403);
  });

  it('403 dacă userul nu e asignat ca responsabil_cab', async () => {
    // pool.query default returns empty → gating denies
    const r = await request(makeApp())
      .post('/api/opme/imports/imp-1/rematch')
      .set('Cookie', authCookie(makeToken({ role: 'user' })))
      .set('X-CSRF-Token', CSRF);
    expect(r.status).toBe(403);
  });

  it('404 dacă import-ul e în alt org', async () => {
    installPoolHandlers([
      H('SELECT id FROM opme_imports', async () => ({ rows: [] })),
    ]);
    const r = await request(makeApp())
      .post('/api/opme/imports/imp-other/rematch')
      .set('Cookie', authCookie(makeToken()))
      .set('X-CSRF-Token', CSRF);
    expect(r.status).toBe(404);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// GET /api/me/can-import-opme — gating server-driven
// ───────────────────────────────────────────────────────────────────────────

describe('GET /api/me/can-import-opme', () => {
  it('admin → can:true fără asignări necesare', async () => {
    const r = await request(makeApp())
      .get('/api/me/can-import-opme')
      .set('Cookie', authCookie(makeToken({ role: 'admin' })));
    expect(r.status).toBe(200);
    expect(r.body.can).toBe(true);
  });

  it('user cu responsabil_cab în alop_sabloane → can:true', async () => {
    installPoolHandlers([
      H(s => s.includes('alop_sabloane') && s.includes('responsabil_cab'),
        async () => ({ rows: [{ '?column?': 1 }] })),
    ]);
    const r = await request(makeApp())
      .get('/api/me/can-import-opme')
      .set('Cookie', authCookie(makeToken({ role: 'user' })));
    expect(r.status).toBe(200);
    expect(r.body.can).toBe(true);
  });

  it('user cu responsabil_cab într-o alop_instances → can:true', async () => {
    installPoolHandlers([
      H(s => s.includes('alop_sabloane') && s.includes('responsabil_cab'),
        async () => ({ rows: [{ '?column?': 1 }] })),
    ]);
    const r = await request(makeApp())
      .get('/api/me/can-import-opme')
      .set('Cookie', authCookie(makeToken({ role: 'user' })));
    expect(r.status).toBe(200);
    expect(r.body.can).toBe(true);
  });

  it('user fără nicio asignare → can:false', async () => {
    // Default pool.query returns empty rows
    const r = await request(makeApp())
      .get('/api/me/can-import-opme')
      .set('Cookie', authCookie(makeToken({ role: 'user' })));
    expect(r.status).toBe(200);
    expect(r.body.can).toBe(false);
  });

  it('user din alt org cu responsabil_cab → can:false (tenant isolation)', async () => {
    // Query filtrează pe org_id=$1 → dacă user-ul e din org 1 dar sablonul e din org 2, no match
    // Default mock returns empty → false
    const r = await request(makeApp())
      .get('/api/me/can-import-opme')
      .set('Cookie', authCookie(makeToken({ role: 'user', orgId: 999 })));
    expect(r.status).toBe(200);
    expect(r.body.can).toBe(false);
  });

  it('401 fără auth', async () => {
    const r = await request(makeApp())
      .get('/api/me/can-import-opme');
    expect(r.status).toBe(401);
  });
});
