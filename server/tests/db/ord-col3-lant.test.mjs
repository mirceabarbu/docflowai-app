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

// #187 — cheia canonică a coloanei 1: `cod||indicator||program||cod_SSI`, normalizată
// (trim + spații colapsate + MAJUSCULE). Vezi `cheieRand` din services/ord-lant.mjs.
const K = (cod, ind, prog = '', ssi = '') => [cod, ind, prog, ssi].join('||');
const K1 = K('A1', 'I1');
/** col.3 derivată pentru o cheie anume — NICIODATĂ un total de document (#187). */
const c3 = (body, cheie = K1) => {
  const e = body && body.chei && body.chei[cheie];
  return e ? e.col3 : undefined;
};

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

d('#186/#187 — col.3 PER CHEIE din lanțul de ORD + disponibil pe ordonanțat + porți', () => {
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
    expect(Number(c3(r2.body))).toBeCloseTo(300424.95, 2);
    expect(r2.body.cheie_unica).toBe(K1);          // o singură cheie la predecesor
    expect(r2.body.predecesor.nr_ord).toBe('41011');

    // Ciclul 3: arhivăm ciclul 2 și punem ORD 47218 ca ORD curent.
    await arhiveazaCiclu({ alopId, orgId: 1, cicluNr: 2, ordId: ord2, plataSuma: C2.col4 });
    const ord3 = await seedOrdAprobat({ dfId, nr: '47218', rows: [rowOf(C3)] });
    await pool.query(`UPDATE alop_instances SET ord_id=$2, ciclu_curent=3 WHERE id=$1`, [alopId, ord3]);

    const r3 = await getCol3(alopId, ord3);
    expect(r3.status).toBe(200);
    expect(Number(c3(r3.body))).toBeCloseTo(353688.51, 2);   // = col.3 REAL al ORD 47218
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
    expect(Number(c3(r.body))).toBeCloseTo(254379.63, 2);   // fără cei 46.045,32
  });

  // ── 3 Prima ORD a dosarului ───────────────────────────────────────────────
  it('3 prima ORD a dosarului ⇒ sursa=prima_ord, col3=null (NU 0)', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, rowsVal: [{ valt_actualiz: '360424.95' }] });
    const ord1 = await seedOrd({ orgId: 1, createdBy: 1, dfId, nrOrd: '41011', rows: [rowOf(C1)] });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', dfId, ordId: ord1 });

    const r = await getCol3(alopId, ord1);
    expect(r.status).toBe(200);
    expect(r.body.sursa).toBe('prima_ord');
    expect(r.body.predecesor).toBeNull();
    expect(r.body.cheie_unica).toBeNull();
    // #187 — fără predecesor, cheile ORD-ului curent sunt „necunoscute", NU zero.
    expect(c3(r.body)).toBeNull();
    expect(r.body.chei[K1].sursa).toBe('indicator_nou');
  });

  // ── 4 ORD multi-bloc, CHEI DIFERITE — fiecare cheie cu valoarea ei ────────
  // ⚠️ #187 a RESCRIS acest test. Forma de la #186 („însumarea acoperă TOATE rândurile")
  // afirma exact defectul reparat aici: rândurile aveau col.3 DIFERITE fără nicio cheie în
  // coloana 1, iar derivarea le aduna. Sub regula corectă, rânduri cu chei diferite dau
  // intrări SEPARATE în hartă; rânduri ale ACELEIAȘI chei cu col.3 diferite sunt o anomalie
  // de date (cazul 4c mai jos), nu o sumă.
  it('4 ORD multi-bloc cu CHEI DIFERITE: fiecare cheie își are propria valoare', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, rowsVal: [{ valt_actualiz: '999999' }] });
    const ordMulti = await seedOrdAprobat({ dfId, nr: 'MB-1', rows: [
      { bloc_idx: 0, cod_angajament: 'A1', indicator_angajament: 'I1',
        receptii: '100000', plati_anterioare: '30000.50', suma_ordonantata_plata: '10000' },
      { bloc_idx: 0, cod_angajament: 'A2', indicator_angajament: 'I2',
        receptii: '20000',  plati_anterioare: '13263.06', suma_ordonantata_plata: '5000' },
      { bloc_idx: 1, cod_angajament: 'A1', indicator_angajament: 'I1',
        receptii: '15000',  plati_anterioare: '30000.50', suma_ordonantata_plata: '2500' },
    ] });
    const ordNou = await seedOrd({ orgId: 1, createdBy: 1, dfId, nrOrd: 'MB-2', rows: [] });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare',
      dfId, ordId: ordNou, cicluCurent: 2 });
    await arhiveazaCiclu({ alopId, orgId: 1, cicluNr: 1, ordId: ordMulti });

    const r = await getCol3(alopId, ordNou);
    expect(r.status).toBe(200);
    // A1/I1: col.3 luată O SINGURĂ DATĂ (30.000,50, repetată în două blocuri) + Σ col.4 (12.500)
    expect(Number(c3(r.body, K1))).toBeCloseTo(42500.50, 2);
    // A2/I2: 13.263,06 + 5.000
    expect(Number(c3(r.body, K('A2', 'I2')))).toBeCloseTo(18263.06, 2);
    expect(r.body.cheie_unica).toBeNull();          // două chei ⇒ nicio ramură „unică"
    // ⛔ NICIO însumare între chei: 42.500,50 + 18.263,06 nu apare nicăieri în răspuns.
    expect(Object.keys(r.body.chei)).toHaveLength(2);
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
    expect(r.body.cheie_unica).toBeNull();
    expect(r.body.chei).toEqual({});   // ORD-ul curent n-are rânduri ⇒ nicio cheie de raportat
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

  // ═══════════════════════════════════════════════════════════════════════════
  // #187 — col.3 se derivă PER CHEIE din coloana 1, NICIODATĂ însumată pe document
  // ═══════════════════════════════════════════════════════════════════════════

  // ── 10 ⭐ CAZUL CARE AR FI PICAT LA #186 ──────────────────────────────────
  it('10 ⭐ două blocuri cu ACEEAȘI cheie: col.3 se ia O SINGURĂ DATĂ (353.688,51, NU 600.849,90)',
    async () => {
      const dfId = await seedDf({ orgId: 1, createdBy: 1, rowsVal: [{ valt_actualiz: '999999' }] });
      // Cifrele REALE ale dosarului „Iluminat public", desfăcute pe doi furnizori:
      // col.3 = 300.424,95 REPETATĂ identic în ambele blocuri (invariantul #128k — col.3 e o
      // proprietate a ANGAJAMENTULUI, nu a furnizorului), col.4 împărțită 30.000 + 23.263,56.
      const predId = await seedOrdAprobat({ dfId, nr: '43759-2B', rows: [
        { bloc_idx: 0, cod_angajament: 'A1', indicator_angajament: 'I1',
          receptii: '353688.51', plati_anterioare: '300424.95', suma_ordonantata_plata: '30000' },
        { bloc_idx: 1, cod_angajament: 'A1', indicator_angajament: 'I1',
          receptii: '353688.51', plati_anterioare: '300424.95', suma_ordonantata_plata: '23263.56' },
      ] });
      const ordNou = await seedOrd({ orgId: 1, createdBy: 1, dfId, nrOrd: '47218', rows: [] });
      const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare',
        dfId, ordId: ordNou, cicluCurent: 2 });
      await arhiveazaCiclu({ alopId, orgId: 1, cicluNr: 1, ordId: predId, plataSuma: '53263.56' });

      const r = await getCol3(alopId, ordNou);
      expect(r.status).toBe(200);
      // 300.424,95 (o singură dată) + (30.000 + 23.263,56) = 353.688,51
      expect(Number(c3(r.body))).toBeCloseTo(353688.51, 2);
      // ⛔ Forma de la #186 (Σ col.3 peste rânduri + Σ col.4) ar fi dat 600.849,90 + 53.263,56.
      expect(Number(c3(r.body))).not.toBeCloseTo(600849.90, 2);
      expect(Number(c3(r.body))).toBeLessThan(400000);
      expect(r.body.cheie_unica).toBe(K1);
    });

  // ── 11 ⭐ Două chei DIFERITE ⇒ două intrări, `cheie_unica` null ───────────
  it('11 ⭐ predecesor cu două chei distincte: două intrări, nicio însumare între ele', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, rowsVal: [{ valt_actualiz: '999999' }] });
    const predId = await seedOrdAprobat({ dfId, nr: 'DK-1', rows: [
      { cod_angajament: 'A1', indicator_angajament: 'I1', program: 'P1', cod_SSI: 'S1',
        plati_anterioare: '1000', suma_ordonantata_plata: '100' },
      { cod_angajament: 'A2', indicator_angajament: 'I2', program: 'P2', cod_SSI: 'S2',
        plati_anterioare: '7000', suma_ordonantata_plata: '250' },
    ] });
    const ordNou = await seedOrd({ orgId: 1, createdBy: 1, dfId, nrOrd: 'DK-2', rows: [] });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare',
      dfId, ordId: ordNou, cicluCurent: 2 });
    await arhiveazaCiclu({ alopId, orgId: 1, cicluNr: 1, ordId: predId, plataSuma: '350' });

    const r = await getCol3(alopId, ordNou);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.chei)).toHaveLength(2);
    expect(Number(c3(r.body, K('A1', 'I1', 'P1', 'S1')))).toBeCloseTo(1100, 2);
    expect(Number(c3(r.body, K('A2', 'I2', 'P2', 'S2')))).toBeCloseTo(7250, 2);
    expect(r.body.cheie_unica).toBeNull();
    // Componentele se întorc, ca frontendul să poată numi cheia în notă.
    expect(r.body.chei[K('A2', 'I2', 'P2', 'S2')].componente)
      .toEqual({ cod_angajament: 'A2', indicator_angajament: 'I2', program: 'P2', cod_SSI: 'S2' });
  });

  // ── 12 ⭐ Indicator NOU pe ORD-ul curent ──────────────────────────────────
  it('12 ⭐ cheie prezentă pe ORD-ul curent, absentă la predecesor ⇒ col3 null, sursa indicator_nou',
    async () => {
      const dfId = await seedDf({ orgId: 1, createdBy: 1, rowsVal: [{ valt_actualiz: '999999' }] });
      const predId = await seedOrdAprobat({ dfId, nr: 'IN-1', rows: [
        { cod_angajament: 'A1', indicator_angajament: 'I1',
          plati_anterioare: '5000', suma_ordonantata_plata: '1000' },
      ] });
      // ORD-ul curent aduce un angajament NOU (A9/I9) pe lângă cel cunoscut.
      const ordNou = await seedOrd({ orgId: 1, createdBy: 1, dfId, nrOrd: 'IN-2', rows: [
        { cod_angajament: 'A1', indicator_angajament: 'I1', plati_anterioare: '0' },
        { cod_angajament: 'A9', indicator_angajament: 'I9', plati_anterioare: '0' },
      ] });
      const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare',
        dfId, ordId: ordNou, cicluCurent: 2 });
      await arhiveazaCiclu({ alopId, orgId: 1, cicluNr: 1, ordId: predId, plataSuma: '1000' });

      const r = await getCol3(alopId, ordNou);
      expect(r.status).toBe(200);
      expect(Number(c3(r.body, K1))).toBeCloseTo(6000, 2);          // cunoscut: 5000 + 1000
      const nou = r.body.chei[K('A9', 'I9')];
      expect(nou).toBeTruthy();
      expect(nou.sursa).toBe('indicator_nou');
      expect(nou.col3).toBeNull();                                   // ⛔ NULL, nu 0
      expect(nou.col3).not.toBe(0);
      // O cheie „nouă" nu strică ramura simplă: predecesorul are tot o singură cheie.
      expect(r.body.cheie_unica).toBe(K1);
    });

  // ── 13 Anomalie de date: aceeași cheie cu col.3 DIFERITE ─────────────────
  it('13 rânduri ale aceleiași chei cu col.3 diferite ⇒ col3_inconsistent, fără prefill', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, rowsVal: [{ valt_actualiz: '999999' }] });
    const predId = await seedOrdAprobat({ dfId, nr: 'AN-1', rows: [
      { bloc_idx: 0, cod_angajament: 'A1', indicator_angajament: 'I1',
        plati_anterioare: '30000.50', suma_ordonantata_plata: '10000' },
      { bloc_idx: 1, cod_angajament: 'A1', indicator_angajament: 'I1',
        plati_anterioare: '13263.06', suma_ordonantata_plata: '5000' },
    ] });
    const ordNou = await seedOrd({ orgId: 1, createdBy: 1, dfId, nrOrd: 'AN-2', rows: [] });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare',
      dfId, ordId: ordNou, cicluCurent: 2 });
    await arhiveazaCiclu({ alopId, orgId: 1, cicluNr: 1, ordId: predId, plataSuma: '15000' });

    const r = await getCol3(alopId, ordNou);
    expect(r.status).toBe(200);
    expect(r.body.chei[K1].col3_inconsistent).toBe(true);
    expect(r.body.chei[K1].col3).toBeNull();          // nu alegem noi intre 30.000,50 si 13.263,06
    expect(r.body.cheie_unica).toBeNull();            // nimic de prefill-at
  });

  // ── 14 Normalizarea cheii ────────────────────────────────────────────────
  it('14 cheia e normalizată: „ AAB2XFH596K " și „aab2xfh596k" sunt aceeași cheie', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, rowsVal: [{ valt_actualiz: '999999' }] });
    const predId = await seedOrdAprobat({ dfId, nr: 'NK-1', rows: [
      { bloc_idx: 0, cod_angajament: ' AAB2XFH596K ', indicator_angajament: ' i1 ',
        plati_anterioare: '2000', suma_ordonantata_plata: '500' },
      { bloc_idx: 1, cod_angajament: 'aab2xfh596k', indicator_angajament: 'I1',
        plati_anterioare: '2000', suma_ordonantata_plata: '300' },
    ] });
    const ordNou = await seedOrd({ orgId: 1, createdBy: 1, dfId, nrOrd: 'NK-2', rows: [] });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare',
      dfId, ordId: ordNou, cicluCurent: 2 });
    await arhiveazaCiclu({ alopId, orgId: 1, cicluNr: 1, ordId: predId, plataSuma: '800' });

    const r = await getCol3(alopId, ordNou);
    expect(r.status).toBe(200);
    // O SINGURĂ cheie (nu două) ⇒ col.3 = 2000 (o dată) + (500 + 300)
    expect(Object.keys(r.body.chei)).toHaveLength(1);
    expect(Number(c3(r.body, K('AAB2XFH596K', 'I1')))).toBeCloseTo(2800, 2);
    expect(r.body.cheie_unica).toBe(K('AAB2XFH596K', 'I1'));
  });

  // ── 15 ETAPA C — poarta de plafon la TRIMITEREA spre CAB ─────────────────
  it('15 ⭐ submit ORD: BLOCARE 400 peste valoarea DF; documentul rămâne în draft', async () => {
    // ⚠️ Creditele bugetare (col.10) sunt LARGI dinadins: `validateOrdBugetAnCurent` rulează
    // ÎNAINTE și ar da 422 pe alt motiv. Aici verificăm STRICT poarta de plafon pe dosar.
    const dfId = await seedDf({ orgId: 1, createdBy: 1,
      rowsVal: [{ valt_actualiz: '100000' }], rowsCtrl: [{ sum_rezv_crdt_bug_act: '9000000' }] });
    const ordVechi = await seedOrdAprobat({ dfId, nr: 'PL-V', rows: [
      { receptii: '60000', plati_anterioare: '0', suma_ordonantata_plata: '50000' },
    ] });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare',
      dfId, cicluCurent: 2 });
    await arhiveazaCiclu({ alopId, orgId: 1, cicluNr: 1, ordId: ordVechi, plataSuma: '50000' });

    // ORD nou, in draft, cu randurile DEJA SALVATE (autosalvare) — 60.000 > disponibil (50.000).
    const ordNou = await seedOrd({ orgId: 1, createdBy: 1, dfId, nrOrd: 'PL-N', status: 'draft',
      rows: [{ receptii: '0', plati_anterioare: '0', suma_ordonantata_plata: '60000' }] });
    await pool.query('UPDATE formulare_ord SET source_alop_id=$2 WHERE id=$1', [ordNou, alopId]);
    await pool.query('UPDATE alop_instances SET ord_id=$2 WHERE id=$1', [alopId, ordNou]);

    const res = await request(app).post(`/api/formulare-ord/${ordNou}/submit`)
      .set('Cookie', cookie()).send({ assigned_to: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('peste_valoare_df');
    expect(Number(res.body.disponibil_df)).toBe(50000);
    const { rows: dupa } = await pool.query('SELECT status FROM formulare_ord WHERE id=$1', [ordNou]);
    expect(dupa[0].status).toBe('draft');            // operatia NU s-a executat
  });

  it('15b submit ORD sub prag ⇒ 200, documentul ajunge la P2', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1,
      rowsVal: [{ valt_actualiz: '100000' }], rowsCtrl: [{ sum_rezv_crdt_bug_act: '9000000' }] });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', dfId, cicluCurent: 1 });
    const ordNou = await seedOrd({ orgId: 1, createdBy: 1, dfId, nrOrd: 'PL-OK', status: 'draft',
      rows: [{ receptii: '90000', plati_anterioare: '0', suma_ordonantata_plata: '9000' }] });
    await pool.query('UPDATE formulare_ord SET source_alop_id=$2 WHERE id=$1', [ordNou, alopId]);
    await pool.query('UPDATE alop_instances SET ord_id=$2 WHERE id=$1', [alopId, ordNou]);

    const res = await request(app).post(`/api/formulare-ord/${ordNou}/submit`)
      .set('Cookie', cookie()).send({ assigned_to: 1 });
    expect(res.status).toBe(200);
    expect(res.body.avertisment_plafon).toBeUndefined();
    const { rows: dupa } = await pool.query('SELECT status FROM formulare_ord WHERE id=$1', [ordNou]);
    expect(dupa[0].status).toBe('pending_p2');
  });
});
