/**
 * test:db — #134g: backfill `source_alop_id` pe lanțurile de revizii DF deja legate de un ALOP.
 *
 * Se testează FUNCȚIA exportată (`backfillSourceAlop`), nu procesul — scriptul are un
 * `main()` subțire sub `import.meta.url === pathToFileURL(process.argv[1]).href`.
 *
 * ⚠️ Miza reală: `source_alop_id` ESTE cheia de dosar
 * (`dosarKeyExpr = COALESCE(fd.source_alop_id::text, fd.nr_unic_inreg)`, #126). Scrierea ei
 * SCHIMBĂ cheia. De aceea, pe lângă porțile de skip, două teste asertează pe RĂSPUNSUL HTTP:
 *   • B7 — lanț cu număr UNIC ⇒ ZERO regresie (aceleași ieșiri înainte/după);
 *   • B8 — două lanțuri care ÎMPART un număr ⇒ contaminate înainte, SEPARATE după.
 *
 * Rulează pe Postgres 17 efemer (vezi CLAUDE.md §test:db).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedAlop, seedFlowApproved,
         getDf, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';
import { backfillSourceAlop, formatReport, parseArgs }
  from '../../../tools/backfill-df-source-alop.mjs';

const d = describe.skipIf(!hasTestDb());

/** Ieșire brută, cerută explicit în raportul lotului (B2/B8). */
const RAW = process.env.BACKFILL_TEST_VERBOSE === '1';
const raw = (titlu, text) => { if (RAW) console.log(`\n──── ${titlu} ────\n${text}`); };

