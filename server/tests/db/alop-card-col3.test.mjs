/**
 * #188 — cardul ALOP („Total plăți") citea `ord_col3` dintr-un SUM SQL peste toate
 * rândurile ORD-ului curent. Col.3 e o proprietate a ANGAJAMENTULUI (cod_angajament /
 * indicator_angajament / program / cod_SSI), repetată identic pe fiecare bloc (#128k) —
 * exact greșeala pe care #187 a reparat-o în derivare (`agregaCheiCol3`), rămasă pe
 * calea de afișare. Acum se agregă PER CHEIE (`sumaCol3PerCheie`, services/ord-lant.mjs):
 * cheia se ia o singură dată, chei diferite se adună.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedAlop, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('Card ALOP — ord_col3 agregat PER CHEIE (#188)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' }); // id 1
    app = buildApp();
  });
  afterAll(() => pool.end());
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  async function cardCol3(alopId) {
    const res = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    return parseFloat(res.body.alop.ord_col3);
  }

  it('⭐ 2 blocuri, aceeași cheie, col.3 repetată identic ⇒ luată o singură dată', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1 });
    const ordId = await seedOrd({
      orgId: 1, createdBy: 1, dfId, status: 'draft',
      rows: [
        { cod_angajament: 'A1', indicator_angajament: 'I1', plati_anterioare: '300424.95', suma_ordonantata_plata: '1000' },
        { cod_angajament: 'A1', indicator_angajament: 'I1', plati_anterioare: '300424.95', suma_ordonantata_plata: '2000' },
      ],
    });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', dfId, ordId });

    expect(await cardCol3(alopId)).toBeCloseTo(300424.95, 2);
  });

  it('chei diferite ⇒ se adună (angajamente distincte)', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1 });
    const ordId = await seedOrd({
      orgId: 1, createdBy: 1, dfId, status: 'draft',
      rows: [
        { cod_angajament: 'A1', indicator_angajament: 'I1', plati_anterioare: '1000', suma_ordonantata_plata: '10' },
        { cod_angajament: 'A2', indicator_angajament: 'I2', plati_anterioare: '2500.50', suma_ordonantata_plata: '20' },
      ],
    });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', dfId, ordId });

    expect(await cardCol3(alopId)).toBeCloseTo(3500.5, 2);
  });

  it('nedeteriorare — un singur bloc ⇒ aceeași cifră ca azi', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1 });
    const ordId = await seedOrd({
      orgId: 1, createdBy: 1, dfId, status: 'draft',
      rows: [
        { cod_angajament: 'A1', indicator_angajament: 'I1', plati_anterioare: '46045.32', suma_ordonantata_plata: '500' },
      ],
    });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', dfId, ordId });

    expect(await cardCol3(alopId)).toBeCloseTo(46045.32, 2);
  });

  it('nedeteriorare — dosarul „Iluminat public" ciclul 2 (#186): cifra rămâne 300.424,95', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, nrUnic: 'DF-6744' });
    // Ciclul 2 al dosarului real: col.3 = 300.424,95 (col.3+col.4 al ciclului 1, plată confirmată).
    const ordId = await seedOrd({
      orgId: 1, createdBy: 1, dfId, status: 'draft', nrOrd: 'ORD-6744-C2',
      rows: [
        { cod_angajament: 'A1', indicator_angajament: 'I1', receptii: '353688.51', plati_anterioare: '300424.95', suma_ordonantata_plata: '53263.56' },
      ],
    });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', dfId, ordId });

    expect(await cardCol3(alopId)).toBeCloseTo(300424.95, 2);
  });

  it('fără ORD curent ⇒ 0 (COALESCE, ca azi)', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1 });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft', dfId });

    expect(await cardCol3(alopId)).toBe(0);
  });
});
