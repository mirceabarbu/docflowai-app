/**
 * Coerență carduri↔listă (prompt 65): GET /api/alop/stats folosește ACELAȘI
 * filtru de vizibilitate ca GET /api/alop (helper partajat buildAlopVisibilityWhere).
 *
 * - user obișnuit: vede DOAR ALOP-urile lui → stats.total == lungimea listei.
 * - admin / org_admin: vede tot org-ul → stats.total == toate ALOP-urile din org.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedAlop, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('ALOP — stats cards = filtrul de vizibilitate al listei', () => {
  let app, orgId, userId, otherId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    const seeded = await seedOrgUser({ role: 'user', email: 'u1@x.ro' });
    orgId = seeded.orgId; userId = seeded.userId;
    otherId = await seedUser({ orgId, email: 'u2@x.ro', role: 'user' });
    app = buildApp();

    // 1 ALOP al userului obișnuit + 5 ALOP-uri ale altui user din același org.
    await seedAlop({ orgId, createdBy: userId, status: 'draft',      titlu: 'al meu' });
    await seedAlop({ orgId, createdBy: otherId, status: 'draft',      titlu: 'altul 1' });
    await seedAlop({ orgId, createdBy: otherId, status: 'angajare',   titlu: 'altul 2' });
    await seedAlop({ orgId, createdBy: otherId, status: 'lichidare',  titlu: 'altul 3' });
    await seedAlop({ orgId, createdBy: otherId, status: 'completed',  titlu: 'altul 4' });
    await seedAlop({ orgId, createdBy: otherId, status: 'plata',      titlu: 'altul 5' });
  });
  afterAll(() => pool.end());

  it('user obișnuit: stats.total == 1 și == lungimea listei', async () => {
    const cookie = makeAuthCookie({ userId, role: 'user', orgId });

    const stats = await request(app).get('/api/alop/stats').set('Cookie', cookie);
    expect(stats.status).toBe(200);
    expect(stats.body.total).toBe(1);
    expect(stats.body.draft).toBe(1);

    const list = await request(app).get('/api/alop').set('Cookie', cookie);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.alop)).toBe(true);
    expect(list.body.alop.length).toBe(stats.body.total);
    expect(list.body.total).toBe(stats.body.total);
  });

  it('org_admin: stats.total == tot org-ul (6)', async () => {
    const adminId = await seedUser({ orgId, email: 'admin@x.ro', role: 'org_admin' });
    const cookie = makeAuthCookie({ userId: adminId, role: 'org_admin', orgId });

    const stats = await request(app).get('/api/alop/stats').set('Cookie', cookie);
    expect(stats.status).toBe(200);
    expect(stats.body.total).toBe(6);
    expect(stats.body.completate).toBe(1);
    expect(stats.body.in_progres).toBe(3); // angajare, lichidare, plata
    expect(stats.body.draft).toBe(2);
  });

  it('admin (super): stats.total == tot org-ul (6)', async () => {
    const cookie = makeAuthCookie({ userId, role: 'admin', orgId });
    const stats = await request(app).get('/api/alop/stats').set('Cookie', cookie);
    expect(stats.status).toBe(200);
    expect(stats.body.total).toBe(6);
  });
});
