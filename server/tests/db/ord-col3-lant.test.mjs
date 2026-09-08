/**
 * #186 — col.3 derivată din LANȚUL de ordonanțări, disponibilul pe ORDONANȚAT, porțile
 * de la lichidare. Pe Postgres real, prin rutele REALE.
 *
 * Regulile de adevăr (OMF 1140/2025, decizie owner):
 *   col.2 Recepții  — dată EXTERNĂ din CAB, aplicația NU o derivă niciodată.
 *   col.3           — `col.3 + col.4` de pe ultima ORD APROBATĂ a dosarului, DAR col.4
 *                     intră numai dacă plata acelui ciclu e CONFIRMATĂ (ghid, Cap. II.1.2 pct.3).
 *   disponibil ord. — `df_valoare − Σ col.4` (ORDONANȚAT, nu plătit).
 *
 * Cifrele: dosarul real „Iluminat public", DF nr. 6744, valoare 360.424,95.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedAlop, seedFlowApproved, seedFlow,
         getAlop, getAlopCicluri, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

// Cifrele reale ale celor trei cicluri consecutive.
const C1 = { col2: '0',         col3: '254379.63', col4: '46045.32' };  // → col.3+col.4 = 300.424,95
const C2 = { col2: '353688.51', col3: '300424.95', col4: '53263.56' };  // → col.3+col.4 = 353.688,51
const C3 = { col2: '413096.30', col3: '353688.51', col4: '59407.79' };

const rowOf = (c) => ({
  cod_angajament: 'A1', indicator_angajament: 'I1',
  receptii: c.col2, plati_anterioare: c.col3, suma_ordonantata_plata: c.col4,
});

// Arhivează un ciclu (alop_ord_cicluri). `plataConfirmata` = ciclul apare ca DECONTAT.
async function arhiveazaCiclu({ alopId, orgId, cicluNr, ordId, plataConfirmata = true, plataSuma = null }) {
  const { rows } = await pool.query(
    `INSERT INTO alop_ord_cicluri
       (alop_id, org_id, ciclu_nr, ord_id, plata_confirmed_at, plata_suma_efectiva, status, an_exercitiu)
     VALUES ($1,$2,$3,$4,$5,$6,'completed',$7) RETURNING id`,
    [alopId, orgId, cicluNr, ordId, plataConfirmata ? new Date() : null,
     plataSuma, new Date().getFullYear()]
  );
  return rows[0].id;
}

d('#186 — col.3 din lanțul de ORD + disponibil pe ordonanțat + porți', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await seedOrgUser({ role: 'user' }); app = buildApp(); });
  afterAll(() => pool.end());

  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  // ORD aprobat = are un flux completed, viu (docAprobatSql).
  async function seedOrdAprobat({ dfId, nr, rows }) {
    const flowId = await seedFlowApproved(`f-${nr}-${Math.random().toString(36).slice(2, 8)}`);
    return seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId, dfId, nrOrd: nr, rows });
  }

  const getCol3 = (alopId, ordId) => request(app)
    .get(`/api/alop/${alopId}/ord-col3${ordId ? `?ord_id=${ordId}` : ''}`)
    .set('Cookie', cookie());

  // ── 1 ⭐ Lanțul de trei cicluri, cu cifrele exacte ────────────────────────
  it('1 ⭐ lanț de trei cicluri: col.3 a ciclului 2 = 300.424,95, a ciclului 3 = 353.688,51', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, nrUnic: '6744',
      rowsVal: [{ valt_actualiz: '360424.95' }], rowsCtrl: [{ sum_rezv_crdt_bug_act: '360424.95' }] });

    const ord1 = await seedOrdAprobat({ dfId, nr: '41011', rows: [rowOf(C1)] });
    const ord2 = await seedOrdAprobat({ dfId, nr: '43759', rows: [rowOf(C2)] });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare',
      dfId, ordId: ord2, cicluCurent: 2 });
    await arhiveazaCiclu({ alopId, orgId: 1, cicluNr: 1, ordId: ord1, plataSuma: C1.col4 });

    // Ciclul 2 derivă din ciclul 1: 254.379,63 + 46.045,32 = 300.424,95 (= col.3 REAL al ORD 43759)
    const r2 = await getCol3(alopId, ord2);
    expect(r2.status).toBe(200);
    expect(r2.body.sursa).toBe('lant');
    expect(r2.body.plata_predecesor_confirmata).toBe(true);
    expect(Number(r2.body.col3)).toBeCloseTo(300424.95, 2);
    expect(r2.body.predecesor.nr_ord).toBe('41011');

    // Ciclul 3: arhivăm ciclul 2 și punem ORD 47218 ca ORD curent.
    await arhiveazaCiclu({ alopId, orgId: 1, cicluNr: 2, ordId: ord2, plataSuma: C2.col4 });
    const ord3 = await seedOrdAprobat({ dfId, nr: '47218', rows: [rowOf(C3)] });
    await pool.query(`UPDATE alop_instances SET ord_id=$2, ciclu_curent=3 WHERE id=$1`, [alopId, ord3]);

    const r3 = await getCol3(alopId, ord3);
    expect(r3.status).toBe(200);
    expect(Number(r3.body.col3)).toBeCloseTo(353688.51, 2);   // = col.3 REAL al ORD 47218
    expect(r3.body.predecesor.nr_ord).toBe('43759');
  });

  // ── 2 ⭐ Nuanța din ghid: predecesor aprobat dar NEdecontat ────────────────
  it('2 ⭐ predecesor aprobat cu plata NECONFIRMATĂ ⇒ col.3 = col.3 al lui, FĂRĂ col.4', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, rowsVal: [{ valt_actualiz: '360424.95' }] });
    const ord1 = await seedOrdAprobat({ dfId, nr: '41011', rows: [rowOf(C1)] });
    const ord2 = await seedOrdAprobat({ dfId, nr: '43759', rows: [rowOf(C2)] });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare',
      dfId, ordId: ord2, cicluCurent: 2 });
    await arhiveazaCiclu({ alopId, orgId: 1, cicluNr: 1, ordId: ord1, plataConfirmata: false });

    const r = await getCol3(alopId, ord2);
    expect(r.status).toBe(200);
    expect(r.body.sursa).toBe('lant');
    expect(r.body.plata_predecesor_confirmata).toBe(false);
    expect(Number(r.body.col3)).toBeCloseTo(254379.63, 2);   // fără cei 46.045,32
  });

  // ── 3 Prima ORD a dosarului ───────────────────────────────────────────────
  it('3 prima ORD a dosarului ⇒ sursa=prima_ord, col3=null (NU 0)', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, rowsVal: [{ valt_actualiz: '360424.95' }] });
    const ord1 = await seedOrd({ orgId: 1, createdBy: 1, dfId, nrOrd: '41011', rows: [rowOf(C1)] });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', dfId, ordId: ord1 });

    const r = await getCol3(alopId, ord1);
    expect(r.status).toBe(200);
    expect(r.body.sursa).toBe('prima_ord');
    expect(r.body.col3).toBeNull();
    expect(r.body.predecesor).toBeNull();
  });

  // ── 4 ORD multi-bloc ──────────────────────────────────────────────────────
  it('4 ORD multi-bloc: însumarea acoperă TOATE rândurile', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, rowsVal: [{ valt_actualiz: '999999' }] });
    const ordMulti = await seedOrdAprobat({ dfId, nr: 'MB-1', rows: [
      { bloc_idx: 0, receptii: '100000', plati_anterioare: '30000.50', suma_ordonantata_plata: '10000' },
      { bloc_idx: 0, receptii: '20000',  plati_anterioare: '13263.06', suma_ordonantata_plata: '5000' },
      { bloc_idx: 1, receptii: '15000',  plati_anterioare: '10000',    suma_ordonantata_plata: '2500' },
    ] });
    const ordNou = await seedOrd({ orgId: 1, createdBy: 1, dfId, nrOrd: 'MB-2', rows: [] });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare',
      dfId, ordId: ordNou, cicluCurent: 2 });
    await arhiveazaCiclu({ alopId, orgId: 1, cicluNr: 1, ordId: ordMulti });

    const r = await getCol3(alopId, ordNou);
    expect(r.status).toBe(200);
    // col.3 = 30000.50 + 13263.06 + 10000 = 53263.56 ; col.4 = 10000 + 5000 + 2500 = 17500
    expect(Number(r.body.col3)).toBeCloseTo(70763.56, 2);
    expect(Number(r.body.predecesor.col3)).toBeCloseTo(53263.56, 2);
    expect(Number(r.body.predecesor.col4)).toBeCloseTo(17500, 2);
  });

  // ── 5 Predecesor NEaprobat ────────────────────────────────────────────────
  it('5 predecesor NEaprobat (fără flux finalizat) NU e considerat predecesor', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, rowsVal: [{ valt_actualiz: '360424.95' }] });
    // ORD 1 are flux, dar NEfinalizat ⇒ nu e aprobat
    const flowViu = await seedFlow({ completed: false });
    const ord1 = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId: flowViu,
      dfId, nrOrd: '41011', rows: [rowOf(C1)] });
    const ord2 = await seedOrd({ orgId: 1, createdBy: 1, dfId, nrOrd: '43759', rows: [] });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare',
      dfId, ordId: ord2, cicluCurent: 2 });
    await arhiveazaCiclu({ alopId, orgId: 1, cicluNr: 1, ordId: ord1 });

    const r = await getCol3(alopId, ord2);
    expect(r.status).toBe(200);
    expect(r.body.sursa).toBe('prima_ord');
    expect(r.body.col3).toBeNull();
  });

  // ── 6 ⭐ Disponibilul se raportează la ORDONANȚAT, nu la PLĂTIT ────────────
  it('6 ⭐ un ORD emis și NEPLĂTIT scade `ramas` cu suma ordonanțată', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1,
      rowsVal: [{ valt_actualiz: '100000' }], rowsCtrl: [{ sum_rezv_crdt_bug_act: '100000' }] });
    const ordId = await seedOrdAprobat({ dfId, nr: 'ORD-NEPLATIT',
      rows: [{ suma_ordonantata_plata: '40000' }] });
    // ⚠️ NICIO plată confirmată: plata_suma_efectiva NULL, suma_totala_platita 0.
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare',
      dfId, ordId, cicluCurent: 1, sumaTotalaPlatita: 0 });

    const r = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie());
    expect(r.status).toBe(200);
    expect(Number(r.body.alop.suma_platita_total)).toBe(0);      // nimic plătit
    expect(Number(r.body.alop.suma_ordonantata_total)).toBe(40000);
    // Forma VECHE ar fi dat 100000 (df_valoare − plătit). Forma #186: 100000 − 40000.
    expect(Number(r.body.alop.ramas)).toBe(60000);
  });

  // ── 7 ⭐ Porțile de la confirma-lichidare ─────────────────────────────────
  it('7 ⭐ BLOCARE 400 peste valoarea DF; AVERTISMENT 200 sub DF dar peste recepții', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1,
      rowsVal: [{ valt_actualiz: '100000' }], rowsCtrl: [{ sum_rezv_crdt_bug_act: '100000' }] });
    // Ciclu anterior aprobat + decontat: col.2 = 60.000, col.3 = 0, col.4 = 50.000
    //   ⇒ ordonanțat = 50.000 ⇒ disponibil DF = 50.000
    //   ⇒ disponibil din RECEPȚII = 60.000 − 50.000 = 10.000
    const ordVechi = await seedOrdAprobat({ dfId, nr: 'ORD-V', rows: [
      { receptii: '60000', plati_anterioare: '0', suma_ordonantata_plata: '50000' },
    ] });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare',
      dfId, cicluCurent: 2 });
    await arhiveazaCiclu({ alopId, orgId: 1, cicluNr: 1, ordId: ordVechi, plataSuma: '50000' });

    // (a) BLOCARE — 60.000 > disponibil DF (50.000)
    const blocat = await request(app).post(`/api/alop/${alopId}/confirma-lichidare`)
      .set('Cookie', cookie()).send({ nr_factura: 'F-1', valoare_factura: 60000 });
    expect(blocat.status).toBe(400);
    expect(blocat.body.error).toBe('peste_valoare_df');
    expect(Number(blocat.body.disponibil_df)).toBe(50000);
    expect(Number(blocat.body.ordonantat)).toBe(50000);
    // operația NU s-a executat
    expect((await getAlop(alopId)).status).toBe('lichidare');

    // (b) AVERTISMENT — 30.000 ≤ 50.000 (DF) dar > 10.000 (recepții). Se EXECUTĂ.
    const avert = await request(app).post(`/api/alop/${alopId}/confirma-lichidare`)
      .set('Cookie', cookie()).send({ nr_factura: 'F-2', valoare_factura: 30000 });
    expect(avert.status).toBe(200);
    expect(avert.body.avertisment_plafon).toBeTruthy();
    expect(Number(avert.body.avertisment_plafon.disponibil_receptii)).toBe(10000);
    expect(Number(avert.body.avertisment_plafon.disponibil_df)).toBe(50000);
    const dupa = await getAlop(alopId);
    expect(dupa.status).toBe('ordonantare');                 // operația S-A EXECUTAT
    expect(Number(dupa.lichidare_valoare_factura)).toBe(30000);
  });

  it('7b sub AMBELE praguri ⇒ 200 fără nicio semnalizare', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, rowsVal: [{ valt_actualiz: '100000' }] });
    const ordVechi = await seedOrdAprobat({ dfId, nr: 'ORD-V', rows: [
      { receptii: '60000', plati_anterioare: '0', suma_ordonantata_plata: '50000' },
    ] });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId, cicluCurent: 2 });
    await arhiveazaCiclu({ alopId, orgId: 1, cicluNr: 1, ordId: ordVechi, plataSuma: '50000' });

    const ok = await request(app).post(`/api/alop/${alopId}/confirma-lichidare`)
      .set('Cookie', cookie()).send({ nr_factura: 'F-3', valoare_factura: 8000 });
    expect(ok.status).toBe(200);
    expect(ok.body.avertisment_plafon).toBeUndefined();
  });

  // ── 8 NEDETERIORARE — poarta de la noua-lichidare ─────────────────────────
  it('8 poarta de la noua-lichidare întoarce ACELEAȘI rezultate ca înainte', async () => {
    // (a) rest disponibil pe col.10 → 200, ramas = col.10 − ordonanțat
    {
      const dfId = await seedDf({ orgId: 1, createdBy: 1,
        rowsVal: [{ valt_actualiz: '9000000' }], rowsCtrl: [{ sum_rezv_crdt_bug_act: '1000' }] });
      const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', dfId,
        nrOrd: 'NL-1', rows: [{ suma_ordonantata_plata: '400' }] });
      const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'completed', dfId, ordId,
        plataSumaEfectiva: 400, cicluCurent: 1 });
      const res = await request(app).post(`/api/alop/${alopId}/noua-lichidare`)
        .set('Cookie', cookie()).send({});
      expect(res.status).toBe(200);
      expect(Number(res.body.ramas)).toBe(600);
      const a = await getAlop(alopId);
      expect(a.status).toBe('lichidare');
      expect(a.ciclu_curent).toBe(2);
      expect(Number(a.suma_totala_platita)).toBe(400);
      expect((await getAlopCicluri(alopId)).length).toBe(1);
    }
    // (b) col.10 integral ordonanțat → 400 limita_depasita, niciun ciclu arhivat
    {
      const dfId = await seedDf({ orgId: 1, createdBy: 1, nrUnic: 'DF-B',
        rowsVal: [{ valt_actualiz: '1000000' }], rowsCtrl: [{ sum_rezv_crdt_bug_act: '1000' }] });
      const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', dfId,
        nrOrd: 'NL-2', rows: [{ suma_ordonantata_plata: '1000' }] });
      const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'completed', dfId, ordId,
        plataSumaEfectiva: 1000, cicluCurent: 1 });
      const res = await request(app).post(`/api/alop/${alopId}/noua-lichidare`)
        .set('Cookie', cookie()).send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('limita_depasita');
      expect((await getAlop(alopId)).status).toBe('completed');
      expect((await getAlopCicluri(alopId)).length).toBe(0);
    }
  });

  // ── 9 ⭐ INVARIANTUL Etapei B ─────────────────────────────────────────────
  it('9 ⭐ GET pe un ORD EXISTENT întoarce EXACT rândurile salvate (nicio derivare)', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, rowsVal: [{ valt_actualiz: '360424.95' }] });
    const ord1 = await seedOrdAprobat({ dfId, nr: '41011', rows: [rowOf(C1)] });
    // ORD-ul 2 e SALVAT cu col.3 = 300.424,95 (cifra semnată)
    const ord2 = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', dfId,
      nrOrd: '43759', rows: [rowOf(C2)] });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare',
      dfId, ordId: ord2, cicluCurent: 2 });
    await arhiveazaCiclu({ alopId, orgId: 1, cicluNr: 1, ordId: ord1, plataSuma: C1.col4 });

    const r = await request(app).get(`/api/formulare-ord/${ord2}`).set('Cookie', cookie());
    expect(r.status).toBe(200);
    expect(r.body.document.rows).toEqual([rowOf(C2)]);
    // Un al doilea GET nu schimbă nimic în DB.
    await request(app).get(`/api/formulare-ord/${ord2}`).set('Cookie', cookie());
    const { rows: db } = await pool.query('SELECT rows FROM formulare_ord WHERE id=$1', [ord2]);
    expect(db[0].rows).toEqual([rowOf(C2)]);
  });
});
