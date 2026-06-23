/**
 * FEATURE buget multi-anual (v3.9.558) — actualizat de fix 12 (v3.9.582):
 * `an_referinta` pe DF ancorează benzile rows_plati la ani absoluți. DUPĂ fix 12 acest
 * mecanism alimentează DOAR CARDUL ALOP („buget exercițiu" = banda anului de exercițiu),
 * NU plafonul de verificare (acela e creditele bugetare col.10 — vezi
 * ord-buget-an-curent-plafon.test.mjs). Plus: an_referinta se moștenește la revizie și are
 * default anul curent la creare.
 *
 * Offset-urile se exersează relativ la anul curent (fără a atinge ceasul):
 *   an_referinta = CUR     → offset 0 → banda `plati_estim_ancrt`
 *   an_referinta = CUR − 1 → offset 1 → banda `plati_estim_an_np1`
 *   an_referinta = CUR + 1 → offset -1 → banda `plati_ani_precedenti`
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, seedAlop, seedFlowApproved,
         getDf, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());
const CUR = new Date().getFullYear();

d('Buget multi-anual — an_referinta ancorează CARDUL buget exercițiu', () => {
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

  // df_buget_an_curent expus pe cardul ALOP (detail GET).
  async function cardBuget(dfOpts) {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', ...dfOpts });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId });
    const res = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    return res.body.alop.df_buget_an_curent;
  }

  // ── Card „buget exercițiu" pe banda anului de exercițiu ──────────────────────

  it('offset 0 (an_referinta = anul curent) → card pe banda ancrt', async () => {
    const buget = await cardBuget({ nrUnic: 'DF-O0', anReferinta: CUR,
      rowsPlati: [{ plati_estim_ancrt: '29000', plati_estim_an_np1: '999999' }] });
    expect(Number(buget)).toBe(29000);
  });

  it('offset 1 (an_referinta = anul curent − 1) → card pe banda np1, NU ancrt', async () => {
    const buget = await cardBuget({ nrUnic: 'DF-O1', anReferinta: CUR - 1,
      rowsPlati: [{ plati_estim_ancrt: '5000', plati_estim_an_np1: '29000' }] });
    expect(Number(buget)).toBe(29000); // np1, nu ancrt
  });

  it('offset -1 (an_referinta = anul curent + 1) → card pe banda ani_precedenti', async () => {
    const buget = await cardBuget({ nrUnic: 'DF-Om1', anReferinta: CUR + 1,
      rowsPlati: [{ plati_ani_precedenti: '29000', plati_estim_ancrt: '5000' }] });
    expect(Number(buget)).toBe(29000);
  });

  it('legacy (an_referinta NULL) → card pe banda ancrt (coalesce la anul curent)', async () => {
    const buget = await cardBuget({ nrUnic: 'DF-LEG', anReferinta: null,
      rowsPlati: [{ plati_estim_ancrt: '29000', plati_estim_an_np1: '1' }] });
    expect(Number(buget)).toBe(29000);
  });

  it('STINGERE bifat → card pe TABEL 1 (valoarea angajamentului), NU banda rows_plati (=0)', async () => {
    // Cazul real owner: Stingere → rows_plati an curent = 0, dar cardul arată angajamentul total.
    const buget = await cardBuget({ nrUnic: 'DF-STING', ckbxSting: '1', anReferinta: null,
      rowsVal: [{ valt_actualiz: '250000' }],
      rowsPlati: [{ plati_estim_ancrt: '0' }] });
    expect(Number(buget)).toBe(250000); // tabel 1, nu 0
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
