/**
 * DocFlowAI — DB live (Postgres real): SEC-88 revocare globală de sesiune.
 *
 * Rulează sessionGuard peste routere REALE, pe un Postgres efemer. Verifică REZULTATUL
 * (status + stare DB), nu ordinea apelurilor — sigur la refactor.
 *
 * Fixture-urile trec prin contractul de producție: hashPassword() real, email lowercased,
 * RETURNING id (fără id-uri hardcodate).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { hasTestDb, migrate, pool, truncateAll } from '../helpers/db-real.mjs';
import { hashPassword } from '../../middleware/auth.mjs';
import { sessionGuard } from '../../middleware/session-guard.mjs';
import usersRouter from '../../routes/admin/users.mjs';
import templatesRouter from '../../routes/templates.mjs';
import authRouter, { injectRateLimiter } from '../../routes/auth.mjs';

const d = describe.skipIf(!hasTestDb());
const PWD = 'Parola!123';

function createApp() {
  injectRateLimiter(async () => ({ blocked: false }), async () => {}, async () => {});
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  // Ordinea din index.mjs: garda ÎNAINTE de routere.
  app.use(sessionGuard());
  app.use('/', authRouter);
  app.use('/', templatesRouter);
  app.use('/', usersRouter);
  return app;
}

async function seed() {
  const orgId = (await pool.query(`INSERT INTO organizations(name) VALUES('Org SEC88') RETURNING id`)).rows[0].id;
  const hash = await hashPassword(PWD);
  const admin = (await pool.query(
    `INSERT INTO users(email,password_hash,nume,role,org_id,institutie,token_version)
     VALUES('admin88@x.ro',$1,'Admin','admin',$2,'Instituția',1) RETURNING id`, [hash, orgId]
  )).rows[0].id;
  const normal = (await pool.query(
    `INSERT INTO users(email,password_hash,nume,role,org_id,institutie,token_version)
     VALUES('normal88@x.ro',$1,'Normal','user',$2,'Instituția',1) RETURNING id`, [hash, orgId]
  )).rows[0].id;
  const second = (await pool.query(
    `INSERT INTO users(email,password_hash,nume,role,org_id,institutie,token_version)
     VALUES('second88@x.ro',$1,'Second','user',$2,'Instituția',1) RETURNING id`, [hash, orgId]
  )).rows[0].id;
  return { orgId, admin, normal, second };
}

async function loginCookie(app, email) {
  const res = await request(app).post('/auth/login').send({ email, password: PWD });
  expect(res.status).toBe(200);
  const setC = res.headers['set-cookie'] || [];
  const auth = setC.find((v) => v.startsWith('auth_token=')).split(';')[0];
  return auth;
}

let f;
beforeAll(migrate);
beforeEach(async () => { await truncateAll(); f = await seed(); });

d('SEC-88 revocare live pe Postgres real', () => {
  it('1+2: login → 200; apoi soft-delete+bump → ACEEAȘI cerere, ACELAȘI cookie → 401 session_revoked', async () => {
    const app = createApp();
    const cookie = await loginCookie(app, 'normal88@x.ro');

    const ok = await request(app).get('/api/templates').set('Cookie', cookie);
    expect(ok.status).toBe(200);

    await pool.query('UPDATE users SET deleted_at=NOW(), token_version=token_version+1 WHERE id=$1', [f.normal]);

    const revoked = await request(app).get('/api/templates').set('Cookie', cookie);
    expect(revoked.status).toBe(401);
    expect(revoked.body.error).toBe('session_revoked'); // fără restart app, fără cache
  });

  it('3: al doilea utilizator activ rămâne NEAFECTAT (200) după revocarea primului', async () => {
    const app = createApp();
    const normalCookie = await loginCookie(app, 'normal88@x.ro');
    const secondCookie = await loginCookie(app, 'second88@x.ro');

    await pool.query('UPDATE users SET deleted_at=NOW(), token_version=token_version+1 WHERE id=$1', [f.normal]);

    expect((await request(app).get('/api/templates').set('Cookie', normalCookie)).status).toBe(401);
    expect((await request(app).get('/api/templates').set('Cookie', secondCookie)).status).toBe(200);
  });

  it('4: reactivare (deleted_at=NULL, tv bump) → cookie vechi rămâne 401; după re-login → 200', async () => {
    const app = createApp();
    const oldCookie = await loginCookie(app, 'normal88@x.ro');

    await pool.query('UPDATE users SET deleted_at=NOW(), token_version=token_version+1 WHERE id=$1', [f.normal]);
    expect((await request(app).get('/api/templates').set('Cookie', oldCookie)).status).toBe(401);

    // Reactivare: contul revine, dar tv rămâne bump-uit → cookie-ul vechi e încă invalid.
    await pool.query('UPDATE users SET deleted_at=NULL WHERE id=$1', [f.normal]);
    const stillRevoked = await request(app).get('/api/templates').set('Cookie', oldCookie);
    expect(stillRevoked.status).toBe(401);
    expect(stillRevoked.body.error).toBe('token_revoked');

    // După re-login, sesiunea nouă are tv-ul curent → 200.
    const freshCookie = await loginCookie(app, 'normal88@x.ro');
    expect((await request(app).get('/api/templates').set('Cookie', freshCookie)).status).toBe(200);
  });

  it('5: schimbare de rol prin PUT /admin/users/:id (bump #87) → cookie vechi al țintei → 401', async () => {
    const app = createApp();
    const normalCookie = await loginCookie(app, 'normal88@x.ro');
    const adminCookie = await loginCookie(app, 'admin88@x.ro');

    // Înainte de schimbare, sesiunea normalului e validă.
    expect((await request(app).get('/api/templates').set('Cookie', normalCookie)).status).toBe(200);

    // Adminul schimbă rolul țintei (user → org_admin): #87 bump-uiește token_version.
    const put = await request(app).put(`/admin/users/${f.normal}`)
      .set('Cookie', [adminCookie, 'csrf_token=db-csrf']).set('x-csrf-token', 'db-csrf')
      .send({ role: 'org_admin' });
    expect(put.status).toBe(200);

    // Cookie-ul vechi al țintei (tv învechit + rol învechit) e respins de gardă.
    const after = await request(app).get('/api/templates').set('Cookie', normalCookie);
    expect(after.status).toBe(401);
    expect(['token_revoked', 'session_role_stale']).toContain(after.body.error);
  });
});
