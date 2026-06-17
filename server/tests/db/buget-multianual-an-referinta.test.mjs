/**
 * FEATURE buget multi-anual (v3.9.558): `an_referinta` pe DF ancorează benzile rows_plati la
 * ani absoluți; plafonul de ordonanțare/plată se aplică pe banda ANULUI DE EXERCIȚIU curent.
 *
 * Offset-urile se exersează relativ la anul curent (fără a atinge ceasul):
 *   an_referinta = CUR     → offset 0 → banda `plati_estim_ancrt`
 *   an_referinta = CUR − 1 → offset 1 → banda `plati_estim_an_np1`
 *   an_referinta = CUR + 1 → offset -1 → banda `plati_ani_precedenti`
 *
 * Decizie owner: DF legacy (an_referinta NULL) → block mono-an pe `ancrt` (identic FIX B).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, seedOrd, seedAlop, seedFlowApproved,
         getOrd, getDf, getAlop, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());
const CUR = new Date().getFullYear();

d('Buget multi-anual — an_referinta ancorează plafonul pe anul de exercițiu', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' }); // id 1
    await seedUser({ orgId: 1, email: 'p2@x.ro' });          // id 2
    app = buildApp();
  });
  afterAll(() => pool.end());
  const p2 = () => makeAuthCookie({ userId: 2, role: 'user', orgId: 1 });
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });
  const completeOrd = (ordId, suma) => request(app)
    .post(`/api/formulare-ord/${ordId}/complete`).set('Cookie', p2())
    .send({ rows: [{ receptii: '100000000', plati_anterioare: '0', suma_ordonantata_plata: String(suma) }] });

  // ── Plafon ORD pe banda anului de exercițiu ────────────────────────────────

  it('offset 0 (an_referinta = anul curent) → plafon pe ancrt (caracterizare = FIX B)', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-O0',
      anReferinta: CUR, rowsPlati: [{ plati_estim_ancrt: '29000', plati_estim_an_np1: '999999' }] });
    const ok = await completeOrd(await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2, dfId, nrOrd: 'O0-a' }), 29000);
    expect(ok.status).toBe(200);
    const over = await completeOrd(await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2, dfId, nrOrd: 'O0-b' }), 29001);
    expect(over.status).toBe(422);
    expect(over.body.error).toBe('buget_an_curent_depasit');
    expect(Number(over.body.bugetAnCurent)).toBe(29000);
    expect(Number(over.body.anExercitiu)).toBe(CUR);
  });

  it('offset 1 (an_referinta = anul curent − 1) → plafon pe np1, NU pe ancrt', async () => {
    // ancrt mic (5000), np1 mare (29000): plafonul efectiv = np1 fiindcă exercițiul curent = ref+1.
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-O1',
      anReferinta: CUR - 1, rowsPlati: [{ plati_estim_ancrt: '5000', plati_estim_an_np1: '29000' }] });
    // 6000 > ancrt(5000) dar ≤ np1(29000) → 200 (dovedește că NU se folosește ancrt).
    const ok = await completeOrd(await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2, dfId, nrOrd: 'O1-a' }), 6000);
    expect(ok.status).toBe(200);
    // 30000 > np1(29000) → 422 cu buget = np1.
    const over = await completeOrd(await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2, dfId, nrOrd: 'O1-b' }), 30000);
    expect(over.status).toBe(422);
    expect(Number(over.body.bugetAnCurent)).toBe(29000);
  });

  it('offset -1 (an_referinta = anul curent + 1) → plafon pe ani_precedenti', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-Om1',
      anReferinta: CUR + 1, rowsPlati: [{ plati_ani_precedenti: '29000', plati_estim_ancrt: '5000' }] });
    const ok = await completeOrd(await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2, dfId, nrOrd: 'Om1-a' }), 29000);
    expect(ok.status).toBe(200);
    const over = await completeOrd(await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2, dfId, nrOrd: 'Om1-b' }), 29001);
    expect(over.status).toBe(422);
    expect(Number(over.body.bugetAnCurent)).toBe(29000);
  });

  it('legacy (an_referinta NULL) → block mono-an pe ancrt (decizia owner)', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-LEG',
      anReferinta: null, rowsPlati: [{ plati_estim_ancrt: '29000' }] });
    const over = await completeOrd(await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2, dfId, nrOrd: 'LEG-a' }), 30000);
    expect(over.status).toBe(422);
    expect(over.body.error).toBe('buget_an_curent_depasit');
    expect(Number(over.body.bugetAnCurent)).toBe(29000);
  });

  // ── Cumul PER an de exercițiu (cicluri arhivate marcate cu an_exercitiu) ─────

  it('ciclu arhivat în alt an de exercițiu NU consumă bugetul anului curent', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-CUM1',
      anReferinta: CUR, rowsPlati: [{ plati_estim_ancrt: '29000' }] });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId });
    // ciclu arhivat de 25000 dar pe anul PRECEDENT → ignorat la cumulul anului curent.
    await pool.query(
      `INSERT INTO alop_ord_cicluri (alop_id, org_id, ciclu_nr, plata_suma_efectiva, an_exercitiu, status)
       VALUES ($1, 1, 1, 25000, $2, 'completed')`, [alopId, CUR - 1]);
    // ORD nou 10000 în anul curent → cumul = 10000 (ciclul vechi nu contează) ≤ 29000 → 200.
    const ok = await completeOrd(await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2, dfId, nrOrd: 'CUM1-a' }), 10000);
    expect(ok.status).toBe(200);
  });

  it('ciclu arhivat în ACELAȘI an de exercițiu SE cumulează → 422', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-CUM2',
      anReferinta: CUR, rowsPlati: [{ plati_estim_ancrt: '29000' }] });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId });
    await pool.query(
      `INSERT INTO alop_ord_cicluri (alop_id, org_id, ciclu_nr, plata_suma_efectiva, an_exercitiu, status)
       VALUES ($1, 1, 1, 25000, $2, 'completed')`, [alopId, CUR]);
    // 25000 + 10000 = 35000 > 29000 → 422.
    const over = await completeOrd(await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2, dfId, nrOrd: 'CUM2-a' }), 10000);
    expect(over.status).toBe(422);
    expect(Number(over.body.ordonantat)).toBe(35000);
  });

  // ── noua-lichidare: ramas pe banda anului de exercițiu ──────────────────────

  it('noua-lichidare → ramas calculat pe banda anului de exercițiu (np1, nu ancrt)', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-NL1',
      anReferinta: CUR - 1, rowsPlati: [{ plati_estim_ancrt: '1000', plati_estim_an_np1: '5000' }] });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'completed', dfId,
      plataSumaEfectiva: 1000, cicluCurent: 1 });
    // Pe ancrt (1000) ramas ar fi 0 → blocaj; pe np1 (5000) ramas = 4000 → ciclu nou permis.
    const res = await request(app).post(`/api/alop/${alopId}/noua-lichidare`).set('Cookie', cookie()).send({});
    expect(res.status).toBe(200);
    expect(Number(res.body.ramas)).toBe(4000);
    expect((await getAlop(alopId)).status).toBe('lichidare');
  });

  // ── Revizie moștenește an_referinta ─────────────────────────────────────────

  it('revizia copiază an_referinta din părinte (exercițiul rămâne ancorat)', async () => {
    const flowId = await seedFlowApproved();
    const r0Id = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-REV',
      anReferinta: CUR, rowsPlati: [{ plati_estim_ancrt: '1000' }] });
    const rev = await request(app).post(`/api/formulare-df/${r0Id}/revizuieste`).set('Cookie', cookie()).send({ motiv: 'suplimentare' });
    expect(rev.status).toBe(200);
    const r1 = await getDf(rev.body.df.id);
    expect(r1.an_referinta).toBe(CUR);
  });

  it('POST /api/formulare-df fără an_referinta → default anul curent', async () => {
    const res = await request(app).post('/api/formulare-df').set('Cookie', cookie())
      .send({ nr_unic_inreg: 'DF-DEF', den_inst_pb: 'X', cif: '123' });
    expect(res.status).toBe(200);
    expect(res.body.document.an_referinta).toBe(CUR);
  });

  it('POST /api/formulare-df cu an_referinta explicit → persistat', async () => {
    const res = await request(app).post('/api/formulare-df').set('Cookie', cookie())
      .send({ nr_unic_inreg: 'DF-EXP', den_inst_pb: 'X', cif: '123', an_referinta: 2030 });
    expect(res.status).toBe(200);
    expect(res.body.document.an_referinta).toBe(2030);
  });
});
