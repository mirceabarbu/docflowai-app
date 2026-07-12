import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { hasTestDb, makeAuthCookie, migrate, pool, truncateAll } from '../helpers/db-real.mjs';
import { hashPassword, JWT_SECRET } from '../../middleware/auth.mjs';
import { resolveActor } from '../../services/actor-identity.mjs';
import usersRouter from '../../routes/admin/users.mjs';
import templatesRouter from '../../routes/templates.mjs';
import authRouter, { injectRateLimiter } from '../../routes/auth.mjs';
import totpRouter from '../../routes/totp.mjs';
import flowsRouter, { injectFlowDeps } from '../../routes/flows.mjs';

const d = describe.skipIf(!hasTestDb());
const SHARED_EMAIL = 'reused@example.ro';

function createApp() {
  // Rate-limiterul de login e injectat din index.mjs, care nu ruleaza in harness-ul de test.
  // Fara injectie, auth.mjs arunca TypeError la _checkLoginRate() si cererea nu raspunde niciodata.
  injectRateLimiter(
    async () => ({ blocked: false }),
    async () => {},
    async () => {},
  );
  injectFlowDeps({
    notify: async () => undefined, wsPush: () => undefined, PDFLib: null,
    stampFooterOnPdf: null, isSignerTokenExpired: () => false,
    newFlowId: () => `EMAIL_REUSE_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    buildSignerLink: (_req, flowId, signerToken) => `https://test/flow=${flowId}&token=${signerToken}`,
    stripSensitive: (data) => data, stripPdfB64: (data) => data,
    sendSignerEmail: async () => ({ ok: true }),
  });
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/', usersRouter);
  app.use('/', templatesRouter);
  app.use('/', authRouter);
  app.use('/', totpRouter);
  app.use('/', flowsRouter);
  return app;
}

function csrf(req, authCookie) {
  return req.set('Cookie', [authCookie, 'csrf_token=db-csrf']).set('x-csrf-token', 'db-csrf');
}

async function seed() {
  const orgA = (await pool.query(`INSERT INTO organizations(name) VALUES('Org A') RETURNING id`)).rows[0].id;
  const orgB = (await pool.query(`INSERT INTO organizations(name) VALUES('Org B') RETURNING id`)).rows[0].id;
  const passwordHash = await hashPassword('Parola!123');
  const deleted = (await pool.query(
    `INSERT INTO users(email,password_hash,nume,functie,institutie,compartiment,role,org_id,token_version,deleted_at)
     VALUES($1,$2,'Cont Vechi','Inspector vechi','Instituția A','A','org_admin',$3,1,NOW()) RETURNING id`,
    [SHARED_EMAIL, passwordHash, orgA]
  )).rows[0].id;
  const active = (await pool.query(
    `INSERT INTO users(email,password_hash,nume,functie,institutie,compartiment,role,org_id,token_version)
     VALUES($1,$2,'Cont Activ','Șef Serviciu','Instituția B','B','org_admin',$3,1) RETURNING id`,
    [SHARED_EMAIL.toUpperCase(), passwordHash, orgB]
  )).rows[0].id;
  const targetA = (await pool.query(
    `INSERT INTO users(email,password_hash,nume,role,org_id,institutie,token_version) VALUES('target-a@example.ro','x','Target A','user',$1,'Instituția A',1) RETURNING id`, [orgA]
  )).rows[0].id;
  const targetB = (await pool.query(
    `INSERT INTO users(email,password_hash,nume,role,org_id,institutie,token_version) VALUES('target-b@example.ro','x','Target B','user',$1,'Instituția B',1) RETURNING id`, [orgB]
  )).rows[0].id;
  await pool.query(
    `INSERT INTO templates(user_email,institutie,name,signers,shared,org_id) VALUES
      ('a@example.ro','Instituția A','Shared A','[]'::jsonb,TRUE,$1),
      ('b@example.ro','Instituția B','Shared B','[]'::jsonb,TRUE,$2)`, [orgA, orgB]
  );
  return { orgA, orgB, deleted, active, targetA, targetB, passwordHash };
}

