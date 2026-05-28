import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool, seedOrgUser, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('Răspunsurile de mutație DF/ORD includ document.capabilities', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await seedOrgUser({ role: 'user' }); app = buildApp(); });
  afterAll(() => pool.end());
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  it('POST create DF → capabilities (draft → can_send_p2)', async () => {
    const res = await request(app).post('/api/formulare-df').set('Cookie', cookie()).send({});
    expect(res.status).toBe(200);
    expect(res.body.document.capabilities).toBeTruthy();
    expect(res.body.document.capabilities.can_send_p2).toBe(true);
  });

  it('PUT DF (draft, creator) → capabilities prezent', async () => {
    const created = await request(app).post('/api/formulare-df').set('Cookie', cookie()).send({});
    const id = created.body.document.id;
    const res = await request(app).put(`/api/formulare-df/${id}`).set('Cookie', cookie()).send({ notes: 'x' });
    expect(res.status).toBe(200);
    expect(res.body.document.capabilities).toBeTruthy();
  });

  it('POST create ORD → capabilities (draft → can_send_p2)', async () => {
    const res = await request(app).post('/api/formulare-ord').set('Cookie', cookie()).send({});
    expect(res.status).toBe(200);
    expect(res.body.document.capabilities).toBeTruthy();
    expect(res.body.document.capabilities.can_send_p2).toBe(true);
  });
});
