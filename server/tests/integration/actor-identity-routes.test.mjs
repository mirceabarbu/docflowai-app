import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import jwt from 'jsonwebtoken';

vi.mock('../../db/index.mjs', () => ({
  pool: { query: vi.fn() },
  DB_READY: true,
  DB_LAST_ERROR: null,
  requireDb: vi.fn(() => false),
  invalidateOrgUserCache: vi.fn(),
  writeAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/user-leave.mjs', () => ({
  validateLeaveSettings: vi.fn((v) => ({ ok: true, value: v })),
  setUserLeave: vi.fn().mockResolvedValue(undefined),
  clearUserLeave: vi.fn().mockResolvedValue(undefined),
  getLeaveInfo: vi.fn(),
  batchGetLeaveInfo: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock('../../middleware/logger.mjs', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  },
}));

vi.mock('../../middleware/rateLimiter.mjs', () => ({
  createRateLimiter: () => (_req, _res, next) => next(),
}));

vi.mock('otplib', () => ({
  generateSecret: vi.fn(() => 'SECRET'),
  generateSync: vi.fn(() => '123456'),
  verifySync: vi.fn(() => true),
}));

import * as db from '../../db/index.mjs';
import * as leave from '../../services/user-leave.mjs';
import usersRouter from '../../routes/admin/users.mjs';
import templatesRouter from '../../routes/templates.mjs';
import authRouter from '../../routes/auth.mjs';
import totpRouter from '../../routes/totp.mjs';
import { JWT_SECRET } from '../../middleware/auth.mjs';

function token(overrides = {}) {
  return jwt.sign({ userId: 20, email: 'same@example.ro', role: 'org_admin', orgId: 200, tv: 1, ...overrides }, JWT_SECRET, { expiresIn: '1h' });
}

function cookie(overrides) {
  return `auth_token=${token(overrides)}`;
}

function csrf(req, overrides) {
  return req.set('Cookie', [cookie(overrides), 'csrf_token=test-csrf']).set('x-csrf-token', 'test-csrf');
}

function actor(overrides = {}) {
  return {
    id: 20, email: 'same@example.ro', nume: 'Activ B', functie: 'Șef Serviciu',
    compartiment: 'Economic', institutie: 'Instituția B', role: 'org_admin',
    org_id: 200, token_version: 1, force_password_change: false, ...overrides,
  };
}

function app(...routers) {
  const instance = express();
  instance.use(express.json());
  instance.use(cookieParser());
  for (const router of routers) instance.use('/', router);
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.pool.query.mockReset();
});

describe('actor identity before users authorization', () => {
  it('/users scopes the business query to the active DB actor org', async () => {
    db.pool.query
      .mockResolvedValueOnce({ rows: [actor()] })
      .mockResolvedValueOnce({ rows: [{ id: 21, email: 'b@x.ro', org_id: 200 }] });
    const res = await request(app(usersRouter)).get('/users').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(db.pool.query.mock.calls[0][0]).toMatch(/WHERE id = \$1[\s\S]*deleted_at IS NULL/i);
    expect(db.pool.query.mock.calls[1][0]).toMatch(/org_id=\$1/i);
    expect(db.pool.query.mock.calls[1][1][0]).toBe(200);
  });

  it('/users fails closed without actor org and never lists globally', async () => {
    db.pool.query.mockResolvedValueOnce({ rows: [actor({ org_id: null })] });
    const res = await request(app(usersRouter)).get('/users')
      .set('Cookie', cookie({ orgId: null }));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('user_without_org');
    expect(db.pool.query).toHaveBeenCalledTimes(1);
  });

  it('/users stale tv stops before the business query', async () => {
    db.pool.query.mockResolvedValueOnce({ rows: [actor({ token_version: 2 })] });
    const res = await request(app(usersRouter)).get('/users').set('Cookie', cookie());
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('token_revoked');
    expect(db.pool.query).toHaveBeenCalledTimes(1);
  });

  it('/admin/users rejects JWT admin after DB role became user', async () => {
    db.pool.query.mockResolvedValueOnce({ rows: [actor({ role: 'user' })] });
    const res = await request(app(usersRouter)).get('/admin/users')
      .set('Cookie', cookie({ role: 'admin' }));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('session_role_stale');
    expect(db.pool.query).toHaveBeenCalledTimes(1);
  });

  it('/admin/users org_admin cannot traverse tenants even with include_deleted', async () => {
    db.pool.query
      .mockResolvedValueOnce({ rows: [actor()] })
      .mockResolvedValueOnce({ rows: [{ id: 20, org_id: 200 }] });
    const res = await request(app(usersRouter)).get('/admin/users?include_deleted=true')
      .set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(db.pool.query.mock.calls[1][0]).toMatch(/org_id=\$1/i);
    expect(db.pool.query.mock.calls[1][1]).toEqual([200]);
  });

  it('/admin/users refuses a soft-deleted actor before listing', async () => {
    db.pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app(usersRouter)).get('/admin/users').set('Cookie', cookie());
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('actor_not_found');
    expect(db.pool.query).toHaveBeenCalledTimes(1);
  });
});

