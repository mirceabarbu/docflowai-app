import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';

// Control DB_READY + pool.query prin mock hoisted (vi.mock e ridicat deasupra codului).
const h = vi.hoisted(() => ({ dbReady: true, queryMock: vi.fn() }));
vi.mock('../../db/index.mjs', () => ({
  pool: { query: h.queryMock },
  get DB_READY() { return h.dbReady; },
}));
vi.mock('../../middleware/logger.mjs', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  redactUrl: (u) => u,
}));

import { sessionGuard, isGuardedPath, GUARDED_PREFIXES } from '../../middleware/session-guard.mjs';
import { JWT_SECRET, AUTH_COOKIE } from '../../middleware/auth.mjs';

const mw = sessionGuard();

// Payload „normal" — corespunde row-ului activ de mai jos.
const goodPayload = (o = {}) => ({ userId: 7, role: 'user', orgId: 12, tv: 3, ...o });
const sign = (payload) => jwt.sign(payload, JWT_SECRET);

const row = (o = {}) => ({
  id: 7, email: 'actor@test.ro', nume: 'Actor', functie: 'Inspector',
  compartiment: 'Juridic', institutie: 'Instituția', role: 'user',
  org_id: 12, token_version: 3, force_password_change: false, ...o,
});

function mkReq({ path = '/api/x', token = null, bearer = null } = {}) {
  const headers = {};
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return {
    path,
    cookies: token ? { [AUTH_COOKIE]: token } : {},
    get(name) { return headers[String(name).toLowerCase()] || ''; },
  };
}

function mkRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

async function run(reqOpts) {
  const req = mkReq(reqOpts);
  const res = mkRes();
  const next = vi.fn();
  await mw(req, res, next);
  return { req, res, next };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.dbReady = true;
});

describe('sessionGuard — prefixe', () => {
  it('GUARDED_PREFIXES sunt /api/, /flows/, /admin/ — FĂRĂ /auth/', () => {
    expect([...GUARDED_PREFIXES]).toEqual(['/api/', '/flows/', '/admin/']);
    expect(isGuardedPath('/auth/login')).toBe(false);
    expect(isGuardedPath('/api/foo')).toBe(true);
    expect(isGuardedPath('/flows/1')).toBe(true);
    expect(isGuardedPath('/admin/users')).toBe(true);
  });
});

describe('sessionGuard — treceri fără verificare DB', () => {
  it('#1 rută nepăzită (/login) → next, fără query', async () => {
    const { res, next } = await run({ path: '/login', token: sign(goodPayload()) });
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeNull();
    expect(h.queryMock).not.toHaveBeenCalled();
  });

  it('#2 POST /auth/login (capcana!) → next, fără query, chiar cu cookie revocat', async () => {
    const { next } = await run({ path: '/auth/login', token: sign(goodPayload({ tv: 99 })) });
    expect(next).toHaveBeenCalledOnce();
    expect(h.queryMock).not.toHaveBeenCalled();
  });

  it('#3 /api/x fără token → next, fără query', async () => {
    const { next } = await run({ path: '/api/x', token: null });
    expect(next).toHaveBeenCalledOnce();
    expect(h.queryMock).not.toHaveBeenCalled();
  });

  it('#4 /api/x cu token invalid → next, fără query', async () => {
    const { next } = await run({ path: '/api/x', token: 'not-a-jwt' });
    expect(next).toHaveBeenCalledOnce();
    expect(h.queryMock).not.toHaveBeenCalled();
  });

  it('#5 token funcțional fără userId (upload/signer) → next, fără query', async () => {
    const { next } = await run({ path: '/flows/1/upload', token: sign({ flowId: 1, signer: true }) });
    expect(next).toHaveBeenCalledOnce();
    expect(h.queryMock).not.toHaveBeenCalled();
  });
});

