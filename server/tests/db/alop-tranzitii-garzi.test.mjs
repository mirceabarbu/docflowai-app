/**
 * Caracterizare: gărzile rutelor de tranziție ALOP.
 *   - id_invalid (':id' = 'null'/'undefined' pe rutele cu gardă explicită)
 *   - 404 not_found (UUID valid inexistent / altă organizație)
 *   - 403 forbidden (actor fără drept, via canEditAlop)
 *   - 400 status_invalid (tranziție din stare greșită)
 *
 * Fotografie a comportamentului CURENT. Codurile/erorile sunt transcrise din handlere.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedAlop, getAlop, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());
const ABSENT_UUID = '00000000-0000-0000-0000-000000000999';

d('ALOP — gărzi rute de tranziție', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await seedOrgUser({ role: 'user' }); app = buildApp(); });
  afterAll(() => pool.end());

  const cookie = (over = {}) => makeAuthCookie({ userId: 1, role: 'user', orgId: 1, ...over });

  // ── id_invalid (doar pe rutele cu gardă explicită la începutul handler-ului) ──
  it('confirma-lichidare cu :id = "null" → 400 id_invalid', async () => {
    const res = await request(app).post('/api/alop/null/confirma-lichidare').set('Cookie', cookie()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('id_invalid');
  });

  it('confirma-lichidare cu :id = "undefined" → 400 id_invalid', async () => {
    const res = await request(app).post('/api/alop/undefined/confirma-lichidare').set('Cookie', cookie()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('id_invalid');
  });

  it('confirma-plata cu :id = "null" → 400 id_invalid', async () => {
    const res = await request(app).post('/api/alop/null/confirma-plata').set('Cookie', cookie()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('id_invalid');
  });

  it('noua-lichidare cu :id = "null" → 400 id_invalid', async () => {
    const res = await request(app).post('/api/alop/null/noua-lichidare').set('Cookie', cookie()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('id_invalid');
  });

  // ── 404 not_found (UUID valid, inexistent) ───────────────────────────────────
  it('confirma-lichidare pe UUID inexistent → 404 not_found', async () => {
    const res = await request(app).post(`/api/alop/${ABSENT_UUID}/confirma-lichidare`).set('Cookie', cookie()).send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

  it('confirma-plata pe UUID inexistent → 404 not_found', async () => {
    const res = await request(app).post(`/api/alop/${ABSENT_UUID}/confirma-plata`).set('Cookie', cookie()).send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

  // ── 403 forbidden (actor fără drept) ─────────────────────────────────────────
  it('confirma-plata de către alt user (fără rol/comp) → 403 forbidden', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'plata' });
    const otherUserId = await seedUser({ orgId: 1, email: 'other@x.ro', compartiment: '' });
    const res = await request(app).post(`/api/alop/${alopId}/confirma-plata`)
      .set('Cookie', cookie({ userId: otherUserId })).send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
    expect((await getAlop(alopId)).status).toBe('plata');
  });

  // ── 400 status_invalid (tranziție din stare greșită) ─────────────────────────
  it('confirma-plata din draft → 400 status_invalid', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft' });
    const res = await request(app).post(`/api/alop/${alopId}/confirma-plata`).set('Cookie', cookie()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('status_invalid');
    expect((await getAlop(alopId)).status).toBe('draft');
  });

  it('confirma-lichidare din draft → 400 status_invalid', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft' });
    const res = await request(app).post(`/api/alop/${alopId}/confirma-lichidare`).set('Cookie', cookie()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('status_invalid');
    expect((await getAlop(alopId)).status).toBe('draft');
  });

  // ── izolare org → 404 (ALOP din altă organizație) ────────────────────────────
  it('confirma-plata pe ALOP din altă org → 404 not_found', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'plata' });
    // a doua organizație + utilizator (org id=2, user id=2)
    const { orgId: org2, userId: user2 } = await seedOrgUser({ orgName: 'Org 2', email: 'org2@x.ro', role: 'user' });
    const res = await request(app).post(`/api/alop/${alopId}/confirma-plata`)
      .set('Cookie', cookie({ userId: user2, orgId: org2 })).send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });
});
