/**
 * test:db — SEC-100.2: coloanele de identitate ale ORD-ului (cod_angajament,
 * indicator_angajament, program, cod_SSI) se DERIVĂ server-side din rows_ctrl-ul DF-ului
 * legat. Un PUT/POST construit de mână NU mai poate fabrica aceste coduri pe un ORD legat.
 *
 * ⛔ Rutele REALE (ord.mjs) peste Postgres real. Derivare, NU validare — nicio rută nu întoarce
 *    400/422 pentru asta; codurile clientului sunt suprascrise tăcut.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, seedOrd, getOrd, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('SEC-100.2 — ORD identity cols derivate din DF', () => {
  let app, orgId, userId, cookie;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    ({ orgId, userId } = await seedOrgUser({ role: 'user', email: 'p1@x.ro' }));
    cookie = makeAuthCookie({ userId, role: 'user', orgId });
    app = buildApp();
  });
  afterAll(() => pool.end());

  // #8 — dovada end-to-end: PUT cu coduri fabricate ⇒ persistă codurile DF-ului.
  it('#8 PUT cu coduri fabricate pe un ORD legat ⇒ în bază sunt codurile DF-ului', async () => {
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'aprobat', nrUnic: 'DF-DER-1',
      rowsCtrl: [{ cod_angajament: 'A100', indicator_angajament: 'IND1', program: 'PROG1', cod_SSI: '20.01.30' }] });
    const ordId = await seedOrd({ orgId, createdBy: userId, dfId, status: 'draft' });

    const pu = await request(app).put(`/api/formulare-ord/${ordId}`).set('Cookie', cookie).send({
      rows: [{ cod_angajament: 'FABRICAT', indicator_angajament: 'FAKE', program: 'HACK',
               cod_SSI: '99.99.99', suma_ordonantata_plata: '500' }],
    });
    expect(pu.status).toBe(200);   // derivare, nu refuz

    const ord = await getOrd(ordId);
    expect(ord.rows[0].cod_angajament).toBe('A100');
    expect(ord.rows[0].indicator_angajament).toBe('IND1');
    expect(ord.rows[0].program).toBe('PROG1');
    expect(ord.rows[0].cod_SSI).toBe('20.01.30');
    expect(ord.rows[0].suma_ordonantata_plata).toBe('500');   // suma clientului rămâne
  });

  // POST create legat direct de DF ⇒ aceeași derivare (a doua cale de scriere).
  it('POST create cu df_id ⇒ codurile fabricate se înlocuiesc cu cele din DF', async () => {
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'aprobat', nrUnic: 'DF-DER-POST',
      rowsCtrl: [{ cod_angajament: 'B200', indicator_angajament: 'IND2', program: 'PROG2', cod_SSI: '20.02.01' }] });

    const cr = await request(app).post('/api/formulare-ord').set('Cookie', cookie).send({
      df_id: dfId, nr_ordonant_pl: 'ORD-DER-POST',
      rows: [{ cod_angajament: 'xhack', indicator_angajament: 'zhack', program: 'H', cod_SSI: '00.00.00',
               suma_ordonantata_plata: '10' }],
    });
    expect(cr.status).toBe(200);
    const ord = await getOrd(cr.body.document.id);
    expect(ord.rows[0].cod_angajament).toBe('B200');
    expect(ord.rows[0].program).toBe('PROG2');
    expect(ord.rows[0].cod_SSI).toBe('20.02.01');
    expect(ord.rows[0].suma_ordonantata_plata).toBe('10');
  });

  // #9 — ORD fără df_id: nu blocăm ORD-uri libere; codurile clientului rămân.
  it('#9 PUT pe ORD fără df_id ⇒ codurile clientului se salvează ca atare', async () => {
    const ordId = await seedOrd({ orgId, createdBy: userId, status: 'draft' });   // df_id null
    const pu = await request(app).put(`/api/formulare-ord/${ordId}`).set('Cookie', cookie).send({
      rows: [{ cod_angajament: 'liber', indicator_angajament: 'i', program: 'p', cod_SSI: '11.11.11' }],
    });
    expect(pu.status).toBe(200);
    const ord = await getOrd(ordId);
    expect(ord.rows[0].cod_angajament).toBe('LIBER');   // normalizat (majuscule), nu derivat
    expect(ord.rows[0].program).toBe('p');
    expect(ord.rows[0].cod_SSI).toBe('11.11.11');
  });

  // #10 — df_id spre alt org: nu se derivă, nu se scurge nimic din DF-ul străin (org_id=$2).
  it('#10 PUT cu df_id din alt org ⇒ nu se derivă, DF-ul străin nu se scurge', async () => {
    // al doilea org + DF cu coduri „secrete".
    const { orgId: org2, userId: user2 } = await seedOrgUser({ orgName: 'Org 2', role: 'user', email: 'other@y.ro' });
    const foreignDf = await seedDf({ orgId: org2, createdBy: user2, status: 'aprobat', nrUnic: 'DF-FOREIGN',
      rowsCtrl: [{ cod_angajament: 'SECRET', indicator_angajament: 'SECRET', program: 'SECRET', cod_SSI: '77.77.77' }] });

    const ordId = await seedOrd({ orgId, createdBy: userId, status: 'draft' });   // ORD-ul org-ului nostru
    const pu = await request(app).put(`/api/formulare-ord/${ordId}`).set('Cookie', cookie).send({
      df_id: foreignDf,   // încearcă să lege de DF-ul altui org
      rows: [{ cod_angajament: 'mine', indicator_angajament: 'i', program: 'p', cod_SSI: '11.11.11' }],
    });
    expect(pu.status).toBe(200);
    const ord = await getOrd(ordId);
    // codurile clientului rămân — NIMIC din DF-ul străin nu s-a scurs.
    expect(ord.rows[0].cod_angajament).toBe('MINE');
    expect(ord.rows[0].cod_SSI).toBe('11.11.11');
    expect(JSON.stringify(ord.rows)).not.toContain('SECRET');
    expect(JSON.stringify(ord.rows)).not.toContain('77.77.77');
  });
});
