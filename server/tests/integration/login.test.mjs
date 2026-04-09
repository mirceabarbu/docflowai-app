/**
 * DocFlowAI — Integration tests: POST /auth/login
 *
 * Testează ruta de login cu pool-ul PostgreSQL mock-uit (vi.mock).
 * Nu necesită bază de date reală — rulează izolat.
 *
 * Acoperire:
 *   ✓ 401 pentru credențiale invalide (user inexistent)
 *   ✓ 401 pentru parolă greșită (user există, hash greșit)
 *   ✓ 400 pentru câmpuri lipsă (email sau password absent)
 *   ✓ 400 pentru parolă prea lungă (> 200 chars, protecție DoS)
 *   ✓ 429 când rate limiter semnalează blocare
 *   ✓ 200 login reușit — răspuns conține câmpurile corecte + cookie JWT
 *   ✓ 200 login reușit cu hash v1 — needsRehash triggerează UPDATE
 *   ✓ force_password_change propagat în răspuns
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';

// ── Mock-uri ESM — hoisted automat de vitest ──────────────────────────────────

vi.mock('../../db/index.mjs', () => {
  const mockQuery = vi.fn();
  return {
    pool:          { query: mockQuery },
    DB_READY:      true,
    requireDb:     vi.fn(() => false),   // false = DB disponibil
    saveFlow:      vi.fn(),
    getFlowData:   vi.fn(),
    initDbWithRetry: vi.fn(),
    DB_LAST_ERROR: null,
  };
});

vi.mock('../../middleware/logger.mjs', () => ({
  logger: {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  },
}));

// ── Import după mock-uri ───────────────────────────────────────────────────────

import * as dbModule from '../../db/index.mjs';
import authRouter, { injectRateLimiter } from '../../routes/auth.mjs';
import { hashPassword } from '../../middleware/auth.mjs';

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Creează un app Express minimal cu doar auth router.
 * Nu importă server/index.mjs (top-level await, efecte secundare).
 */
function createTestApp({ rateLimited = false } = {}) {
  // Injectăm rate limiter mock — nu atinge pool-ul în teste
  injectRateLimiter(
    async () => rateLimited
      ? { blocked: true, remainSec: 300 }
      : { blocked: false },
    async () => {},  // recordLoginFail
    async () => {},  // clearLoginRate
  );

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/', authRouter);
  return app;
}

/** Construiește un user row valid cu hash v2 */
async function makeUser(overrides = {}) {
  const pwd = overrides.plainPwd || 'ParolaTest@2025';
  return {
    id:                    1,
    email:                 'test@primaria.ro',
    password_hash:         await hashPassword(pwd),
    hash_algo:             'pbkdf2_v2',
    role:                  'user',
    org_id:                1,
    nume:                  'Ion Popescu',
    functie:               'Referent',
    institutie:            'Primăria Test',
    force_password_change: false,
    ...overrides,
  };
}

/** Construiește un hash v1 (PBKDF2 100k, fără prefix v2:) */
function makeV1Hash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100_000, 64, 'sha256').toString('hex');
  return `${salt}:${hash}`;
}

