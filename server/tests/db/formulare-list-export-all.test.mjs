/**
 * #133a: modul ?all=1 (export Excel) pe GET /api/formulare/list — DOVADĂ pe PG real
 * că exportul (1) sare peste paginare, (2) respectă EXACT aceleași filtre/autorizare
 * ca lista paginată (`conds` partajate — nu un al doilea adevăr), (3) nu devine un
 * canal de evadare cross-tenant/cross-compartiment.
 * Model: server/tests/db/formulare-list-status-filtre.test.mjs (#132a).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, seedOrd, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('GET /api/formulare/list?all=1 — modul export (#133a)', () => {
  let app, orgId, userId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    ({ orgId, userId } = await seedOrgUser({ role: 'org_admin' }));
    app = buildApp();
  });
  afterAll(() => pool.end());

  const cookie = () => makeAuthCookie({ userId: 1, role: 'org_admin', orgId: 1 });

  it('1. DF, ?all=1 fără filtre: rows.length === total și total > 20 (plafonul de 20 a dispărut)', async () => {
    for (let i = 0; i < 25; i++) {
      await seedDf({ orgId, createdBy: userId, status: 'draft', nrUnic: `DF-2026-${1000 + i}` });
    }
    const res = await request(app).get('/api/formulare/list?type=df&all=1').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(20);
    expect(res.body.rows.length).toBe(res.body.total);
  });

  it('2. DF, ?all=1&status=returnat: întoarce EXACT documentele returnat', async () => {
    const dfReturnat = await seedDf({ orgId, createdBy: userId, status: 'returnat', nrUnic: 'DF-2026-200' });
    await seedDf({ orgId, createdBy: userId, status: 'draft', nrUnic: 'DF-2026-201' });

    const res = await request(app).get('/api/formulare/list?type=df&all=1&status=returnat').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.rows.every(r => r.badge_status === 'returnat')).toBe(true);
    expect(res.body.rows.some(r => r.id === dfReturnat)).toBe(true);
  });

  it('3. DF, ?all=1&status=neaprobat: coerent cu #132a (status brut neaprobat, fără flux)', async () => {
    const dfNeaprobat = await seedDf({ orgId, createdBy: userId, status: 'neaprobat', nrUnic: 'DF-2026-300' });
    await seedDf({ orgId, createdBy: userId, status: 'draft', nrUnic: 'DF-2026-301' });

    const res = await request(app).get('/api/formulare/list?type=df&all=1&status=neaprobat').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.rows.some(r => r.id === dfNeaprobat)).toBe(true);
    expect(res.body.rows.every(r => r.badge_status === 'neaprobat')).toBe(true);
  });

  it('4. ORD, ?all=1&nr=<fragment furnizor>: respectă căutarea pe beneficiar (#121)', async () => {
    const ordMatch = await seedOrd({ orgId, createdBy: userId, status: 'draft', nrOrd: 'ORD-2026-400' });
    await pool.query(`UPDATE formulare_ord SET beneficiar=$1 WHERE id=$2`, ['SC Furnizor Alpha SRL', ordMatch]);
    const ordOther = await seedOrd({ orgId, createdBy: userId, status: 'draft', nrOrd: 'ORD-2026-401' });
    await pool.query(`UPDATE formulare_ord SET beneficiar=$1 WHERE id=$2`, ['Alt Nume SRL', ordOther]);

    const res = await request(app).get('/api/formulare/list?type=ord&all=1&nr=' + encodeURIComponent('Furnizor Alpha')).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.rows.some(r => r.id === ordMatch)).toBe(true);
    expect(res.body.rows.some(r => r.id === ordOther)).toBe(false);
  });

  it('5. ?all=1 NU sare peste autorizare — utilizator non-manager, non-CAB, alt compartiment vede DOAR documentele proprii', async () => {
    const otherUserId = await seedUser({ orgId, email: 'other@x.ro', role: 'user', compartiment: 'Alt Compartiment' });
    const myDf = await seedDf({ orgId, createdBy: otherUserId, status: 'draft', nrUnic: 'DF-2026-500' });
    const foreignDf = await seedDf({ orgId, createdBy: userId, status: 'draft', nrUnic: 'DF-2026-501' });

    const restrictedCookie = makeAuthCookie({ userId: otherUserId, role: 'user', orgId, email: 'other@x.ro' });
    const res = await request(app).get('/api/formulare/list?type=df&all=1').set('Cookie', restrictedCookie);
    expect(res.status).toBe(200);
    expect(res.body.rows.some(r => r.id === myDf)).toBe(true);
    expect(res.body.rows.some(r => r.id === foreignDf)).toBe(false);
  });

  it('6. Alt org_id nu apare niciodată în ?all=1', async () => {
    const { orgId: org2Id, userId: user2Id } = await seedOrgUser({ orgName: 'Org 2', email: 'p1-org2@x.ro', role: 'org_admin' });
    const dfOrg2 = await seedDf({ orgId: org2Id, createdBy: user2Id, status: 'draft', nrUnic: 'DF-2026-600' });
    await seedDf({ orgId, createdBy: userId, status: 'draft', nrUnic: 'DF-2026-601' });

    const res = await request(app).get('/api/formulare/list?type=df&all=1').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.rows.some(r => r.id === dfOrg2)).toBe(false);
  });

  it('7. Fără all=1: rows.length === 20, total = numărul real (non-regresie paginare DF)', async () => {
    for (let i = 0; i < 25; i++) {
      await seedDf({ orgId, createdBy: userId, status: 'draft', nrUnic: `DF-2026-7${100 + i}` });
    }
    const res = await request(app).get('/api/formulare/list?type=df').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBe(20);
    expect(res.body.total).toBe(25);
  });

  it('8. Fără all=1: rows.length === 20, total = numărul real (non-regresie paginare ORD)', async () => {
    for (let i = 0; i < 25; i++) {
      await seedOrd({ orgId, createdBy: userId, status: 'draft', nrOrd: `ORD-2026-8${100 + i}` });
    }
    const res = await request(app).get('/api/formulare/list?type=ord').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBe(20);
    expect(res.body.total).toBe(25);
  });
});
