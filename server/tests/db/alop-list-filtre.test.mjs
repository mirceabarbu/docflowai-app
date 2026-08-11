/**
 * #121: filtre listă ALOP pe GET /api/alop (oglindesc DF/ORD) — q (titlu), status, comp
 * (compartiment), from/to (created_at), creat (EXISTS corelat pe users, NU JOIN — COUNT-ul
 * n-are JOIN pe users). Actor = org_admin, ca să testăm filtrele și nu vizibilitatea.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedAlop, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('GET /api/alop — filtre listă (#121)', () => {
  let app, orgId, adminId, budgetUserId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    ({ orgId, userId: adminId } = await seedOrgUser({ role: 'org_admin', email: 'admin@x.ro', compartiment: 'Conducere' }));
    // user secundar în ACEEAȘI org (nu seedOrgUser — ar crea o organizație nouă)
    const { rows: usr } = await pool.query(
      `INSERT INTO users (email, password_hash, nume, role, compartiment, org_id)
       VALUES ($1, 'x', 'Test Buget', 'user', $2, $3) RETURNING id`,
      ['buget@x.ro', 'Serviciul Buget', orgId]
    );
    budgetUserId = usr[0].id;
    app = buildApp();
  });
  afterAll(() => pool.end());

  const cookie = () => makeAuthCookie({ userId: adminId, role: 'org_admin', orgId, email: 'admin@x.ro' });

  it('?q=<fragment titlu> — doar ALOP-urile cu titlul potrivit', async () => {
    const a1 = await seedAlop({ orgId, createdBy: adminId, status: 'draft', titlu: 'Reparatii strada Garii' });
    const a2 = await seedAlop({ orgId, createdBy: adminId, status: 'draft', titlu: 'Modernizare Parc' });

    const res = await request(app).get('/api/alop?q=Reparatii').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.alop.map(a => a.id)).toEqual([a1]);
    expect(res.body.alop.map(a => a.id)).not.toContain(a2);
  });

  it('?status=lichidare — doar cele în lichidare', async () => {
    const a1 = await seedAlop({ orgId, createdBy: adminId, status: 'lichidare', titlu: 'ALOP Lichidare' });
    await seedAlop({ orgId, createdBy: adminId, status: 'draft', titlu: 'ALOP Draft' });

    const res = await request(app).get('/api/alop?status=lichidare').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.alop.map(a => a.id)).toEqual([a1]);
  });

  it('?comp=<compartiment> — doar ALOP cu compartiment potrivit', async () => {
    const a1 = await seedAlop({ orgId, createdBy: adminId, status: 'draft', titlu: 'ALOP Buget', compartiment: 'Serviciul Buget' });
    await seedAlop({ orgId, createdBy: adminId, status: 'draft', titlu: 'ALOP Juridic', compartiment: 'Compartimentul Juridic' });

    const res = await request(app).get('/api/alop?comp=' + encodeURIComponent('Serviciul Buget')).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.alop.map(a => a.id)).toEqual([a1]);
  });

  it('?creat=<nume/email creator> — doar ALOP create de acel user (EXISTS corelat, COUNT corect)', async () => {
    const a1 = await seedAlop({ orgId, createdBy: budgetUserId, status: 'draft', titlu: 'ALOP Buget User' });
    await seedAlop({ orgId, createdBy: adminId, status: 'draft', titlu: 'ALOP Admin User' });

    const res = await request(app).get('/api/alop?creat=buget@x.ro').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.alop.map(a => a.id)).toEqual([a1]);
  });

  it('?from=&to= — interval pe created_at, to inclusiv până la 23:59:59', async () => {
    const aOld = await seedAlop({ orgId, createdBy: adminId, status: 'draft', titlu: 'ALOP Vechi' });
    await pool.query(`UPDATE alop_instances SET created_at = '2020-01-01T10:00:00Z' WHERE id = $1`, [aOld]);
    const aToday = await seedAlop({ orgId, createdBy: adminId, status: 'draft', titlu: 'ALOP Azi' });

    const today = new Date().toISOString().slice(0, 10);
    const res = await request(app).get(`/api/alop?from=${today}&to=${today}`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.alop.map(a => a.id)).toEqual([aToday]);
  });

  it('combinație ?status=...&comp=... — intersecție corectă', async () => {
    const aMatch = await seedAlop({ orgId, createdBy: adminId, status: 'lichidare', titlu: 'ALOP Match', compartiment: 'Serviciul Buget' });
    await seedAlop({ orgId, createdBy: adminId, status: 'draft', titlu: 'ALOP Status Diferit', compartiment: 'Serviciul Buget' });
    await seedAlop({ orgId, createdBy: adminId, status: 'lichidare', titlu: 'ALOP Comp Diferit', compartiment: 'Compartimentul Juridic' });

    const res = await request(app).get('/api/alop?status=lichidare&comp=' + encodeURIComponent('Serviciul Buget')).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.alop.map(a => a.id)).toEqual([aMatch]);
  });

  it('?q=zzz-inexistent — total=0, alop=[]', async () => {
    await seedAlop({ orgId, createdBy: adminId, status: 'draft', titlu: 'ALOP Oarecare' });

    const res = await request(app).get('/api/alop?q=zzz-inexistent').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.alop).toEqual([]);
  });
});
