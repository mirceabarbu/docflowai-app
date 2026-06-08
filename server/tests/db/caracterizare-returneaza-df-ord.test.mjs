// Caracterizare (Etapa 0 refactor) — POST /api/formulare-{df|ord}/:id/returneaza.
// Afirmă: status rezultat, motiv persistat, cine poate (P2-side), erorile curente.
// Efectul notificării e non-fatal (sendNotif scrie în `notifications`, tabelă opțională în
// schema de test) → caracterizăm efectul OBSERVABIL în DB/răspuns: status='returnat' + motiv.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, seedOrd, getDf, getOrd, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('POST /api/formulare-*/:id/returneaza (caracterizare)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' });   // id 1, org 1 (creator)
    await seedUser({ orgId: 1, email: 'p2@x.ro' });           // id 2, org 1 (P2)
    app = buildApp();
  });
  afterAll(() => pool.end());
  const p1 = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });
  const p2 = () => makeAuthCookie({ userId: 2, role: 'user', orgId: 1 });

  // ── happy path ──────────────────────────────────────────────────────────────
  it('DF: P2 returnează din pending_p2 cu motiv → 200, status returnat, motiv_returnare persistat', async () => {
    const id = await seedDf({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2 });
    const res = await request(app).post(`/api/formulare-df/${id}/returneaza`).set('Cookie', p2()).send({ motiv: 'lipsă document' });
    expect(res.status).toBe(200);
    expect(res.body.document.status).toBe('returnat');
    expect(res.body.document.capabilities).toBeTruthy();
    const row = await getDf(id);
    expect(row.status).toBe('returnat');
    expect(row.motiv_returnare).toBe('lipsă document');
  });

  it('ORD: P2 returnează din pending_p2 cu motiv → 200, status returnat, motiv_returnare persistat', async () => {
    const id = await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2 });
    const res = await request(app).post(`/api/formulare-ord/${id}/returneaza`).set('Cookie', p2()).send({ motiv: 'IBAN greșit' });
    expect(res.status).toBe(200);
    expect(res.body.document.status).toBe('returnat');
    const row = await getOrd(id);
    expect(row.status).toBe('returnat');
    expect(row.motiv_returnare).toBe('IBAN greșit');
  });

  // ── motiv obligatoriu ───────────────────────────────────────────────────────────
  it('DF: fără motiv → 400 motiv_obligatoriu, status neschimbat', async () => {
    const id = await seedDf({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2 });
    const res = await request(app).post(`/api/formulare-df/${id}/returneaza`).set('Cookie', p2()).send({ motiv: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('motiv_obligatoriu');
    expect((await getDf(id)).status).toBe('pending_p2');
  });

  it('ORD: fără motiv → 400 motiv_obligatoriu', async () => {
    const id = await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2 });
    const res = await request(app).post(`/api/formulare-ord/${id}/returneaza`).set('Cookie', p2()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('motiv_obligatoriu');
  });

  // ── autorizare: doar P2-side ─────────────────────────────────────────────────────
  it('DF: P1 (creator, neasignat) încearcă returneaza → 403 forbidden', async () => {
    const id = await seedDf({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2 });
    const res = await request(app).post(`/api/formulare-df/${id}/returneaza`).set('Cookie', p1()).send({ motiv: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
    expect((await getDf(id)).status).toBe('pending_p2');
  });

  it('ORD: P1 (creator, neasignat) încearcă returneaza → 403 forbidden', async () => {
    const id = await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2 });
    const res = await request(app).post(`/api/formulare-ord/${id}/returneaza`).set('Cookie', p1()).send({ motiv: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });

  // ── status invalid ──────────────────────────────────────────────────────────────
  it('DF: returneaza pe status non-pending_p2 (draft) → 409 status_invalid + status', async () => {
    const id = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', assignedTo: 2 });
    const res = await request(app).post(`/api/formulare-df/${id}/returneaza`).set('Cookie', p2()).send({ motiv: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('status_invalid');
    expect(res.body.status).toBe('draft');
  });

  it('ORD: returneaza pe status non-pending_p2 (completed) → 409 status_invalid + status', async () => {
    const id = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', assignedTo: 2 });
    const res = await request(app).post(`/api/formulare-ord/${id}/returneaza`).set('Cookie', p2()).send({ motiv: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('status_invalid');
    expect(res.body.status).toBe('completed');
  });
});
