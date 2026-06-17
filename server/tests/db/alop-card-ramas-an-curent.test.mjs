/**
 * Paritate card↔gardă (v3.9.568): cardul ALOP afișează „Rămas de ordonanțat (exercițiu curent)"
 * via NOUL câmp `ramas_an_curent` din detail GET `/api/alop/:id`. Valoarea TREBUIE să fie IDENTICĂ
 * cu cea pe care garda din `noua-lichidare` o aplică, altfel cardul ar induce decizii greșite
 * („cardul zice X, garda respinge la Y").
 *
 * Formula gărzii (oglindit aici independent, recalculat din DB + helper-ul PUR bugetPentruAnul):
 *   bugetAnCurent = bugetPentruAnul(df.rows_plati, an_referinta ?? CUR, CUR)
 *   sumaPlata     = SUM(plata_suma_efectiva | cicluri din anul curent) + alop.plata_suma_efectiva
 *   ramas         = bugetAnCurent − sumaPlata
 *
 * Acoperă: fără cicluri, cicluri din anul curent, plata live prezentă, legacy an_referinta NULL,
 * fără DF (→ NULL, nu NaN).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, seedAlop, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';
import { bugetPentruAnul } from '../../services/buget-an.mjs';

const d = describe.skipIf(!hasTestDb());
const CUR = new Date().getFullYear();

d('Card ALOP — ramas_an_curent oglindește garda noua-lichidare', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' }); // id 1
    await seedUser({ orgId: 1, email: 'p2@x.ro' });          // id 2
    app = buildApp();
  });
  afterAll(() => pool.end());
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  // Câmpul din card (detail GET) — numeric pg vine ca string, null rămâne null.
  async function cardRamas(alopId) {
    const res = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    return res.body.alop.ramas_an_curent;
  }
  // Recalcul INDEPENDENT al formulei gărzii din DB (NU prin endpoint).
  async function guardRamas(alopId) {
    const { rows: [a] } = await pool.query(
      'SELECT df_id, plata_suma_efectiva FROM alop_instances WHERE id=$1', [alopId]);
    const { rows: [df] } = await pool.query(
      'SELECT an_referinta, rows_plati FROM formulare_df WHERE id=$1', [a.df_id]);
    const anRef = df?.an_referinta == null ? CUR : df.an_referinta;
    const buget = bugetPentruAnul(df?.rows_plati, anRef, CUR) || 0;
    const { rows: [s] } = await pool.query(
      `SELECT COALESCE(SUM(plata_suma_efectiva),0) AS total FROM alop_ord_cicluri
        WHERE alop_id=$1
          AND COALESCE(an_exercitiu, EXTRACT(YEAR FROM plata_data)::int, EXTRACT(YEAR FROM created_at)::int) = $2`,
      [alopId, CUR]);
    const sumaPlata = parseFloat(s.total || 0) + parseFloat(a.plata_suma_efectiva || 0);
    return buget - sumaPlata;
  }
  const addCiclu = (alopId, suma, an) => pool.query(
    `INSERT INTO alop_ord_cicluri (alop_id, org_id, ciclu_nr, plata_suma_efectiva, an_exercitiu, status)
     VALUES ($1, 1, (SELECT COALESCE(MAX(ciclu_nr),0)+1 FROM alop_ord_cicluri WHERE alop_id=$1), $2, $3, 'completed')`,
    [alopId, suma, an]);

  it('fără cicluri, fără plata live → ramas = bugetul benzii (paritate)', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-NC',
      anReferinta: CUR, rowsPlati: [{ plati_estim_ancrt: '29000', plati_estim_an_np1: '999999' }] });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId });
    const card = await cardRamas(alopId);
    expect(Number(card)).toBe(29000);
    expect(Number(card)).toBe(await guardRamas(alopId)); // paritate card↔gardă
  });

  it('cicluri din anul curent → se scad din ramas (paritate)', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-CC',
      anReferinta: CUR, rowsPlati: [{ plati_estim_ancrt: '29000' }] });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId, cicluCurent: 2 });
    await addCiclu(alopId, 5000, CUR);       // an curent → contează
    await addCiclu(alopId, 7000, CUR - 1);   // an anterior → ignorat
    const card = await cardRamas(alopId);
    expect(Number(card)).toBe(24000);        // 29000 − 5000 (ciclul vechi nu se scade)
    expect(Number(card)).toBe(await guardRamas(alopId));
  });

  it('plata live prezentă (a.plata_suma_efectiva) → inclusă în sumaPlata (paritate)', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-PL',
      anReferinta: CUR, rowsPlati: [{ plati_estim_ancrt: '29000' }] });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'completed', dfId,
      plataSumaEfectiva: 3000, cicluCurent: 2 });
    await addCiclu(alopId, 5000, CUR);
    const card = await cardRamas(alopId);
    expect(Number(card)).toBe(21000);        // 29000 − (5000 + 3000)
    expect(Number(card)).toBe(await guardRamas(alopId));
  });

  it('legacy an_referinta NULL → banda ancrt (NU NULL), paritate cu garda', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-LEG',
      anReferinta: null, rowsPlati: [{ plati_estim_ancrt: '29000', plati_estim_an_np1: '1' }] });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId,
      plataSumaEfectiva: 4000 });
    const card = await cardRamas(alopId);
    expect(card).not.toBeNull();
    expect(Number(card)).toBe(25000);        // ancrt 29000 − plata live 4000
    expect(Number(card)).toBe(await guardRamas(alopId));
  });

  it('ALOP fără DF (df_id NULL) → ramas_an_curent = NULL (nu NaN, nu 0)', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft' });
    const card = await cardRamas(alopId);
    expect(card).toBeNull();
  });
});
