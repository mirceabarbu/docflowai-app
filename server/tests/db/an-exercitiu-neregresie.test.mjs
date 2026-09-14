/**
 * #204 — NEREGRESIE: consolidarea anului de exercițiu în `anExercitiuCurent()` NU mișcă nicio cifră.
 *
 * Tiparul de la #202/#203: expresiile PRE-LOT (copiate VERBATIM de aici de jos, cu
 * `EXTRACT(YEAR FROM NOW())` în ele) se rulează LIVE, pe aceleași rânduri, în același test, și se
 * compară cu ce întorc rutele post-lot — nu cu constante scrise de mână. Dacă apare o diferență,
 * lotul e GREȘIT, nu „diferit".
 *
 * DF-urile au `an_referinta` DIFERIT de anul curent (offset −1 / 0 / +1), ca banda `rows_plati`
 * să fie efectiv exercitată (fiecare bandă cu o sumă distinctă), nu doar ramura offset = 0.
 *
 * Acoperă cele patru locuri consolidate:
 *   6.  lista ALOP (`GET /api/alop`)            → df_buget_an_curent
 *   7.  detaliul ALOP (`GET /api/alop/:id`)     → df_buget_an_curent + ramas_an_curent
 *   8.  bifa „Stingere" (ramura sqlTabel1)      → identic, listă + detaliu
 *   9.  plafonul noua-lichidare (`ramas` + an_exercitiu al ciclului arhivat)
 *   10. computeOrdBudgetContext (plafon ORD)
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, seedOrd, seedAlop, getAlopCicluri, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';
import { computeOrdBudgetContext } from '../../services/formular-shared.mjs';
import { anExercitiuCurent } from '../../services/buget-an.mjs';

const d = describe.skipIf(!hasTestDb());
const CUR = new Date().getFullYear();

// ── Expresiile PRE-LOT, verbatim (alop.mjs @ v3.9.856) ─────────────────────────────────────
function OLD_sqlStingereTruthy(df) {
  return `(COALESCE(${df}.ckbx_sting_ang_in_ancrt,'') NOT IN ('','0','false','f','no','off'))`;
}
function OLD_sqlBandaRowsPlati(df) {
  const off = `(EXTRACT(YEAR FROM NOW())::int - COALESCE(${df}.an_referinta, EXTRACT(YEAR FROM NOW())::int))`;
  const band = `(CASE
        WHEN ${off} < 0 THEN 'plati_ani_precedenti'
        WHEN ${off} = 0 THEN 'plati_estim_ancrt'
        WHEN ${off} = 1 THEN 'plati_estim_an_np1'
        WHEN ${off} = 2 THEN 'plati_estim_an_np2'
        WHEN ${off} = 3 THEN 'plati_estim_an_np3'
        ELSE 'plati_estim_ani_ulter' END)`;
  return `(SELECT COALESCE(SUM((r->>${band})::numeric),0)
           FROM jsonb_array_elements(COALESCE(${df}.rows_plati,'[]'::jsonb)) r
           WHERE (r->>${band}) ~ '^[0-9.]+$')`;
}
function OLD_sqlTabel1(df) {
  return `(SELECT COALESCE(SUM((r->>'valt_actualiz')::numeric),0)
           FROM jsonb_array_elements(COALESCE(${df}.rows_val,'[]'::jsonb)) r
           WHERE (r->>'valt_actualiz') ~ '^[0-9.]+$')`;
}
function OLD_sqlBugetAnExercitiu(df) {
  return `(CASE WHEN ${OLD_sqlStingereTruthy(df)} THEN ${OLD_sqlTabel1(df)} ELSE ${OLD_sqlBandaRowsPlati(df)} END)`;
}
function OLD_sqlCrediteBugetareCol10(df) {
  return `(SELECT COALESCE(SUM((r->>'sum_rezv_crdt_bug_act')::numeric),0)
           FROM jsonb_array_elements(COALESCE(${df}.rows_ctrl,'[]'::jsonb)) r
           WHERE (r->>'sum_rezv_crdt_bug_act') ~ '^[0-9.]+$')`;
}
function OLD_sqlOrdonantatAnCurent(a) {
  return `(
    COALESCE((
      SELECT SUM(co.s)
        FROM alop_ord_cicluri c_re
        CROSS JOIN LATERAL (
          SELECT COALESCE(SUM((r->>'suma_ordonantata_plata')::numeric),0) AS s
            FROM formulare_ord fo_re
            LEFT JOIN jsonb_array_elements(COALESCE(fo_re.rows,'[]'::jsonb)) r ON true
           WHERE fo_re.id = c_re.ord_id
        ) co
       WHERE c_re.alop_id = ${a}.id
         AND COALESCE(c_re.an_exercitiu,
                      EXTRACT(YEAR FROM c_re.plata_data)::int,
                      EXTRACT(YEAR FROM c_re.created_at)::int) = EXTRACT(YEAR FROM NOW())::int
    ), 0)
    + COALESCE((
      SELECT COALESCE(SUM((r->>'suma_ordonantata_plata')::numeric),0)
        FROM formulare_ord fo_cur
        LEFT JOIN jsonb_array_elements(COALESCE(fo_cur.rows,'[]'::jsonb)) r ON true
       WHERE fo_cur.id = ${a}.ord_id
    ), 0)
  )`;
}
function OLD_sqlRamasAnExercitiu(df, a) {
  return `(CASE WHEN ${a}.df_id IS NULL THEN NULL ELSE
    ${OLD_sqlCrediteBugetareCol10(df)} - ${OLD_sqlOrdonantatAnCurent(a)}
  END)`;
}

/** Rulează expresiile PRE-LOT live pe rândul ALOP dat. */
async function oldCard(alopId) {
  const { rows: [r] } = await pool.query(
    `SELECT ${OLD_sqlBugetAnExercitiu('df')} AS buget,
            ${OLD_sqlRamasAnExercitiu('df','a')} AS ramas,
            ${OLD_sqlCrediteBugetareCol10('df')} - ${OLD_sqlOrdonantatAnCurent('a')} AS plafon_ramas
       FROM alop_instances a
       LEFT JOIN formulare_df df ON df.id = a.df_id
      WHERE a.id = $1`, [alopId]);
  return r;
}
const num = (v) => (v === null || v === undefined) ? v : Number(v);

