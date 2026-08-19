/**
 * #132a: filtrele de Status la GET /api/formulare/list reflectă exact stările afișate
 * (badge ⟺ filtru). Acoperă în principal derivarea `neaprobat` din refuzul fluxului
 * (badge_status), care înainte lăsa un DF/ORD refuzat afișat „De revizuit"/„Completat".
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedFlow, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

async function markFlowRefused(flowId) {
  await pool.query(
    `UPDATE flows SET data = jsonb_set(data, '{status}', '"refused"') WHERE id=$1`,
    [flowId]
  );
}

d('GET /api/formulare/list?status= — filtrele reflectă exact badge_status (#132a)', () => {
  let app, orgId, userId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    ({ orgId, userId } = await seedOrgUser({ role: 'org_admin' }));
    app = buildApp();
  });
  afterAll(() => pool.end());

  const cookie = () => makeAuthCookie({ userId: 1, role: 'org_admin', orgId: 1 });

  // ── DF ───────────────────────────────────────────────────────────────────

  it('1. DF: status=returnat întoarce DF-ul cu status=returnat și badge_status=returnat', async () => {
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'returnat', nrUnic: 'DF-2026-101' });

    const res = await request(app).get('/api/formulare/list?type=df&status=returnat').set('Cookie', cookie());
    expect(res.status).toBe(200);
    const row = res.body.rows.find(r => r.id === dfId);
    expect(row).toBeTruthy();
    expect(row.badge_status).toBe('returnat');
  });

  it('2. DF: status=de_revizuit întoarce DF-ul cu status=de_revizuit și badge_status=de_revizuit', async () => {
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'de_revizuit', nrUnic: 'DF-2026-102' });

    const res = await request(app).get('/api/formulare/list?type=df&status=de_revizuit').set('Cookie', cookie());
    expect(res.status).toBe(200);
    const row = res.body.rows.find(r => r.id === dfId);
    expect(row).toBeTruthy();
    expect(row.badge_status).toBe('de_revizuit');
  });

  it('3. DF: status=neaprobat întoarce ATÂT DF-ul cu status=neaprobat fără flux, CÂT ȘI DF-ul de_revizuit cu flux refuzat (badge derivat)', async () => {
    const dfIdNeaprobat = await seedDf({ orgId, createdBy: userId, status: 'neaprobat', nrUnic: 'DF-2026-103' });

    const flowId = await seedFlow({ orgId, completed: false });
    await markFlowRefused(flowId);
    const dfIdDeRevizuitRefuzat = await seedDf({ orgId, createdBy: userId, status: 'de_revizuit', flowId, nrUnic: 'DF-2026-104' });

    const res = await request(app).get('/api/formulare/list?type=df&status=neaprobat').set('Cookie', cookie());
    expect(res.status).toBe(200);

    const rowNeaprobat = res.body.rows.find(r => r.id === dfIdNeaprobat);
    expect(rowNeaprobat).toBeTruthy();
    expect(rowNeaprobat.badge_status).toBe('neaprobat');

    const rowDeRevizuitRefuzat = res.body.rows.find(r => r.id === dfIdDeRevizuitRefuzat);
    expect(rowDeRevizuitRefuzat).toBeTruthy();
    expect(rowDeRevizuitRefuzat.badge_status).toBe('neaprobat');
  });

  it('4. DF: status=completed NU întoarce un DF completed al cărui flux e refuzat', async () => {
    const flowId = await seedFlow({ orgId, completed: false });
    await markFlowRefused(flowId);
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'completed', flowId, nrUnic: 'DF-2026-105' });

    const res = await request(app).get('/api/formulare/list?type=df&status=completed').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.rows.some(r => r.id === dfId)).toBe(false);
  });

  it('5. DF: status=de_revizuit NU întoarce DF-ul de_revizuit al cărui flux e refuzat (garda _dfRespins)', async () => {
    const flowId = await seedFlow({ orgId, completed: false });
    await markFlowRefused(flowId);
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'de_revizuit', flowId, nrUnic: 'DF-2026-106' });

    const res = await request(app).get('/api/formulare/list?type=df&status=de_revizuit').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.rows.some(r => r.id === dfId)).toBe(false);
  });

  it('6. DF: invariant — pentru fiecare rând întors la status=X, row.badge_status === X', async () => {
    const statuses = ['draft', 'pending_p2', 'returnat', 'de_revizuit', 'neaprobat'];
    for (let i = 0; i < statuses.length; i++) {
      await seedDf({ orgId, createdBy: userId, status: statuses[i], nrUnic: `DF-2026-2${i}0` });
    }
    for (const st of statuses) {
      const res = await request(app).get(`/api/formulare/list?type=df&status=${st}`).set('Cookie', cookie());
      expect(res.status).toBe(200);
      for (const row of res.body.rows) {
        expect(row.badge_status).toBe(st);
      }
    }
  });

  // ── ORD ──────────────────────────────────────────────────────────────────

  it('7. ORD: status=returnat întoarce ORD-ul returnat', async () => {
    const ordId = await seedOrd({ orgId, createdBy: userId, status: 'returnat', nrOrd: 'ORD-2026-101' });

    const res = await request(app).get('/api/formulare/list?type=ord&status=returnat').set('Cookie', cookie());
    expect(res.status).toBe(200);
    const row = res.body.rows.find(r => r.id === ordId);
    expect(row).toBeTruthy();
    expect(row.badge_status).toBe('returnat');
  });

  it('8. ORD: status=neaprobat întoarce ORD-ul completed cu flux refuzat, badge_status=neaprobat (NU completed)', async () => {
    const flowId = await seedFlow({ orgId, completed: false });
    await markFlowRefused(flowId);
    const ordId = await seedOrd({ orgId, createdBy: userId, status: 'completed', flowId, nrOrd: 'ORD-2026-102' });

    const res = await request(app).get('/api/formulare/list?type=ord&status=neaprobat').set('Cookie', cookie());
    expect(res.status).toBe(200);
    const row = res.body.rows.find(r => r.id === ordId);
    expect(row).toBeTruthy();
    expect(row.badge_status).toBe('neaprobat');
  });

  it('9. ORD: status=completed NU întoarce ORD-ul de la cazul 8 (refuzat)', async () => {
    const flowId = await seedFlow({ orgId, completed: false });
    await markFlowRefused(flowId);
    const ordId = await seedOrd({ orgId, createdBy: userId, status: 'completed', flowId, nrOrd: 'ORD-2026-103' });

    const res = await request(app).get('/api/formulare/list?type=ord&status=completed').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.rows.some(r => r.id === ordId)).toBe(false);
  });

  it('10. ORD: status=transmis_flux neschimbat — ORD completed + flux activ nefinalizat', async () => {
    const flowId = await seedFlow({ orgId, completed: false });
    const ordId = await seedOrd({ orgId, createdBy: userId, status: 'completed', flowId, nrOrd: 'ORD-2026-104' });

    const res = await request(app).get('/api/formulare/list?type=ord&status=transmis_flux').set('Cookie', cookie());
    expect(res.status).toBe(200);
    const row = res.body.rows.find(r => r.id === ordId);
    expect(row).toBeTruthy();
    expect(row.badge_status).toBe('transmis_flux');
  });
});
