/**
 * DocFlowAI — DB live (Postgres real): #94 auth lifecycle hardening (v3.9.678).
 *
 * Rulează rutele REALE din auth.mjs + sessionGuard peste un Postgres efemer. Verifică
 * REZULTATUL (status + stare DB + cookie emis), nu ordinea apelurilor.
 *
 * Acoperă:
 *   A — /auth/refresh cu DB indisponibil ⇒ 503 db_unavailable, FĂRĂ Set-Cookie nou.
 *   B — schimbarea parolei ⇒ token_version +1 în DB.
 *   B — schimbarea parolei ⇒ Set-Cookie auth_token nou, cu tv == noul token_version (sesiunea
 *       curentă rămâne validă).
 *   B — JWT emis ÎNAINTE de schimbare ⇒ respins de sessionGuard pe /api/.
 *   D — parolă de 9 caractere ⇒ 400 password_too_short; 10 ⇒ acceptată.
 */
import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { hasTestDb, migrate, pool, truncateAll } from '../helpers/db-real.mjs';
import { hashPassword } from '../../middleware/auth.mjs';
import { sessionGuard } from '../../middleware/session-guard.mjs';
import { markDbFailed, markDbReady } from '../../db/index.mjs';
import templatesRouter from '../../routes/templates.mjs';
import authRouter, { injectRateLimiter } from '../../routes/auth.mjs';

const d = describe.skipIf(!hasTestDb());
const PWD = 'Parola!123';
const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-vitest-docflowai-2025';
const CSRF = 'db-csrf';

function createApp() {
  injectRateLimiter(async () => ({ blocked: false }), async () => {}, async () => {});
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(sessionGuard());          // ordinea din index.mjs: garda ÎNAINTE de routere
  app.use('/', authRouter);
  app.use('/', templatesRouter);
  return app;
}

async function seed() {
  const orgId = (await pool.query(`INSERT INTO organizations(name) VALUES('Org 94') RETURNING id`)).rows[0].id;
  const hash = await hashPassword(PWD);
  const userId = (await pool.query(
    `INSERT INTO users(email,password_hash,nume,role,org_id,institutie,token_version)
     VALUES('user94@x.ro',$1,'User','user',$2,'Instituția',1) RETURNING id`, [hash, orgId]
  )).rows[0].id;
  return { orgId, userId };
}

// Login → întoarce cookie-ul auth_token (string „auth_token=...").
async function loginCookie(app) {
  const res = await request(app).post('/auth/login').send({ email: 'user94@x.ro', password: PWD });
  expect(res.status).toBe(200);
  const setC = res.headers['set-cookie'] || [];
  return setC.find((v) => v.startsWith('auth_token=')).split(';')[0];
}

function authCookieFrom(setCookieArr) {
  const c = (setCookieArr || []).find((v) => v.startsWith('auth_token='));
  return c ? c.split(';')[0] : null;
}

let f;
beforeAll(migrate);
beforeEach(async () => { markDbReady(); await truncateAll(); f = await seed(); });
afterEach(() => { markDbReady(); });   // orice test care a picat DB-ul îl restaurează

