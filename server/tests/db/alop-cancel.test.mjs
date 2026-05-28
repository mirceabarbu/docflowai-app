import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedAlop, getAlop, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('POST /api/alop/:id/cancel (caracterizare ștergere ALOP)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await seedOrgUser({ role: 'user' }); app = buildApp(); });
  afterAll(() => pool.end());
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  it('ALOP fără DF/ORD → 200, cancelled_at setat', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft' });
    const res = await request(app).post(`/api/alop/${alopId}/cancel`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect((await getAlop(alopId)).cancelled_at).not.toBeNull();
  });

  it('ALOP cu DF legat ne-șters → 409 cancel_blocked_df_exists', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'draft' });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', dfId });
    const res = await request(app).post(`/api/alop/${alopId}/cancel`).set('Cookie', cookie());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cancel_blocked_df_exists');
    expect((await getAlop(alopId)).cancelled_at).toBeNull();
  });

  it('ALOP cu ORD legată ne-ștearsă → 409 cancel_blocked_ord_exists', async () => {
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'draft' });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', ordId });
    const res = await request(app).post(`/api/alop/${alopId}/cancel`).set('Cookie', cookie());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cancel_blocked_ord_exists');
  });
});