describe('sessionGuard — fail-closed', () => {
  it('#6 DB_READY=false → 503 db_unavailable, fără next', async () => {
    h.dbReady = false;
    const { res, next } = await run({ path: '/api/x', token: sign(goodPayload()) });
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: 'db_unavailable' });
    expect(next).not.toHaveBeenCalled();
    expect(h.queryMock).not.toHaveBeenCalled();
  });

  it('#7 pool.query respinge → 503 db_unavailable, fără next', async () => {
    h.queryMock.mockRejectedValueOnce(new Error('db down'));
    const { res, next } = await run({ path: '/api/x', token: sign(goodPayload()) });
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: 'db_unavailable' });
    expect(next).not.toHaveBeenCalled();
  });
});

describe('sessionGuard — revocare', () => {
  it('#8 rows:[] (cont dezactivat) → 401 session_revoked', async () => {
    h.queryMock.mockResolvedValueOnce({ rows: [] });
    const { res, next } = await run({ path: '/api/x', token: sign(goodPayload()) });
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: 'session_revoked' });
    expect(next).not.toHaveBeenCalled();
  });

  it('#9 tv JWT ≠ token_version DB → 401 token_revoked', async () => {
    h.queryMock.mockResolvedValueOnce({ rows: [row({ token_version: 4 })] });
    const { res, next } = await run({ path: '/api/x', token: sign(goodPayload({ tv: 3 })) });
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: 'token_revoked' });
    expect(next).not.toHaveBeenCalled();
  });

  it('#10 role JWT (admin) ≠ DB (user) → 401 session_role_stale', async () => {
    h.queryMock.mockResolvedValueOnce({ rows: [row({ role: 'user' })] });
    const { res, next } = await run({ path: '/admin/x', token: sign(goodPayload({ role: 'admin' })) });
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: 'session_role_stale' });
    expect(next).not.toHaveBeenCalled();
  });

  it('#11 orgId JWT 5, DB null → 401 session_org_stale (null-aware)', async () => {
    h.queryMock.mockResolvedValueOnce({ rows: [row({ org_id: null })] });
    const { res, next } = await run({ path: '/api/x', token: sign(goodPayload({ orgId: 5 })) });
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: 'session_org_stale' });
    expect(next).not.toHaveBeenCalled();
  });

  it('#12 orgId JWT null, DB null (super-admin) → next', async () => {
    h.queryMock.mockResolvedValueOnce({ rows: [row({ org_id: null })] });
    const { res, next } = await run({ path: '/api/x', token: sign(goodPayload({ orgId: null })) });
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeNull();
  });
});

describe('sessionGuard — happy path & regresie SQL', () => {
  it('#13 totul OK → next + req._actorRow setat', async () => {
    h.queryMock.mockResolvedValueOnce({ rows: [row()] });
    const { req, res, next } = await run({ path: '/api/x', token: sign(goodPayload()) });
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeNull();
    expect(req._actorRow).toEqual(row());
  });

  it('token acceptat și din Authorization: Bearer, nu doar cookie', async () => {
    h.queryMock.mockResolvedValueOnce({ rows: [row()] });
    const req = mkReq({ path: '/api/x', bearer: sign(goodPayload()) });
    const res = mkRes(); const next = vi.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req._actorRow).toEqual(row());
  });

  it('#14 regresie SQL: WHERE id=$1 + deleted_at IS NULL; NU pe email', async () => {
    h.queryMock.mockResolvedValueOnce({ rows: [row()] });
    await run({ path: '/api/x', token: sign(goodPayload()) });
    const [sql, params] = h.queryMock.mock.calls[0];
    expect(sql).toMatch(/WHERE\s+id\s*=\s*\$1/i);
    expect(sql).toMatch(/deleted_at\s+IS\s+NULL/i);
    expect(sql).not.toMatch(/WHERE\s+(?:lower\s*\(\s*)?email/i);
    expect(sql).not.toMatch(/AND\s+(?:lower\s*\(\s*)?email/i);
    expect(params).toEqual([7]);
  });
});
