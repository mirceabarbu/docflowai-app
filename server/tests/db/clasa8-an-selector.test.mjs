/**
 * test:db — #203: selectorul de an în Clasa 8 — `?an=` firmat din rute până în UI.
 *
 * #202 a dat bugetului dimensiunea `an`, dar rutele de raport nu trimiteau anul mai departe
 * (serviciile citeau implicit anul curent) și nu exista nicio cale de a-l alege. #203:
 *   - `GET /api/clasa8/buget/ani` — anii cu buget încărcat + `an_curent` (separat: anul curent
 *     poate lipsi din `ani` și trebuie totuși să fie selectabil);
 *   - `?an=` pe `GET /api/clasa8`, `/buget/disponibil` și `/admin/alop/stats` (raport read-only;
 *     `an` LEGAT ca parametru, nu interpolat). `an` e ecou în răspuns la /api/clasa8 și
 *     /buget/disponibil; payload-ul /admin/alop/stats rămâne NESCHIMBAT (testul lui preexistent
 *     e `toEqual` strict — un câmp nou l-ar fi picat);
 *   - `_parseAn` acceptă doar scalari (`Number([2026]) === 2026` trecea înainte).
 *
 * ⛔ Anul porților de SCRIERE (plafon ordonanțare/plată — alop.mjs, formular-shared.mjs) NU vine
 * din cerere; testul `unit/an-nu-din-cerere.test.mjs` apără decizia. Aici doar rapoarte.
 *
 * ⭐ Proprietatea de siguranță (testul 9): cu date DOAR pe anul curent, toate răspunsurile sunt
 * identice cu cele de dinainte de lot (fără `?an=` ⇒ implicit anul curent, ca în v3.9.855).
 *
 * Anii sunt calculați din ceas (Y = anul curent, Y-1), NU literali.
 * Rulează pe Postgres 17 efemer (vezi CLAUDE.md §test:db).
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedAlop, seedFlowApproved, makeAuthCookie } from '../helpers/db-real.mjs';

// Mock-uri ortogonale (NU db) — aceeași strategie ca clasa8-buget-an.test.mjs.
vi.mock('../../middleware/csrf.mjs', () => ({ csrfMiddleware: (_req, _res, next) => next() }));
vi.mock('../../middleware/require-module.mjs', () => ({
  requireModule: () => (_req, _res, next) => next(),
  default: () => (_req, _res, next) => next(),
}));
vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  redactUrl: (u) => u,
}));

const clasa8Router     = (await import('../../routes/clasa8.mjs')).default;
const adminFlowsRouter = (await import('../../routes/admin/flows.mjs')).default;
const { getClasa8Aggregate, getBugetDisponibil } = await import('../../services/clasa8.mjs');

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use('/api/clasa8', clasa8Router);
  app.use('/', adminFlowsRouter);
  return app;
}

const d = describe.skipIf(!hasTestDb());

const Y  = new Date().getFullYear();   // anul curent (implicitul rutelor)
const Y0 = Y - 1;                      // anul precedent — „vreau să mă uit la 2026 din 2027"
const SSI_A = '810101';                // comun ambilor ani, sume diferite
const SSI_B = '810102';                // doar pe Y
const SSI_C = '810103';                // doar pe Y-1

const p1     = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });
const p2     = () => makeAuthCookie({ userId: 2, role: 'user', orgId: 2 });
const admin1 = () => makeAuthCookie({ userId: 1, role: 'org_admin', orgId: 1 });
const itemFor = (result, cod) => result.items.find(x => x.cod_ssi === cod);

async function seedBuget(orgId, an, entries, versionNo = 1) {
  const total = entries.reduce((s, [, v]) => s + v, 0);
  const { rows } = await pool.query(
    `INSERT INTO clasa8_buget_versions (org_id, version_no, row_count, total_value, an)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgId, versionNo, entries.length, total, an]
  );
  for (const [cod, val] of entries) {
    await pool.query(
      `INSERT INTO clasa8_buget (version_id, org_id, cod_ssi, valoare, an) VALUES ($1,$2,$3,$4,$5)`,
      [rows[0].id, orgId, cod, val, an]
    );
  }
  return rows[0].id;
}

async function snapshotAn(orgId, an) {
  const { rows } = await pool.query(
    `SELECT cod_ssi, valoare::text AS valoare FROM clasa8_buget
      WHERE org_id = $1 AND an = $2 ORDER BY cod_ssi`,
    [orgId, an]
  );
  return rows.map(r => [r.cod_ssi, r.valoare]);
}

// Seed pe DOI ani: Y = {A:1000, B:2000}, Y-1 = {A:1500, C:7}.
async function seedDoiAni() {
  await seedBuget(1, Y,  [[SSI_A, 1000], [SSI_B, 2000]], 1);
  await seedBuget(1, Y0, [[SSI_A, 1500], [SSI_C, 7]],    2);
}

// DF aprobat cu col.10 pe SSI_A — ca `ramane_din_buget` să fie nebanal.
async function seedDfAprobat(suma) {
  const alop = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', titlu: 'Dosar A' });
  const flow = await seedFlowApproved();
  await seedDf({
    orgId: 1, createdBy: 1, status: 'aprobat', flowId: flow, nrUnic: '40339', sourceAlopId: alop,
    rowsCtrl: [{ cod_SSI: SSI_A, sum_rezv_crdt_bug_act: String(suma) }],
  });
}

// ALOP + DF legat pe un an de referință dat (pentru /admin/alop/stats).
async function seedAlopAn({ orgId, status, an, col10, platita = 0 }) {
  const dfId = await seedDf({
    orgId, createdBy: 1, status: 'aprobat',
    nrUnic: `DF-${orgId}-${status}-${an}-${Math.random().toString(36).slice(2, 6)}`,
    anReferinta: an, rowsCtrl: [{ sum_rezv_crdt_bug_act: String(col10) }],
  });
  return seedAlop({ orgId, createdBy: 1, status, dfId, sumaTotalaPlatita: platita });
}

const BAD_AN = ['abc', '1999', '2101', '2026.5', '[2026]'];

d('#203 — selector de an în Clasa 8: ?an= firmat din rute', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user' });                          // org 1, user 1
    await seedOrgUser({ role: 'user', orgName: 'Org 2', email: 'p2@x.ro' }); // org 2, user 2
    app = buildApp();
  });
  afterAll(() => pool.end());

  // ── 1. implicit = anul curent, identic cu v3.9.855 ────────────────────────────
  it('1. GET /api/clasa8 fără ?an= ⇒ totalurile anului curent (identic cu v3.9.855) + `an` în răspuns', async () => {
    await seedDoiAni();
    await seedDfAprobat(300);

    const res = await request(app).get('/api/clasa8').set('Cookie', p1());
    expect(res.status).toBe(200);
    expect(res.body.an).toBe(Y);
    expect(res.body.totals.buget).toBe(3000);                 // NU 4507 (ambii ani), NU 1507
    expect(res.body.totals.ramane_din_buget).toBe(2700);
    expect(itemFor(res.body, SSI_A)).toMatchObject({ buget: 1000, angajamente: 300, ramane_din_buget: 700 });
    expect(itemFor(res.body, SSI_B)).toMatchObject({ buget: 2000 });
    expect(itemFor(res.body, SSI_C)).toBeUndefined();          // codul doar-pe-Y-1 nu apare

    // paritate cu serviciul apelat direct fără an (referința pre-lot)
    const ref = await getClasa8Aggregate(pool, 1, {});
    expect(res.body.totals).toEqual(ref.totals);
    expect(res.body.items).toEqual(ref.items);
  });

  // ── 2. ?an=Y-1 ⇒ totalurile lui Y-1, diferite de 1 ────────────────────────────
  it('2. GET /api/clasa8?an=Y-1 ⇒ totalurile lui Y-1, DIFERITE de implicit', async () => {
    await seedDoiAni();
    await seedDfAprobat(300);

    const res = await request(app).get(`/api/clasa8?an=${Y0}`).set('Cookie', p1());
    expect(res.status).toBe(200);
    expect(res.body.an).toBe(Y0);
    expect(res.body.totals.buget).toBe(1507);
    expect(itemFor(res.body, SSI_A)).toMatchObject({ buget: 1500, angajamente: 300, ramane_din_buget: 1200 });
    expect(itemFor(res.body, SSI_C)).toMatchObject({ buget: 7 });
    expect(itemFor(res.body, SSI_B)).toBeUndefined();          // codul doar-pe-Y nu apare

    // și cu filtrele existente active — anul rămâne ULTIMUL parametru
    const resF = await request(app).get(`/api/clasa8?an=${Y0}&ssi=8101&q=x&compartiment=C`).set('Cookie', p1());
    expect(resF.status).toBe(200);
    expect(resF.body.totals.buget).toBe(1507);
  });

  // ── 3. an invalid ⇒ 400 pe toate rutele de raport ─────────────────────────────
  it.each(BAD_AN)('3. ?an=%s ⇒ 400 an_invalid pe /api/clasa8, /buget/disponibil și /admin/alop/stats', async (bad) => {
    await seedDoiAni();
    const q = '?an=' + encodeURIComponent(bad);
    for (const [path, cookie] of [
      ['/api/clasa8' + q,                  p1()],
      ['/api/clasa8/buget/disponibil' + q, p1()],
      ['/admin/alop/stats' + q,            admin1()],
    ]) {
      const r = await request(app).get(path).set('Cookie', cookie);
      expect(r.status, path).toBe(400);
      expect(r.body.error, path).toBe('an_invalid');
    }
  });

  it('3b. _parseAn strâns: `an` array în corpul importului ⇒ 400 (Number([Y]) === Y trecea înainte); ?an=Y&an=Y ⇒ 400', async () => {
    const before = await snapshotAn(1, Y);
    const r = await request(app).post('/api/clasa8/buget/import').set('Cookie', p1())
      .send({ an: [Y], rows: [{ cod_ssi: SSI_A, valoare: 5 }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('an_invalid');
    expect(await snapshotAn(1, Y)).toEqual(before);            // zero scrieri

    // `?an=` duplicat ⇒ Express dă array ⇒ 400 (nu primul/ultimul element)
    const r2 = await request(app).get(`/api/clasa8?an=${Y}&an=${Y0}`).set('Cookie', p1());
    expect(r2.status).toBe(400);
    expect(r2.body.error).toBe('an_invalid');
  });

  // ── 4. /buget/ani ─────────────────────────────────────────────────────────────
  it('4. GET /buget/ani ⇒ anii cu buget, descrescător, plus an_curent', async () => {
    await seedDoiAni();
    const res = await request(app).get('/api/clasa8/buget/ani').set('Cookie', p1());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ani: [Y, Y0], an_curent: Y });

    // un an cu versiune dar FĂRĂ rânduri (buget șters) nu apare — selectorul citește ce EXISTĂ
    await pool.query('DELETE FROM clasa8_buget WHERE org_id = 1 AND an = $1', [Y0]);
    const res2 = await request(app).get('/api/clasa8/buget/ani').set('Cookie', p1());
    expect(res2.body.ani).toEqual([Y]);
  });

  it('5. GET /buget/ani pe un org FĂRĂ buget ⇒ ani: [] dar an_curent prezent; izolare tenant', async () => {
    await seedDoiAni(); // doar org 1
    const res = await request(app).get('/api/clasa8/buget/ani').set('Cookie', p2());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ani: [], an_curent: Y });
  });

  // ── 6. /buget/disponibil?an= ─────────────────────────────────────────────────
  it('6. /buget/disponibil?an=Y-1 ⇒ plafonul lui Y-1; fără ?an= ⇒ al anului curent', async () => {
    await seedDoiAni();
    await seedDfAprobat(300);

    const r0 = await request(app).get('/api/clasa8/buget/disponibil').set('Cookie', p1());
    expect(r0.status).toBe(200);
    expect(r0.body.an).toBe(Y);
    expect(itemFor(r0.body, SSI_A)).toMatchObject({ buget: 1000, angajat_aprobat: 300, disponibil: 700 });
    expect(itemFor(r0.body, SSI_C)).toBeUndefined();

    const r1 = await request(app).get(`/api/clasa8/buget/disponibil?an=${Y0}`).set('Cookie', p1());
    expect(r1.status).toBe(200);
    expect(r1.body.an).toBe(Y0);
    expect(itemFor(r1.body, SSI_A)).toMatchObject({ buget: 1500, angajat_aprobat: 300, disponibil: 1200 });
    expect(itemFor(r1.body, SSI_C)).toMatchObject({ buget: 7, disponibil: 7 });
    expect(itemFor(r1.body, SSI_B)).toBeUndefined();

    // paritate cu serviciul
    const ref = await getBugetDisponibil(pool, 1, null, Y0);
    expect(r1.body.items).toEqual(ref.items);
  });

  // ── 7. ⭐ DELETE pe Y lasă Y-1 intact ────────────────────────────────────────
  it('7. ⭐ DELETE /buget?an=Y lasă Y-1 INTACT (număr și sume); selectorul îl mai vede doar pe Y-1', async () => {
    await seedDoiAni();
    const before0 = await snapshotAn(1, Y0);
    expect(before0).toHaveLength(2);

    const res = await request(app).delete(`/api/clasa8/buget?an=${Y}`).set('Cookie', p1());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 2, an: Y });

    expect(await snapshotAn(1, Y)).toEqual([]);
    expect(await snapshotAn(1, Y0)).toEqual(before0);          // exact ce era

    const ani = await request(app).get('/api/clasa8/buget/ani').set('Cookie', p1());
    expect(ani.body).toEqual({ ani: [Y0], an_curent: Y });      // Y lipsește din `ani`, dar an_curent rămâne

    // raportul pe Y-1 e neschimbat după ștergerea lui Y
    const agg0 = await request(app).get(`/api/clasa8?an=${Y0}`).set('Cookie', p1());
    expect(agg0.body.totals.buget).toBe(1507);
    // raportul pe Y (implicit) rămâne funcțional, cu coloana BUGET goală
    const agg = await request(app).get('/api/clasa8').set('Cookie', p1());
    expect(agg.status).toBe(200);
    expect(agg.body.totals.buget).toBe(0);
  });

  // ── 8. /admin/alop/stats?an= ─────────────────────────────────────────────────
  it('8. /admin/alop/stats?an=Y-1 ⇒ cifre DIFERITE de implicit (an LEGAT ca parametru); implicit = anul curent', async () => {
    // Y: angajat 10000 (activ) + 5000 (completed); Y-1: angajat 7000 (completed)
    await seedAlopAn({ orgId: 1, status: 'angajare',  an: Y,  col10: 10000, platita: 2000 });
    await seedAlopAn({ orgId: 1, status: 'completed', an: Y,  col10: 5000,  platita: 1500 });
    await seedAlopAn({ orgId: 1, status: 'completed', an: Y0, col10: 7000,  platita: 999 });
    // zgomot în org 2 — org_admin al org 1 nu-l vede (parametrul de org rămâne $1, anul e $2)
    await seedAlopAn({ orgId: 2, status: 'completed', an: Y0, col10: 99999, platita: 99999 });

    const r0 = await request(app).get('/admin/alop/stats').set('Cookie', admin1());
    expect(r0.status).toBe(200);
    expect(r0.body).toMatchObject({ alop_active: 1, alop_finalizate_an: 1,
                                    valoare_angajata_an: 15000, valoare_platita_an: 3500 });

    const r1 = await request(app).get(`/admin/alop/stats?an=${Y0}`).set('Cookie', admin1());
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ alop_active: 1, alop_finalizate_an: 1,
                                    valoare_angajata_an: 7000, valoare_platita_an: 999 });

    // super-admin (fără filtru de org ⇒ params=[] ⇒ anul e $1): indicele legat corect
    const rAdm = await request(app).get(`/admin/alop/stats?an=${Y0}`)
      .set('Cookie', makeAuthCookie({ userId: 1, role: 'admin', orgId: null }));
    expect(rAdm.status).toBe(200);
    expect(rAdm.body).toMatchObject({ valoare_angajata_an: 106999, valoare_platita_an: 100998 });

    // ?an=abc ⇒ 400 (acoperit și de 3, dar explicit aici pentru ruta admin)
    const rBad = await request(app).get('/admin/alop/stats?an=abc').set('Cookie', admin1());
    expect(rBad.status).toBe(400);
    expect(rBad.body.error).toBe('an_invalid');
  });

  // ── 9. ⭐ NEREGRESIE ─────────────────────────────────────────────────────────
  it('9. ⭐ cu date DOAR pe anul curent, toate răspunsurile sunt identice cu cele de dinainte de lot', async () => {
    await seedBuget(1, Y, [[SSI_A, 1000], [SSI_B, 2000]]);
    await seedDfAprobat(300);
    await seedAlopAn({ orgId: 1, status: 'completed', an: Y, col10: 5000, platita: 1500 });

    // Referința PRE-LOT pentru buget: CTE-ul `buget` fără an (identic cu #202 testul 7)
    const { rows: ref } = await pool.query(
      `SELECT cod_ssi, valoare FROM clasa8_buget WHERE org_id = $1 ORDER BY cod_ssi`, [1]);
    const refBuget = ref.reduce((s, r) => s + Number(r.valoare), 0);
    expect(refBuget).toBe(3000);

    // /api/clasa8 fără ?an= ≡ serviciul fără an ≡ pre-lot
    const agg = await request(app).get('/api/clasa8').set('Cookie', p1());
    const aggRef = await getClasa8Aggregate(pool, 1, {});
    expect(agg.body.totals).toEqual(aggRef.totals);
    expect(agg.body.totals).toMatchObject({ buget: 3000, angajamente: 300, ramane_din_buget: 2700 });
    expect(agg.body.items).toEqual(aggRef.items);
    // răspunsul e cel vechi + `an` (singura cheie nouă)
    expect(Object.keys(agg.body).sort()).toEqual(['an', 'count', 'filters_applied', 'items', 'totals']);

    // /buget/disponibil fără ?an= ≡ serviciul fără an
    const disp = await request(app).get('/api/clasa8/buget/disponibil').set('Cookie', p1());
    const dispRef = await getBugetDisponibil(pool, 1, null);
    expect(disp.body.items).toEqual(dispRef.items);
    expect(itemFor(disp.body, SSI_A)).toMatchObject({ buget: 1000, angajat_aprobat: 300, disponibil: 700 });

    // /admin/alop/stats fără ?an= ≡ expresia PRE-LOT (EXTRACT(YEAR FROM NOW()) interpolată), rulată live
    const stats = await request(app).get('/admin/alop/stats').set('Cookie', admin1());
    const { rows: preLot } = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE a.status='completed'
               AND COALESCE(df.an_referinta, EXTRACT(YEAR FROM NOW())::int) = EXTRACT(YEAR FROM NOW())::int)::int AS fin,
             COALESCE(SUM((SELECT COALESCE(SUM((r->>'sum_rezv_crdt_bug_act')::numeric),0)
                FROM jsonb_array_elements(COALESCE(df.rows_ctrl,'[]'::jsonb)) r
                WHERE (r->>'sum_rezv_crdt_bug_act') ~ '^[0-9.]+$'))
               FILTER (WHERE COALESCE(df.an_referinta, EXTRACT(YEAR FROM NOW())::int) = EXTRACT(YEAR FROM NOW())::int), 0)::float8 AS ang
        FROM alop_instances a LEFT JOIN formulare_df df ON df.id = a.df_id
       WHERE a.cancelled_at IS NULL AND a.org_id = 1`);
    expect(stats.body.alop_finalizate_an).toBe(preLot[0].fin);
    expect(stats.body.valoare_angajata_an).toBe(Number(preLot[0].ang));
    expect(stats.body.valoare_angajata_an).toBe(5000);

    // meta / coduri / ani — implicit anul curent
    const meta = await request(app).get('/api/clasa8/buget/meta').set('Cookie', p1());
    expect(meta.body.an).toBe(Y);
    expect(meta.body.active).toMatchObject({ version_no: 1, row_count: 2, total_value: '3000.00' });
    const ani = await request(app).get('/api/clasa8/buget/ani').set('Cookie', p1());
    expect(ani.body).toEqual({ ani: [Y], an_curent: Y });
  });
});
