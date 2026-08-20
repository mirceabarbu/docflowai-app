/**
 * #134b — plafonul ORD numără ciclurile arhivate prin DOSARUL ALOP, nu prin pointerul mobil.
 *
 * BUG (tăcut, aceeași clasă cu #115): subinterogarea din `computeOrdBudgetContext` corela
 * ciclurile arhivate cu `a.df_id = df.id`, unde `df` = revizia ÎNGHEȚATĂ a ORD-ului
 * (`ord.df_id`) iar `a.df_id` = pointerul MOBIL al dosarului ALOP. La prima revizie DF cei
 * doi diverg ⇒ JOIN-ul nu potrivea niciun ALOP ⇒ `cicluriArhivate = 0` ⇒ plafonul 422 ignora
 * TOT ce s-a ordonanțat deja în anul de exercițiu.
 *
 * FIX: dosarul ALOP se rezolvă EXPLICIT (`resolveAlopIdForBudget`), în ordinea încrederii:
 * (1) prin ORD (alop_instances.ord_id, apoi alop_ord_cicluri.ord_id), (2) prin
 * `formulare_df.source_alop_id`, (3) fallback pe pointer (documente vechi).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, seedOrd, seedAlop, getOrd, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';
import { computeOrdBudgetContext, resolveAlopIdForBudget } from '../../services/formular-shared.mjs';
import { logger } from '../../middleware/logger.mjs';

const d = describe.skipIf(!hasTestDb());
const CUR = new Date().getFullYear();

d('#134b — cicluri arhivate corelate prin dosarul ALOP', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' });   // id 1, org 1
    await seedUser({ orgId: 1, email: 'p2@x.ro' });          // id 2, org 1
    app = buildApp();
    vi.clearAllMocks();
  });
  afterAll(() => pool.end());
  const p2 = () => makeAuthCookie({ userId: 2, role: 'user', orgId: 1 });

  /**
   * Fixture canonic: DF R0 (col.10 = 50.000) + R1 (revizia), un ALOP cu un ciclu ARHIVAT
   * ordonanțat de 10.000 în anul curent, plus un ORD „curent" legat de R0.
   * Pointerul `alop.df_id` pleacă pe R0 (intact) — testele îl mută explicit.
   */
  async function fixture({ withSourceAlop = true, anCiclu = CUR, orgAlop = 1 } = {}) {
    const alopId = await seedAlop({ orgId: orgAlop, createdBy: 1, status: 'ordonantare' });
    const dfR0 = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-134B',
      revizieNr: 0, rowsCtrl: [{ sum_rezv_crdt_bug_act: '50000' }],
      rowsPlati: [{ plati_estim_ancrt: '0' }], rowsVal: [{ valt_actualiz: '9000000' }],
      sourceAlopId: withSourceAlop ? alopId : null });
    const dfR1 = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-134B',
      revizieNr: 1, parentDfId: dfR0, rowsCtrl: [{ sum_rezv_crdt_bug_act: '50000' }],
      sourceAlopId: withSourceAlop ? alopId : null });
    // Ciclu ARHIVAT: ORD propriu cu 10.000 ordonanțați, legat de R0.
    const ordArhivat = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', dfId: dfR0,
      nrOrd: 'ORD-134B-C1', rows: [{ suma_ordonantata_plata: '10000' }] });
    await pool.query(
      `INSERT INTO alop_ord_cicluri (alop_id, org_id, ciclu_nr, ord_id, an_exercitiu, status)
       VALUES ($1, $2, 1, $3, $4, 'completed')`, [alopId, orgAlop, ordArhivat, anCiclu]);
    // ORD „curent" (ciclul 2), pe care se face verificarea de plafon.
    const ordCurent = await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2,
      dfId: dfR0, nrOrd: 'ORD-134B-C2' });
    await pool.query(`UPDATE alop_instances SET df_id=$1, ord_id=$2 WHERE id=$3`,
      [dfR0, ordCurent, alopId]);
    return { alopId, dfR0, dfR1, ordArhivat, ordCurent };
  }

  const mutaPointerul = (alopId, dfR1) =>
    pool.query(`UPDATE alop_instances SET df_id=$1 WHERE id=$2`, [dfR1, alopId]);

  // ── C0 — non-regresie: pointer intact, fără ordId ⇒ ciclul se numără (comportamentul de azi)
  it('C0 — pointer intact, fără ordId ⇒ cicluriArhivate = 10.000', async () => {
    const { dfR0 } = await fixture();
    const ctx = await computeOrdBudgetContext({ dfId: dfR0, orgId: 1 });
    expect(ctx.bugetAnCurent).toBe(50000);
    expect(ctx.cicluriArhivate).toBe(10000);
  });

  // ── C1 — BUG-UL: pointerul mutat de o revizie DF. Cu `ordId`, pasul 1 rezolvă dosarul.
  it('C1 — pointer mutat pe R1 + ordId ⇒ cicluriArhivate rămâne 10.000 (pasul 1)', async () => {
    const { dfR0, dfR1, alopId, ordCurent } = await fixture();
    await mutaPointerul(alopId, dfR1);
    const ctx = await computeOrdBudgetContext({ dfId: dfR0, orgId: 1, ordId: ordCurent });
    expect(ctx.cicluriArhivate).toBe(10000);
  });

  // ── C2 — fără ordId, dar DF-ul are proveniență (`source_alop_id`) ⇒ pasul 2
  it('C2 — pointer mutat, fără ordId, DF cu source_alop_id ⇒ 10.000 (pasul 2)', async () => {
    const { dfR0, dfR1, alopId } = await fixture({ withSourceAlop: true });
    await mutaPointerul(alopId, dfR1);
    const ctx = await computeOrdBudgetContext({ dfId: dfR0, orgId: 1 });
    expect(ctx.cicluriArhivate).toBe(10000);
  });

  // ── C3 — limita DOCUMENTATĂ: fără ordId și fără proveniență ⇒ 0, dar logat (nu ascuns)
  it('C3 — pointer mutat, fără ordId și fără source_alop_id ⇒ 0 + logger.warn', async () => {
    const { dfR0, dfR1, alopId } = await fixture({ withSourceAlop: false });
    await mutaPointerul(alopId, dfR1);
    const ctx = await computeOrdBudgetContext({ dfId: dfR0, orgId: 1 });
    expect(ctx.cicluriArhivate).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ dfId: dfR0 }),
      expect.stringContaining('dosar ALOP nerezolvat')
    );
  });

  // ── C4 ⭐ — garda hard 422 end-to-end, cu pointerul mutat. Cazul care contează.
  it('C4 — pointer mutat: ORD care depășește 50.000 − 10.000 e respins cu 422', async () => {
    const { dfR1, alopId, ordCurent } = await fixture();
    await mutaPointerul(alopId, dfR1);
    // col.5 = 100000 − 0 − 45000 ≥ 0 (trece), dar 45000 + 10000 > 50000 col.10.
    const rows = [{ receptii: '100000', plati_anterioare: '0', suma_ordonantata_plata: '45000' }];
    const res = await request(app).post(`/api/formulare-ord/${ordCurent}/complete`)
      .set('Cookie', p2()).send({ rows });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('buget_an_curent_depasit');
    expect(Number(res.body.ordonantat)).toBe(55000);
    expect(Number(res.body.bugetAnCurent)).toBe(50000);
    expect((await getOrd(ordCurent)).status).toBe('pending_p2'); // neschimbat
  });

  it('C4b — sub plafon (39.000 + 10.000 ≤ 50.000) ⇒ 200, cu pointerul tot mutat', async () => {
    const { dfR1, alopId, ordCurent } = await fixture();
    await mutaPointerul(alopId, dfR1);
    const rows = [{ receptii: '100000', plati_anterioare: '0', suma_ordonantata_plata: '39000' }];
    const res = await request(app).post(`/api/formulare-ord/${ordCurent}/complete`)
      .set('Cookie', p2()).send({ rows });
    expect(res.status).toBe(200);
    expect((await getOrd(ordCurent)).status).toBe('completed');
  });

  // ── C5 — izolare pe an de exercițiu
  it('C5 — ciclu din anul trecut NU intră în cicluriArhivate', async () => {
    const { dfR0, dfR1, alopId, ordCurent } = await fixture({ anCiclu: CUR - 1 });
    await mutaPointerul(alopId, dfR1);
    const ctx = await computeOrdBudgetContext({ dfId: dfR0, orgId: 1, ordId: ordCurent });
    expect(ctx.cicluriArhivate).toBe(0);
  });

  // ── C6 — izolare pe org
  it('C6 — un ALOP din alt org nu e rezolvat de niciun pas', async () => {
    await pool.query(`INSERT INTO organizations (name) VALUES ('Org 2')`);
    const { dfR0, ordCurent } = await fixture({ orgAlop: 2 });
    expect(await resolveAlopIdForBudget({ ordId: ordCurent, dfId: dfR0, orgId: 1 })).toBe(null);
    const ctx = await computeOrdBudgetContext({ dfId: dfR0, orgId: 1, ordId: ordCurent });
    expect(ctx.cicluriArhivate).toBe(0);
  });

  // ── C7 — dosar anulat
  it('C7 — ALOP cu cancelled_at nu e rezolvat de niciun pas', async () => {
    const { dfR0, alopId, ordCurent } = await fixture();
    await pool.query(`UPDATE alop_instances SET cancelled_at = NOW() WHERE id=$1`, [alopId]);
    expect(await resolveAlopIdForBudget({ ordId: ordCurent, dfId: dfR0, orgId: 1 })).toBe(null);
    const ctx = await computeOrdBudgetContext({ dfId: dfR0, orgId: 1, ordId: ordCurent });
    expect(ctx.cicluriArhivate).toBe(0);
  });

  // ── C8 — a doua ramură a pasului 1: ORD-ul e ciclu ARHIVAT, nu ciclul curent
  it('C8 — ordId găsit prin alop_ord_cicluri (nu prin alop_instances.ord_id)', async () => {
    const { dfR0, dfR1, alopId, ordArhivat } = await fixture();
    await mutaPointerul(alopId, dfR1);
    await pool.query(`UPDATE alop_instances SET ord_id = NULL WHERE id=$1`, [alopId]);
    expect(await resolveAlopIdForBudget({ ordId: ordArhivat, dfId: dfR0, orgId: 1 })).toBe(alopId);
    const ctx = await computeOrdBudgetContext({ dfId: dfR0, orgId: 1, ordId: ordArhivat });
    expect(ctx.cicluriArhivate).toBe(10000);
  });

  // ── C9 — paritate: atenționarea inline (GET detaliu) nu contrazice garda hard
  it('C9 — GET /api/formulare-ord/:id întoarce același cicluri_arhivate ca garda hard', async () => {
    const { dfR0, dfR1, alopId, ordCurent } = await fixture();
    await mutaPointerul(alopId, dfR1);
    const res = await request(app).get(`/api/formulare-ord/${ordCurent}`).set('Cookie', p2());
    expect(res.status).toBe(200);
    const ctx = await computeOrdBudgetContext({ dfId: dfR0, orgId: 1, ordId: ordCurent });
    expect(Number(res.body.document.cicluri_arhivate)).toBe(ctx.cicluriArhivate);
    expect(Number(res.body.document.cicluri_arhivate)).toBe(10000);
    expect(Number(res.body.document.buget_an_curent)).toBe(50000);
  });
});
