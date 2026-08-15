/**
 * test:db — #128c: backendul SCRIE și CITEȘTE `formulare_ord.blocuri`; cele 8 coloane plate
 * devin OGLINDA blocului 1 (un singur loc de scriere: `oglindaBloc1`).
 *
 * ⭐ Criteriul de acceptanță al lotului: pentru un payload FĂRĂ `blocuri` (adică tot ce trimite
 * clientul azi), coloanele plate scrise în DB sunt IDENTICE cu cele de dinainte de patch.
 *
 * ⛔ Rutele REALE (ord.mjs) peste Postgres real — nu se redeclară aici logica de scriere.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedAlop, getOrd, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

// Payload-ul „de azi": cele 6 câmpuri de bloc pe care le trimite efectiv frontendul.
const PAYLOAD_AZI = {
  beneficiar: 'Furnizor SRL',
  cif_beneficiar: 'RO12345678',
  iban_beneficiar: 'RO49AAAA1B31007593840000',
  banca_beneficiar: 'Trezoreria Cluj',
  documente_justificative: 'Factura 100/2026',
  inf_pv_plata: 'PV receptie 12',
};

d('#128c — scriere/citire blocuri ORD (coloanele plate = oglinda blocului 1)', () => {
  let app, orgId, userId, cookie;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    ({ orgId, userId } = await seedOrgUser({ role: 'user', email: 'p1@x.ro' }));
    cookie = makeAuthCookie({ userId, role: 'user', orgId });
    app = buildApp();
  });
  afterAll(() => pool.end());

  // ⭐ #1 NON-REGRESIE — cazul care contează cel mai mult.
  it('#1 ⭐ POST cu payload-ul de azi (fără blocuri) ⇒ coloane plate NESCHIMBATE + un bloc', async () => {
    const cr = await request(app).post('/api/formulare-ord').set('Cookie', cookie)
      .send({ nr_ordonant_pl: 'ORD-BLOC-1', ...PAYLOAD_AZI });
    expect(cr.status).toBe(200);

    const ord = await getOrd(cr.body.document.id);
    // coloanele plate — exact ce a trimis clientul
    for (const [k, v] of Object.entries(PAYLOAD_AZI)) expect(ord[k]).toBe(v);
    // câmpurile de bloc NEtrimise rămân NULL (nu '' — oglinda nu scrie peste ce nu cunoaște)
    expect(ord.nr_unic_inreg).toBeNull();
    expect(ord.inf_pv_plata1).toBeNull();

    // blocuri: exact UN bloc, cu aceleași valori, bloc_idx 0
    expect(Array.isArray(ord.blocuri)).toBe(true);
    expect(ord.blocuri).toHaveLength(1);
    expect(ord.blocuri[0].bloc_idx).toBe(0);
    for (const [k, v] of Object.entries(PAYLOAD_AZI)) expect(ord.blocuri[0][k]).toBe(v);
  });

  // ⭐ #2 PUT PARȚIAL — dovada că fuziunea peste docExistent funcționează.
  it('#2 ⭐ PUT doar cu {beneficiar} ⇒ cif/iban/banca NESCHIMBATE, blocuri[0].beneficiar nou', async () => {
    const cr = await request(app).post('/api/formulare-ord').set('Cookie', cookie)
      .send({ nr_ordonant_pl: 'ORD-BLOC-2', ...PAYLOAD_AZI });
    expect(cr.status).toBe(200);
    const id = cr.body.document.id;

    const pu = await request(app).put(`/api/formulare-ord/${id}`).set('Cookie', cookie)
      .send({ beneficiar: 'Alt Furnizor SA' });
    expect(pu.status).toBe(200);

    const ord = await getOrd(id);
    expect(ord.beneficiar).toBe('Alt Furnizor SA');
    // ⭐ câmpurile neatinse de payload NU au fost șterse
    expect(ord.cif_beneficiar).toBe(PAYLOAD_AZI.cif_beneficiar);
    expect(ord.iban_beneficiar).toBe(PAYLOAD_AZI.iban_beneficiar);
    expect(ord.banca_beneficiar).toBe(PAYLOAD_AZI.banca_beneficiar);
    expect(ord.documente_justificative).toBe(PAYLOAD_AZI.documente_justificative);

    expect(ord.blocuri).toHaveLength(1);
    expect(ord.blocuri[0].beneficiar).toBe('Alt Furnizor SA');
    expect(ord.blocuri[0].cif_beneficiar).toBe(PAYLOAD_AZI.cif_beneficiar);
  });

  // #3 bloc_idx pe rânduri — ORDONAREA față de deriveOrdIdentityCols (§3.3).
  it('#3 POST cu rows fără bloc_idx ⇒ toate rândurile bloc_idx 0, identitatea DF neschimbată', async () => {
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'aprobat', nrUnic: 'DF-BLOC-3',
      rowsCtrl: [
        { cod_angajament: 'A100', indicator_angajament: 'IND1', program: 'PROG1', cod_SSI: '20.01.30' },
        { cod_angajament: 'A200', indicator_angajament: 'IND2', program: 'PROG2', cod_SSI: '20.02.01' },
      ] });

    const cr = await request(app).post('/api/formulare-ord').set('Cookie', cookie).send({
      df_id: dfId, nr_ordonant_pl: 'ORD-BLOC-3', ...PAYLOAD_AZI,
      rows: [
        { cod_angajament: 'fabricat', indicator_angajament: 'fake', program: 'H', cod_SSI: '00.00.00', suma_ordonantata_plata: '100' },
        { cod_angajament: 'fabricat2', indicator_angajament: 'fake2', program: 'H2', cod_SSI: '11.11.11', suma_ordonantata_plata: '200' },
      ],
    });
    expect(cr.status).toBe(200);

    const ord = await getOrd(cr.body.document.id);
    expect(ord.rows.map((r) => r.bloc_idx)).toEqual([0, 0]);
    // identitatea derivată din DF a SUPRAVIEȚUIT aplicării bloc_idx (ordonare corectă)
    expect(ord.rows[0].cod_angajament).toBe('A100');
    expect(ord.rows[0].indicator_angajament).toBe('IND1');
    expect(ord.rows[0].program).toBe('PROG1');
    expect(ord.rows[0].cod_SSI).toBe('20.01.30');
    expect(ord.rows[1].cod_angajament).toBe('A200');
    expect(ord.rows[1].cod_SSI).toBe('20.02.01');
    // sumele clientului rămân
    expect(ord.rows[0].suma_ordonantata_plata).toBe('100');
    expect(ord.rows[1].suma_ordonantata_plata).toBe('200');
  });

  // #4 payload CU blocuri (niciun client nu-l trimite încă) — coloanele plate = blocul 1.
  it('#4 POST cu 2 blocuri ⇒ ambele salvate (bloc_idx 0,1), coloanele plate reflectă blocul 1', async () => {
    const cr = await request(app).post('/api/formulare-ord').set('Cookie', cookie).send({
      nr_ordonant_pl: 'ORD-BLOC-4',
      blocuri: [
        { beneficiar: 'Furnizor A', cif_beneficiar: 'RO111', iban_beneficiar: 'RO49AAAA0000000000000001',
          banca_beneficiar: 'Trez A', documente_justificative: 'F1', inf_pv_plata: 'PV1' },
        { beneficiar: 'Furnizor B', cif_beneficiar: 'RO222', iban_beneficiar: 'RO49BBBB0000000000000002',
          banca_beneficiar: 'Trez B', documente_justificative: 'F2', inf_pv_plata: 'PV2' },
      ],
    });
    expect(cr.status).toBe(200);

    const ord = await getOrd(cr.body.document.id);
    expect(ord.blocuri).toHaveLength(2);
    expect(ord.blocuri.map((b) => b.bloc_idx)).toEqual([0, 1]);
    expect(ord.blocuri[1].beneficiar).toBe('Furnizor B');
    // oglinda = blocul 1
    expect(ord.beneficiar).toBe('Furnizor A');
    expect(ord.cif_beneficiar).toBe('RO111');
    expect(ord.iban_beneficiar).toBe('RO49AAAA0000000000000001');
    expect(ord.banca_beneficiar).toBe('Trez A');
    // NIMIC din blocul 2 nu se scurge în coloanele plate
    expect(JSON.stringify([ord.beneficiar, ord.cif_beneficiar, ord.iban_beneficiar])).not.toContain('222');
  });

  // #5 document legacy (blocuri NULL) ⇒ GET detaliu întoarce blocul derivat.
  it('#5 GET detaliu pe document legacy (blocuri NULL) ⇒ un bloc derivat din coloanele plate', async () => {
    const id = await seedOrd({ orgId, createdBy: userId, nrOrd: 'ORD-BLOC-5' });
    await pool.query(
      `UPDATE formulare_ord SET beneficiar=$2, cif_beneficiar=$3, iban_beneficiar=$4, blocuri=NULL WHERE id=$1`,
      [id, 'Legacy SRL', 'RO999', 'RO49LLLL0000000000000009']
    );

    const g = await request(app).get(`/api/formulare-ord/${id}`).set('Cookie', cookie);
    expect(g.status).toBe(200);
    expect(g.body.document.blocuri).toHaveLength(1);
    expect(g.body.document.blocuri[0].bloc_idx).toBe(0);
    expect(g.body.document.blocuri[0].beneficiar).toBe('Legacy SRL');
    expect(g.body.document.blocuri[0].cif_beneficiar).toBe('RO999');
    expect(g.body.document.blocuri[0].iban_beneficiar).toBe('RO49LLLL0000000000000009');
    // în DB coloana rămâne NULL — GET derivă, nu face backfill tăcut
    const ord = await getOrd(id);
    expect(ord.blocuri).toBeNull();
  });

  // #6 PUT pe document legacy fără câmpuri de beneficiar ⇒ blocuri populat, coloane identice.
  it('#6 PUT pe legacy (doar rows) ⇒ blocuri se populează, coloanele plate rămân identice', async () => {
    const id = await seedOrd({ orgId, createdBy: userId, nrOrd: 'ORD-BLOC-6' });
    await pool.query(
      `UPDATE formulare_ord SET beneficiar=$2, cif_beneficiar=$3, blocuri=NULL WHERE id=$1`,
      [id, 'Legacy SRL', 'RO999']
    );

    const pu = await request(app).put(`/api/formulare-ord/${id}`).set('Cookie', cookie)
      .send({ rows: [{ cod_angajament: 'liber', suma_ordonantata_plata: '50' }] });
    expect(pu.status).toBe(200);

    const ord = await getOrd(id);
    expect(ord.beneficiar).toBe('Legacy SRL');
    expect(ord.cif_beneficiar).toBe('RO999');
    expect(ord.iban_beneficiar).toBeNull();          // NU s-a scris '' peste NULL
    expect(ord.banca_beneficiar).toBeNull();
    expect(ord.blocuri).toHaveLength(1);
    expect(ord.blocuri[0].bloc_idx).toBe(0);
    expect(ord.blocuri[0].beneficiar).toBe('Legacy SRL');
    expect(ord.blocuri[0].cif_beneficiar).toBe('RO999');
    expect(ord.rows[0].bloc_idx).toBe(0);
    expect(ord.rows[0].cod_angajament).toBe('LIBER');   // normalizarea existentă neatinsă
  });

  // #7 non-regresie pe garda de dedup #124e′ (blocurile nu se pregătesc înaintea ei).
  it('#7 două POST-uri pe același source_alop_id ⇒ al doilea întoarce documentul existent', async () => {
    const alopId = await seedAlop({ orgId, createdBy: userId });
    const p1 = await request(app).post('/api/formulare-ord').set('Cookie', cookie)
      .send({ source_alop_id: alopId, nr_ordonant_pl: 'ORD-BLOC-7A', ...PAYLOAD_AZI });
    expect(p1.status).toBe(200);
    const p2 = await request(app).post('/api/formulare-ord').set('Cookie', cookie)
      .send({ source_alop_id: alopId, nr_ordonant_pl: 'ORD-BLOC-7B', ...PAYLOAD_AZI });
    expect(p2.status).toBe(200);
    expect(p2.body.deduplicated).toBe(true);
    expect(p2.body.document.id).toBe(p1.body.document.id);

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM formulare_ord WHERE source_alop_id=$1`, [alopId]
    );
    expect(rows[0].n).toBe(1);
  });
});
