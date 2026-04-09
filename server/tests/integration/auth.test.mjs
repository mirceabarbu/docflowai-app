/**
 * DocFlowAI — Integration tests: /api/auth routes (v4)
 *
 * Testează cu pool mock-uit (fără DB reală).
 *
 * Acoperire:
 *   ✓ POST /api/auth/login cu credențiale corecte → 200 + cookie setat
 *   ✓ POST /api/auth/login cu parolă greșită → 401
 *   ✓ POST /api/auth/login de 10 ori → cont blocat (login_blocked_until)
 *   ✓ GET  /api/auth/me fără token → 401
 *   ✓ GET  /api/auth/me cu token valid → 200 + user data
 *   ✓ POST /api/auth/logout → cookie șters
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request    from 'supertest';
import express    from 'express';
import cookieParser from 'cookie-parser';
import jwt        from 'jsonwebtoken';
import bcrypt     from 'bcryptjs';

// ── Mock-uri — trebuie hoisted înainte de orice import ────────────────────────

vi.mock('../../db/index.mjs', () => {
  const mockQuery = vi.fn();
  return {
    pool:             { query: mockQuery },
    DB_READY:         true,
    DB_LAST_ERROR:    null,
    requireDb:        vi.fn((a, b, c) => { if (typeof c === 'function') c(); else return false; }),
    saveFlow:         vi.fn(),
    getFlowData:      vi.fn(),
    getDefaultOrgId:  vi.fn(),
    getUserMapForOrg: vi.fn(),
    writeAuditEvent:  vi.fn(),
    initDbWithRetry:  vi.fn(),
    DB_READY_PROMISE: Promise.resolve(),
  };
});

vi.mock('../../middleware/logger.mjs', () => ({
  logger: {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  },
  requestLogger: vi.fn((_req, _res, next) => next()),
}));

// ── Import dopo mock-uri ──────────────────────────────────────────────────────

import * as dbModule from '../../db/index.mjs';
import authRouter    from '../../modules/auth/routes.mjs';

// ── Helpers ───────────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-vitest-docflowai-2025';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRouter);
  return app;
}

async function makeUser(overrides = {}) {
  const plain = overrides.plainPwd || 'TestPass@2025';
  const hash  = await bcrypt.hash(plain, 4); // fast rounds for tests
  return {
    id:                    42,
    email:                 'test@primaria.ro',
    password_hash:         hash,
    hash_algo:             'bcrypt',
    role:                  'user',
    org_id:                1,
    name:                  'Ion Popescu',
    functie:               'Referent',
    institutie:            'Primăria Test',
    compartiment:          '',
    token_version:         1,
    mfa_enabled:           false,
    totp_enabled:          false,
    force_password_change: false,
    login_blocked_until:   null,
    login_attempts:        0,
    status:                'active',
    ...overrides,
  };
}

function makeValidJwt(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, org_id: user.org_id, role: user.role,
      name: user.name, ver: user.token_version,
      userId: user.id, orgId: user.org_id, nume: user.name, tv: user.token_version },
    JWT_SECRET,
    { expiresIn: '8h' }
  );
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  dbModule.pool.query.mockReset();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/auth/login', () => {

  it('200 — login reușit cu bcrypt hash → cookie setat', async () => {
    const plainPwd = 'TestPass@2025';
    const user     = await makeUser({ plainPwd });

    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [user] })           // SELECT user
      .mockResolvedValueOnce({ rows: [] })               // UPDATE reset attempts
      .mockResolvedValueOnce({ rows: [] });              // audit_log INSERT

    const app = createTestApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: plainPwd });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.email).toBe(user.email);
    expect(res.body.role).toBe('user');
    expect(res.body.orgId).toBe(1);

    // Cookie dfai_token trebuie setat
    const rawCookies = res.headers['set-cookie'];
    const cookies    = Array.isArray(rawCookies) ? rawCookies : (rawCookies ? [rawCookies] : []);
    const authCookie = cookies.find(c => c.startsWith('dfai_token='));
    expect(authCookie).toBeDefined();
    expect(authCookie.toLowerCase()).toContain('httponly');
  });

  it('401 — parolă greșită', async () => {
    const user = await makeUser();
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [user] })           // SELECT user
      .mockResolvedValueOnce({ rows: [] })               // UPDATE login_attempts
      .mockResolvedValueOnce({ rows: [] });              // audit_log

    const app = createTestApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'gresita' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('401 — user inexistent', async () => {
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [] })               // SELECT → empty
      .mockResolvedValueOnce({ rows: [] });              // audit_log

    const app = createTestApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'noone@test.ro', password: 'orice' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('401 — cont blocat (login_blocked_until în viitor)', async () => {
    const blockedUntil = new Date(Date.now() + 10 * 60 * 1000); // +10 min
    const user = await makeUser({ login_blocked_until: blockedUntil.toISOString() });

    dbModule.pool.query.mockResolvedValueOnce({ rows: [user] });

    const app = createTestApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'orice' });

    expect(res.status).toBe(401);
    expect(res.body.remainSec).toBeGreaterThan(0);
  });

  it('401 — după 10 parole greșite, contul se blochează', async () => {
    // User cu 9 încercări deja
    const user = await makeUser({ login_attempts: 9 });

    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [user] })           // SELECT
      .mockResolvedValueOnce({ rows: [] })               // UPDATE attempts → blocked
      .mockResolvedValueOnce({ rows: [] });              // audit_log

    const app = createTestApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'gresita' });

    expect(res.status).toBe(401);
    // La 10 attempt-uri (9+1) blocam, remainSec trebuie prezent
    expect(res.body.remainSec).toBeGreaterThan(0);

    // Verificăm că UPDATE-ul setează login_blocked_until
    const updateCall = dbModule.pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('UPDATE users') && sql.includes('login_blocked_until')
    );
    expect(updateCall).toBeDefined();
  });

  it('400 — câmpuri lipsă', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'x@y.ro' }); // fără password

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('email_and_password_required');
  });

  it('400 — parolă prea lungă (DoS protection)', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'x@y.ro', password: 'a'.repeat(201) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('password_too_long');
  });
});

describe('GET /api/auth/me', () => {

  it('401 — fără token', async () => {
    const app = createTestApp();
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('200 — cu token valid → returnează user data', async () => {
    const user  = await makeUser();
    const token = makeValidJwt(user);

    const app = createTestApp();
    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', `dfai_token=${token}`);

    expect(res.status).toBe(200);
    expect(res.body.email).toBe(user.email);
    expect(res.body.role).toBe(user.role);
    expect(res.body.org_id).toBe(user.org_id);
    // Câmpuri sensibile nu apar
    expect(res.body.password_hash).toBeUndefined();
  });

  it('401 — token expirat', async () => {
    const user  = await makeUser();
    const token = jwt.sign(
      { sub: user.id, email: user.email, org_id: user.org_id, role: user.role },
      JWT_SECRET,
      { expiresIn: -1 } // expirat imediat
    );

    const app = createTestApp();
    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', `dfai_token=${token}`);

    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {

  it('200 — logout șterge cookie', async () => {
    const user  = await makeUser();
    const token = makeValidJwt(user);

    dbModule.pool.query.mockResolvedValue({ rows: [] }); // audit_log

    const app = createTestApp();
    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', `dfai_token=${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Cookie trebuie curățat (maxAge=0 sau expires în trecut)
    const rawCookies = res.headers['set-cookie'];
    const cookies    = Array.isArray(rawCookies) ? rawCookies : (rawCookies ? [rawCookies] : []);
    const cleared    = cookies.find(c => c.startsWith('dfai_token='));
    expect(cleared).toBeDefined();
    // Cookie șters = valoare goală sau maxAge=0
    expect(cleared).toMatch(/dfai_token=;|max-age=0/i);
  });

  it('200 — logout fără token → ok (no crash)', async () => {
    const app = createTestApp();
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(200);
  });
});
