/**
 * FEAT ALOP-CAB (v3.9.690) — compartimentul CAB al ORGANIZAȚIEI vede și editează tot ALOP/DF/ORD
 * din org, ca un org_admin limitat la aceste module. Rute REALE + Postgres real.
 *
 * Izolare maximă: „tot" = tot din actor.orgId, NICIODATĂ alt org (testul 10 = testul critic).
 * Fail-safe: org fără cab_compartiment ⇒ nimeni nu capătă acces cab_dept (testul 12).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, seedOrd, seedAlop, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('CAB dept — vede+editează tot org-ul, izolat pe org', () => {
  let app;
  let orgA, cabA, altA, thirdA;   // Org A: CAB setat pe 'Serviciul Buget'
  let orgB, userB, dfB;           // Org B: alt org, pentru izolare
  let dfAlt, dfThird, ordAlt, alopAlt;

  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    app = buildApp();

    // ── Org A — cu compartiment CAB = 'Serviciul Buget' ──────────────────────
    const sA = await seedOrgUser({ orgName: 'Org A CAB', email: 'cab-a@x.ro', role: 'user', compartiment: 'Serviciul Buget' });
    orgA = sA.orgId; cabA = sA.userId;
    await pool.query(`UPDATE organizations SET cab_compartiment='Serviciul Buget' WHERE id=$1`, [orgA]);
    altA   = await seedUser({ orgId: orgA, email: 'alt-a@x.ro',   role: 'user', compartiment: 'Achizitii' });
    thirdA = await seedUser({ orgId: orgA, email: 'third-a@x.ro', role: 'user', compartiment: 'Juridic' });

    // Documente create de useri NON-CAB, din compartimente diferite → nimeni în afară de CAB/admin ar trebui să le vadă pe toate.
    dfAlt   = await seedDf ({ orgId: orgA, createdBy: altA,   nrUnic: 'DF-A-ALT' });
    dfThird = await seedDf ({ orgId: orgA, createdBy: thirdA, nrUnic: 'DF-A-THIRD' });
    ordAlt  = await seedOrd({ orgId: orgA, createdBy: altA,   nrOrd:  'ORD-A-ALT' });
    alopAlt = await seedAlop({ orgId: orgA, createdBy: altA,  titlu:  'ALOP alt A' });

    // ── Org B — alt org, un DF ───────────────────────────────────────────────
    const sB = await seedOrgUser({ orgName: 'Org B', email: 'user-b@x.ro', role: 'user', compartiment: 'Buget B' });
    orgB = sB.orgId; userB = sB.userId;
    dfB  = await seedDf({ orgId: orgB, createdBy: userB, nrUnic: 'DF-B-001' });
  });
  afterAll(() => pool.end());

  const ids = (rows) => rows.map(r => String(r.id));

  it('6. CAB listează DF ⇒ vede DF-urile altor compartimente din org (alt + third)', async () => {
    const cookie = makeAuthCookie({ userId: cabA, role: 'user', orgId: orgA });
    const res = await request(app).get('/api/formulare/list?type=df').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(ids(res.body.rows)).toEqual(expect.arrayContaining([String(dfAlt), String(dfThird)]));
  });

  it('6b. CAB listează ORD ⇒ vede ORD-ul altui compartiment', async () => {
    const cookie = makeAuthCookie({ userId: cabA, role: 'user', orgId: orgA });
    const res = await request(app).get('/api/formulare/list?type=ord').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(ids(res.body.rows)).toContain(String(ordAlt));
  });

  it('7. CAB listează ALOP ⇒ vede ALOP-ul altui compartiment', async () => {
    const cookie = makeAuthCookie({ userId: cabA, role: 'user', orgId: orgA });
    const res = await request(app).get('/api/alop').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(ids(res.body.alop)).toContain(String(alopAlt));
  });

  it('8. CAB PUT pe DF-ul altui compartiment ⇒ 200 (poate edita)', async () => {
    const cookie = makeAuthCookie({ userId: cabA, role: 'user', orgId: orgA });
    const res = await request(app)
      .put(`/api/formulare-df/${dfAlt}`)
      .set('Cookie', cookie)
      .send({ subtitlu_df: 'editat de CAB' });
    expect(res.status).toBe(200);
  });

  it('9. CAB editează ALOP-ul altui compartiment (canEditAlop via /titlu) ⇒ 200', async () => {
    const cookie = makeAuthCookie({ userId: cabA, role: 'user', orgId: orgA });
    const res = await request(app)
      .post(`/api/alop/${alopAlt}/titlu`)
      .set('Cookie', cookie)
      .send({ titlu: 'retitlu CAB' });
    expect(res.status).toBe(200);
  });

  it('10. IZOLARE — CAB din Org A NU vede documentele Org B (listă + detaliu)', async () => {
    const cookie = makeAuthCookie({ userId: cabA, role: 'user', orgId: orgA });

    const list = await request(app).get('/api/formulare/list?type=df').set('Cookie', cookie);
    expect(list.status).toBe(200);
    expect(ids(list.body.rows)).not.toContain(String(dfB));

    const detail = await request(app).get(`/api/formulare-df/${dfB}`).set('Cookie', cookie);
    expect(detail.status).toBe(404);
  });

  it('11. CONTROL NEGATIV — non-CAB (Achizitii) NU vede DF-ul altui compartiment (Juridic)', async () => {
    const cookie = makeAuthCookie({ userId: altA, role: 'user', orgId: orgA });
    const res = await request(app).get('/api/formulare/list?type=df').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const seen = ids(res.body.rows);
    expect(seen).toContain(String(dfAlt));       // propriul DF — da
    expect(seen).not.toContain(String(dfThird)); // DF-ul din Juridic — NU (dovada că n-am relaxat pt. toți)
  });

  it('12. FAIL-SAFE — org fără cab_compartiment ⇒ nimeni nu capătă acces cab_dept', async () => {
    // Org C: user în compartiment 'Serviciul Buget' (același NUME), dar org C are cab_compartiment NULL.
    const sC = await seedOrgUser({ orgName: 'Org C fara CAB', email: 'buget-c@x.ro', role: 'user', compartiment: 'Serviciul Buget' });
    const orgC = sC.orgId, bugetC = sC.userId;
    const otherC = await seedUser({ orgId: orgC, email: 'other-c@x.ro', role: 'user', compartiment: 'Contabilitate' });
    const dfOtherC = await seedDf({ orgId: orgC, createdBy: otherC, nrUnic: 'DF-C-OTHER' });

    const cookie = makeAuthCookie({ userId: bugetC, role: 'user', orgId: orgC });
    const res = await request(app).get('/api/formulare/list?type=df').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(ids(res.body.rows)).not.toContain(String(dfOtherC)); // fără CAB setat → fără vizibilitate extra
  });
});
