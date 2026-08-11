/**
 * #121: căutarea după Nr. la GET /api/formulare/list acoperă și:
 *  - DF: denumirea (titlu) ALOP-ului legat — activ (alop.df_id=df.id) SAU proveniență
 *    (df.source_alop_id=alop.id), cu izolare de org (a_s.org_id = fd.org_id);
 *  - ORD: denumirea furnizorului (fo.beneficiar).
 * Căutarea pe nr_unic_inreg / nr_ordonant_pl rămâne funcțională (OR, nu înlocuire).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedAlop, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('GET /api/formulare/list?nr= — căutare extinsă (DF→ALOP, ORD→furnizor) (#121)', () => {
  let app, orgId, userId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    ({ orgId, userId } = await seedOrgUser({ role: 'org_admin' }));
    app = buildApp();
  });
  afterAll(() => pool.end());

  const cookie = () => makeAuthCookie({ userId: 1, role: 'org_admin', orgId: 1 });

  it('DF: nr caută în titlul ALOP-ului legat ACTIV (alop.df_id = df.id)', async () => {
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'draft', nrUnic: 'DF-2026-777' });
    await seedAlop({ orgId, createdBy: userId, status: 'angajare', titlu: 'Reparatii strada Garii', dfId });

    const res = await request(app).get('/api/formulare/list?type=df&nr=Reparatii').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.rows.some(r => r.id === dfId)).toBe(true);
  });

  it('DF: nr caută în titlul ALOP-ului legat prin PROVENIENȚĂ (df.source_alop_id = alop.id)', async () => {
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'draft', nrUnic: 'DF-2026-778' });
    const alopId = await seedAlop({ orgId, createdBy: userId, status: 'draft', titlu: 'Modernizare Parc Central' });
    await pool.query(`UPDATE formulare_df SET source_alop_id=$1 WHERE id=$2`, [alopId, dfId]);

    const res = await request(app).get('/api/formulare/list?type=df&nr=Parc%20Central').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.rows.some(r => r.id === dfId)).toBe(true);
  });

  it('DF: căutarea numerică după fragmentul din nr_unic_inreg rămâne funcțională', async () => {
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'draft', nrUnic: 'DF-2026-999' });
    const res = await request(app).get('/api/formulare/list?type=df&nr=2026-999').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.rows.some(r => r.id === dfId)).toBe(true);
  });

  it('DF: izolare org — ALOP cu titlu potrivit dintr-o ALTĂ org nu face DF-ul altei org să apară', async () => {
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'draft', nrUnic: 'DF-2026-001' });
    const { orgId: otherOrgId, userId: otherUserId } = await seedOrgUser({ orgName: 'Alta Org', email: 'other@x.ro', role: 'org_admin' });
    const otherAlopId = await seedAlop({ orgId: otherOrgId, createdBy: otherUserId, status: 'draft', titlu: 'Titlu Cross Tenant' });
    await pool.query(`UPDATE formulare_df SET source_alop_id=$1 WHERE id=$2`, [otherAlopId, dfId]);

    const res = await request(app).get('/api/formulare/list?type=df&nr=Cross%20Tenant').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.rows.some(r => r.id === dfId)).toBe(false);
  });

  it('ORD: nr caută în denumirea furnizorului (fo.beneficiar)', async () => {
    const ordId = await seedOrd({ orgId, createdBy: userId, status: 'draft', nrOrd: 'ORD-2026-111' });
    await pool.query(`UPDATE formulare_ord SET beneficiar=$1 WHERE id=$2`, ['SC ACME DISTRIBUTIE SRL', ordId]);

    const res = await request(app).get('/api/formulare/list?type=ord&nr=ACME').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.rows.some(r => r.id === ordId)).toBe(true);
  });

  it('ORD: căutarea numerică după fragmentul din nr_ordonant_pl rămâne funcțională', async () => {
    const ordId = await seedOrd({ orgId, createdBy: userId, status: 'draft', nrOrd: 'ORD-2026-222' });
    const res = await request(app).get('/api/formulare/list?type=ord&nr=2026-222').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.rows.some(r => r.id === ordId)).toBe(true);
  });
});
