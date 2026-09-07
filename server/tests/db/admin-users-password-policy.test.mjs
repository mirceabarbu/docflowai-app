/**
 * #181 (v3.9.836) — două lucruri, pe rute REALE peste Postgres real:
 *
 * (C) POST /admin/users/:id/reset-password — garda cross-tenant era PERMISIVĂ: refuza
 *     doar când putea DOVEDI că organizațiile diferă
 *     (`actorOrgId && target.org_id && actorOrgId !== target.org_id`). Cu oricare dintre
 *     cele două org_id NULL, condiția cădea și resetarea trecea — parolă nouă generată,
 *     trimisă pe email, adică preluare de cont (clasa P0-02). Acum e fail-closed, ca
 *     sora ei de la PUT /admin/users/:id.
 *
 * (D) Politica de lungime era scrisă în trei locuri, cu două valori (10 la
 *     /auth/change-password, 4 la creare și la PUT). Trece în services/password-policy.mjs.
 *     Efect vizibil: o parolă prea scurtă trimisă de admin întoarce acum 400, în loc să
 *     fie ÎNLOCUITĂ tăcut cu una generată (creare) sau IGNORATĂ tăcut cu răspuns 200 (PUT).
 *
 * Aserțiile pe hash citesc DIRECT din DB — un 403/400 corect care totuși schimbă parola
 * ar fi exact bug-ul pe care testul trebuie să-l prindă.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { hasTestDb, migrate, truncateAll, pool, seedOrgUser, seedUser, makeAuthCookie } from '../helpers/db-real.mjs';
import { validatePassword } from '../../services/password-policy.mjs';

vi.mock('../../middleware/csrf.mjs', () => ({ csrfMiddleware: (_req, _res, next) => next() }));
// Determinism + siguranță: fără mock, un dev cu RESEND_API_KEY în mediu ar trimite emailuri
// REALE de resetare de parolă din suita de teste.
vi.mock('../../mailer.mjs', () => ({
  sendSignerEmail: vi.fn(async () => ({ ok: true })),
  verifySmtp: vi.fn(async () => ({ ok: true })),
}));

const usersRouter = (await import('../../routes/admin/users.mjs')).default;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/', usersRouter);
  return app;
}

async function hashOf(id) {
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [id]);
  return rows[0]?.password_hash;
}

const cookieFor = (userId, role, orgId) => makeAuthCookie({ userId, role, orgId, email: 'x@x.ro' });

const d = describe.skipIf(!hasTestDb());

d('#181 — reset-password fail-closed + politica de parole (Postgres real)', () => {
  let app, orgA, orgAdminA, orgB, targetB, targetA;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    const seededA = await seedOrgUser({ orgName: 'Org A P181', email: 'admina@x.ro', role: 'org_admin' });
    orgA = seededA.orgId; orgAdminA = seededA.userId;
    const seededB = await seedOrgUser({ orgName: 'Org B P181', email: 'adminb@x.ro', role: 'org_admin' });
    orgB = seededB.orgId;
    targetB = await seedUser({ orgId: orgB, email: 'targetb@x.ro', nume: 'Target B' });
    targetA = await seedUser({ orgId: orgA, email: 'targeta@x.ro', nume: 'Target A' });
    app = buildApp();
  });
  afterAll(() => pool.end());

  // ── C — garda cross-tenant la resetarea parolei ──────────────────────────────
  describe('C — POST /admin/users/:id/reset-password', () => {
    it('1. GAURA VECHE: org_admin cu org_id NULL ⇒ 403, hash-ul țintei NEMODIFICAT', async () => {
      // Actorul e org_admin dar fără organizație în DB. Forma veche a gărzii cădea pe
      // `actorOrgId && ...` ⇒ resetarea trecea pe ORICE utilizator din ORICE organizație.
      const orfan = await seedUser({ orgId: null, email: 'orfan@x.ro', role: 'org_admin', nume: 'Orfan' });

      for (const [eticheta, tinta] of [['altă org', targetB], ['propria vecinătate', targetA]]) {
        const before = await hashOf(tinta);
        const res = await request(app)
          .post(`/admin/users/${tinta}/reset-password`)
          .set('Cookie', cookieFor(orfan, 'org_admin', null))
          .send({});
        expect(res.status, `ținta din ${eticheta}`).toBe(403);
        expect(res.body.error).toBe('forbidden_cross_tenant');
        expect(await hashOf(tinta), `hash schimbat pentru ținta din ${eticheta}`).toBe(before);
      }
    });

    it('2. A DOUA JUMĂTATE: țintă cu org_id NULL, actor org_admin cu org ⇒ 403, hash NEMODIFICAT', async () => {
      const tintaOrfana = await seedUser({ orgId: null, email: 'fara-org@x.ro', nume: 'Fara Org' });
      const before = await hashOf(tintaOrfana);

      const res = await request(app)
        .post(`/admin/users/${tintaOrfana}/reset-password`)
        .set('Cookie', cookieFor(orgAdminA, 'org_admin', orgA))
        .send({});

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('forbidden_cross_tenant');
      expect(await hashOf(tintaOrfana)).toBe(before);
    });

    it('3. NEDETERIORARE: org_admin pe user din PROPRIA org ⇒ 200, hash SCHIMBAT', async () => {
      const before = await hashOf(targetA);
      const res = await request(app)
        .post(`/admin/users/${targetA}/reset-password`)
        .set('Cookie', cookieFor(orgAdminA, 'org_admin', orgA))
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(await hashOf(targetA)).not.toBe(before);
    });

    it('4. NEDETERIORARE: platform-admin pe user din altă org ⇒ 200 (cross-org păstrat deliberat)', async () => {
      const platformAdmin = await seedUser({ orgId: orgA, email: 'super@x.ro', role: 'admin', nume: 'Super' });
      const before = await hashOf(targetB);

      const res = await request(app)
        .post(`/admin/users/${targetB}/reset-password`)
        .set('Cookie', cookieFor(platformAdmin, 'admin', orgA))
        .send({});

      expect(res.status).toBe(200);
      expect(await hashOf(targetB)).not.toBe(before);
    });

    it('4b. NEDETERIORARE: platform-admin FĂRĂ org_id pe user din altă org ⇒ tot 200', async () => {
      // Strângerea gărzii e limitată la ramura org_admin — platform-adminul nu e afectat
      // nici măcar când propriul org_id lipsește.
      const superFaraOrg = await seedUser({ orgId: null, email: 'super2@x.ro', role: 'admin', nume: 'Super2' });
      const before = await hashOf(targetB);

      const res = await request(app)
        .post(`/admin/users/${targetB}/reset-password`)
        .set('Cookie', cookieFor(superFaraOrg, 'admin', null))
        .send({});

      expect(res.status).toBe(200);
      expect(await hashOf(targetB)).not.toBe(before);
    });
  });

  // ── D.2 — PUT /admin/users/:id ───────────────────────────────────────────────
  describe('D.2 — PUT /admin/users/:id', () => {
    it('5. parolă de 6 caractere ⇒ 400 password_too_short ȘI hash NEMODIFICAT (înainte: 200 fără modificare)', async () => {
      const before = await hashOf(targetA);
      const res = await request(app)
        .put(`/admin/users/${targetA}`)
        .set('Cookie', cookieFor(orgAdminA, 'org_admin', orgA))
        .send({ password: 'abc123' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('password_too_short');
      expect(res.body.message).toContain('10');
      expect(await hashOf(targetA)).toBe(before);
    });

    it('5b. parolă de 10 caractere ⇒ 200 și hash SCHIMBAT', async () => {
      const before = await hashOf(targetA);
      const res = await request(app)
        .put(`/admin/users/${targetA}`)
        .set('Cookie', cookieFor(orgAdminA, 'org_admin', orgA))
        .send({ password: '1234567890' });

      expect(res.status).toBe(200);
      expect(await hashOf(targetA)).not.toBe(before);
    });

    it('5c. parolă peste 200 de caractere ⇒ 400 password_too_long cu max, hash NEMODIFICAT', async () => {
      const before = await hashOf(targetA);
      const res = await request(app)
        .put(`/admin/users/${targetA}`)
        .set('Cookie', cookieFor(orgAdminA, 'org_admin', orgA))
        .send({ password: 'a'.repeat(201) });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('password_too_long');
      expect(res.body.max).toBe(200);
      expect(await hashOf(targetA)).toBe(before);
    });

    it('7. NEDETERIORARE: PUT fără niciun câmp ⇒ 400 nothing_to_update (NU password_missing)', async () => {
      const res = await request(app)
        .put(`/admin/users/${targetA}`)
        .set('Cookie', cookieFor(orgAdminA, 'org_admin', orgA))
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('nothing_to_update');
    });

    it('7b. NEDETERIORARE: PUT cu password gol + alt câmp ⇒ 200, parola NEATINSĂ', async () => {
      // Câmpul gol din interfață înseamnă „nu atinge parola", nu „parolă invalidă".
      const before = await hashOf(targetA);
      const res = await request(app)
        .put(`/admin/users/${targetA}`)
        .set('Cookie', cookieFor(orgAdminA, 'org_admin', orgA))
        .send({ password: '', compartiment: 'Financiar' });

      expect(res.status).toBe(200);
      expect(res.body.compartiment).toBe('Financiar');
      expect(await hashOf(targetA)).toBe(before);
    });
  });

  // ── D.1 — POST /admin/users ──────────────────────────────────────────────────
  describe('D.1 — POST /admin/users', () => {
    // Ruta trece prin resolveActorOr ⇒ JWT-ul trebuie să corespundă EXACT rândului din DB
    // (rol, org_id, token_version). tv implicit din makeAuthCookie = 1 = DEFAULT-ul coloanei.
    async function platformAdmin() {
      return seedUser({ orgId: orgA, email: 'creator@x.ro', role: 'admin', nume: 'Creator' });
    }

    it('6. creare cu parolă de 6 caractere ⇒ 400 password_too_short, utilizatorul NU se creează', async () => {
      const admin = await platformAdmin();
      const res = await request(app)
        .post('/admin/users')
        .set('Cookie', cookieFor(admin, 'admin', orgA))
        .send({ email: 'nou@x.ro', nume: 'Nou Utilizator', password: 'abc123', skip_verification: true });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('password_too_short');

      const { rows } = await pool.query('SELECT id FROM users WHERE email=$1', ['nou@x.ro']);
      expect(rows.length).toBe(0);
    });

    it('6b. creare FĂRĂ câmpul password ⇒ 201, iar parola generată trece validatePassword', async () => {
      // Platforma nu-și încalcă propria politică: pragul de 10 nu invalidează
      // generatePassword() (xxx-xxx-xxx = 11 caractere).
      const admin = await platformAdmin();
      const res = await request(app)
        .post('/admin/users')
        .set('Cookie', cookieFor(admin, 'admin', orgA))
        .send({ email: 'nou2@x.ro', nume: 'Nou Doi', skip_verification: true });

      expect(res.status).toBe(201);
      expect(typeof res.body.tempPassword).toBe('string');
      expect(validatePassword(res.body.tempPassword)).toEqual({ ok: true });
    });

    it('6c. creare cu parolă VALIDĂ ⇒ 201 și parola rămâne cea trimisă (nu una generată)', async () => {
      const admin = await platformAdmin();
      const res = await request(app)
        .post('/admin/users')
        .set('Cookie', cookieFor(admin, 'admin', orgA))
        .send({ email: 'nou3@x.ro', nume: 'Nou Trei', password: 'ParolaBuna123', skip_verification: true });

      expect(res.status).toBe(201);
      expect(res.body.tempPassword).toBe('ParolaBuna123');
    });
  });
});
