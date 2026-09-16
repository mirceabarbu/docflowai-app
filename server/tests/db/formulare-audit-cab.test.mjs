/**
 * #216 — auditul DF/ORD (`GET /api/formulare-audit/:type/:id`) e vizibil și compartimentului
 * CAB al organizației, nu doar admin/org_admin. Sursa unică: canViewFormularAudit
 * (server/services/authz-formular.mjs), consumată de poarta rutei ȘI de `can_audit` din
 * `GET /api/formulare/list`. Testul 4 verifică EXPLICIT paritatea listă↔rută.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, seedOrd, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('#216 — audit DF/ORD vizibil compartimentului CAB', () => {
  let app;
  let orgA, cabA, nonCabA;
  let dfA, ordA;
  let orgB, dfB;

  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    app = buildApp();

    const sA = await seedOrgUser({ orgName: 'Org A CAB', email: 'cab-a@x.ro', role: 'user', compartiment: 'Serviciul Buget' });
    orgA = sA.orgId; cabA = sA.userId;
    await pool.query(`UPDATE organizations SET cab_compartiment='Serviciul Buget' WHERE id=$1`, [orgA]);
    nonCabA = await seedUser({ orgId: orgA, email: 'non-cab-a@x.ro', role: 'user', compartiment: 'Achizitii' });

    dfA  = await seedDf ({ orgId: orgA, createdBy: nonCabA, nrUnic: 'DF-A-001' });
    ordA = await seedOrd({ orgId: orgA, createdBy: nonCabA, nrOrd:  'ORD-A-001' });

    const sB = await seedOrgUser({ orgName: 'Org B', email: 'user-b@x.ro', role: 'user', compartiment: 'Buget B' });
    orgB = sB.orgId;
    dfB = await seedDf({ orgId: orgB, createdBy: sB.userId, nrUnic: 'DF-B-001' });
  });
  afterAll(() => pool.end());

  it('1. CAB ⇒ GET /api/formulare-audit/df/:id pe DF din org proprie ⇒ 200, la fel pentru ORD', async () => {
    const cookie = makeAuthCookie({ userId: cabA, role: 'user', orgId: orgA });
    const resDf = await request(app).get(`/api/formulare-audit/df/${dfA}`).set('Cookie', cookie);
    expect(resDf.status).toBe(200);
    const resOrd = await request(app).get(`/api/formulare-audit/ord/${ordA}`).set('Cookie', cookie);
    expect(resOrd.status).toBe(200);
  });

  it('2. CAB ⇒ DF din altă organizație ⇒ 403', async () => {
    const cookie = makeAuthCookie({ userId: cabA, role: 'user', orgId: orgA });
    const res = await request(app).get(`/api/formulare-audit/df/${dfB}`).set('Cookie', cookie);
    expect(res.status).toBe(403);
  });

  it('3. Non-CAB ⇒ 403 (neregresie)', async () => {
    const cookie = makeAuthCookie({ userId: nonCabA, role: 'user', orgId: orgA });
    const res = await request(app).get(`/api/formulare-audit/df/${dfA}`).set('Cookie', cookie);
    expect(res.status).toBe(403);
  });

  it('4. paritate: can_audit din listă coincide cu 200/403 al rutei de audit, pentru DF și ORD', async () => {
    const cabCookie    = makeAuthCookie({ userId: cabA,    role: 'user', orgId: orgA });
    const nonCabCookie = makeAuthCookie({ userId: nonCabA, role: 'user', orgId: orgA });

    for (const [cookie, expectAudit] of [[cabCookie, true], [nonCabCookie, false]]) {
      const listDf = await request(app).get('/api/formulare/list?type=df').set('Cookie', cookie);
      expect(listDf.status).toBe(200);
      const rowDf = listDf.body.rows.find(r => String(r.id) === String(dfA));
      expect(rowDf.can_audit).toBe(expectAudit);

      const auditDf = await request(app).get(`/api/formulare-audit/df/${dfA}`).set('Cookie', cookie);
      expect(auditDf.status).toBe(expectAudit ? 200 : 403);

      const listOrd = await request(app).get('/api/formulare/list?type=ord').set('Cookie', cookie);
      expect(listOrd.status).toBe(200);
      const rowOrd = listOrd.body.rows.find(r => String(r.id) === String(ordA));
      expect(rowOrd.can_audit).toBe(expectAudit);

      const auditOrd = await request(app).get(`/api/formulare-audit/ord/${ordA}`).set('Cookie', cookie);
      expect(auditOrd.status).toBe(expectAudit ? 200 : 403);
    }
  });

  it('5. org_admin ⇒ can_audit=true și 200 (neregresie)', async () => {
    const orgAdminId = await seedUser({ orgId: orgA, email: 'org-admin-a@x.ro', role: 'org_admin', compartiment: '' });
    const cookie = makeAuthCookie({ userId: orgAdminId, role: 'org_admin', orgId: orgA });

    const list = await request(app).get('/api/formulare/list?type=df').set('Cookie', cookie);
    expect(list.status).toBe(200);
    const row = list.body.rows.find(r => String(r.id) === String(dfA));
    expect(row.can_audit).toBe(true);

    const audit = await request(app).get(`/api/formulare-audit/df/${dfA}`).set('Cookie', cookie);
    expect(audit.status).toBe(200);
  });
});