d('#94 auth lifecycle hardening (Postgres real)', () => {
  // ── A — refresh fail-closed ──────────────────────────────────────────────
  it('A: /auth/refresh cu DB indisponibil ⇒ 503 db_unavailable, FĂRĂ Set-Cookie nou', async () => {
    const app = createApp();
    const cookie = await loginCookie(app);

    // Simulează DB picat DUPĂ login (cookie-ul e deja emis).
    markDbFailed('simulare incident');
    try {
      const res = await request(app).post('/auth/refresh').set('Cookie', cookie);
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('db_unavailable');
      // NU emite token nou și NU șterge cookie-ul (cookie-ul vechi rămâne).
      const setC = res.headers['set-cookie'] || [];
      expect(setC.some((v) => v.startsWith('auth_token='))).toBe(false);
    } finally {
      markDbReady();
    }
  });

  // ── B — schimbarea parolei ───────────────────────────────────────────────
  it('B: schimbarea parolei ⇒ token_version +1 în DB', async () => {
    const app = createApp();
    const cookie = await loginCookie(app);

    const before = (await pool.query('SELECT token_version FROM users WHERE id=$1', [f.userId])).rows[0].token_version;

    const res = await request(app).post('/auth/change-password')
      .set('Cookie', [cookie, `csrf_token=${CSRF}`]).set('x-csrf-token', CSRF)
      .send({ current_password: PWD, new_password: 'ParolaNoua!123' });
    expect(res.status).toBe(200);

    const after = (await pool.query('SELECT token_version FROM users WHERE id=$1', [f.userId])).rows[0].token_version;
    expect(Number(after)).toBe(Number(before) + 1);
  });

  it('B: schimbarea parolei ⇒ Set-Cookie auth_token nou cu tv == noul token_version (sesiunea curentă rămâne validă)', async () => {
    const app = createApp();
    const cookie = await loginCookie(app);

    const res = await request(app).post('/auth/change-password')
      .set('Cookie', [cookie, `csrf_token=${CSRF}`]).set('x-csrf-token', CSRF)
      .send({ current_password: PWD, new_password: 'ParolaNoua!123' });
    expect(res.status).toBe(200);

    const newAuth = authCookieFrom(res.headers['set-cookie']);
    expect(newAuth).toBeTruthy();

    const dbTv = (await pool.query('SELECT token_version FROM users WHERE id=$1', [f.userId])).rows[0].token_version;
    const decoded = jwt.verify(newAuth.replace('auth_token=', ''), JWT_SECRET);
    expect(Number(decoded.tv)).toBe(Number(dbTv));

    // Sesiunea curentă (cookie-ul re-emis) rămâne validă pe o rută păzită.
    const stillOk = await request(app).get('/api/templates').set('Cookie', newAuth);
    expect(stillOk.status).toBe(200);
  });

  it('B: JWT emis ÎNAINTE de schimbarea parolei ⇒ respins de sessionGuard pe /api/', async () => {
    const app = createApp();
    const oldCookie = await loginCookie(app);

    // Înainte de schimbare, cookie-ul vechi e valid.
    expect((await request(app).get('/api/templates').set('Cookie', oldCookie)).status).toBe(200);

    const res = await request(app).post('/auth/change-password')
      .set('Cookie', [oldCookie, `csrf_token=${CSRF}`]).set('x-csrf-token', CSRF)
      .send({ current_password: PWD, new_password: 'ParolaNoua!123' });
    expect(res.status).toBe(200);

    // Cookie-ul VECHI (tv învechit) e respins de gardă — celelalte sesiuni au murit.
    const after = await request(app).get('/api/templates').set('Cookie', oldCookie);
    expect(after.status).toBe(401);
    expect(after.body.error).toBe('token_revoked');
  });

  // ── D — lungime minimă 10 ────────────────────────────────────────────────
  it('D: parolă de 9 caractere ⇒ 400 password_too_short; de 10 ⇒ acceptată', async () => {
    const app = createApp();
    const cookie = await loginCookie(app);

    const nine = await request(app).post('/auth/change-password')
      .set('Cookie', [cookie, `csrf_token=${CSRF}`]).set('x-csrf-token', CSRF)
      .send({ current_password: PWD, new_password: '123456789' });      // 9 caractere
    expect(nine.status).toBe(400);
    expect(nine.body.error).toBe('password_too_short');

    const ten = await request(app).post('/auth/change-password')
      .set('Cookie', [cookie, `csrf_token=${CSRF}`]).set('x-csrf-token', CSRF)
      .send({ current_password: PWD, new_password: '1234567890' });     // 10 caractere
    expect(ten.status).toBe(200);
  });
});
