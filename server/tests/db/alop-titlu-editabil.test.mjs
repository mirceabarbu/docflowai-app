import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedAlop, getAlop, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('POST /api/alop/:id/titlu (editare titlu ALOP, oricând, fără cascadă)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' }); // org 1, user 1 (creator)
    app = buildApp();
  });
  afterAll(() => pool.end());
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  it('titlu gol → 400 titlu_obligatoriu', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft', titlu: 'Vechi' });
    const res = await request(app).post(`/api/alop/${alopId}/titlu`)
      .set('Cookie', cookie()).send({ titlu: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('titlu_obligatoriu');
    expect((await getAlop(alopId)).titlu).toBe('Vechi');
  });

  it('titlu valid → 200, persistă, permis chiar pe ALOP completed', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'completed', titlu: 'Vechi' });
    const res = await request(app).post(`/api/alop/${alopId}/titlu`)
      .set('Cookie', cookie()).send({ titlu: 'Titlu Nou' });
    expect(res.status).toBe(200);
    expect(res.body.alop.titlu).toBe('Titlu Nou');
    expect((await getAlop(alopId)).titlu).toBe('Titlu Nou');
  });

  it('creator poate edita, alt user fără compartiment → 403', async () => {
    const otherId = await seedUser({ orgId: 1, email: 'other@x.ro', role: 'user', compartiment: '' });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft', titlu: 'Vechi' });
    const res = await request(app).post(`/api/alop/${alopId}/titlu`)
      .set('Cookie', makeAuthCookie({ userId: otherId, role: 'user', orgId: 1 }))
      .send({ titlu: 'Alt titlu' });
    expect(res.status).toBe(403);
    expect((await getAlop(alopId)).titlu).toBe('Vechi');
  });

  it('admin poate edita indiferent de creator', async () => {
    const adminId = await seedUser({ orgId: 1, email: 'admin@x.ro', role: 'admin' });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft', titlu: 'Vechi' });
    const res = await request(app).post(`/api/alop/${alopId}/titlu`)
      .set('Cookie', makeAuthCookie({ userId: adminId, role: 'admin', orgId: 1 }))
      .send({ titlu: 'Titlu Admin' });
    expect(res.status).toBe(200);
    expect((await getAlop(alopId)).titlu).toBe('Titlu Admin');
  });
});