d('#134g — backfill source_alop_id pe lanțuri de revizii', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' });   // org 1, user 1
    app = buildApp();
  });
  afterAll(() => pool.end());

  const p1 = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });
  const srcOf = async (id) => (await getDf(id)).source_alop_id;

  /** Lanț legacy R0→R1→…, fără source_alop_id, + un ALOP care pointează la `pointerRev`. */
  async function seedLant({ orgId = 1, userId = 1, nr = 'DF-UNIC-1', revizii = 2,
                            pointerRev = 0, aprobate = false, cancelledAt = undefined } = {}) {
    const ids = [];
    for (let r = 0; r <= revizii; r++) {
      const flowId = aprobate ? await seedFlowApproved() : null;
      ids.push(await seedDf({
        orgId, createdBy: userId, status: aprobate ? 'aprobat' : 'draft',
        flowId, nrUnic: nr, revizieNr: r, parentDfId: r === 0 ? null : ids[r - 1],
      }));
    }
    const alop = await seedAlop({ orgId, createdBy: userId, status: 'angajare',
      titlu: `Dosar ${nr}`, dfId: ids[pointerRev], cancelledAt });
    return { ids, alop };
  }

  // ── B1 ─────────────────────────────────────────────────────────────────────
  it('B1 — ALL-OR-NOTHING: lanț R0→R1→R2, pointer pe R1 ⇒ toate TREI primesc alop.id', async () => {
    const { ids, alop } = await seedLant({ revizii: 2, pointerRev: 1 });
    const [r0, r1, r2] = ids;

    const rap = await backfillSourceAlop({ pool, apply: true });

    expect(rap.lanturiExaminate).toBe(1);
    expect(rap.lanturiScrise).toBe(1);
    expect(rap.dfAtinse).toBe(3);
    // propagare în SUS (R1→R0) ȘI în JOS (R1→R2) — dovada că traversarea e bidirecțională
    expect(await srcOf(r0)).toBe(alop);
    expect(await srcOf(r1)).toBe(alop);
    expect(await srcOf(r2)).toBe(alop);
    expect(rap.scrise[0].scrise.sort()).toEqual([r0, r1, r2].sort());
    for (const k of Object.keys(rap.skip)) expect(rap.skip[k]).toEqual([]);
  });

  // ── B2 ─────────────────────────────────────────────────────────────────────
  it('B2 — DRY-RUN pe același fixture: ZERO scrieri, raport identic ca formă', async () => {
    const { ids } = await seedLant({ revizii: 2, pointerRev: 1 });

    const dry = await backfillSourceAlop({ pool, apply: false });
    raw('B2 — raport DRY-RUN', formatReport(dry));

    expect(dry.apply).toBe(false);
    expect(dry.lanturiExaminate).toBe(1);
    expect(dry.lanturiScrise).toBe(1);        // „ar fi fost"
    expect(dry.dfAtinse).toBe(3);
    for (const id of ids) expect(await srcOf(id)).toBeNull();   // ⇐ NIMIC scris

    const txt = formatReport(dry);
    expect(txt).toContain('DRY-RUN — nu s-a scris nimic. Reruleaza cu --apply.');
    for (const id of ids) expect(txt).toContain(id);            // id-uri concrete în raport

    // Aceeași FORMĂ ca la --apply (aceleași chei, aceleași secțiuni).
    const wet = await backfillSourceAlop({ pool, apply: true });
    expect(Object.keys(wet).sort()).toEqual(Object.keys(dry).sort());
    expect(Object.keys(wet.skip).sort()).toEqual(Object.keys(dry.skip).sort());
    expect(wet.lanturiScrise).toBe(dry.lanturiScrise);
    expect(wet.dfAtinse).toBe(dry.dfAtinse);
  });

  // ── B3 (S1) ────────────────────────────────────────────────────────────────
  it('B3 (S1) — un membru revendicat de ALT ALOP ⇒ lanț SĂRIT INTEGRAL, niciun rând atins', async () => {
    const { ids, alop } = await seedLant({ revizii: 2, pointerRev: 0 });
    const alopStrain = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft', titlu: 'Străin' });
    await pool.query('UPDATE formulare_df SET source_alop_id=$2 WHERE id=$1', [ids[2], alopStrain]);

    const rap = await backfillSourceAlop({ pool, apply: true });

    expect(rap.lanturiScrise).toBe(0);
    expect(rap.dfAtinse).toBe(0);
    expect(rap.skip.S1).toHaveLength(1);
    expect(rap.skip.S1[0].alopId).toBe(alop);
    expect(rap.skip.S1[0].membri.sort()).toEqual(ids.slice().sort());
    expect(rap.skip.S1[0].detaliu).toContain(alopStrain);
    expect(await srcOf(ids[0])).toBeNull();
    expect(await srcOf(ids[1])).toBeNull();
    expect(await srcOf(ids[2])).toBe(alopStrain);   // neatins
  });

  // ── B4 (S3) ────────────────────────────────────────────────────────────────
  it('B4 (S3) — două rânduri active cu același revizie_nr ⇒ lanț sărit, index unic nevătămat', async () => {
    const r0 = await seedDf({ orgId: 1, createdBy: 1, nrUnic: 'DUP-1', revizieNr: 0 });
    const r1a = await seedDf({ orgId: 1, createdBy: 1, nrUnic: 'DUP-1', revizieNr: 1, parentDfId: r0 });
    const r1b = await seedDf({ orgId: 1, createdBy: 1, nrUnic: 'DUP-1', revizieNr: 1, parentDfId: r0 });
    const alop = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', dfId: r0 });

    const rap = await backfillSourceAlop({ pool, apply: true });

    expect(rap.lanturiScrise).toBe(0);
    expect(rap.skip.S3).toHaveLength(1);
    expect(rap.skip.S3[0].alopId).toBe(alop);
    expect(rap.skip.S3[0].detaliu).toMatch(/revizie_nr duplicat/);
    for (const id of [r0, r1a, r1b]) expect(await srcOf(id)).toBeNull();

    // Indexul unic parțial (migrarea 095) e intact — nu l-a doborât nicio scriere.
    const { rows } = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE indexname='df_source_alop_revizie_uniq'`);
    expect(rows).toHaveLength(1);
  });

  it('B4-bis (S3) — revizie_nr deja ocupat pe ALOP de un rând din AFARA lanțului ⇒ sărit', async () => {
    const { ids, alop } = await seedLant({ revizii: 1, pointerRev: 0, nr: 'OCUP-1' });
    // Un DF fără legătură de parentaj, dar deja purtând source_alop_id = alop, cu R0 ocupat.
    await seedDf({ orgId: 1, createdBy: 1, nrUnic: 'ALTUL', revizieNr: 0, sourceAlopId: alop });

    const rap = await backfillSourceAlop({ pool, apply: true });

    expect(rap.lanturiScrise).toBe(0);
    expect(rap.skip.S3).toHaveLength(1);
    expect(rap.skip.S3[0].detaliu).toMatch(/deja ocupat/);
    for (const id of ids) expect(await srcOf(id)).toBeNull();
  });

  // ── B5 (S2) ────────────────────────────────────────────────────────────────
  it('B5 (S2) — două ALOP-uri necancelate pointează în același lanț ⇒ sărit', async () => {
    const { ids, alop } = await seedLant({ revizii: 1, pointerRev: 0, nr: 'AMB-1' });
    const alop2 = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare',
      titlu: 'Al doilea', dfId: ids[1] });

    const rap = await backfillSourceAlop({ pool, apply: true });

    expect(rap.lanturiScrise).toBe(0);
    expect(rap.skip.S2).toHaveLength(2);     // ambii candidați cad pe aceeași poartă
    const alopiRaportati = rap.skip.S2.map((s) => s.alopId).sort();
    expect(alopiRaportati).toEqual([alop, alop2].sort());
    expect(rap.skip.S2[0].detaliu).toMatch(/ambiguu — 2 ALOP-uri/);
    for (const id of ids) expect(await srcOf(id)).toBeNull();
  });

  it('B5-bis — al doilea ALOP CANCELAT nu mai face lanțul ambiguu ⇒ se scrie', async () => {
    const { ids, alop } = await seedLant({ revizii: 1, pointerRev: 0, nr: 'AMB-2' });
    await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', dfId: ids[1],
      cancelledAt: new Date().toISOString() });

    const rap = await backfillSourceAlop({ pool, apply: true });

    expect(rap.skip.S2).toEqual([]);
    expect(rap.lanturiScrise).toBe(1);
    for (const id of ids) expect(await srcOf(id)).toBe(alop);
  });

  // ── B6 ─────────────────────────────────────────────────────────────────────
  it('B6 — idempotență: a doua rulare --apply raportează ZERO scrieri', async () => {
    const { ids, alop } = await seedLant({ revizii: 2, pointerRev: 2, nr: 'IDEM-1' });

    const r1 = await backfillSourceAlop({ pool, apply: true });
    expect(r1.lanturiScrise).toBe(1);
    expect(r1.dfAtinse).toBe(3);

    const r2 = await backfillSourceAlop({ pool, apply: true });
    expect(r2.lanturiExaminate).toBe(0);     // candidații dispar: DF-ul pointat are proveniență
    expect(r2.lanturiScrise).toBe(0);
    expect(r2.dfAtinse).toBe(0);
    for (const k of Object.keys(r2.skip)) expect(r2.skip[k]).toEqual([]);
    for (const id of ids) expect(await srcOf(id)).toBe(alop);
  });

  // ── B7 ⭐ non-regresie pe cheia de dosar ───────────────────────────────────
  it('B7 ⭐ — lanț cu număr UNIC: has_newer_revision / nr_partajat / aprobate IDENTICE după backfill', async () => {
    const { ids } = await seedLant({ revizii: 1, pointerRev: 1, nr: 'UNIC-7', aprobate: true });
    const [r0, r1] = ids;

    const citeste = async () => {
      const ap = await request(app).get('/api/formulare-df/aprobate').set('Cookie', p1());
      const d0 = await request(app).get(`/api/formulare-df/${r0}`).set('Cookie', p1());
      const d1 = await request(app).get(`/api/formulare-df/${r1}`).set('Cookie', p1());
      const ls = await request(app).get('/api/formulare/list?type=df&limit=50').set('Cookie', p1());
      const byId = Object.fromEntries(ls.body.rows.map((r) => [r.id, r]));
      const rv = await request(app).get(`/api/formulare-df/${r0}/revizii`).set('Cookie', p1());
      return {
        aprobate: ap.body.documents.map((x) => x.id).sort(),
        r0: { hnr: d0.body.document.has_newer_revision,
              lrn: Number(d0.body.document.latest_revizie_nr),
              part: byId[r0].nr_partajat },
        r1: { hnr: d1.body.document.has_newer_revision,
              lrn: Number(d1.body.document.latest_revizie_nr),
              part: byId[r1].nr_partajat },
        revizii: rv.body.revizii.map((x) => x.id).sort(),
      };
    };

    const inainte = await citeste();
    const rap = await backfillSourceAlop({ pool, apply: true });
    expect(rap.lanturiScrise).toBe(1);
    const dupa = await citeste();

    expect(dupa).toEqual(inainte);            // ⇐ ZERO regresie pe cheia de dosar
    // …și valorile chiar sunt cele așteptate (nu „identic gol de ambele părți").
    expect(inainte.aprobate).toEqual([r1]);   // DISTINCT ON pe dosar: doar ultima revizie
    expect(inainte.r0.hnr).toBe(true);
    expect(inainte.r1.hnr).toBe(false);
    expect(inainte.r0.part).toBe(false);
    expect(inainte.revizii).toEqual([r0, r1].sort());
  });

  // ── B8 ⭐ îmbunătățirea ────────────────────────────────────────────────────
  it('B8 ⭐ — două lanțuri care ÎMPART nr_unic_inreg: contaminate ÎNAINTE, separate DUPĂ', async () => {
    const NR = '40339';
    // Lanț A: R0→R1. Lanț B: doar R0. Același număr, dosare DIFERITE.
    const a0 = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat',
      flowId: await seedFlowApproved(), nrUnic: NR, revizieNr: 0 });
    const a1 = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat',
      flowId: await seedFlowApproved(), nrUnic: NR, revizieNr: 1, parentDfId: a0 });
    const b0 = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat',
      flowId: await seedFlowApproved(), nrUnic: NR, revizieNr: 0 });
    const alopA = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', titlu: 'A', dfId: a1 });
    const alopB = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', titlu: 'B', dfId: b0 });

    const citeste = async () => {
      const dB = await request(app).get(`/api/formulare-df/${b0}`).set('Cookie', p1());
      const ls = await request(app).get('/api/formulare/list?type=df&limit=50').set('Cookie', p1());
      const byId = Object.fromEntries(ls.body.rows.map((r) => [r.id, r]));
      const rv = await request(app).get(`/api/formulare-df/${b0}/revizii`).set('Cookie', p1());
      const ap = await request(app).get('/api/formulare-df/aprobate').set('Cookie', p1());
      return {
        b0_has_newer_revision: dB.body.document.has_newer_revision,
        b0_latest_revizie_nr: Number(dB.body.document.latest_revizie_nr),
        nr_partajat: { a0: byId[a0].nr_partajat, a1: byId[a1].nr_partajat, b0: byId[b0].nr_partajat },
        revizii_lant_B: rv.body.revizii.map((x) => x.id).sort(),
        aprobate: ap.body.documents.map((x) => x.id).sort(),
      };
    };

    const inainte = await citeste();
    raw('B8 — ÎNAINTE de backfill (fixture nemodificat, ambele lanțuri legacy)',
        JSON.stringify(inainte, null, 2));

    // CONTAMINARE dovedită pe fixture-ul nemodificat:
    expect(inainte.b0_has_newer_revision).toBe(true);   // R1-ul dosarului A îl marchează „istoric"
    expect(inainte.b0_latest_revizie_nr).toBe(1);
    expect(inainte.revizii_lant_B.sort()).toEqual([a0, a1, b0].sort());  // dosar STRĂIN în lanț
    expect(inainte.nr_partajat.b0).toBe(false);         // badge-ul de avertizare NU se aprinde
    expect(inainte.aprobate).toEqual([a1]);             // b0 pierdut din dropdown-ul ORD

    const rap = await backfillSourceAlop({ pool, apply: true });
    expect(rap.lanturiScrise).toBe(2);
    expect(rap.dfAtinse).toBe(3);
    expect(await srcOf(a0)).toBe(alopA);
    expect(await srcOf(a1)).toBe(alopA);
    expect(await srcOf(b0)).toBe(alopB);

    const dupa = await citeste();
    raw('B8 — DUPĂ backfill', JSON.stringify(dupa, null, 2));

    expect(dupa.b0_has_newer_revision).toBe(false);     // dosarul B are doar R0
    expect(dupa.b0_latest_revizie_nr).toBe(0);
    expect(dupa.revizii_lant_B).toEqual([b0]);          // lanț curat
    expect(dupa.nr_partajat).toEqual({ a0: true, a1: true, b0: true });  // badge-ul se aprinde
    expect(dupa.aprobate.sort()).toEqual([a1, b0].sort());               // b0 revine în dropdown
  });

  // ── B9 ─────────────────────────────────────────────────────────────────────
  it('B9 — ALOP cancelled ⇒ lanțul lui nu e atins', async () => {
    const { ids } = await seedLant({ revizii: 1, pointerRev: 0, nr: 'CANC-1',
      cancelledAt: new Date().toISOString() });

    const rap = await backfillSourceAlop({ pool, apply: true });

    expect(rap.lanturiExaminate).toBe(0);
    expect(rap.lanturiScrise).toBe(0);
    for (const id of ids) expect(await srcOf(id)).toBeNull();
  });

  // ── B10 ────────────────────────────────────────────────────────────────────
  it('B10 — --org restrânge corect: lanțul din alt org rămâne neatins', async () => {
    const { orgId: org2, userId: u2 } = await seedOrgUser({ orgName: 'Org 2', email: 'p2@y.ro' });
    const l1 = await seedLant({ orgId: 1, userId: 1, revizii: 1, nr: 'ORG1-1' });
    const l2 = await seedLant({ orgId: org2, userId: u2, revizii: 1, nr: 'ORG2-1' });

    const rap = await backfillSourceAlop({ pool, apply: true, orgId: 1 });

    expect(rap.orgId).toBe(1);
    expect(rap.lanturiExaminate).toBe(1);
    expect(rap.lanturiScrise).toBe(1);
    for (const id of l1.ids) expect(await srcOf(id)).toBe(l1.alop);
    for (const id of l2.ids) expect(await srcOf(id)).toBeNull();

    // Fără filtru, al doilea lanț se prelucrează normal.
    const rap2 = await backfillSourceAlop({ pool, apply: true });
    expect(rap2.lanturiScrise).toBe(1);
    for (const id of l2.ids) expect(await srcOf(id)).toBe(l2.alop);
  });

  // ── B11 ────────────────────────────────────────────────────────────────────
  it('B11 — parent_df_id în CICLU ⇒ lanțul e sărit și raportat, restul CONTINUĂ', async () => {
    // Lanț corupt: A.parent=B, B.parent=A.
    const A = await seedDf({ orgId: 1, createdBy: 1, nrUnic: 'CICLU-1', revizieNr: 0 });
    const B = await seedDf({ orgId: 1, createdBy: 1, nrUnic: 'CICLU-1', revizieNr: 1, parentDfId: A });
    await pool.query('UPDATE formulare_df SET parent_df_id=$2 WHERE id=$1', [A, B]);
    const alopCorupt = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare',
      titlu: 'Corupt', dfId: A });

    // …și un lanț SĂNĂTOS, care trebuie prelucrat în aceeași rulare.
    const sanatos = await seedLant({ revizii: 1, pointerRev: 0, nr: 'SANATOS-1' });

    const rap = await backfillSourceAlop({ pool, apply: true });

    expect(rap.skip.CICLU).toHaveLength(1);
    expect(rap.skip.CICLU[0].alopId).toBe(alopCorupt);
    expect(rap.skip.CICLU[0].membri.sort()).toEqual([A, B].sort());
    expect(rap.skip.CICLU[0].detaliu).toMatch(/buclă în parent_df_id/);
    expect(await srcOf(A)).toBeNull();
    expect(await srcOf(B)).toBeNull();

    expect(rap.lanturiScrise).toBe(1);                       // ⇐ restul a continuat
    for (const id of sanatos.ids) expect(await srcOf(id)).toBe(sanatos.alop);
    expect(rap.skip.EROARE).toEqual([]);
  });

  // ── S4 (a patra poartă) ────────────────────────────────────────────────────
  it('S4 — un membru din alt org decât ALOP-ul ⇒ lanț sărit integral', async () => {
    const { orgId: org2, userId: u2 } = await seedOrgUser({ orgName: 'Org 2', email: 'p2@y.ro' });
    const r0 = await seedDf({ orgId: 1, createdBy: 1, nrUnic: 'MIX-1', revizieNr: 0 });
    const r1 = await seedDf({ orgId: org2, createdBy: u2, nrUnic: 'MIX-1', revizieNr: 1, parentDfId: r0 });
    const alop = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', dfId: r0 });

    const rap = await backfillSourceAlop({ pool, apply: true });

    expect(rap.lanturiScrise).toBe(0);
    expect(rap.skip.S4).toHaveLength(1);
    expect(rap.skip.S4[0].alopId).toBe(alop);
    expect(rap.skip.S4[0].detaliu).toMatch(/org ALOP=1/);
    expect(await srcOf(r0)).toBeNull();
    expect(await srcOf(r1)).toBeNull();
  });

  // ── Traversarea NU trece prin nr_unic_inreg ────────────────────────────────
  it('⛔ propagarea NU trece prin nr_unic_inreg: un DF omonim fără parentaj rămâne neatins', async () => {
    const { ids, alop } = await seedLant({ revizii: 1, pointerRev: 0, nr: 'OMONIM-1' });
    const strain = await seedDf({ orgId: 1, createdBy: 1, nrUnic: 'OMONIM-1', revizieNr: 5 });

    const rap = await backfillSourceAlop({ pool, apply: true });

    expect(rap.lanturiScrise).toBe(1);
    expect(rap.dfAtinse).toBe(2);
    for (const id of ids) expect(await srcOf(id)).toBe(alop);
    expect(await srcOf(strain)).toBeNull();     // ⇐ omonimul NU a fost înghițit
  });

  // ── Membrii soft-șterși nu intră în lanț ───────────────────────────────────
  it('un membru soft-șters nu intră în lanț (și nu rupe all-or-nothing)', async () => {
    const { ids, alop } = await seedLant({ revizii: 2, pointerRev: 0, nr: 'SOFT-1' });
    await pool.query('UPDATE formulare_df SET deleted_at=NOW() WHERE id=$1', [ids[2]]);

    const rap = await backfillSourceAlop({ pool, apply: true });

    expect(rap.dfAtinse).toBe(2);
    expect(await srcOf(ids[0])).toBe(alop);
    expect(await srcOf(ids[1])).toBe(alop);
    expect(await srcOf(ids[2])).toBeNull();
  });

  // ── parseArgs — poarta CLI ─────────────────────────────────────────────────
  it('parseArgs: dry-run implicit, --apply explicit, argument necunoscut ⇒ eroare (NU apply)', () => {
    expect(parseArgs([])).toEqual({ apply: false, orgId: null });
    expect(parseArgs(['--apply'])).toEqual({ apply: true, orgId: null });
    expect(parseArgs(['--org=7'])).toEqual({ apply: false, orgId: 7 });
    expect(parseArgs(['--org=7', '--apply'])).toEqual({ apply: true, orgId: 7 });
    expect(parseArgs(['--force']).eroare).toMatch(/argument necunoscut/);
    expect(parseArgs(['--force']).apply).toBeUndefined();
    // org_id e INTEGER în schemă — un UUID e respins explicit, nu tăcut.
    expect(parseArgs(['--org=550e8400-e29b-41d4-a716-446655440000']).eroare).toMatch(/INTEGER/);
  });
});
