/**
 * Paritate card↔gardă (v3.9.568 → fix 12, v3.9.582): cardul ALOP afișează „Rămas de
 * ordonanțat (exercițiu curent)" via câmpul `ramas_an_curent` din detail GET `/api/alop/:id`.
 * Valoarea TREBUIE să fie IDENTICĂ cu cea pe care garda din `noua-lichidare` o aplică.
 *
 * Formula gărzii (oglindită aici independent, recalculată din DB):
 *   buget       = crediteBugetareAnCurent(df.rows_ctrl)            // col.10 sum_rezv_crdt_bug_act
 *   ordonantat  = Σ(cicluri arhivate anul curent → ord_id → rows.suma_ordonantata_plata)
 *                 + (ORD curent alop.ord_id → rows.suma_ordonantata_plata)
 *   ramas       = buget − ordonantat
 *
 * Acoperă: fără cicluri/fără ORD curent, cicluri din anul curent, ORD curent prezent,
 * an_referinta NULL irelevant (col.10), fără DF (→ NULL, nu NaN).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, seedOrd, seedAlop, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';
import { crediteBugetareAnCurent } from '../../services/buget-an.mjs';

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
      'SELECT df_id, ord_id FROM alop_instances WHERE id=$1', [alopId]);
    if (!a.df_id) return null;
    const { rows: [df] } = await pool.query(
      'SELECT rows_ctrl FROM formulare_df WHERE id=$1', [a.df_id]);
    const buget = crediteBugetareAnCurent(df?.rows_ctrl) || 0;
    const { rows: [arh] } = await pool.query(
      `SELECT COALESCE(SUM(co.s),0) AS total FROM alop_ord_cicluri c
         CROSS JOIN LATERAL (
           SELECT COALESCE(SUM((r->>'suma_ordonantata_plata')::numeric),0) AS s
             FROM formulare_ord fo LEFT JOIN jsonb_array_elements(COALESCE(fo.rows,'[]'::jsonb)) r ON true
            WHERE fo.id = c.ord_id
         ) co
        WHERE c.alop_id=$1
          AND COALESCE(c.an_exercitiu, EXTRACT(YEAR FROM c.plata_data)::int, EXTRACT(YEAR FROM c.created_at)::int) = $2`,
      [alopId, CUR]);
    const { rows: [cur] } = await pool.query(
      `SELECT COALESCE(SUM((r->>'suma_ordonantata_plata')::numeric),0) AS total
         FROM formulare_ord fo LEFT JOIN jsonb_array_elements(COALESCE(fo.rows,'[]'::jsonb)) r ON true
        WHERE fo.id=$1`, [a.ord_id]);
    return buget - parseFloat(arh.total || 0) - parseFloat(cur.total || 0);
  }
  // ORD cu o sumă ordonanțată dată.
  const seedOrdSum = (dfId, suma, nr) => seedOrd({
    orgId: 1, createdBy: 1, status: 'completed', dfId, nrOrd: nr,
    rows: [{ suma_ordonantata_plata: String(suma) }],
  });
  // Ciclu arhivat cu suma ORDONANȚATĂ (via ORD propriu), pe anul `an`.
  const addCiclu = async (alopId, dfId, ordonantat, an, nr) => {
    const ordId = await seedOrdSum(dfId, ordonantat, `ORD-C-${nr}-${an}`);
    await pool.query(
      `INSERT INTO alop_ord_cicluri (alop_id, org_id, ciclu_nr, ord_id, an_exercitiu, status)
       VALUES ($1, 1, $2, $3, $4, 'completed')`, [alopId, nr, ordId, an]);
  };

  it('fără cicluri, fără ORD curent → ramas = col.10 (paritate)', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-NC',
      rowsCtrl: [{ sum_rezv_crdt_bug_act: '29000' }] });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId });
    const card = await cardRamas(alopId);
    expect(Number(card)).toBe(29000);
    expect(Number(card)).toBe(await guardRamas(alopId)); // paritate card↔gardă
  });

  it('cicluri din anul curent → se scad din ramas (paritate)', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-CC',
      rowsCtrl: [{ sum_rezv_crdt_bug_act: '29000' }] });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId, cicluCurent: 2 });
    await addCiclu(alopId, dfId, 5000, CUR, 1);       // an curent → contează
    await addCiclu(alopId, dfId, 7000, CUR - 1, 2);   // an anterior → ignorat
    const card = await cardRamas(alopId);
    expect(Number(card)).toBe(24000);        // 29000 − 5000 (ciclul vechi nu se scade)
    expect(Number(card)).toBe(await guardRamas(alopId));
  });

  it('ORD curent (alop.ord_id) → ordonanțatul lui se scade (paritate)', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-PL',
      rowsCtrl: [{ sum_rezv_crdt_bug_act: '29000' }] });
    const ordCur = await seedOrdSum(dfId, 3000, 'ORD-CUR');
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'completed', dfId,
      ordId: ordCur, cicluCurent: 2 });
    await addCiclu(alopId, dfId, 5000, CUR, 1);
    const card = await cardRamas(alopId);
    expect(Number(card)).toBe(21000);        // 29000 − (5000 + 3000)
    expect(Number(card)).toBe(await guardRamas(alopId));
  });

  it('an_referinta NULL irelevant — col.10 e baza (paritate cu garda)', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-LEG',
      anReferinta: null, rowsCtrl: [{ sum_rezv_crdt_bug_act: '29000' }] });
    const ordCur = await seedOrdSum(dfId, 4000, 'ORD-LEG');
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId, ordId: ordCur });
    const card = await cardRamas(alopId);
    expect(card).not.toBeNull();
    expect(Number(card)).toBe(25000);        // col.10 29000 − ordonanțat curent 4000
    expect(Number(card)).toBe(await guardRamas(alopId));
  });

  it('ALOP fără DF (df_id NULL) → ramas_an_curent = NULL (nu NaN, nu 0)', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft' });
    const card = await cardRamas(alopId);
    expect(card).toBeNull();
  });

  // ── credite_bugetare_an_curent (v3.9.600): valoarea din paranteza „rămas exercițiu" ─────
  // = col.10 (`sqlCrediteBugetareCol10`) = BAZA reală a lui ramas_an_curent. Blochează
  //   re-divergența parantezei față de cifra rămas pe care o însoțește.
  async function cardCredite(alopId) {
    const res = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    return res.body.alop.credite_bugetare_an_curent;
  }

  it('credite_bugetare_an_curent = col.10 (crediteBugetareAnCurent din rows_ctrl)', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-CB',
      rowsCtrl: [{ sum_rezv_crdt_bug_act: '29000' }] });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId });
    const { rows: [df] } = await pool.query('SELECT rows_ctrl FROM formulare_df WHERE id=$1', [dfId]);
    const credite = await cardCredite(alopId);
    expect(Number(credite)).toBe(crediteBugetareAnCurent(df.rows_ctrl)); // = col.10
    expect(Number(credite)).toBe(29000);
  });

  it('consistență: credite_bugetare_an_curent === ramas_an_curent + ordonanțat curent', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-CONS',
      rowsCtrl: [{ sum_rezv_crdt_bug_act: '29000' }] });
    const ordCur = await seedOrdSum(dfId, 3000, 'ORD-CONS');
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'completed', dfId,
      ordId: ordCur, cicluCurent: 2 });
    await addCiclu(alopId, dfId, 5000, CUR, 1);
    const credite = Number(await cardCredite(alopId));
    const ramas = Number(await cardRamas(alopId));
    const ordonantat = 5000 + 3000; // ciclu an curent + ORD curent
    // paranteza (credite = bază) = cifra principală (ramas) + ce s-a ordonanțat = invariant
    expect(credite).toBe(ramas + ordonantat);
    expect(credite).toBe(29000);
    expect(ramas).toBe(21000);
  });

  it('ALOP fără DF → credite_bugetare_an_curent NULL/0 (ca ramas, fără NaN)', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft' });
    const credite = await cardCredite(alopId);
    // fără DF → COALESCE SUM pe rows_ctrl inexistent = 0 (nu NaN); frontend gardează cu ||0
    expect(credite == null || Number(credite) === 0).toBe(true);
    expect(Number.isNaN(Number(credite ?? 0))).toBe(false);
  });
});
