import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedOrd, seedAlop, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('GET /api/formulare/list?type=ord — ord_valoare / plata_suma (#130)', () => {
  let app, orgId, userId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    ({ orgId, userId } = await seedOrgUser({ role: 'org_admin' }));
    app = buildApp();
  });
  afterAll(() => pool.end());

  const cookie = () => makeAuthCookie({ userId: 1, role: 'org_admin', orgId: 1 });

  it('ORD cu rânduri pe două blocuri de furnizor → ord_valoare = suma tuturor rândurilor', async () => {
    await seedOrd({
      orgId, createdBy: userId, status: 'draft',
      rows: [
        { bloc_idx: 0, suma_ordonantata_plata: '100.50' },
        { bloc_idx: 1, suma_ordonantata_plata: '250.25' },
      ],
    });
    const res = await request(app).get('/api/formulare/list?type=ord').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(Number(res.body.rows[0].ord_valoare)).toBeCloseTo(350.75, 2);
  });

  it('ORD fără rows / rows gol → ord_valoare = 0 (nu NULL, nu eroare)', async () => {
    await seedOrd({ orgId, createdBy: userId, status: 'draft', rows: [] });
    const res = await request(app).get('/api/formulare/list?type=ord').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(Number(res.body.rows[0].ord_valoare)).toBe(0);
  });

  it('ORD legat de ciclul CURENT (alop_instances.ord_id) cu plată confirmată → plata_suma din alop_instances', async () => {
    const ordId = await seedOrd({ orgId, createdBy: userId, status: 'draft', rows: [{ suma_ordonantata_plata: '500' }] });
    await seedAlop({ orgId, createdBy: userId, status: 'ordonantare', ordId, plataSumaEfectiva: 500 });
    const res = await request(app).get('/api/formulare/list?type=ord').set('Cookie', cookie());
    expect(Number(res.body.rows[0].plata_suma)).toBeCloseTo(500, 2);
  });

  it('ORD arhivat într-un ciclu închis (alop_ord_cicluri.ord_id) → plata_suma vine din rândul de ciclu', async () => {
    const ordId = await seedOrd({ orgId, createdBy: userId, status: 'completed', rows: [{ suma_ordonantata_plata: '800' }] });
    const alopId = await seedAlop({ orgId, createdBy: userId, status: 'lichidare' });
    await pool.query(
      `INSERT INTO alop_ord_cicluri (alop_id, org_id, ciclu_nr, ord_id, plata_suma_efectiva)
       VALUES ($1,$2,1,$3,$4)`,
      [alopId, orgId, ordId, 777.77]
    );
    const res = await request(app).get('/api/formulare/list?type=ord').set('Cookie', cookie());
    expect(Number(res.body.rows[0].plata_suma)).toBeCloseTo(777.77, 2);
  });

  it('ORD fără nicio legătură ALOP → plata_suma este NULL', async () => {
    await seedOrd({ orgId, createdBy: userId, status: 'draft', rows: [{ suma_ordonantata_plata: '100' }] });
    const res = await request(app).get('/api/formulare/list?type=ord').set('Cookie', cookie());
    expect(res.body.rows[0].plata_suma).toBeNull();
  });

  it('ALOP anulat (cancelled_at setat) nu contribuie la plata_suma', async () => {
    const ordId = await seedOrd({ orgId, createdBy: userId, status: 'draft', rows: [{ suma_ordonantata_plata: '100' }] });
    await seedAlop({ orgId, createdBy: userId, status: 'cancelled', ordId, plataSumaEfectiva: 999, cancelledAt: new Date() });
    const res = await request(app).get('/api/formulare/list?type=ord').set('Cookie', cookie());
    expect(res.body.rows[0].plata_suma).toBeNull();
  });

  it('Non-regresie: răspunsul ramurii DF nu conține ord_valoare sau plata_suma', async () => {
    const { seedDf } = await import('../helpers/db-real.mjs');
    await seedDf({ orgId, createdBy: userId, status: 'draft' });
    const res = await request(app).get('/api/formulare/list?type=df').set('Cookie', cookie());
    expect(res.body.rows[0]).not.toHaveProperty('ord_valoare');
    expect(res.body.rows[0]).not.toHaveProperty('plata_suma');
  });
});
