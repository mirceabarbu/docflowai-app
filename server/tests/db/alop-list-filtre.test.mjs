/**
 * #121: filtre listă ALOP pe GET /api/alop (oglindesc DF/ORD) — q (titlu), status, comp
 * (compartiment), from/to (created_at), creat (EXISTS corelat pe users, NU JOIN — COUNT-ul
 * n-are JOIN pe users). Actor = org_admin, ca să testăm filtrele și nu vizibilitatea.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedAlop, seedDf, seedFlow, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('GET /api/alop — filtre listă (#121)', () => {
  let app, orgId, adminId, budgetUserId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    ({ orgId, userId: adminId } = await seedOrgUser({ role: 'org_admin', email: 'admin@x.ro', compartiment: 'Conducere' }));
    // user secundar în ACEEAȘI org (nu seedOrgUser — ar crea o organizație nouă)
    const { rows: usr } = await pool.query(
      `INSERT INTO users (email, password_hash, nume, role, compartiment, org_id)
       VALUES ($1, 'x', 'Test Buget', 'user', $2, $3) RETURNING id`,
      ['buget@x.ro', 'Serviciul Buget', orgId]
    );
    budgetUserId = usr[0].id;
    app = buildApp();
  });
  afterAll(() => pool.end());

  const cookie = () => makeAuthCookie({ userId: adminId, role: 'org_admin', orgId, email: 'admin@x.ro' });

  it('?q=<fragment titlu> — doar ALOP-urile cu titlul potrivit', async () => {
    const a1 = await seedAlop({ orgId, createdBy: adminId, status: 'draft', titlu: 'Reparatii strada Garii' });
    const a2 = await seedAlop({ orgId, createdBy: adminId, status: 'draft', titlu: 'Modernizare Parc' });

    const res = await request(app).get('/api/alop?q=Reparatii').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.alop.map(a => a.id)).toEqual([a1]);
    expect(res.body.alop.map(a => a.id)).not.toContain(a2);
  });

  it('?status=lichidare — doar cele în lichidare', async () => {
    const a1 = await seedAlop({ orgId, createdBy: adminId, status: 'lichidare', titlu: 'ALOP Lichidare' });
    await seedAlop({ orgId, createdBy: adminId, status: 'draft', titlu: 'ALOP Draft' });

    const res = await request(app).get('/api/alop?status=lichidare').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.alop.map(a => a.id)).toEqual([a1]);
  });

  it('?comp=<compartiment> — doar ALOP cu compartiment potrivit', async () => {
    const a1 = await seedAlop({ orgId, createdBy: adminId, status: 'draft', titlu: 'ALOP Buget', compartiment: 'Serviciul Buget' });
    await seedAlop({ orgId, createdBy: adminId, status: 'draft', titlu: 'ALOP Juridic', compartiment: 'Compartimentul Juridic' });

    const res = await request(app).get('/api/alop?comp=' + encodeURIComponent('Serviciul Buget')).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.alop.map(a => a.id)).toEqual([a1]);
  });

  it('?creat=<nume/email creator> — doar ALOP create de acel user (EXISTS corelat, COUNT corect)', async () => {
    const a1 = await seedAlop({ orgId, createdBy: budgetUserId, status: 'draft', titlu: 'ALOP Buget User' });
    await seedAlop({ orgId, createdBy: adminId, status: 'draft', titlu: 'ALOP Admin User' });

    const res = await request(app).get('/api/alop?creat=buget@x.ro').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.alop.map(a => a.id)).toEqual([a1]);
  });

  it('?from=&to= — interval pe created_at, to inclusiv până la 23:59:59', async () => {
    const aOld = await seedAlop({ orgId, createdBy: adminId, status: 'draft', titlu: 'ALOP Vechi' });
    await pool.query(`UPDATE alop_instances SET created_at = '2020-01-01T10:00:00Z' WHERE id = $1`, [aOld]);
    const aToday = await seedAlop({ orgId, createdBy: adminId, status: 'draft', titlu: 'ALOP Azi' });

    const today = new Date().toISOString().slice(0, 10);
    const res = await request(app).get(`/api/alop?from=${today}&to=${today}`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.alop.map(a => a.id)).toEqual([aToday]);
  });

  it('combinație ?status=...&comp=... — intersecție corectă', async () => {
    const aMatch = await seedAlop({ orgId, createdBy: adminId, status: 'lichidare', titlu: 'ALOP Match', compartiment: 'Serviciul Buget' });
    await seedAlop({ orgId, createdBy: adminId, status: 'draft', titlu: 'ALOP Status Diferit', compartiment: 'Serviciul Buget' });
    await seedAlop({ orgId, createdBy: adminId, status: 'lichidare', titlu: 'ALOP Comp Diferit', compartiment: 'Compartimentul Juridic' });

    const res = await request(app).get('/api/alop?status=lichidare&comp=' + encodeURIComponent('Serviciul Buget')).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.alop.map(a => a.id)).toEqual([aMatch]);
  });

  it('?q=zzz-inexistent — total=0, alop=[]', async () => {
    await seedAlop({ orgId, createdBy: adminId, status: 'draft', titlu: 'ALOP Oarecare' });

    const res = await request(app).get('/api/alop?q=zzz-inexistent').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.alop).toEqual([]);
  });

  // ── #132b — badge_status derivat server-side; filtrul e inversa lui exactă ─────────
  //
  // Fixtures (fiecare cu un rând REAL în `flows`, ca derivarea să aibă ce citi):
  //   A — angajare, DF fără flux                       ⇒ angajare
  //   B — angajare, DF cu flux ACTIV, revizie_nr=0     ⇒ angajare_flux
  //   C — lichidare, DF revizie_nr=1 + flux ACTIV      ⇒ revizie_flux (revizia bate FAZA)
  //   D — lichidare, DF fără revizie                   ⇒ lichidare
  //   E — angajare, flux REFUZAT (deci NU activ)       ⇒ angajare
  describe('#132b — badge_status + filtru derivat', () => {
    let A, B, C, D, E;

    async function seedBadgeFixtures() {
      // A — DF fără flux
      const dfA = await seedDf({ orgId, createdBy: adminId, status: 'completed', nrUnic: 'DF-A' });
      A = await seedAlop({ orgId, createdBy: adminId, status: 'angajare', titlu: 'ALOP A', dfId: dfA });

      // B — DF cu flux ACTIV (pending), fără revizie
      const flB = await seedFlow({ orgId, completed: false });
      const dfB = await seedDf({ orgId, createdBy: adminId, status: 'transmis_flux', nrUnic: 'DF-B', flowId: flB });
      B = await seedAlop({ orgId, createdBy: adminId, status: 'angajare', titlu: 'ALOP B', dfId: dfB, dfFlowId: flB });

      // C — revizie R1 pe flux ACTIV, dar ALOP e deja în lichidare
      const flC = await seedFlow({ orgId, completed: false });
      const dfC = await seedDf({ orgId, createdBy: adminId, status: 'transmis_flux', nrUnic: 'DF-C', flowId: flC, revizieNr: 1 });
      C = await seedAlop({ orgId, createdBy: adminId, status: 'lichidare', titlu: 'ALOP C', dfId: dfC, dfFlowId: flC });

      // D — lichidare curată, DF fără revizie și fără flux activ
      const dfD = await seedDf({ orgId, createdBy: adminId, status: 'completed', nrUnic: 'DF-D' });
      D = await seedAlop({ orgId, createdBy: adminId, status: 'lichidare', titlu: 'ALOP D', dfId: dfD });

      // E — flux REFUZAT ⇒ nu e activ ⇒ badge rămâne faza brută
      const flE = await seedFlow({ orgId, completed: false });
      await pool.query(`UPDATE flows SET data = jsonb_set(data, '{status}', '"refused"') WHERE id = $1`, [flE]);
      const dfE = await seedDf({ orgId, createdBy: adminId, status: 'transmis_flux', nrUnic: 'DF-E', flowId: flE });
      E = await seedAlop({ orgId, createdBy: adminId, status: 'angajare', titlu: 'ALOP E', dfId: dfE, dfFlowId: flE });
    }

    beforeEach(seedBadgeFixtures);

    // `alop_instances.id` e UUID (string) — sortare LEXICOGRAFICĂ, nu numerică:
    // un comparator `x - y` întoarce NaN și lasă ordinea neschimbată (fals negativ mascat).
    const ids = res => res.body.alop.map(a => a.id).sort();

    it('1. ?status=angajare — A și E (flux refuzat ≠ activ), NU B', async () => {
      const res = await request(app).get('/api/alop?status=angajare').set('Cookie', cookie());
      expect(res.status).toBe(200);
      expect(ids(res)).toEqual([A, E].sort());
      expect(ids(res)).not.toContain(B);
    });

    it('2. ?status=angajare_flux — B, NU A', async () => {
      const res = await request(app).get('/api/alop?status=angajare_flux').set('Cookie', cookie());
      expect(res.status).toBe(200);
      expect(ids(res)).toEqual([B]);
      expect(ids(res)).not.toContain(A);
    });

    it('3. ?status=revizie_flux — C (revizia suprascrie ORICE fază), NU B', async () => {
      const res = await request(app).get('/api/alop?status=revizie_flux').set('Cookie', cookie());
      expect(res.status).toBe(200);
      expect(ids(res)).toEqual([C]);
      expect(ids(res)).not.toContain(B);
    });

    it('4. ?status=lichidare — D, NU C', async () => {
      const res = await request(app).get('/api/alop?status=lichidare').set('Cookie', cookie());
      expect(res.status).toBe(200);
      expect(ids(res)).toEqual([D]);
      expect(ids(res)).not.toContain(C);
    });

    it('5. ?status=completed — niciunul dintre A-E', async () => {
      const res = await request(app).get('/api/alop?status=completed').set('Cookie', cookie());
      expect(res.status).toBe(200);
      expect(res.body.alop).toEqual([]);
      expect(res.body.total).toBe(0);
    });

    it('6. total (COUNT fără JOIN) === rows.length pentru FIECARE filtru derivat', async () => {
      for (const st of ['angajare', 'angajare_flux', 'revizie_flux', 'lichidare', 'completed']) {
        const res = await request(app).get('/api/alop?status=' + st).set('Cookie', cookie());
        expect(res.status).toBe(200);
        expect({ st, total: res.body.total }).toEqual({ st, total: res.body.alop.length });
      }
    });

    it('7. invariant — fiecare rând întors la ?status=X are badge_status === X', async () => {
      for (const st of ['angajare', 'angajare_flux', 'revizie_flux', 'lichidare']) {
        const res = await request(app).get('/api/alop?status=' + st).set('Cookie', cookie());
        expect(res.status).toBe(200);
        expect(res.body.alop.length).toBeGreaterThan(0);
        for (const row of res.body.alop) expect(row.badge_status).toBe(st);
      }
    });

    it('8. fără ?status — toate cinci, fiecare cu badge_status derivat corect', async () => {
      const res = await request(app).get('/api/alop').set('Cookie', cookie());
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(5);
      const byId = Object.fromEntries(res.body.alop.map(a => [a.id, a.badge_status]));
      expect(byId[A]).toBe('angajare');
      expect(byId[B]).toBe('angajare_flux');
      expect(byId[C]).toBe('revizie_flux');
      expect(byId[D]).toBe('lichidare');
      expect(byId[E]).toBe('angajare');
    });

    it('9. GET /api/alop/:id expune ACELAȘI badge_status ca lista', async () => {
      for (const [id, expected] of [[A, 'angajare'], [B, 'angajare_flux'], [C, 'revizie_flux'], [D, 'lichidare'], [E, 'angajare']]) {
        const res = await request(app).get('/api/alop/' + id).set('Cookie', cookie());
        expect(res.status).toBe(200);
        expect(res.body.alop.badge_status).toBe(expected);
      }
    });
  });
});