let f;
beforeAll(migrate);
beforeEach(async () => {
  await truncateAll();
  f = await seed();
});

function activeClaims(overrides = {}) {
  return { userId: f.active, email: SHARED_EMAIL, role: 'org_admin', orgId: f.orgB, tv: 1, ...overrides };
}

function activeCookie(overrides) {
  return makeAuthCookie(activeClaims(overrides));
}

d('email reuse authorization on real PostgreSQL', () => {
  it('stores multiple historical rows for one case-insensitive email', async () => {
    const rows = await pool.query('SELECT id FROM users WHERE LOWER(email)=LOWER($1)', [SHARED_EMAIL]);
    expect(rows.rowCount).toBe(2);
  });

  it('resolveActor selects the active account strictly by id', async () => {
    const result = await resolveActor(activeClaims());
    expect(result).toMatchObject({ ok: true, user: { id: f.active, org_id: f.orgB, functie: 'Șef Serviciu' } });
  });

  it('resolveActor refuses the soft-deleted id even when email was reused', async () => {
    const result = await resolveActor({ userId: f.deleted, email: SHARED_EMAIL, role: 'org_admin', orgId: f.orgA, tv: 1 });
    expect(result).toMatchObject({ ok: false, status: 403, error: 'actor_not_found' });
  });

  it('/users scopes to the actor institution, not to a soft-deleted homonym', async () => {
    const res = await request(createApp()).get('/users').set('Cookie', activeCookie());
    expect(res.status).toBe(200);
    expect(res.body.some((u) => u.id === f.targetA)).toBe(false);
    expect(res.body.some((u) => u.id === f.targetB)).toBe(true);
  });

  it('/admin/users for org_admin B does not expose A, including deleted rows', async () => {
    const res = await request(createApp()).get('/admin/users?include_deleted=true').set('Cookie', activeCookie());
    expect(res.status).toBe(200);
    expect(res.body.some((u) => u.id === f.targetA || u.id === f.deleted)).toBe(false);
  });

  it('POST /admin/users by org_admin B persists org B', async () => {
    const res = await csrf(request(createApp()).post('/admin/users'), activeCookie()).send({
      email: 'created-b@example.ro', password: 'Parola!123', nume: 'Creat B', role: 'user', skip_verification: true,
    });
    expect(res.status).toBe(201);
    const row = await pool.query(`SELECT org_id FROM users WHERE email='created-b@example.ro'`);
    expect(String(row.rows[0].org_id)).toBe(String(f.orgB));
  });

  it('self leave updates only the active reused-email account', async () => {
    const res = await csrf(request(createApp()).put('/api/users/me/leave'), activeCookie()).send({
      leave_start: '2026-07-13', leave_end: '2026-07-14', leave_reason: 'Test',
    });
    expect(res.status).toBe(200);
    const rows = await pool.query('SELECT id,leave_start,leave_end FROM users WHERE id=ANY($1)', [[f.deleted, f.active]]);
    const activeRow = rows.rows.find((r) => r.id === f.active);
    const deletedRow = rows.rows.find((r) => r.id === f.deleted);
    expect(activeRow.leave_start).not.toBeNull();
    expect(activeRow.leave_end).not.toBeNull();
    expect(deletedRow.leave_start).toBeNull();
    expect(deletedRow.leave_end).toBeNull();
  });

  it.each(['admin', 'org_admin'])('%s B cannot administer target A leave', async (role) => {
    await pool.query('UPDATE users SET role=$1 WHERE id=$2', [role, f.active]);
    const res = await csrf(request(createApp()).put(`/admin/users/${f.targetA}/leave`), activeCookie({ role })).send({
      leave_start: '2026-07-13', leave_end: '2026-07-14', leave_reason: 'Test',
    });
    expect(res.status).toBe(403);
  });

  it('GET templates B excludes shared A', async () => {
    const res = await request(createApp()).get('/api/templates').set('Cookie', activeCookie());
    expect(res.status).toBe(200);
    expect(res.body.map((t) => t.name)).toContain('Shared B');
    expect(res.body.map((t) => t.name)).not.toContain('Shared A');
  });

  it('POST template B persists org B', async () => {
    const res = await request(createApp()).post('/api/templates').set('Cookie', activeCookie()).send({
      name: 'New Shared B', signers: [{ name: 'Ion', email: 'ion@example.ro' }], shared: true,
    });
    expect(res.status).toBe(201);
    const row = await pool.query(`SELECT org_id FROM templates WHERE name='New Shared B'`);
    expect(String(row.rows[0].org_id)).toBe(String(f.orgB));
  });

  it('login authenticates the active account for the reused email', async () => {
    const res = await request(createApp()).post('/auth/login').send({ email: SHARED_EMAIL, password: 'Parola!123' });
    expect(res.status).toBe(200);
    const auth = res.headers['set-cookie'].find((v) => v.startsWith('auth_token='));
    const payload = jwt.verify(auth.split(';')[0].slice('auth_token='.length), JWT_SECRET);
    expect(payload.userId).toBe(f.active);
  });

  it('/auth/me refuses the deleted historical id and clears auth', async () => {
    const old = makeAuthCookie({ userId: f.deleted, email: SHARED_EMAIL, role: 'org_admin', orgId: f.orgA, tv: 1 });
    const res = await request(createApp()).get('/auth/me').set('Cookie', old);
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie'].join(';')).toMatch(/auth_token=;/);
  });

  it('TOTP pending for the deleted historical id emits no auth token', async () => {
    const pending = jwt.sign({ requires2fa: true, userId: f.deleted, role: 'org_admin', orgId: f.orgA, tv: 1 }, JWT_SECRET, { expiresIn: '5m' });
    const res = await request(createApp()).post('/auth/totp/verify').send({ pending_token: pending, code: '123456' });
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie'] || []).not.toEqual(expect.arrayContaining([expect.stringMatching(/^auth_token=/)]));
  });

  it('POST /flows snapshots metadata from the active B account', async () => {
    const res = await request(createApp()).post('/flows').set('Cookie', activeCookie()).send({
      docName: 'Document DB', initName: 'Date client ignorate', initEmail: SHARED_EMAIL,
      signers: [{ name: 'Semnatar Test', email: 'signer@example.ro', rol: 'AVIZAT' }],
    });
    expect(res.status).toBe(200);
    const row = await pool.query('SELECT data FROM flows WHERE id=$1', [res.body.flowId]);
    expect(row.rows[0].data).toMatchObject({
      initName: 'Cont Activ', initFunctie: 'Șef Serviciu', institutie: 'Instituția B',
      compartiment: 'B', orgId: f.orgB,
    });
    expect(row.rows[0].data.initFunctie).not.toBe('Inspector vechi');
  });

  it('stale admin role is rejected before every route business query', async () => {
    const stale = activeCookie({ role: 'admin' });
    for (const path of ['/users', '/admin/users', '/api/templates', '/auth/me']) {
      const res = await request(createApp()).get(path).set('Cookie', stale);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('session_role_stale');
    }
  });

  it('a third deleted duplicate does not change active resolution', async () => {
    await pool.query(
      `INSERT INTO users(email,password_hash,nume,functie,role,org_id,token_version,deleted_at)
       VALUES($1,'x','Mai Vechi','Altă funcție','user',$2,1,NOW())`, [SHARED_EMAIL, f.orgA]
    );
    const result = await resolveActor(activeClaims());
    expect(result).toMatchObject({ ok: true, user: { id: f.active, functie: 'Șef Serviciu' } });
  });
});
