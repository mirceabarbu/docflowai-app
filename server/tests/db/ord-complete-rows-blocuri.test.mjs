/**
 * #128l — `/complete` NU mai pierde tăcut rândurile blocurilor 2+.
 *
 * `completeFormular` scrie `data.rows` din corpul cererii, ÎNLOCUIND întregul array. Un client
 * vechi (sau o cale nemigrată) care trimite doar rândurile blocului 0 ștergea definitiv
 * rândurile furnizorilor 2+ — beneficiarul lor supraviețuia în coloana `blocuri`, deci
 * simptomul era „bloc completat, tabel gol", iar ALOP-ul arăta o sumă prea mică.
 *
 * Garda e FAIL-CLOSED (409 `rows_bloc_lipsa`), nu merge automat: un merge ar învia rânduri
 * șterse intenționat de utilizator. Aici se verifică și că refuzul se produce ÎNAINTE de orice
 * scriere (lecția #123: „a refuzat" vs „a refuzat DUPĂ ce a scris").
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, seedOrd, getOrd, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('POST /api/formulare-ord/:id/complete — rândurile TUTUROR blocurilor (#128l)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' });   // id 1, org 1 — creator (P1)
    await seedUser({ orgId: 1, email: 'p2@x.ro' });          // id 2, org 1 — assigned (P2)
    app = buildApp();
  });
  afterAll(() => pool.end());
  const p2 = () => makeAuthCookie({ userId: 2, role: 'user', orgId: 1 });

  // DF cu credite bugetare col.10 generoase — plafonul de buget NU e obiectul acestui test.
  const seedDfLarg = () => seedDf({
    orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-128L',
    rowsVal: [{ valt_actualiz: '1000000' }],
    rowsPlati: [{ plati_estim_ancrt: '1000000' }],
    rowsCtrl: [{ sum_rezv_crdt_bug_act: '1000000' }],
  });

  async function seedOrdCuBlocuri(blocuri, rows) {
    const dfId = await seedDfLarg();
    const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2, dfId, rows });
    if (blocuri) {
      await pool.query('UPDATE formulare_ord SET blocuri=$2::jsonb WHERE id=$1', [ordId, JSON.stringify(blocuri)]);
    }
    return ordId;
  }
  const DOUA_BLOCURI = [
    { bloc_idx: 0, beneficiar: 'SC Unu SRL', cif_beneficiar: '19' },
    { bloc_idx: 1, beneficiar: 'SC Doi SRL', cif_beneficiar: '29' },
  ];
  const R0 = { bloc_idx: 0, cod_angajament: 'A-01', receptii: '5000', plati_anterioare: '0', suma_ordonantata_plata: '3000' };
  const R1 = { bloc_idx: 1, cod_angajament: 'B-02', receptii: '1000', plati_anterioare: '0', suma_ordonantata_plata: '435' };

  it('⭐ 2 blocuri, payload doar cu bloc_idx 0 → 409 rows_bloc_lipsa, `rows` NESCHIMBAT în DB', async () => {
    const ordId = await seedOrdCuBlocuri(DOUA_BLOCURI, [R0, R1]);

    const res = await request(app).post(`/api/formulare-ord/${ordId}/complete`)
      .set('Cookie', p2()).send({ rows: [R0] });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('rows_bloc_lipsa');
    expect(res.body.blocuri_lipsa).toEqual([1]);
    expect(res.body.message).toContain('Furnizor 2');

    // Refuzul e ÎNAINTE de scriere: nici rândurile, nici statusul nu s-au atins.
    const doc = await getOrd(ordId);
    expect(doc.status).toBe('pending_p2');
    expect(doc.completed_at).toBeNull();
    expect(doc.rows).toHaveLength(2);
    expect(doc.rows.map((r) => r.bloc_idx)).toEqual([0, 1]);
    expect(String(doc.rows[1].suma_ordonantata_plata)).toBe('435');
  });

  it('⭐ 2 blocuri, payload cu ambele → 200, ambele rânduri salvate', async () => {
    const ordId = await seedOrdCuBlocuri(DOUA_BLOCURI, [R0]);

    const res = await request(app).post(`/api/formulare-ord/${ordId}/complete`)
      .set('Cookie', p2()).send({ rows: [R0, R1] });

    expect(res.status).toBe(200);
    const doc = await getOrd(ordId);
    expect(doc.status).toBe('completed');
    expect(doc.rows).toHaveLength(2);
    expect(doc.rows.map((r) => r.bloc_idx)).toEqual([0, 1]);
    expect(doc.rows.map((r) => r.cod_angajament)).toEqual(['A-01', 'B-02']);
  });

  it('⭐ NON-REGRESIE: `blocuri` NULL (ORD legacy) → /complete se comportă exact ca înainte', async () => {
    const ordId = await seedOrdCuBlocuri(null, []);
    const res = await request(app).post(`/api/formulare-ord/${ordId}/complete`)
      .set('Cookie', p2()).send({ rows: [{ cod_angajament: 'A-01', receptii: '5000', suma_ordonantata_plata: '3000' }] });

    expect(res.status).toBe(200);
    const doc = await getOrd(ordId);
    expect(doc.status).toBe('completed');
    expect(doc.rows).toHaveLength(1);
    expect(doc.rows[0].bloc_idx).toBe(0);   // normalizat, ca la PUT
  });

  it('NON-REGRESIE: `blocuri` cu UN singur element → nicio gardă, 200', async () => {
    const ordId = await seedOrdCuBlocuri([{ bloc_idx: 0, beneficiar: 'SC Unu SRL' }], []);
    const res = await request(app).post(`/api/formulare-ord/${ordId}/complete`)
      .set('Cookie', p2()).send({ rows: [R0] });
    expect(res.status).toBe(200);
    expect((await getOrd(ordId)).rows).toHaveLength(1);
  });

  it('bloc_idx lipsă / string numeric → normalizat la numeric (bloc 0 / bloc 1)', async () => {
    const ordId = await seedOrdCuBlocuri(DOUA_BLOCURI, []);
    const res = await request(app).post(`/api/formulare-ord/${ordId}/complete`).set('Cookie', p2()).send({
      rows: [
        { cod_angajament: 'A-01', receptii: '5000', suma_ordonantata_plata: '3000' },          // fără bloc_idx
        { bloc_idx: '1', cod_angajament: 'B-02', receptii: '1000', suma_ordonantata_plata: '435' }, // string
      ],
    });

    expect(res.status).toBe(200);
    const doc = await getOrd(ordId);
    expect(doc.rows.map((r) => r.bloc_idx)).toEqual([0, 1]);
    expect(doc.rows.every((r) => typeof r.bloc_idx === 'number')).toBe(true);
  });

  it('DF (notafd) nu e atins de gardă — `/complete` fără `rows` merge ca înainte', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2, nrUnic: 'DF-128L-2' });
    const res = await request(app).post(`/api/formulare-df/${dfId}/complete`)
      .set('Cookie', p2()).send({ rows_ctrl: [{ cod_angajament: 'A-01' }] });
    expect(res.status).toBe(200);
  });
});