describe('actor identity before user creation and leave mutation', () => {
  it('org_admin creates only in the org read from DB', async () => {
    db.pool.query
      .mockResolvedValueOnce({ rows: [actor()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 30, email: 'new@x.ro', org_id: 200 }] });
    const res = await csrf(request(app(usersRouter)).post('/admin/users'))
      .send({ email: 'new@x.ro', password: 'Parola!123', role: 'user', nume: 'Nou User' });
    expect(res.status).toBe(201);
    const insert = db.pool.query.mock.calls.find(([sql]) => /INSERT INTO users/i.test(sql));
    expect(insert).toBeTruthy();
    expect(insert[1]).toContain(200);
  });

  it('stale org stops before password hash and INSERT', async () => {
    db.pool.query.mockResolvedValueOnce({ rows: [actor()] });
    const res = await csrf(request(app(usersRouter)).post('/admin/users'), { orgId: 100 })
      .send({ email: 'new@x.ro', password: 'Parola!123', role: 'user', nume: 'Nou User' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('session_org_stale');
    expect(db.pool.query).toHaveBeenCalledTimes(1);
  });

  it('self leave uses actor.id and never resolves by email', async () => {
    db.pool.query.mockResolvedValueOnce({ rows: [actor()] });
    const res = await csrf(request(app(usersRouter)).put('/api/users/me/leave')).send({ isOnLeave: true });
    expect(res.status).toBe(200);
    expect(leave.setUserLeave).toHaveBeenCalledWith(expect.objectContaining({ targetUserId: 20 }));
    expect(db.pool.query.mock.calls[0][0]).not.toMatch(/WHERE\s+email/i);
  });

  it.each(['admin', 'org_admin'])('%s cannot administer leave across orgs', async (role) => {
    db.pool.query
      .mockResolvedValueOnce({ rows: [actor({ role })] })
      .mockResolvedValueOnce({ rows: [{ id: 10, org_id: 100 }] });
    const res = await csrf(request(app(usersRouter)).put('/admin/users/10/leave'), { role }).send({ isOnLeave: true });
    expect(res.status).toBe(403);
    expect(leave.setUserLeave).not.toHaveBeenCalled();
  });

  it('admin leave returns 404 for a soft-deleted target', async () => {
    db.pool.query
      .mockResolvedValueOnce({ rows: [actor()] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await csrf(request(app(usersRouter)).delete('/admin/users/10/leave'));
    expect(res.status).toBe(404);
    expect(leave.clearUserLeave).not.toHaveBeenCalled();
  });
});

describe('changing a role invalidates active sessions (SEC-87 PAS 3e)', () => {
  it('role change bumps token_version in the same UPDATE', async () => {
    db.pool.query
      .mockResolvedValueOnce({ rows: [{ role: 'org_admin' }] }) // current role in DB
      .mockResolvedValueOnce({ rows: [{ id: 10, org_id: 200, role: 'user' }] }); // UPDATE
    const res = await csrf(request(app(usersRouter)).put('/admin/users/10'), { role: 'admin' })
      .send({ role: 'user' });
    expect(res.status).toBe(200);
    const update = db.pool.query.mock.calls.find(([sql]) => /UPDATE users SET/i.test(sql));
    expect(update).toBeTruthy();
    expect(update[0]).toMatch(/token_version=COALESCE\(token_version,1\)\+1/i);
  });

  it('re-sending the SAME role does not bump token_version', async () => {
    db.pool.query
      .mockResolvedValueOnce({ rows: [{ role: 'user' }] }) // current role already 'user'
      .mockResolvedValueOnce({ rows: [{ id: 10, org_id: 200, role: 'user' }] }); // UPDATE
    const res = await csrf(request(app(usersRouter)).put('/admin/users/10'), { role: 'admin' })
      .send({ role: 'user' });
    expect(res.status).toBe(200);
    const update = db.pool.query.mock.calls.find(([sql]) => /UPDATE users SET/i.test(sql));
    expect(update).toBeTruthy();
    expect(update[0]).not.toMatch(/token_version/i);
  });
});

describe('templates and /auth/me use the authoritative row', () => {
  it('GET templates scopes shared templates to DB org', async () => {
    db.pool.query
      .mockResolvedValueOnce({ rows: [actor()] })
      .mockResolvedValueOnce({ rows: [{ id: 2, org_id: 200, shared: true, user_email: 'other@x.ro' }] });
    const res = await request(app(templatesRouter)).get('/api/templates').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(db.pool.query.mock.calls[1][1]).toEqual(['same@example.ro', 200]);
  });

  it('POST template persists DB org and DB email', async () => {
    db.pool.query
      .mockResolvedValueOnce({ rows: [actor()] })
      .mockResolvedValueOnce({ rows: [{ id: 3, user_email: 'same@example.ro', org_id: 200 }] });
    const res = await request(app(templatesRouter)).post('/api/templates')
      .set('Cookie', cookie()).send({ name: 'Shared B', signers: [{ name: 'Ion', email: 'ion@x.ro' }], shared: true });
    expect(res.status).toBe(201);
    expect(db.pool.query.mock.calls[1][1]).toEqual(expect.arrayContaining(['same@example.ro', 200]));
  });

  it('/auth/me never substitutes a new account having the reused email', async () => {
    db.pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app(authRouter)).get('/auth/me')
      .set('Cookie', cookie({ userId: 10, orgId: 100 }));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('actor_not_found');
    expect(res.headers['set-cookie']?.join(';')).toMatch(/auth_token=;/);
    expect(db.pool.query.mock.calls[0][1]).toEqual([10]);
  });

  it('/auth/me fails closed with 503 on DB error', async () => {
    db.pool.query.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app(authRouter)).get('/auth/me').set('Cookie', cookie());
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('identity_lookup_failed');
  });

  it('/auth/me returns the DB profile, not stale JWT profile claims', async () => {
    db.pool.query.mockResolvedValueOnce({ rows: [actor()] });
    const res = await request(app(authRouter)).get('/auth/me')
      .set('Cookie', cookie({ nume: 'Vechi', functie: 'Inspector vechi' }));
    expect(res.status).toBe(200);
    expect(res.body.nume).toBe('Activ B');
    expect(res.body.functie).toBe('Șef Serviciu');
  });
});

describe('TOTP pending identity is fail-closed', () => {
  function pending(overrides = {}) {
    return jwt.sign({
      requires2fa: true, userId: 20, email: 'same@example.ro', role: 'org_admin',
      orgId: 200, tv: 1, ...overrides,
    }, JWT_SECRET, { expiresIn: '5m' });
  }

  function totpUser(overrides = {}) {
    return {
      ...actor(), totp_secret: 'SECRET', totp_enabled: true, totp_backup_codes: [],
      ...overrides,
    };
  }

  it('soft-deleted pending user is rejected without auth cookie', async () => {
    db.pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app(totpRouter)).post('/auth/totp/verify')
      .send({ pending_token: pending({ userId: 10, orgId: 100 }), code: '123456' });
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie'] || []).not.toEqual(expect.arrayContaining([expect.stringMatching(/^auth_token=/)]));
    expect(db.pool.query.mock.calls[0][0]).toMatch(/deleted_at IS NULL/i);
  });

  it.each([
    ['role', { role: 'admin' }],
    ['org', { orgId: 100 }],
    ['tv', { tv: 2 }],
  ])('stale pending %s is rejected without auth cookie', async (_label, claims) => {
    db.pool.query.mockResolvedValueOnce({ rows: [totpUser()] });
    const res = await request(app(totpRouter)).post('/auth/totp/verify')
      .send({ pending_token: pending(claims), code: '123456' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('token_revoked');
    expect(res.headers['set-cookie'] || []).not.toEqual(expect.arrayContaining([expect.stringMatching(/^auth_token=/)]));
  });

  it('valid pending identity emits a complete auth token', async () => {
    db.pool.query.mockResolvedValueOnce({ rows: [totpUser()] });
    const res = await request(app(totpRouter)).post('/auth/totp/verify')
      .send({ pending_token: pending(), code: '123456' });
    expect(res.status).toBe(200);
    const raw = res.headers['set-cookie'].find((value) => value.startsWith('auth_token='));
    const full = jwt.verify(raw.split(';')[0].slice('auth_token='.length), JWT_SECRET);
    expect(full).toMatchObject({ userId: 20, orgId: 200, role: 'org_admin', tv: 1 });
  });
});
