// DF duplicat din context ALOP — idempotență server + index unic + curățare migrare 095.
// Incident 13.07.2026: dublu-click pe „Completează DF" ⇒ două formulare_df goale (revizie_nr=0,
// același source_alop_id) ⇒ ALOP legat la cel gol. Postgres REAL (index unic parțial exercitat).
// ⛔ Testele importă din producție (handler-ul din df.mjs + SQL-ul migrării 095) — nu redeclara logica.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedAlop, seedDf, getDf, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';
import { MIGRATIONS } from '../../db/index.mjs';

const d = describe.skipIf(!hasTestDb());

// SQL-ul real al migrării 095 (2a curățare + 2b index) — rulat în testele de migrare.
const MIG_095 = MIGRATIONS.find(m => m.id === '095_df_dedup_and_unique');
// makeAuthCookie e pur (jwt.sign, fără DB) — cookie-ul userului 1 (P1, org 1).
const _cookie = makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

d('DF dedup din ALOP (idempotență + index + migrare 095)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' }); // id 1, org 1
    app = buildApp();
  });

  const countActiveDf = async (alopId) => {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM formulare_df
       WHERE source_alop_id = $1 AND deleted_at IS NULL`, [alopId]);
    return rows[0].n;
  };

  // ── 1. Idempotență secvențială ────────────────────────────────────────────────
  it('două POST consecutive cu același source_alop_id → UN singur rând, același id, 200', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft' });
    const r1 = await request(app).post('/api/formulare-df').set('Cookie', _cookie)
      .send({ source_alop_id: alopId });
    const r2 = await request(app).post('/api/formulare-df').set('Cookie', _cookie)
      .send({ source_alop_id: alopId });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body.document.id).toBe(r1.body.document.id);   // al doilea = documentul existent
    expect(r2.body.document.capabilities).toBeTruthy();       // format identic cu creare
    expect(await countActiveDf(alopId)).toBe(1);
  });

  // ── 2. Concurență (testul care contează — exercită indexul unic, nu doar SELECT-ul) ──
  it('două POST în PARALEL cu același source_alop_id → UN singur rând (23505 prins, nu 500)', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft' });
    const [ra, rb] = await Promise.all([
      request(app).post('/api/formulare-df').set('Cookie', _cookie).send({ source_alop_id: alopId }),
      request(app).post('/api/formulare-df').set('Cookie', _cookie).send({ source_alop_id: alopId }),
    ]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(ra.body.document.id).toBe(rb.body.document.id);
    expect(await countActiveDf(alopId)).toBe(1);
  });

  // ── 3. Fără source_alop_id → comportament neschimbat ──────────────────────────
  it('fără source_alop_id → se creează normal (fiecare POST = rând nou)', async () => {
    const r1 = await request(app).post('/api/formulare-df').set('Cookie', _cookie).send({ subtitlu_df: 'A' });
    const r2 = await request(app).post('/api/formulare-df').set('Cookie', _cookie).send({ subtitlu_df: 'B' });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.document.id).not.toBe(r2.body.document.id);
  });

  // ── 4. Revizii — revizie_nr diferit = DOUĂ rânduri permise (NU o bloca!) ───────
  it('același source_alop_id, revizie_nr diferit → DOUĂ rânduri permise (revizie legitimă)', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft' });
    // R0 via POST (revizie_nr default 0)
    const r0 = await request(app).post('/api/formulare-df').set('Cookie', _cookie).send({ source_alop_id: alopId });
    expect(r0.status).toBe(200);
    // R1 direct (revizie_nr=1) — indexul parțial NU o respinge
    const r1Id = await seedDf({ orgId: 1, createdBy: 1, revizieNr: 1, nrUnic: 'DF-R1' });
    await pool.query(`UPDATE formulare_df SET source_alop_id=$1 WHERE id=$2`, [alopId, r1Id]);
    const { rows } = await pool.query(
      `SELECT revizie_nr FROM formulare_df WHERE source_alop_id=$1 AND deleted_at IS NULL ORDER BY revizie_nr`,
      [alopId]);
    expect(rows.map(r => r.revizie_nr)).toEqual([0, 1]);
  });

  // ── 5. Migrarea 095 — curăță duplicatele, păstrează cel cu flow_id ────────────
  it('migrarea 095 curăță duplicate goale; DF-ul cu flow_id supraviețuiește întotdeauna', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft' });
    // Simulează starea „înainte de 095": scoate indexul ca să putem insera duplicate.
    await pool.query(`DROP INDEX IF EXISTS df_source_alop_revizie_uniq`);
    const draftId = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', nrUnic: 'DF-DUP-A' });
    const flowId  = await seedDf({ orgId: 1, createdBy: 1, status: 'transmis_flux', flowId: 'flow-x', nrUnic: 'DF-DUP-B' });
    await pool.query(`UPDATE formulare_df SET source_alop_id=$1, revizie_nr=0 WHERE id=ANY($2)`,
      [alopId, [draftId, flowId]]);

    await pool.query(MIG_095.sql);   // rulează 2a + 2b din producție

    const draft = await getDf(draftId);
    const onFlow = await getDf(flowId);
    expect(onFlow.deleted_at).toBeNull();          // cel cu flow_id — sacru, NEATINS
    expect(draft.deleted_at).not.toBeNull();       // draftul gol — soft-deleted
    expect(await countActiveDf(alopId)).toBe(1);
    // indexul unic există acum
    const { rows: idx } = await pool.query(
      `SELECT 1 FROM pg_indexes WHERE indexname='df_source_alop_revizie_uniq'`);
    expect(idx.length).toBe(1);
  });

  // ── 6. Cazul intratabil — 2 rânduri AMBELE cu flow_id → migrarea nu le atinge ──
  it('două DF-uri AMBELE cu flow_id → migrarea 095 NU le atinge, nu crapă (boot supraviețuiește)', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft' });
    await pool.query(`DROP INDEX IF EXISTS df_source_alop_revizie_uniq`);
    const a = await seedDf({ orgId: 1, createdBy: 1, status: 'transmis_flux', flowId: 'flow-a', nrUnic: 'DF-INT-A' });
    const b = await seedDf({ orgId: 1, createdBy: 1, status: 'transmis_flux', flowId: 'flow-b', nrUnic: 'DF-INT-B' });
    await pool.query(`UPDATE formulare_df SET source_alop_id=$1, revizie_nr=0 WHERE id=ANY($2)`,
      [alopId, [a, b]]);

    // NU trebuie să arunce — EXCEPTION WHEN unique_violation prinde eșecul indexului.
    await expect(pool.query(MIG_095.sql)).resolves.toBeTruthy();

    // Ambele DF-uri pe flux rămân active — niciunul șters.
    expect((await getDf(a)).deleted_at).toBeNull();
    expect((await getDf(b)).deleted_at).toBeNull();
    expect(await countActiveDf(alopId)).toBe(2);
    // indexul NU s-a putut crea (duplicate rămase) — și e OK, aplicația pornește.
    const { rows: idx } = await pool.query(
      `SELECT 1 FROM pg_indexes WHERE indexname='df_source_alop_revizie_uniq'`);
    expect(idx.length).toBe(0);
  });

  // Reface indexul (testele de migrare 095 îl pot lăsa lipsă — e schema-level, nu-l prinde
  // truncateAll), apoi închide pool-ul. Ordinea contează: recreare ÎNAINTE de pool.end().
  afterAll(async () => {
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS df_source_alop_revizie_uniq
        ON formulare_df (source_alop_id, revizie_nr)
        WHERE source_alop_id IS NOT NULL AND deleted_at IS NULL`).catch(() => {});
    await pool.end();
  });
});