// ── Setup / teardown ───────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Resetăm explicit queue-ul mockResolvedValueOnce doar pentru pool.query.
  // vi.clearAllMocks() resetează calls/results dar NU queue-ul one-time.
  // vi.resetAllMocks() resetează și implementările altor mock-uri (requireDb etc.) — prea agresiv.
  dbModule.pool.query.mockReset();
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('POST /auth/login', () => {

  // ── Validare input ────────────────────────────────────────────────────────

  it('400 — câmpuri lipsă (fără email)', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/auth/login')
      .send({ password: 'ceva' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('email_and_password_required');
  });

  it('400 — câmpuri lipsă (fără password)', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'user@test.ro' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('email_and_password_required');
  });

  it('400 — parolă prea lungă (> 200 chars — protecție DoS)', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'user@test.ro', password: 'a'.repeat(201) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('password_too_long');
    expect(res.body.max).toBe(200);
  });

  // ── Rate limiting ─────────────────────────────────────────────────────────

  it('429 — IP blocat de rate limiter', async () => {
    const app = createTestApp({ rateLimited: true });
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'user@test.ro', password: 'orice' });

    expect(res.status).toBe(429);
    expect(res.body.error).toBe('too_many_attempts');
    expect(res.body.remainSec).toBeGreaterThan(0);
  });

  // ── Credențiale invalide ──────────────────────────────────────────────────

  it('401 — user inexistent în DB', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] }); // SELECT user

    const app = createTestApp();
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'inexistent@test.ro', password: 'orice' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('401 — parolă greșită (user există)', async () => {
    const user = await makeUser(); // hash generat pentru 'ParolaTest@2025'
    dbModule.pool.query.mockResolvedValueOnce({ rows: [user] }); // SELECT user

    const app = createTestApp();
    const res = await request(app)
      .post('/auth/login')
      .send({ email: user.email, password: 'parola_gresita' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  // ── Login reușit ──────────────────────────────────────────────────────────

  it('200 — login reușit cu hash v2', async () => {
    const plainPwd = 'ParolaCorecta@2025';
    const user     = await makeUser({ plainPwd });

    // SELECT user → UPDATE hash_algo nu e necesar (deja v2) → clearLoginRate (DELETE)
    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [user] })   // SELECT
      .mockResolvedValueOnce({ rows: [] });       // DELETE login_blocks (clearLoginRate)

    const app = createTestApp();
    const res = await request(app)
      .post('/auth/login')
      .send({ email: user.email, password: plainPwd });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.email).toBe(user.email);
    expect(res.body.role).toBe('user');
    expect(res.body.orgId).toBe(1);
    // Câmpuri sensibile nu trebuie să apară în răspuns
    expect(res.body.password_hash).toBeUndefined();
    expect(res.body.plain_password).toBeUndefined();
  });

  it('200 — cookie JWT setat în răspuns (HttpOnly)', async () => {
    const plainPwd = 'ParolaCorecta@2025';
    const user     = await makeUser({ plainPwd });

    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [user] })
      .mockResolvedValueOnce({ rows: [] });

    const app = createTestApp();
    const res = await request(app)
      .post('/auth/login')
      .set('host', 'localhost')
      .send({ email: user.email, password: plainPwd });

    // Cookie dfai_token trebuie să existe
    // Notă: set-cookie poate fi string (1 cookie) sau array (multiple cookies)
    const rawCookies = res.headers['set-cookie'];
    const cookieList = Array.isArray(rawCookies) ? rawCookies : (rawCookies ? [rawCookies] : []);
    const authCookie = cookieList.find(c => c.startsWith('dfai_token='));
    expect(authCookie).toBeDefined();
    expect(authCookie.toLowerCase()).toContain('httponly');
  });

  it('200 — force_password_change=true propagat în răspuns', async () => {
    const plainPwd = 'ParolaProvizie';
    const user     = await makeUser({ plainPwd, force_password_change: true });

    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [user] })
      .mockResolvedValueOnce({ rows: [] });

    const app = createTestApp();
    const res = await request(app)
      .post('/auth/login')
      .send({ email: user.email, password: plainPwd });

    expect(res.status).toBe(200);
    expect(res.body.force_password_change).toBe(true);
  });

  it('200 — hash v1 legacy triggerează lazy re-hash (UPDATE în DB)', async () => {
    const plainPwd = 'ParolaVeche';
    const v1Hash   = makeV1Hash(plainPwd);
    const user     = await makeUser({ plainPwd, password_hash: v1Hash, hash_algo: 'pbkdf2_v1' });

    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [user] })   // SELECT user
      .mockResolvedValueOnce({ rows: [] })        // UPDATE hash (lazy re-hash)
      .mockResolvedValueOnce({ rows: [] });       // DELETE login_blocks

    const app = createTestApp();
    const res = await request(app)
      .post('/auth/login')
      .send({ email: user.email, password: plainPwd });

    expect(res.status).toBe(200);
    // Verificăm că UPDATE-ul de re-hash a fost apelat
    const calls = dbModule.pool.query.mock.calls;
    const updateCall = calls.find(args =>
      typeof args[0] === 'string' && args[0].includes('UPDATE users SET password_hash')
    );
    expect(updateCall).toBeDefined();
    // Noul hash trebuie să fie v2 (prefix v2:)
    expect(updateCall[1][0]).toMatch(/^v2:/);
  });

  // ── Email case-insensitive ────────────────────────────────────────────────

  it('200 — email case-insensitive (normalizat la lowercase)', async () => {
    const plainPwd = 'Parola123';
    const user     = await makeUser({ plainPwd, email: 'user@primaria.ro' });

    dbModule.pool.query
      .mockResolvedValueOnce({ rows: [user] })
      .mockResolvedValueOnce({ rows: [] });

    const app = createTestApp();
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'USER@Primaria.RO', password: plainPwd }); // uppercase

    // Query-ul SELECT trebuie să folosească email lowercase
    const selectCall = dbModule.pool.query.mock.calls[0];
    expect(selectCall[1][0]).toBe('user@primaria.ro');
    expect(res.status).toBe(200);
  });
});
