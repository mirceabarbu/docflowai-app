/**
 * SEC-90 — GET /users (dropdown de semnatari) e izolat pe org_id, NU pe `institutie`.
 *
 * Bug-ul demonstrat aici NU e reproductibil cu mock-uri: are nevoie de DOUĂ organizații
 * cu ACELAȘI text în `institutie`. Cu codul vechi (`WHERE institutie=$1`), utilizatorul
 * unei organizații îi vedea pe cei din CEALALTĂ organizație care scriseseră identic
 * câmpul liber `institutie`. Scoping-ul pe `org_id` îi separă corect.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { hasTestDb, makeAuthCookie, migrate, pool, truncateAll } from '../helpers/db-real.mjs';
import { hashPassword } from '../../middleware/auth.mjs';
import usersRouter from '../../routes/admin/users.mjs';

const d = describe.skipIf(!hasTestDb());

const SAME_INST = 'Primaria Test';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/', usersRouter);
  return app;
}

// makeAuthCookie emite un JWT cu {userId, role, orgId, tv}; resolveActor cere ca role/orgId/tv
// din token să corespundă rândului din DB (altfel fail-closed) — de aceea toți userii au tv=1.
function cookieFor(userId, role, orgId) {
  return makeAuthCookie({ userId, role, orgId, tv: 1 });
}

async function seed() {
  const passwordHash = await hashPassword('Parola!123');
  const orgA = (await pool.query(`INSERT INTO organizations(name) VALUES('Org A') RETURNING id`)).rows[0].id;
  const orgB = (await pool.query(`INSERT INTO organizations(name) VALUES('Org B') RETURNING id`)).rows[0].id;

  // email stocat lowercase (contractul real de creare cont). RETURNING id — fără ID hardcodat.
  const mkUser = async (email, nume, role, orgId, institutie, deleted = false) => (await pool.query(
    `INSERT INTO users(email,password_hash,nume,functie,institutie,compartiment,role,org_id,token_version,deleted_at)
     VALUES($1,$2,$3,'Funcție',$4,'C',$5,$6,1,$7) RETURNING id`,
    [email.toLowerCase(), passwordHash, nume, institutie, role, orgId, deleted ? new Date() : null]
  )).rows[0].id;

  const a1 = await mkUser('a1@example.ro', 'Ana Unu', 'user', orgA, SAME_INST);
  const a2 = await mkUser('a2@example.ro', 'Bogdan Doi', 'org_admin', orgA, SAME_INST);
  const b1 = await mkUser('b1@example.ro', 'Cristina Trei', 'user', orgB, SAME_INST); // ACELAȘI text!
  const sa = await mkUser('sa@example.ro', 'Super Admin', 'admin', orgA, ''); // super-admin platformă
  const aDeleted = await mkUser('adel@example.ro', 'Sters', 'user', orgA, SAME_INST, true);

  // Actor fără organizație (contul istoric de super-admin putea avea org_id NULL).
  const noOrg = (await pool.query(
    `INSERT INTO users(email,password_hash,nume,role,token_version) VALUES('noorg@example.ro',$1,'Fara Org','user',1) RETURNING id`,
    [passwordHash]
  )).rows[0].id;

  return { orgA, orgB, a1, a2, b1, sa, aDeleted, noOrg };
}

let f;
beforeAll(migrate);
beforeEach(async () => {
  await truncateAll();
  f = await seed();
});

d('SEC-90 — /users scopat pe org_id, nu pe institutie (Postgres real)', () => {
  it('A1 vede colegii din org A, NU pe B1 din altă org cu ACELAȘI institutie', async () => {
    const res = await request(createApp()).get('/users').set('Cookie', cookieFor(f.a1, 'user', f.orgA));
    expect(res.status).toBe(200);
    const ids = res.body.map((u) => u.id);
    expect(ids).toContain(f.a1);
    expect(ids).toContain(f.a2);
    // ⭐ bug-ul: cu codul vechi B1 APĂREA aici (același text `institutie`). Acum NU.
    expect(ids).not.toContain(f.b1);
  });

  it('A1 NU îl vede pe super-admin (role=admin), deși e în aceeași org', async () => {
    const res = await request(createApp()).get('/users').set('Cookie', cookieFor(f.a1, 'user', f.orgA));
    expect(res.status).toBe(200);
    expect(res.body.map((u) => u.id)).not.toContain(f.sa);
  });

  it('B1 vede DOAR org B — nimic din org A', async () => {
    const res = await request(createApp()).get('/users').set('Cookie', cookieFor(f.b1, 'user', f.orgB));
    expect(res.status).toBe(200);
    const ids = res.body.map((u) => u.id);
    expect(ids).toContain(f.b1);
    expect(ids).not.toContain(f.a1);
    expect(ids).not.toContain(f.a2);
    expect(ids).not.toContain(f.sa);
  });

  it('utilizatorul soft-deleted din org A nu apare la A1', async () => {
    const res = await request(createApp()).get('/users').set('Cookie', cookieFor(f.a1, 'user', f.orgA));
    expect(res.status).toBe(200);
    expect(res.body.map((u) => u.id)).not.toContain(f.aDeleted);
  });

  it('actor fără organizație (org_id NULL) ⇒ listă GOALĂ, NU tot sistemul', async () => {
    const res = await request(createApp()).get('/users').set('Cookie', cookieFor(f.noOrg, 'user', null));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
