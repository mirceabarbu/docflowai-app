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
    // subtitlu_df e în DF_P1_FIELDS (text liber, fără constraint-uri) → PUT valid
    const res = await request(app).put(`/api/formulare-df/${id}`).set('Cookie', cookie())
      .send({ subtitlu_df: 'updated by test' });
    expect(res.status).toBe(200);
    expect(res.body.document.capabilities).toBeTruthy();
    // draft + creator → can_send_p2 + can_reset
    expect(res.body.document.capabilities.can_send_p2).toBe(true);
    expect(res.body.document.status).toBe('draft');
  });

  it('POST create ORD → capabilities (draft → can_send_p2)', async () => {
    const res = await request(app).post('/api/formulare-ord').set('Cookie', cookie()).send({});
    expect(res.status).toBe(200);
    expect(res.body.document.capabilities).toBeTruthy();
    expect(res.body.document.capabilities.can_send_p2).toBe(true);
  });

  it('POST returneaza DF → document.capabilities (returnat)', async () => {
    await pool.query(`INSERT INTO users (email, password_hash, nume, role, org_id) VALUES ('p2@x.ro','x','P2','user',1)`);
    const created = await request(app).post('/api/formulare-df').set('Cookie', cookie()).send({ nr_unic_inreg: 'RET-1' });
    const id = created.body.document.id;
    await request(app).post(`/api/formulare-df/${id}/submit`).set('Cookie', cookie()).send({ assigned_to: 2 });
    const p2cookie = makeAuthCookie({ userId: 2, role: 'user', orgId: 1 });
    const res = await request(app).post(`/api/formulare-df/${id}/returneaza`).set('Cookie', p2cookie).send({ motiv: 'lipsă' });
    expect(res.status).toBe(200);
    expect(res.body.document).toBeTruthy();
    expect(res.body.document.capabilities).toBeTruthy();
  });
});