// Benzi cu sume DISTINCTE — banda greșită dă o cifră diferită, nu aceeași.
const ROWS_PLATI = [{
  plati_ani_precedenti: '111', plati_estim_ancrt: '222', plati_estim_an_np1: '333',
  plati_estim_an_np2: '444', plati_estim_an_np3: '555', plati_estim_ani_ulter: '666',
}];
const COL10 = [{ sum_rezv_crdt_bug_act: '10000' }];

d('#204 — an de exercițiu: NEREGRESIE (expresia veche live === ruta nouă)', () => {
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

  const seedOrdSum = (dfId, suma, nr) => seedOrd({
    orgId: 1, createdBy: 1, status: 'completed', dfId, nrOrd: nr,
    rows: [{ suma_ordonantata_plata: String(suma) }],
  });
  const addCiclu = async (alopId, dfId, ordonantat, an, nr) => {
    const ordId = await seedOrdSum(dfId, ordonantat, `ORD-C-${nr}-${an}`);
    await pool.query(
      `INSERT INTO alop_ord_cicluri (alop_id, org_id, ciclu_nr, ord_id, an_exercitiu, status)
       VALUES ($1, 1, $2, $3, $4, 'completed')`, [alopId, nr, ordId, an]);
  };
  // Trei DF-uri cu an_referinta −1 / 0 / +1 față de anul curent → offset +1 / 0 / −1.
  async function seedTreiDosare() {
    const out = [];
    for (const [i, anRef] of [CUR - 1, CUR, CUR + 1].entries()) {
      const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: `DF-OFF-${i}`,
        anReferinta: anRef, rowsPlati: ROWS_PLATI, rowsCtrl: COL10 });
      const ordCur = await seedOrdSum(dfId, 1000 + i, `ORD-CUR-${i}`);
      const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'completed', dfId, ordId: ordCur, cicluCurent: 3 });
      await addCiclu(alopId, dfId, 2000 + i, CUR, 1);       // anul curent → intră în ordonanțat
      await addCiclu(alopId, dfId, 5000 + i, CUR - 1, 2);   // anul anterior → NU intră
      out.push({ dfId, alopId, anRef });
    }
    return out;
  }

  it('0. sanity: anExercitiuCurent() === anul lui NOW() din Postgres (același ceas, aceeași zi)', async () => {
    const { rows: [r] } = await pool.query('SELECT EXTRACT(YEAR FROM NOW())::int AS an');
    expect(anExercitiuCurent()).toBe(r.an);
    expect(anExercitiuCurent()).toBe(CUR);
  });

  it('6. ⭐ lista ALOP — df_buget_an_curent identic cu expresia pre-lot, pe offset +1 / 0 / −1', async () => {
    const dosare = await seedTreiDosare();
    const res = await request(app).get('/api/alop').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.alop.length).toBe(3);
    for (const { alopId, anRef } of dosare) {
      const row = res.body.alop.find(x => x.id === alopId);
      expect(row, `ALOP ${alopId} lipsește din listă`).toBeTruthy();
      const old = await oldCard(alopId);
      expect(num(row.df_buget_an_curent)).toBe(num(old.buget));
      // și banda a fost chiar exercitată: offset = CUR − anRef ⇒ np1 / ancrt / ani_precedenti
      const asteptat = { [CUR - 1]: 333, [CUR]: 222, [CUR + 1]: 111 }[anRef];
      expect(num(row.df_buget_an_curent)).toBe(asteptat);
    }
  });

  it('7. ⭐ detaliul ALOP — df_buget_an_curent ȘI ramas_an_curent identice cu expresia pre-lot', async () => {
    const dosare = await seedTreiDosare();
    for (const { alopId, anRef } of dosare) {
      const res = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie());
      expect(res.status).toBe(200);
      const old = await oldCard(alopId);
      expect(num(res.body.alop.df_buget_an_curent)).toBe(num(old.buget));
      expect(num(res.body.alop.ramas_an_curent)).toBe(num(old.ramas));
      // sanity pe cifre: col.10 10000 − (ciclu an curent + ORD curent); ciclul din CUR−1 nu se scade
      const i = [CUR - 1, CUR, CUR + 1].indexOf(anRef);
      expect(num(res.body.alop.ramas_an_curent)).toBe(10000 - (2000 + i) - (1000 + i));
    }
  });

  it('8. ⭐ „Stingere" bifat (ramura sqlTabel1) — identic, listă + detaliu', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-STING',
      anReferinta: CUR - 1, ckbxSting: '1',
      rowsVal: [{ valt_actualiz: '250000' }, { valt_actualiz: '50000' }],
      rowsPlati: ROWS_PLATI, rowsCtrl: COL10 });
    const ordCur = await seedOrdSum(dfId, 700, 'ORD-STING');
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'completed', dfId, ordId: ordCur, cicluCurent: 2 });
    await addCiclu(alopId, dfId, 300, CUR, 1);
    const old = await oldCard(alopId);

    const det = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie());
    expect(det.status).toBe(200);
    expect(det.body.alop.df_stingere).toBe(true);
    expect(num(det.body.alop.df_buget_an_curent)).toBe(num(old.buget));
    expect(num(det.body.alop.df_buget_an_curent)).toBe(300000); // tabel 1, NU banda (333)
    expect(num(det.body.alop.ramas_an_curent)).toBe(num(old.ramas));
    expect(num(det.body.alop.ramas_an_curent)).toBe(10000 - 300 - 700);

    const lst = await request(app).get('/api/alop').set('Cookie', cookie());
    expect(lst.status).toBe(200);
    expect(num(lst.body.alop[0].df_buget_an_curent)).toBe(num(old.buget));
  });

  it('9. plafonul noua-lichidare — `ramas` identic cu expresia pre-lot; an_exercitiu al ciclului arhivat = anul NOW()', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-NL',
      anReferinta: CUR - 1, rowsPlati: ROWS_PLATI, rowsCtrl: COL10 });
    const ordCur = await seedOrdSum(dfId, 1000, 'ORD-NL');
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'completed', dfId, ordId: ordCur,
      cicluCurent: 3, plataSumaEfectiva: 900 });
    await addCiclu(alopId, dfId, 2000, CUR, 1);
    await addCiclu(alopId, dfId, 5000, CUR - 1, 2);
    // expresia veche ÎNAINTE de mutație (ORD curent încă pe a.ord_id)
    const old = await oldCard(alopId);
    expect(num(old.plafon_ramas)).toBe(10000 - 2000 - 1000);

    const res = await request(app).post(`/api/alop/${alopId}/noua-lichidare`).set('Cookie', cookie()).send({});
    expect(res.status).toBe(200);
    expect(num(res.body.ramas)).toBe(num(old.plafon_ramas));

    // ciclul arhivat acum (plata_data NULL → fallback anExercitiu) poartă anul lui NOW()
    const { rows: [db] } = await pool.query('SELECT EXTRACT(YEAR FROM NOW())::int AS an');
    const cicluri = await getAlopCicluri(alopId);
    const arhivatAcum = cicluri.find(c => c.ciclu_nr === 3);
    expect(arhivatAcum).toBeTruthy();
    expect(arhivatAcum.an_exercitiu).toBe(db.an);
  });

  it('9b. plafon epuizat → limita_depasita menționează anul lui NOW() (mesaj neschimbat)', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-NL-EP',
      anReferinta: CUR, rowsPlati: ROWS_PLATI, rowsCtrl: [{ sum_rezv_crdt_bug_act: '1000' }] });
    const ordCur = await seedOrdSum(dfId, 1000, 'ORD-NL-EP');
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'completed', dfId, ordId: ordCur, cicluCurent: 1 });
    const res = await request(app).post(`/api/alop/${alopId}/noua-lichidare`).set('Cookie', cookie()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('limita_depasita');
    const { rows: [db] } = await pool.query('SELECT EXTRACT(YEAR FROM NOW())::int AS an');
    expect(res.body.message).toContain(String(db.an));
  });

  it('10. computeOrdBudgetContext — anExercitiu + cicluriArhivate identice cu expresia pre-lot', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-CTX',
      anReferinta: CUR + 1, rowsPlati: ROWS_PLATI, rowsCtrl: COL10 });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId, cicluCurent: 3 });
    await addCiclu(alopId, dfId, 2500, CUR, 1);
    await addCiclu(alopId, dfId, 6500, CUR - 1, 2);

    // pre-lot: `anExercitiu = new Date().getFullYear()` legat ca $3; aici anul vine din NOW() al bazei
    const { rows: [old] } = await pool.query(
      `SELECT EXTRACT(YEAR FROM NOW())::int AS an,
              COALESCE((
                SELECT SUM(co.s)
                FROM alop_ord_cicluri c
                JOIN alop_instances a ON a.id = c.alop_id
                CROSS JOIN LATERAL (
                  SELECT COALESCE(SUM((r->>'suma_ordonantata_plata')::numeric),0) AS s
                  FROM formulare_ord fo
                  LEFT JOIN jsonb_array_elements(COALESCE(fo.rows,'[]'::jsonb)) r ON true
                  WHERE fo.id = c.ord_id
                ) co
                WHERE a.id = $1::uuid AND a.org_id = 1 AND a.cancelled_at IS NULL
                  AND COALESCE(c.an_exercitiu, EXTRACT(YEAR FROM c.plata_data)::int,
                               EXTRACT(YEAR FROM c.created_at)::int) = EXTRACT(YEAR FROM NOW())::int
              ), 0) AS cicluri_arhivate`, [alopId]);

    const ctx = await computeOrdBudgetContext({ dfId, orgId: 1 });
    expect(ctx).not.toBeNull();
    expect(ctx.anExercitiu).toBe(old.an);
    expect(ctx.cicluriArhivate).toBe(num(old.cicluri_arhivate));
    expect(ctx.cicluriArhivate).toBe(2500); // ciclul din CUR−1 nu intră
    expect(ctx.bugetAnCurent).toBe(10000);
  });
});
