/**
 * tenant-isolation.test.mjs — pachetul de izolare multi-tenant (prompt #104).
 *
 * Definiția executabilă a lui „nu regresăm": seed-uiește DOUĂ organizații cu date
 * reale în fiecare modul și verifică, pe RUTELE REALE + Postgres real, că un
 * utilizator din Org B nu vede/atinge NIMIC din Org A.
 *
 * NU repară nimic. Un roșu aici = o scurgere reală descoperită (vezi RAPORT în prompt).
 * Aserțiunile „NU conține" verifică pe ID/nr, niciodată pe lungimea listei.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import {
  hasTestDb, migrate, truncateAll, makeAuthCookie,
  seedOrgUser, seedUser, seedDf, seedOrd, seedAlop, seedFlow, seedRegistru,
} from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const app = buildApp();

// Compară id-uri indiferent de tip (BIGSERIAL vine ca string, SERIAL ca number).
const sameId = (a, b) => a != null && b != null && String(a) === String(b);

// Construiește Org A + Org B, fiecare cu utilizatori; Org A primește un obiect în
// fiecare modul (DF/ORD/ALOP/flux/registratură). Nume org + emailuri DISTINCTE
// (organizations.name e UNIQUE; a picat CI-ul la #100.2 pe organizations_name_key).
//
// ⚠️ `compartiment` IDENTIC intenționat ('Contabilitate' la ambele org-uri) — prinde
// bug-ul de la auditul 14.07: subquery-uri pe TRIM(compartiment)=$1 fără org_id ar
// putea face un user din B vizibil pe documentele din A. Vrem să lovim exact acest caz.
async function seedTwoOrgs() {
  const A = await seedOrgUser({ orgName: 'Primaria A', email: 'admin-a@a.ro', role: 'org_admin', compartiment: 'Contabilitate' });
  const B = await seedOrgUser({ orgName: 'Primaria B', email: 'admin-b@b.ro', role: 'org_admin', compartiment: 'Contabilitate' });
  const uA = await seedUser({ orgId: A.orgId, email: 'user-a@a.ro', compartiment: 'Contabilitate', nume: 'User A' });
  const uB = await seedUser({ orgId: B.orgId, email: 'user-b@b.ro', compartiment: 'Contabilitate', nume: 'User B' });

  const dfA   = await seedDf({ orgId: A.orgId, createdBy: uA, nrUnic: 'DF-A-001', status: 'draft' });
  const ordA  = await seedOrd({ orgId: A.orgId, createdBy: uA, nrOrd: 'ORD-A-001', status: 'draft' });
  const alopA = await seedAlop({ orgId: A.orgId, createdBy: uA, titlu: 'ALOP-A-001', status: 'draft', compartiment: 'Contabilitate' });
  const flowA = await seedFlow({ orgId: A.orgId, initEmail: 'user-b@b.ro', docName: 'FLOW-A-001' }); // email-ul lui B, dar org A → doar org_id îl exclude
  const regA  = await seedRegistru({ orgId: A.orgId, obiect: 'REG-A-001' });

  return { A, B, uA, uB, dfA, ordA, alopA, flowA, regA };
}

// Cookie-uri per actor (userId real din seed pentru vizibilitatea per-compartiment).
const cookieUserB  = (uB, B) => makeAuthCookie({ userId: uB, role: 'user',      orgId: B.orgId, email: 'user-b@b.ro' });
const cookieAdminB = (B)     => makeAuthCookie({ userId: B.userId, role: 'org_admin', orgId: B.orgId, email: 'admin-b@b.ro' });
const cookieUserA  = (uA, A) => makeAuthCookie({ userId: uA, role: 'user',      orgId: A.orgId, email: 'user-a@a.ro' });

const d = describe.skipIf(!hasTestDb());

d('tenant-isolation — B nu vede/atinge NIMIC din A', () => {
  beforeAll(migrate);

  let S;
  beforeEach(async () => {
    await truncateAll();
    S = await seedTwoOrgs();
  });

  // ── Grupa 1 — Listări (actor = user-b / admin-b) ───────────────────────────
  describe('Grupa 1 — listări', () => {
    it('1. GET /api/formulare/list?type=df ca user-b ⇒ NU conține DF-A-001', async () => {
      const r = await request(app).get('/api/formulare/list?type=df').set('Cookie', cookieUserB(S.uB, S.B));
      expect(r.status).toBe(200);
      expect(r.body.rows.find(x => x.nr === 'DF-A-001' || sameId(x.id, S.dfA))).toBeUndefined();
    });

    it('2. GET /api/formulare/list?type=df ca admin-b (org_admin) ⇒ NU conține DF-A-001', async () => {
      const r = await request(app).get('/api/formulare/list?type=df').set('Cookie', cookieAdminB(S.B));
      expect(r.status).toBe(200);
      expect(r.body.rows.find(x => x.nr === 'DF-A-001' || sameId(x.id, S.dfA))).toBeUndefined();
    });

    it('3. GET /api/formulare/list?type=ord ca user-b ⇒ NU conține ORD-A-001', async () => {
      const r = await request(app).get('/api/formulare/list?type=ord').set('Cookie', cookieUserB(S.uB, S.B));
      expect(r.status).toBe(200);
      expect(r.body.rows.find(x => x.nr === 'ORD-A-001' || sameId(x.id, S.ordA))).toBeUndefined();
    });

    it('4. GET /api/alop ca user-b ⇒ NU conține alopA', async () => {
      const r = await request(app).get('/api/alop').set('Cookie', cookieUserB(S.uB, S.B));
      expect(r.status).toBe(200);
      expect(r.body.alop.find(x => sameId(x.id, S.alopA))).toBeUndefined();
    });

    it('5. GET /api/alop/stats ca user-b ⇒ cifrele NU includ valorile din Org A', async () => {
      const r = await request(app).get('/api/alop/stats').set('Cookie', cookieUserB(S.uB, S.B));
      expect(r.status).toBe(200);
      // Org B nu are ALOP; dacă org filter lipsește, total ar include alopA (≥1).
      expect(r.body.total).toBe(0);
    });

    it('6. GET /api/registratura/intrari ca user-b ⇒ NU conține regA', async () => {
      const r = await request(app).get('/api/registratura/intrari').set('Cookie', cookieUserB(S.uB, S.B));
      expect(r.status).toBe(200);
      expect(r.body.items.find(x => sameId(x.id, S.regA.id) || x.obiect === 'REG-A-001')).toBeUndefined();
    });

    it('7. GET /api/formulare/utilizatori-org ca user-b ⇒ NU conține user-a@a.ro', async () => {
      const r = await request(app).get('/api/formulare/utilizatori-org').set('Cookie', cookieUserB(S.uB, S.B));
      expect(r.status).toBe(200);
      expect(r.body.users.find(x => x.email === 'user-a@a.ro')).toBeUndefined();
    });

    it('7b. GET /my-flows ca user-b ⇒ NU conține flowA (email partajat, org diferit)', async () => {
      const r = await request(app).get('/my-flows').set('Cookie', cookieUserB(S.uB, S.B));
      expect(r.status).toBe(200);
      const rows = r.body.flows || [];
      expect(rows.find(x => x.docName === 'FLOW-A-001')).toBeUndefined();
    });
  });

  // ── Grupa 2 — Acces la obiect individual (IDOR cross-org) ───────────────────
  describe('Grupa 2 — acces obiect individual (IDOR)', () => {
    it('8. GET /api/alop/:id cu alopA ca user-b ⇒ 403/404 (nu 200 cu datele lui A)', async () => {
      const r = await request(app).get(`/api/alop/${S.alopA}`).set('Cookie', cookieUserB(S.uB, S.B));
      expect([403, 404]).toContain(r.status);
    });

    it('9. GET /api/formulare-atasamente/df/:id cu dfA ca user-b ⇒ 403/404', async () => {
      const r = await request(app).get(`/api/formulare-atasamente/df/${S.dfA}`).set('Cookie', cookieUserB(S.uB, S.B));
      expect([403, 404]).toContain(r.status);
    });

    it('10. GET /api/formulare-audit/df/:id cu dfA ca user-b ⇒ 403/404', async () => {
      const r = await request(app).get(`/api/formulare-audit/df/${S.dfA}`).set('Cookie', cookieUserB(S.uB, S.B));
      expect([403, 404]).toContain(r.status);
    });

    it('11. PUT /api/formulare-df/:id cu dfA ca user-b ⇒ 403/404 (scriere cross-org blocată)', async () => {
      const r = await request(app)
        .put(`/api/formulare-df/${S.dfA}`)
        .set('Cookie', cookieUserB(S.uB, S.B))
        .send({ subtitlu_df: 'hijack' });
      expect([403, 404]).toContain(r.status);
    });
  });

  // ── Grupa 3 — Control pozitiv (izolarea nu e prea agresivă) ─────────────────
  describe('Grupa 3 — control pozitiv', () => {
    it('12. user-a VEDE DF-A-001 în lista lui ⇒ 200, conține DF-ul', async () => {
      const r = await request(app).get('/api/formulare/list?type=df').set('Cookie', cookieUserA(S.uA, S.A));
      expect(r.status).toBe(200);
      expect(r.body.rows.find(x => x.nr === 'DF-A-001' || sameId(x.id, S.dfA))).toBeDefined();
    });

    it('13. user-a deschide alopA ⇒ 200 (acces legitim în interiorul org-ului)', async () => {
      const r = await request(app).get(`/api/alop/${S.alopA}`).set('Cookie', cookieUserA(S.uA, S.A));
      expect(r.status).toBe(200);
      expect(sameId(r.body.id ?? r.body.alop?.id, S.alopA)).toBe(true);
    });
  });
});
