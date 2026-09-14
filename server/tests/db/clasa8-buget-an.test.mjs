/**
 * test:db — #202: bugetul Clasa 8 capătă dimensiunea AN — importul pe anul următor
 * NU mai șterge bugetul anului curent.
 *
 * Până la #202, UNIQUE (org_id, cod_ssi) forța `POST /api/clasa8/buget/import` să facă
 * `DELETE FROM clasa8_buget WHERE org_id` — încărcarea bugetului pe anul următor ștergea
 * definitiv valorile per cod SSI ale anului curent (versiunile păstrau doar metadata).
 *
 * Migrarea 111 adaugă `an`, îl backfillează din anul încărcării versiunii și schimbă cheia în
 * (org_id, an, cod_ssi). Importul, DELETE /buget, meta și coduri sunt scopate pe an; serviciile
 * de raport citesc implicit anul curent.
 *
 * ⭐ Proprietatea de siguranță a lotului: cu un singur an în bază (cazul real după backfill),
 * NICIO cifră nu se schimbă — testul 7 o ancorează, comparând cu CTE-ul `buget` de dinainte
 * de lot (`WHERE org_id` fără an), rulat live pe aceeași bază.
 *
 * Anii sunt calculați din ceas (Y = anul curent, Y+1), NU literali — un 2026 hardcodat ar face
 * suita să pice singură pe 1 ianuarie (serviciile citesc implicit anul curent).
 *
 * Rulează pe Postgres 17 efemer (vezi CLAUDE.md §test:db).
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedAlop, seedFlowApproved, makeAuthCookie } from '../helpers/db-real.mjs';

// Mock-uri ortogonale (NU db) — aceeași strategie ca admin-cancel-flow.test.mjs.
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

const clasa8Router = (await import('../../routes/clasa8.mjs')).default;
const { getClasa8Aggregate, getBugetDisponibil } = await import('../../services/clasa8.mjs');

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use('/api/clasa8', clasa8Router);
  return app;
}

const d = describe.skipIf(!hasTestDb());

const Y  = new Date().getFullYear();   // anul curent (implicitul serviciilor/rutelor)
const Y1 = Y + 1;                      // „bugetul pe anul următor"
const SSI_A = '810101';
const SSI_B = '810102';

const p1 = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });
const itemFor = (result, cod) => result.items.find(x => x.cod_ssi === cod);

// Seed direct în DB (echivalentul unui import deja făcut pe anul `an`).
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

// Fotografie a rândurilor unui an: [cod, valoare] sortate — pentru „intact" (număr + sume identice).
async function snapshotAn(orgId, an) {
  const { rows } = await pool.query(
    `SELECT cod_ssi, valoare::text AS valoare FROM clasa8_buget
      WHERE org_id = $1 AND an = $2 ORDER BY cod_ssi`,
    [orgId, an]
  );
  return rows.map(r => [r.cod_ssi, r.valoare]);
}

async function countAll() {
  const { rows } = await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM clasa8_buget) AS buget,
            (SELECT COUNT(*)::int FROM clasa8_buget_versions) AS versions`
  );
  return rows[0];
}

// DF aprobat cu col.10 pe SSI_A — ca `ramane_din_buget` să fie nebanal în testul 7.
async function seedDfAprobat(suma) {
  const alop = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', titlu: 'Dosar A' });
  const flow = await seedFlowApproved();
  await seedDf({
    orgId: 1, createdBy: 1, status: 'aprobat', flowId: flow, nrUnic: '40339', sourceAlopId: alop,
    rowsCtrl: [{ cod_SSI: SSI_A, sum_rezv_crdt_bug_act: String(suma) }],
  });
}

d('#202 — bugetul Clasa 8 are dimensiunea AN', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll(); // organizations CASCADE ⇒ clasa8_buget{,_versions} golite
    await seedOrgUser({ role: 'user' }); // org 1, user 1
    app = buildApp();
  });
  afterAll(() => pool.end());

  // ── 1. schema după migrare ──────────────────────────────────────────────────────
  it('1. coloana `an` există pe ambele tabele, e NOT NULL, și nu există rânduri cu an IS NULL', async () => {
    const { rows } = await pool.query(
      `SELECT table_name, is_nullable, data_type FROM information_schema.columns
        WHERE table_schema='public' AND column_name='an'
          AND table_name IN ('clasa8_buget','clasa8_buget_versions')
        ORDER BY table_name`
    );
    expect(rows).toEqual([
      { table_name: 'clasa8_buget',          is_nullable: 'NO', data_type: 'integer' },
      { table_name: 'clasa8_buget_versions', is_nullable: 'NO', data_type: 'integer' },
    ]);
    const { rows: nulls } = await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM clasa8_buget WHERE an IS NULL) AS b,
              (SELECT COUNT(*)::int FROM clasa8_buget_versions WHERE an IS NULL) AS v`
    );
    expect(nulls[0]).toEqual({ b: 0, v: 0 });
  });

  // ── 2. exact o constrângere de unicitate, cea nouă ─────────────────────────────
  it('2. UNIQUE pe clasa8_buget: exact `clasa8_buget_org_an_cod_uniq` (org_id, an, cod_ssi); cea veche a dispărut', async () => {
    const { rows } = await pool.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'clasa8_buget'::regclass AND contype = 'u' ORDER BY conname`
    );
    expect(rows).toEqual([
      { conname: 'clasa8_buget_org_an_cod_uniq', def: 'UNIQUE (org_id, an, cod_ssi)' },
    ]);
    // ⛔ UNIQUE (org_id, version_no) de pe versions rămâne NEATINS
    const { rows: v } = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'clasa8_buget_versions'::regclass AND contype = 'u'`
    );
    expect(v.map(x => x.def)).toEqual(['UNIQUE (org_id, version_no)']);
  });

  // ── 3. același cod, același org, doi ani ⇒ ambele inserări reușesc ────────────
  it('3. același cod_ssi + același org pe doi ani diferiți ⇒ ambele rânduri există', async () => {
    await seedBuget(1, Y,  [[SSI_A, 1000]], 1);
    await seedBuget(1, Y1, [[SSI_A, 1500]], 2);
    expect(await snapshotAn(1, Y)).toEqual([[SSI_A, '1000.00']]);
    expect(await snapshotAn(1, Y1)).toEqual([[SSI_A, '1500.00']]);
    // iar în ACELAȘI an cheia rămâne unică
    await expect(pool.query(
      `INSERT INTO clasa8_buget (version_id, org_id, cod_ssi, valoare, an)
       SELECT id, 1, $1, 1, $2 FROM clasa8_buget_versions WHERE an = $2`,
      [SSI_A, Y]
    )).rejects.toMatchObject({ code: '23505' });
  });

  // ── 4. ⭐ CAZUL CENTRAL ──────────────────────────────────────────────────────────
  it('4. ⭐ import prin rută pe Y+1 lasă bugetul pe Y INTACT (număr + sume identice) și creează Y+1', async () => {
    await seedBuget(1, Y, [[SSI_A, 1000], [SSI_B, 2000]]);
    const before = await snapshotAn(1, Y);
    expect(before).toHaveLength(2);

    const res = await request(app)
      .post('/api/clasa8/buget/import')
      .set('Cookie', p1())
      .send({ an: Y1, filename: `buget-${Y1}.xlsx`,
              rows: [{ cod_ssi: SSI_A, valoare: 1100 }, { cod_ssi: SSI_B, valoare: 2200 }, { cod_ssi: '810103', valoare: 5 }] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, an: Y1, version_no: 2, count: 3, total: 3305 });

    // Y: exact ce era înainte — ăsta e bugul reparat
    expect(await snapshotAn(1, Y)).toEqual(before);
    // Y+1: există, cu valorile noi
    expect(await snapshotAn(1, Y1)).toEqual([[SSI_A, '1100.00'], [SSI_B, '2200.00'], ['810103', '5.00']]);

    // versiunea nouă poartă anul; version_no rămâne secvență globală per org (2, nu 1)
    const { rows: v } = await pool.query(
      `SELECT version_no, an, row_count FROM clasa8_buget_versions WHERE org_id=1 ORDER BY version_no`);
    expect(v).toEqual([{ version_no: 1, an: Y, row_count: 2 }, { version_no: 2, an: Y1, row_count: 3 }]);
  });

  it('4b. re-import pe ACELAȘI an înlocuiește doar acel an (comportamentul vechi, scopat)', async () => {
    await seedBuget(1, Y,  [[SSI_A, 1000], [SSI_B, 2000]], 1);
    await seedBuget(1, Y1, [[SSI_A, 1500]], 2);
    const before1 = await snapshotAn(1, Y1);

    const res = await request(app)
      .post('/api/clasa8/buget/import')
      .set('Cookie', p1())
      .send({ an: Y, rows: [{ cod_ssi: SSI_A, valoare: 999 }] });
    expect(res.status).toBe(200);

    expect(await snapshotAn(1, Y)).toEqual([[SSI_A, '999.00']]); // SSI_B pe Y a fost înlocuit (ca înainte)
    expect(await snapshotAn(1, Y1)).toEqual(before1);            // Y+1 neatins
  });

  it('4c. import fără `an` ⇒ implicit anul curent', async () => {
    const res = await request(app)
      .post('/api/clasa8/buget/import')
      .set('Cookie', p1())
      .send({ rows: [{ cod_ssi: SSI_A, valoare: 10 }] });
    expect(res.status).toBe(200);
    expect(res.body.an).toBe(Y);
    expect(await snapshotAn(1, Y)).toEqual([[SSI_A, '10.00']]);
  });

  // ── 5. DELETE scopat pe an ─────────────────────────────────────────────────────
  it('5. DELETE /api/clasa8/buget?an=Y+1 șterge doar Y+1; Y rămâne intact', async () => {
    await seedBuget(1, Y,  [[SSI_A, 1000], [SSI_B, 2000]], 1);
    await seedBuget(1, Y1, [[SSI_A, 1500]], 2);
    const before = await snapshotAn(1, Y);

    const res = await request(app).delete(`/api/clasa8/buget?an=${Y1}`).set('Cookie', p1());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 1, an: Y1 });

    expect(await snapshotAn(1, Y)).toEqual(before);
    expect(await snapshotAn(1, Y1)).toEqual([]);
    // metadatele versiunilor rămân în istoric (ambele)
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM clasa8_buget_versions WHERE org_id=1`);
    expect(rows[0].n).toBe(2);
  });

  it('5b. DELETE fără `an` ⇒ implicit anul curent; Y+1 rămâne', async () => {
    await seedBuget(1, Y,  [[SSI_A, 1000]], 1);
    await seedBuget(1, Y1, [[SSI_A, 1500]], 2);
    const res = await request(app).delete('/api/clasa8/buget').set('Cookie', p1());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 1, an: Y });
    expect(await snapshotAn(1, Y)).toEqual([]);
    expect(await snapshotAn(1, Y1)).toEqual([[SSI_A, '1500.00']]);
  });

  // ── 6. an invalid ⇒ 400, zero scrieri ─────────────────────────────────────────
  it.each(['abc', 1999, 2101, 2026.5, '20x6'])('6. import cu an=%s ⇒ 400 an_invalid, zero scrieri', async (bad) => {
    await seedBuget(1, Y, [[SSI_A, 1000]]);
    const before = await countAll();

    const res = await request(app)
      .post('/api/clasa8/buget/import')
      .set('Cookie', p1())
      .send({ an: bad, rows: [{ cod_ssi: SSI_A, valoare: 5 }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('an_invalid');
    expect(await countAll()).toEqual(before);
    expect(await snapshotAn(1, Y)).toEqual([[SSI_A, '1000.00']]);
  });

  it('6b. DELETE / meta / coduri cu ?an= invalid ⇒ 400 an_invalid, zero scrieri', async () => {
    await seedBuget(1, Y, [[SSI_A, 1000]]);
    const before = await countAll();
    for (const path of ['/api/clasa8/buget?an=abc', '/api/clasa8/buget?an=1999']) {
      const r = await request(app).delete(path).set('Cookie', p1());
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('an_invalid');
    }
    for (const path of ['/api/clasa8/buget/meta?an=2101', '/api/clasa8/buget/coduri?an=2026.5']) {
      const r = await request(app).get(path).set('Cookie', p1());
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('an_invalid');
    }
    expect(await countAll()).toEqual(before);
  });

  // ── 7. ⭐ NEREGRESIE — proprietatea de siguranță a lotului ───────────────────────
  it('7. ⭐ cu date DOAR pe anul curent, agregatul întoarce EXACT totalurile de dinainte de lot (buget, ramane_din_buget)', async () => {
    await seedBuget(1, Y, [[SSI_A, 1000], [SSI_B, 2000]]);
    await seedDfAprobat(300); // angajament 300 pe SSI_A ⇒ ramane_din_buget nebanal

    // Referința PRE-LOT, rulată live: CTE-ul `buget` de dinainte era
    //   SELECT cod_ssi, valoare FROM clasa8_buget WHERE org_id = $1   (fără an)
    const { rows: ref } = await pool.query(
      `SELECT cod_ssi, valoare FROM clasa8_buget WHERE org_id = $1 ORDER BY cod_ssi`, [1]);
    const refBuget = ref.reduce((s, r) => s + Number(r.valoare), 0);
    expect(refBuget).toBe(3000);

    const agg = await getClasa8Aggregate(pool, 1, {});
    expect(agg.totals.buget).toBe(refBuget);                 // 3000
    expect(agg.totals.angajamente).toBe(300);
    expect(agg.totals.ramane_din_buget).toBe(refBuget - 300); // 2700
    expect(itemFor(agg, SSI_A)).toMatchObject({ buget: 1000, angajamente: 300, ramane_din_buget: 700 });
    expect(itemFor(agg, SSI_B)).toMatchObject({ buget: 2000, angajamente: 0,   ramane_din_buget: 2000 });

    const disp = await getBugetDisponibil(pool, 1, null);
    expect(itemFor(disp, SSI_A)).toMatchObject({ buget: 1000, angajat_aprobat: 300, disponibil: 700 });
    expect(itemFor(disp, SSI_B)).toMatchObject({ buget: 2000, angajat_aprobat: 0,   disponibil: 2000 });

    // rutele meta/coduri, fără ?an=, văd aceeași versiune / aceleași coduri ca înainte
    const meta = await request(app).get('/api/clasa8/buget/meta').set('Cookie', p1());
    expect(meta.status).toBe(200);
    expect(meta.body.an).toBe(Y);
    expect(meta.body.active).toMatchObject({ version_no: 1, row_count: 2, total_value: '3000.00' });
    const coduri = await request(app).get('/api/clasa8/buget/coduri').set('Cookie', p1());
    expect(coduri.body.items).toEqual([{ cod_ssi: SSI_A, valoare: 1000 }, { cod_ssi: SSI_B, valoare: 2000 }]);
  });

  // ── 8. doi ani în bază ⇒ agregatul implicit NU îi amestecă ─────────────────────
  it('8. cu date pe Y ȘI Y+1, agregatul implicit citește doar Y; cu filters.an=Y+1 doar Y+1', async () => {
    await seedBuget(1, Y,  [[SSI_A, 1000], [SSI_B, 2000]], 1);
    await seedBuget(1, Y1, [[SSI_A, 1500], ['810199', 7]],  2);
    await seedDfAprobat(300);

    const agg = await getClasa8Aggregate(pool, 1, {});
    expect(agg.totals.buget).toBe(3000);                 // NU 4507
    expect(agg.totals.ramane_din_buget).toBe(2700);
    expect(itemFor(agg, SSI_A).buget).toBe(1000);        // NU 2500 și NU 1500
    expect(itemFor(agg, '810199')).toBeUndefined();      // codul doar-pe-Y+1 nu apare

    const agg1 = await getClasa8Aggregate(pool, 1, { an: Y1 });
    expect(agg1.totals.buget).toBe(1507);
    expect(itemFor(agg1, SSI_A)).toMatchObject({ buget: 1500, angajamente: 300, ramane_din_buget: 1200 });
    expect(itemFor(agg1, SSI_B)).toBeUndefined();

    // filtrele existente + an: anul e ULTIMUL parametru, indiferent câte filtre sunt active
    const aggF = await getClasa8Aggregate(pool, 1, { an: Y1, ssi: '8101', q: 'x', compartiment: 'C' });
    expect(aggF.totals.buget).toBe(1507);

    const disp  = await getBugetDisponibil(pool, 1, null);
    expect(itemFor(disp, SSI_A)).toMatchObject({ buget: 1000, disponibil: 700 });
    const disp1 = await getBugetDisponibil(pool, 1, null, Y1);
    expect(itemFor(disp1, SSI_A)).toMatchObject({ buget: 1500, disponibil: 1200 });

    // meta/coduri pe ?an=
    const m1 = await request(app).get(`/api/clasa8/buget/meta?an=${Y1}`).set('Cookie', p1());
    expect(m1.body.active).toMatchObject({ version_no: 2, row_count: 2 });
    const c1 = await request(app).get(`/api/clasa8/buget/coduri?an=${Y1}`).set('Cookie', p1());
    expect(c1.body.items.map(x => x.cod_ssi)).toEqual([SSI_A, '810199']);
    const c0 = await request(app).get('/api/clasa8/buget/coduri').set('Cookie', p1());
    expect(c0.body.items.map(x => x.cod_ssi)).toEqual([SSI_A, SSI_B]); // fiecare cod O SINGURĂ dată
  });
});
