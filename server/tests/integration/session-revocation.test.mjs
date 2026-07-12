/**
 * DocFlowAI — Integration: SEC-88 revocare globală de sesiune (sessionGuard)
 *
 * App Express minimal care oglindește ordinea de montare din server/index.mjs:
 *   cookieParser → express.static → healthRouter → sessionGuard() → routere.
 * Pool-ul PostgreSQL e mock-uit — nu necesită DB reală.
 *
 * Demonstrează exact suprafețele pe care #87 NU le acoperea (semnare, ALOP, flows)
 * și capcana /auth/ (un cont revocat trebuie să se poată reloga).
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── Mock DB controlabil (hoisted) ─────────────────────────────────────────────
const H = vi.hoisted(() => {
  const self = { usersRow: null, dbReady: true, calls: [] };
  self.query = async (sql, params) => {
    self.calls.push({ sql, params });
    if (/FROM\s+users/i.test(sql)) return { rows: self.usersRow ? [self.usersRow] : [] };
    return { rows: [] };
  };
  return self;
});

vi.mock('../../db/index.mjs', () => ({
  pool: { query: (...a) => H.query(...a) },
  get DB_READY() { return H.dbReady; },
  DB_LAST_ERROR: null,
  requireDb: (res) => { if (!H.dbReady) { res.status(503).json({ error: 'db_not_ready' }); return true; } return false; },
}));

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
  redactUrl: (u) => u,
}));

// ── Import după mock-uri ───────────────────────────────────────────────────────
import { makeHealthRouter } from '../../routes/health.mjs';
import { sessionGuard } from '../../middleware/session-guard.mjs';
import { JWT_SECRET, AUTH_COOKIE, hashPassword } from '../../middleware/auth.mjs';
import authRouter, { injectRateLimiter } from '../../routes/auth.mjs';
import templatesRouter from '../../routes/templates.mjs';
import jwt from 'jsonwebtoken';

const STATIC_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sec88-static-'));
fs.writeFileSync(path.join(STATIC_DIR, 'asset.txt'), 'hello');

function buildApp() {
  injectRateLimiter(async () => ({ blocked: false }), async () => {}, async () => {});
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(express.static(STATIC_DIR));
  app.use(makeHealthRouter({ version: 'test', pool: { query: (...a) => H.query(...a) }, getReady: () => H.dbReady, getLastError: () => null }));
  app.use(sessionGuard());
  // Stub-uri sub prefixe păzite = fix suprafețele pe care #87 nu le acoperea (semnare, ALOP).
  // NB: POST /flows (creare flux) NU e sub /flows/ — dar e acoperit de resolveActor din #87.
  app.post('/flows/:id/upload-signed-pdf', (req, res) => res.json({ ok: true, reached: 'flows' }));
  app.get('/api/alop/:id', (req, res) => res.json({ ok: true, reached: 'alop' }));
  app.post('/flows/:id/initiate-cloud-signing', (req, res) => res.json({ ok: true, reached: 'signing' }));
  app.use(authRouter);
  app.use(templatesRouter);
  return app;
}

const app = buildApp();
const cookie = (payload) => `${AUTH_COOKIE}=${jwt.sign(payload, JWT_SECRET)}`;
const activePayload = (o = {}) => ({ userId: 7, email: 'actor@test.ro', role: 'user', orgId: 12, tv: 3, ...o });
const activeRow = (o = {}) => ({
  id: 7, email: 'actor@test.ro', nume: 'Actor', functie: 'Inspector', compartiment: 'Juridic',
  institutie: 'Instituția', role: 'user', org_id: 12, token_version: 3, force_password_change: false, ...o,
});
const usersCalls = () => H.calls.filter(c => /FROM\s+users/i.test(c.sql)).length;

beforeEach(() => { H.calls.length = 0; H.dbReady = true; H.usersRow = null; });

describe('SEC-88 — cont dezactivat blochează suprafețele necoperite de #87', () => {
  it('POST /flows/:id/upload-signed-pdf (semnare local) → 401 session_revoked', async () => {
    H.usersRow = null; // users lookup → rows:[]
    const r = await request(app).post('/flows/1/upload-signed-pdf').set('Cookie', cookie(activePayload())).send({});
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ error: 'session_revoked' });
  });

  it('GET /api/alop/:id (ALOP) → 401 session_revoked', async () => {
    H.usersRow = null;
    const r = await request(app).get('/api/alop/1').set('Cookie', cookie(activePayload()));
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ error: 'session_revoked' });
  });

  it('POST /flows/:id/initiate-cloud-signing (semnare) → 401 session_revoked', async () => {
    H.usersRow = null;
    const r = await request(app).post('/flows/1/initiate-cloud-signing').set('Cookie', cookie(activePayload())).send({});
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ error: 'session_revoked' });
  });
});

describe('SEC-88 — token_version & rol', () => {
  it('admin retrogradat / parolă resetată (tv bump) + cookie vechi → 401 token_revoked', async () => {
    H.usersRow = activeRow({ token_version: 4 }); // DB bump-uit
    const r = await request(app).post('/flows/1/upload-signed-pdf').set('Cookie', cookie(activePayload({ tv: 3 }))).send({});
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ error: 'token_revoked' });
  });

  it('rol schimbat în DB + cookie vechi → 401 session_role_stale', async () => {
    H.usersRow = activeRow({ role: 'user' });
    const r = await request(app).get('/api/alop/1').set('Cookie', cookie(activePayload({ role: 'admin' })));
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ error: 'session_role_stale' });
  });
});

describe('SEC-88 — /auth/ NU e păzit (capcana loginului)', () => {
  it('POST /auth/login cu un cookie REVOCAT în cerere → 200 (loginul funcționează!)', async () => {
    const hash = await hashPassword('Secret123!');
    H.usersRow = { ...activeRow(), password_hash: hash, totp_enabled: false };
    const revokedCookie = cookie(activePayload({ tv: 999 })); // cookie stale în cerere
    const r = await request(app)
      .post('/auth/login')
      .set('Cookie', revokedCookie)
      .send({ email: 'actor@test.ro', password: 'Secret123!' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true });
  });
});

describe('SEC-88 — endpoint-uri nepăzite nu ating users', () => {
  it('GET /health → 200, fără query pe users', async () => {
    const r = await request(app).get('/health');
    expect(r.status).toBe(200);
    expect(usersCalls()).toBe(0);
  });

  it('GET /readyz → 200, fără query pe users', async () => {
    const r = await request(app).get('/readyz');
    expect(r.status).toBe(200);
    expect(usersCalls()).toBe(0);
  });

  it('asset static → 200, fără query pe users', async () => {
    const r = await request(app).get('/asset.txt');
    expect(r.status).toBe(200);
    expect(r.text).toBe('hello');
    expect(usersCalls()).toBe(0);
  });
});

describe('SEC-88 — utilizator valid: resolveActor refolosește rândul gărzii', () => {
  it('GET /api/templates → 200 și un SINGUR query pe users (garda), fără al doilea din resolveActor', async () => {
    H.usersRow = activeRow();
    const r = await request(app).get('/api/templates').set('Cookie', cookie(activePayload()));
    expect(r.status).toBe(200);
    expect(usersCalls()).toBe(1);
  });
});
