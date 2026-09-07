/**
 * DocFlowAI — DB live (Postgres real): #182 — `force_password_change` devine poartă pe server.
 *
 * Până la acest lot steagul era citit în `sessionGuard` și NEFOLOSIT; singura lui consecință
 * era un banner desenat din `localStorage`, adică o sugestie. Un cont care trebuia să-și
 * schimbe parola putea opera nelimitat, inclusiv semna, cu parola generată de administrator
 * și cunoscută de el.
 *
 * Rulează rutele REALE (auth + templates + flows/crud) peste `sessionGuard`, pe un Postgres
 * efemer. Verifică REZULTATUL (status code + starea din DB), nu ordinea apelurilor.
 *
 * Acoperă:
 *   1 — poarta ține pe /api/                              ⇒ 403 password_change_required
 *   2 — aceeași poartă pe suprafața de semnare (/flows/, /bulk-signing/)
 *   3 — IEȘIREA există: POST /auth/change-password reușește (nu 403)
 *   4 — CICLUL COMPLET: după schimbare, aceeași rută ⇒ 200; steagul e FALSE în DB
 *   5 — nedeteriorare: utilizator fără steag ⇒ 200 de la început
 *   6 — ordinea gărzilor: steag + token_version nepotrivit ⇒ 401 token_revoked
 *   7 — ordinea gărzilor: steag + cont dezactivat        ⇒ 401 session_revoked
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { hasTestDb, migrate, pool, truncateAll, seedFlow } from '../helpers/db-real.mjs';
import { hashPassword } from '../../middleware/auth.mjs';
import { sessionGuard } from '../../middleware/session-guard.mjs';
import { markDbReady } from '../../db/index.mjs';
import templatesRouter from '../../routes/templates.mjs';
import authRouter, { injectRateLimiter } from '../../routes/auth.mjs';

const crudMod = await import('../../routes/flows/crud.mjs');
const crudRouter = crudMod.default;
crudMod._injectDeps({ stripSensitive: (d) => d });

const d = describe.skipIf(!hasTestDb());
const PWD = 'Parola!123';
const NEW_PWD = 'ParolaNoua!456';
const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-vitest-docflowai-2025';
const CSRF = 'db-csrf-182';

function createApp() {
  injectRateLimiter(async () => ({ blocked: false }), async () => {}, async () => {});
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use(sessionGuard());          // ordinea din index.mjs: garda ÎNAINTE de routere
  app.use('/', authRouter);
  app.use('/', templatesRouter);
  app.use('/', crudRouter);
  // Santinelă pe suprafața de semnare în masă. `/bulk-signing/` e prefix PĂZIT (SEC-88.1), dar
  // routerul real trage tot stack-ul STS (fișier NO-TOUCH) și cere sesiune OAuth. Ruta de mai
  // jos răspunde 200 dacă cererea AJUNGE la ea ⇒ un 403 dovedește că poarta a oprit-o ÎNAINTE
  // de orice rută, iar un 200 (utilizator fără steag) dovedește că santinela chiar e atinsă.
  app.post('/bulk-signing/initiate', (req, res) => res.json({ ok: true, sentinel: true }));
  return app;
}

async function seedUserWithPwd({ email, force }) {
  const hash = await hashPassword(PWD);
  const { rows } = await pool.query(
    `INSERT INTO users(email,password_hash,nume,role,org_id,institutie,token_version,force_password_change)
     VALUES($1,$2,'User 182','user',$3,'Instituția',1,$4) RETURNING id`,
    [email, hash, ORG.id, force]
  );
  return rows[0].id;
}

// Login → cookie-ul auth_token (string „auth_token=..."). /auth/login NU e păzit, deci un cont
// cu steagul pus se poate autentifica — altfel n-ar avea cum să ajungă la change-password.
async function loginCookie(app, email) {
  const res = await request(app).post('/auth/login').send({ email, password: PWD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] || []).find((v) => v.startsWith('auth_token=')).split(';')[0];
}

function authCookieFrom(setCookieArr) {
  const c = (setCookieArr || []).find((v) => v.startsWith('auth_token='));
  return c ? c.split(';')[0] : null;
}

const ORG = { id: null };
let flaggedId, cleanId, flaggedFlowId, cleanFlowId;

beforeAll(migrate);
beforeEach(async () => {
  markDbReady();
  await truncateAll();
  ORG.id = (await pool.query(`INSERT INTO organizations(name) VALUES('Org 182') RETURNING id`)).rows[0].id;
  flaggedId = await seedUserWithPwd({ email: 'flagged182@x.ro', force: true });
  cleanId   = await seedUserWithPwd({ email: 'clean182@x.ro',   force: false });
  // Fluxuri proprii: fiecare utilizator e INIȚIATOR pe fluxul lui ⇒ trece de `canActorReadFlow`.
  flaggedFlowId = await seedFlow({ id: 'flow-182-flagged', orgId: ORG.id, initEmail: 'flagged182@x.ro' });
  cleanFlowId   = await seedFlow({ id: 'flow-182-clean',   orgId: ORG.id, initEmail: 'clean182@x.ro' });
});

d('#182 poarta force_password_change (Postgres real)', () => {
  // ── 1 — poarta ține ───────────────────────────────────────────────────────
  it('1: utilizator cu steag, autentificat corect ⇒ GET /api/templates = 403 password_change_required', async () => {
    const app = createApp();
    const cookie = await loginCookie(app, 'flagged182@x.ro');

    const res = await request(app).get('/api/templates').set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('password_change_required');
  });

  // ── 2 — aceeași poartă pe suprafața de semnare ────────────────────────────
  it('2: același utilizator pe /flows/:flowId (fluxul LUI) ⇒ tot 403 — nu poate ajunge la semnare', async () => {
    const app = createApp();
    const cookie = await loginCookie(app, 'flagged182@x.ro');

    const res = await request(app).get(`/flows/${flaggedFlowId}`).set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('password_change_required');   // NU 'forbidden' (ACL-ul l-ar fi lăsat)
  });

  it('2: același utilizator pe /bulk-signing/initiate ⇒ 403, oprit înaintea rutei (santinela nu răspunde)', async () => {
    const app = createApp();
    const cookie = await loginCookie(app, 'flagged182@x.ro');

    const res = await request(app).post('/bulk-signing/initiate').set('Cookie', cookie).send({ items: [] });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('password_change_required');
    expect(res.body.sentinel).toBeUndefined();
  });

  // ── 3 — ieșirea există ────────────────────────────────────────────────────
  it('3: același utilizator ⇒ POST /auth/change-password REUȘEȘTE (nu 403)', async () => {
    const app = createApp();
    const cookie = await loginCookie(app, 'flagged182@x.ro');

    const res = await request(app).post('/auth/change-password')
      .set('Cookie', [cookie, `csrf_token=${CSRF}`]).set('x-csrf-token', CSRF)
      .send({ current_password: PWD, new_password: NEW_PWD });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  // ── 4 — ciclul complet (cazul care dovedește totul) ───────────────────────
  it('4: după schimbare, cu cookie-ul nou ⇒ aceeași rută = 200, iar steagul e FALSE în DB', async () => {
    const app = createApp();
    const cookie = await loginCookie(app, 'flagged182@x.ro');

    // Înainte: poarta ține.
    expect((await request(app).get('/api/templates').set('Cookie', cookie)).status).toBe(403);

    const chg = await request(app).post('/auth/change-password')
      .set('Cookie', [cookie, `csrf_token=${CSRF}`]).set('x-csrf-token', CSRF)
      .send({ current_password: PWD, new_password: NEW_PWD });
    expect(chg.status).toBe(200);

    // Cookie-ul re-emis de change-password (tv nou) — sesiunea curentă supraviețuiește (#94).
    const newCookie = authCookieFrom(chg.headers['set-cookie']);
    expect(newCookie).toBeTruthy();

    const after = await request(app).get('/api/templates').set('Cookie', newCookie);
    expect(after.status).toBe(200);

    // Și pe suprafața de semnare.
    const flow = await request(app).get(`/flows/${flaggedFlowId}`).set('Cookie', newCookie);
    expect(flow.status).toBe(200);

    const row = (await pool.query('SELECT force_password_change FROM users WHERE id=$1', [flaggedId])).rows[0];
    expect(row.force_password_change).toBe(false);
  });

  // ── 5 — nedeteriorare ─────────────────────────────────────────────────────
  it('5: utilizator FĂRĂ steag ⇒ 200 de la început, pe /api/, /flows/ și santinela /bulk-signing/', async () => {
    const app = createApp();
    const cookie = await loginCookie(app, 'clean182@x.ro');

    expect((await request(app).get('/api/templates').set('Cookie', cookie)).status).toBe(200);
    expect((await request(app).get(`/flows/${cleanFlowId}`).set('Cookie', cookie)).status).toBe(200);

    const bulk = await request(app).post('/bulk-signing/initiate').set('Cookie', cookie).send({ items: [] });
    expect(bulk.status).toBe(200);
    expect(bulk.body.sentinel).toBe(true);   // santinela E atinsă ⇒ 403-ul de la cazul 2 vine din poartă
  });

  // ── 6 / 7 — ordinea gărzilor: revocarea sesiunii are prioritate ───────────
  it('6: steag + token_version nepotrivit ⇒ 401 token_revoked, NU 403', async () => {
    const app = createApp();
    // JWT cu tv=99, în timp ce DB are token_version=1.
    const stale = jwt.sign(
      { userId: flaggedId, email: 'flagged182@x.ro', role: 'user', orgId: ORG.id, tv: 99 },
      JWT_SECRET, { expiresIn: '1h' }
    );
    const res = await request(app).get('/api/templates').set('Cookie', `auth_token=${stale}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('token_revoked');
  });

  it('7: steag + cont dezactivat ⇒ 401 session_revoked, NU 403', async () => {
    const app = createApp();
    const cookie = await loginCookie(app, 'flagged182@x.ro');

    await pool.query('UPDATE users SET deleted_at=NOW() WHERE id=$1', [flaggedId]);

    const res = await request(app).get('/api/templates').set('Cookie', cookie);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('session_revoked');
  });
});
