// Caracterizare (Etapa 0 refactor) — POST /api/formulare-{df|ord}/:id/submit.
// Fotografie a comportamentului CURENT înainte de consolidarea handler-elor DF/ORD.
// Dacă un assert pică pentru că ipoteza era greșită → corectează TESTUL, nu codul.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, seedOrd, getDf, getOrd, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('POST /api/formulare-*/:id/submit (caracterizare)', () => {
  let app;
  beforeAll(migrate);
  // userId 1 = P1 (creator), userId 2 = P2 (assigned) — ambii în org 1.
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' });          // id 1, org 1
    await seedUser({ orgId: 1, email: 'p2@x.ro' });                  // id 2, org 1
    app = buildApp();
  });
  afterAll(() => pool.end());
  const p1 = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  // ── happy path ──────────────────────────────────────────────────────────────
  it('DF din draft cu P2 valid → 200, pending_p2, assigned_to persistă, capabilities prezent', async () => {
    const id = await seedDf({ orgId: 1, createdBy: 1, status: 'draft' });
    const res = await request(app).post(`/api/formulare-df/${id}/submit`).set('Cookie', p1()).send({ assigned_to: 2 });
    expect(res.status).toBe(200);
    expect(res.body.document.status).toBe('pending_p2');
    expect(res.body.document.assigned_to).toBe(2);
    expect(res.body.assigned_to.id).toBe(2);
    // capabilities calculate cu ft='notafd' (DF). Nu există câmp `capsFt`; forma reală:
    // P1 + pending_p2 → is_waiting_p2.
    expect(res.body.document.capabilities).toBeTruthy();
    expect(res.body.document.capabilities.is_waiting_p2).toBe(true);
    expect((await getDf(id)).status).toBe('pending_p2');
  });

  it('ORD din draft cu P2 valid → 200, pending_p2, assigned_to persistă, capabilities prezent', async () => {
    const id = await seedOrd({ orgId: 1, createdBy: 1, status: 'draft' });
    const res = await request(app).post(`/api/formulare-ord/${id}/submit`).set('Cookie', p1()).send({ assigned_to: 2 });
    expect(res.status).toBe(200);
    expect(res.body.document.status).toBe('pending_p2');
    expect(res.body.document.assigned_to).toBe(2);
    // capabilities calculate cu ft='ordnt' (ORD).
    expect(res.body.document.capabilities).toBeTruthy();
    expect(res.body.document.capabilities.is_waiting_p2).toBe(true);
    expect((await getOrd(id)).status).toBe('pending_p2');
  });

  it('din returnat → 200 pentru AMBELE tipuri (status comun acceptat)', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'returnat' });
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'returnat' });
    const rDf = await request(app).post(`/api/formulare-df/${dfId}/submit`).set('Cookie', p1()).send({ assigned_to: 2 });
    const rOrd = await request(app).post(`/api/formulare-ord/${ordId}/submit`).set('Cookie', p1()).send({ assigned_to: 2 });
    expect(rDf.status).toBe(200);
    expect(rOrd.status).toBe(200);
  });

  // ── ASIMETRIA CRITICĂ ─────────────────────────────────────────────────────────
  // ASIMETRIE INTENȚIONATĂ — NU uniformiza la consolidare.
  // DF acceptă submit din `de_revizuit` (['draft','returnat','de_revizuit']),
  // ORD NU (['draft','returnat']).
  it('ASIMETRIE: DF din de_revizuit → 200 (ACCEPTĂ)', async () => {
    const id = await seedDf({ orgId: 1, createdBy: 1, status: 'de_revizuit' });
    const res = await request(app).post(`/api/formulare-df/${id}/submit`).set('Cookie', p1()).send({ assigned_to: 2 });
    expect(res.status).toBe(200);
    expect(res.body.document.status).toBe('pending_p2');
  });

  it('ASIMETRIE: ORD din de_revizuit → 409 document_not_draft (RESPINGE)', async () => {
    const id = await seedOrd({ orgId: 1, createdBy: 1, status: 'de_revizuit' });
    const res = await request(app).post(`/api/formulare-ord/${id}/submit`).set('Cookie', p1()).send({ assigned_to: 2 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('document_not_draft');
    expect(res.body.status).toBe('de_revizuit');
  });

  // ── erori curente ──────────────────────────────────────────────────────────────
  it('DF fără assigned_to → 400 assigned_to obligatoriu', async () => {
    const id = await seedDf({ orgId: 1, createdBy: 1, status: 'draft' });
    const res = await request(app).post(`/api/formulare-df/${id}/submit`).set('Cookie', p1()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('assigned_to obligatoriu');
  });

  it('ORD fără assigned_to → 400 assigned_to obligatoriu', async () => {
    const id = await seedOrd({ orgId: 1, createdBy: 1, status: 'draft' });
    const res = await request(app).post(`/api/formulare-ord/${id}/submit`).set('Cookie', p1()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('assigned_to obligatoriu');
  });

  it('DF din status invalid (aprobat) → 409 document_not_draft + status', async () => {
    const id = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat' });
    const res = await request(app).post(`/api/formulare-df/${id}/submit`).set('Cookie', p1()).send({ assigned_to: 2 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('document_not_draft');
    expect(res.body.status).toBe('aprobat');
  });

  it('ORD din status invalid (completed) → 409 document_not_draft + status', async () => {
    const id = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed' });
    const res = await request(app).post(`/api/formulare-ord/${id}/submit`).set('Cookie', p1()).send({ assigned_to: 2 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('document_not_draft');
    expect(res.body.status).toBe('completed');
  });

  // ── izolare org pe P2 (assigned_to dintr-o ALTĂ organizație) ─────────────────────
  it('DF: P2 din altă organizație → 400 utilizator_invalid', async () => {
    // user 3 într-o a doua organizație (seedOrgUser creează org 2 + user 3)
    await seedOrgUser({ orgName: 'Org 2', role: 'user', email: 'other@x.ro' }); // org 2, user 3
    const id = await seedDf({ orgId: 1, createdBy: 1, status: 'draft' });
    const res = await request(app).post(`/api/formulare-df/${id}/submit`).set('Cookie', p1()).send({ assigned_to: 3 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('utilizator_invalid');
  });

  it('ORD: P2 din altă organizație → 400 utilizator_invalid', async () => {
    await seedOrgUser({ orgName: 'Org 2', role: 'user', email: 'other@x.ro' }); // org 2, user 3
    const id = await seedOrd({ orgId: 1, createdBy: 1, status: 'draft' });
    const res = await request(app).post(`/api/formulare-ord/${id}/submit`).set('Cookie', p1()).send({ assigned_to: 3 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('utilizator_invalid');
  });

  // ── izolare org pe DOCUMENT (doc dintr-o altă org → 404) ─────────────────────────
  it('DF dintr-o altă org → 404 not_found', async () => {
    await seedOrgUser({ orgName: 'Org 2', role: 'user', email: 'other@x.ro' }); // org 2, user 3
    const id = await seedDf({ orgId: 2, createdBy: 3, status: 'draft' });
    const res = await request(app).post(`/api/formulare-df/${id}/submit`).set('Cookie', p1()).send({ assigned_to: 2 });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });
});
