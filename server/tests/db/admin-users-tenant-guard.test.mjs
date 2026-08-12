/**
 * #123 P0-02 (audit v3.9.746) — PUT /admin/users/:id era singura rută de mutație user
 * din admin/users.mjs FĂRĂ gardă de tenant: un org_admin din org A putea schimba email/
 * parolă/compartiment ale unui utilizator din org B (preluare de cont). Gardă adăugată,
 * fail-closed, cu aceeași semantică (`forbidden_cross_tenant`) ca rutele surori
 * (reset-password/delete/reactivate/send-credentials) din același fișier.
 *
 * Rulează rutele REALE peste Postgres real.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { hasTestDb, migrate, truncateAll, pool, seedOrgUser, seedUser, makeAuthCookie } from '../helpers/db-real.mjs';

vi.mock('../../middleware/csrf.mjs', () => ({ csrfMiddleware: (_req, _res, next) => next() }));

const usersRouter = (await import('../../routes/admin/users.mjs')).default;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/', usersRouter);
  return app;
}

async function getUser(id) {
  const { rows } = await pool.query('SELECT id, email, password_hash, compartiment, org_id FROM users WHERE id=$1', [id]);
  return rows[0];
}

const d = describe.skipIf(!hasTestDb());

d('#123 P0-02 — PUT /admin/users/:id gardat pe tenant (Postgres real)', () => {
  let app, orgA, orgAdminA, orgB, targetB;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    // Nume distincte — orgName implicit ar coliza pe organizations_name_key.
    const seededA = await seedOrgUser({ orgName: 'Org A P123', email: 'admina@x.ro', role: 'org_admin' });
    orgA = seededA.orgId; orgAdminA = seededA.userId;
    const seededB = await seedOrgUser({ orgName: 'Org B P123', email: 'adminb@x.ro', role: 'org_admin' });
    orgB = seededB.orgId;
    targetB = await seedUser({ orgId: orgB, email: 'targetb@x.ro', nume: 'Target B' });
    app = buildApp();
  });
  afterAll(() => pool.end());

  const cookieFor = (userId, role, orgId) => makeAuthCookie({ userId, role, orgId, email: 'x@x.ro' });

  it('NEGATIV: org_admin din org A pe user din org B → 403 forbidden_cross_tenant, DB neschimbat', async () => {
    const before = await getUser(targetB);
    const res = await request(app)
      .put(`/admin/users/${targetB}`)
      .set('Cookie', cookieFor(orgAdminA, 'org_admin', orgA))
      .send({ password: 'parolanoua123', email: 'preluat@x.ro' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden_cross_tenant');

    const after = await getUser(targetB);
    expect(after.password_hash).toBe(before.password_hash);
    expect(after.email).toBe(before.email);
  });

  it('POZITIV: org_admin din org A pe user din org A → 200, câmpul se modifică', async () => {
    const sameOrgTarget = await seedUser({ orgId: orgA, email: 'colegA@x.ro', nume: 'Coleg A' });
    const res = await request(app)
      .put(`/admin/users/${sameOrgTarget}`)
      .set('Cookie', cookieFor(orgAdminA, 'org_admin', orgA))
      .send({ compartiment: 'Financiar' });
    expect(res.status).toBe(200);
    const after = await getUser(sameOrgTarget);
    expect(after.compartiment).toBe('Financiar');
  });

  it('POZITIV: platform-admin pe user din altă org → 200 (cross-org păstrat deliberat)', async () => {
    const platformAdmin = await seedUser({ orgId: orgA, email: 'super@x.ro', role: 'admin', nume: 'Super' });
    const res = await request(app)
      .put(`/admin/users/${targetB}`)
      .set('Cookie', cookieFor(platformAdmin, 'admin', orgA))
      .send({ compartiment: 'IT' });
    expect(res.status).toBe(200);
    const after = await getUser(targetB);
    expect(after.compartiment).toBe('IT');
  });

  it('NEGATIV: țintă inexistentă → 404 user_not_found', async () => {
    const res = await request(app)
      .put(`/admin/users/999999`)
      .set('Cookie', cookieFor(orgAdminA, 'org_admin', orgA))
      .send({ compartiment: 'X' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('user_not_found');
  });

  it('Paritate: cross-tenant pe POST /admin/users/:id/reset-password rămâne 403 (garda soră neatinsă)', async () => {
    const res = await request(app)
      .post(`/admin/users/${targetB}/reset-password`)
      .set('Cookie', cookieFor(orgAdminA, 'org_admin', orgA))
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden_cross_tenant');
  });
});
