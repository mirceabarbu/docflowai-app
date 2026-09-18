/**
 * #222 — DB real: clasa G `flux_fara_document` în auditul document↔flux (#120).
 *
 * Un flux VIU pe un document generat de platformă (docName pe tipar) care nu declară nici
 * `dfId`, nici `ordId`. Complementara tuturor celorlalte clase: acelea compară două legături,
 * aici a doua legătură nu s-a născut — invizibil pentru orice detector care face JOIN pe `meta`
 * (cardul arăta ✅ 0 pe ORD 45301 stricat).
 *
 * Plus PARITATEA JS↔SQL: `parseGeneratedDocName` (JS, folosit la adopție în crud.mjs) și
 * `generatedDocNameSql` (SQL, folosit aici) trebuie să dea același verdict pe aceleași nume.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hasTestDb, migrate, truncateAll, pool, seedOrgUser } from '../helpers/db-real.mjs';
import { FIXTURES_POZITIVE, FIXTURES_NEGATIVE } from '../helpers/flow-doc-name-fixtures.mjs';

const { findFlowLinkDivergences } = await import('../../services/flow-link-audit.mjs');
const { parseGeneratedDocName, generatedDocNameSql } = await import('../../services/flow-doc-name.mjs');

let _seq = 0;
async function insertFlow({ orgId, docName, meta = {}, status = 'pending', deletedAt = null }) {
  const id = `flow-g-${++_seq}`;
  const data = { docName, initName: 'Init', initEmail: 'init@x.ro', signers: [], meta, status, completed: status === 'completed' };
  await pool.query(
    `INSERT INTO flows (id, data, org_id, deleted_at) VALUES ($1,$2::jsonb,$3,$4)`,
    [id, JSON.stringify(data), orgId, deletedAt]
  );
  return id;
}

const d = describe.skipIf(!hasTestDb());

d('#222 — clasa G: flux_fara_document', () => {
  let orgId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    const s = await seedOrgUser({ role: 'user', email: 'p1@x.ro' });
    orgId = s.orgId;
  });
  afterAll(() => pool.end());

  // ── ⭐ 7 — flux viu, docName pe tipar, meta gol ⇒ apare ─────────────────────────
  it('⭐ flux VIU + docName pe tipar + meta {} → apare în flux_fara_document, byClass = 1', async () => {
    const fid = await insertFlow({ orgId, docName: 'OrdonantarePlata_45301_20260821', meta: {}, status: 'completed' });

    const r = await findFlowLinkDivergences(pool, { orgId });
    expect(r.byClass.flux_fara_document).toBe(1);
    const row = r.rows.find((x) => x.clasa === 'flux_fara_document');
    expect(row).toMatchObject({ clasa: 'flux_fara_document', tip: 'ord', flux: fid, doc_nr: 'OrdonantarePlata_45301_20260821' });
    expect(row.doc_id).toBeNull();
  });

  it('DF pe tipar → tip = df; flux fără cheia meta deloc → tot apare (NULL-safe)', async () => {
    const id = `flow-g-nometa-${++_seq}`;
    await pool.query(
      `INSERT INTO flows (id, data, org_id) VALUES ($1,$2::jsonb,$3)`,
      [id, JSON.stringify({ docName: 'DocumentFundamentare_6744_20260707.pdf', status: 'pending', signers: [] }), orgId]
    );
    const r = await findFlowLinkDivergences(pool, { orgId });
    expect(r.byClass.flux_fara_document).toBe(1);
    expect(r.rows.find((x) => x.clasa === 'flux_fara_document')).toMatchObject({ tip: 'df', flux: id });
  });

  // ── ⭐ 8 — același flux, dar cancelled ⇒ NU apare ──────────────────────────────
  it('⭐ flux ANULAT cu meta gol → NU apare (cardul trebuie să poată ajunge la 0)', async () => {
    await insertFlow({ orgId, docName: 'DocumentFundamentare_6744_20260707', meta: {}, status: 'cancelled' });
    await insertFlow({ orgId, docName: 'OrdonantarePlata_1_20260707', meta: {}, status: 'refused' });
    await insertFlow({ orgId, docName: 'OrdonantarePlata_2_20260707', meta: {}, status: 'pending', deletedAt: new Date() });

    const r = await findFlowLinkDivergences(pool, { orgId });
    expect(r.byClass.flux_fara_document).toBe(0);
  });

  // ── ⭐ 9 — flux cu meta.ordId ⇒ NU apare ───────────────────────────────────────
  it('⭐ flux cu meta.ordId / meta.dfId setat → NU apare', async () => {
    await insertFlow({ orgId, docName: 'OrdonantarePlata_45301_20260821', meta: { ordId: 'x', docType: 'ordnt' }, status: 'completed' });
    await insertFlow({ orgId, docName: 'DocumentFundamentare_6744_20260707', meta: { dfId: 'y', docType: 'notafd' }, status: 'pending' });

    const r = await findFlowLinkDivergences(pool, { orgId });
    expect(r.byClass.flux_fara_document).toBe(0);
  });

  // ── ⭐ 10 — docName în afara tiparului + meta gol ⇒ NU apare ───────────────────
  it('⭐ docName în afara tiparului + meta {} → NU apare (documentele care nu sunt ale platformei rămân libere)', async () => {
    await insertFlow({ orgId, docName: 'contract-servicii.pdf', meta: {}, status: 'completed' });
    await insertFlow({ orgId, docName: 'raport.pdf', meta: {}, status: 'pending' });

    const r = await findFlowLinkDivergences(pool, { orgId });
    expect(r.byClass.flux_fara_document).toBe(0);
    expect(r.total).toBe(0);
  });

  it('scoping pe organizație: fluxul orfan al ALTEI org nu apare când e scopat, apare fără scop', async () => {
    const o2 = await seedOrgUser({ role: 'user', email: 'p2@y.ro', orgName: 'Org 2' });
    await insertFlow({ orgId: o2.orgId, docName: 'OrdonantarePlata_7_20260821', meta: {}, status: 'pending' });

    expect((await findFlowLinkDivergences(pool, { orgId })).byClass.flux_fara_document).toBe(0);
    expect((await findFlowLinkDivergences(pool, { orgId: null })).byClass.flux_fara_document).toBe(1);
  });

  // ── ⭐ 11 — paritate JS↔SQL pe aceleași fixture-uri ────────────────────────────
  it('⭐ paritate JS↔SQL: generatedDocNameSql dă același verdict ca parseGeneratedDocName pe toate fixture-urile', async () => {
    const toate = [...FIXTURES_POZITIVE.map(([n]) => n), ...FIXTURES_NEGATIVE];
    const ids = [];
    for (const nume of toate) ids.push(await insertFlow({ orgId, docName: nume, meta: {}, status: 'pending' }));

    const { rows } = await pool.query(
      `SELECT f.id, f.data->>'docName' AS nume, (${generatedDocNameSql('f')}) AS sql_verdict
         FROM flows f WHERE f.org_id = $1 ORDER BY f.id`, [orgId]);
    expect(rows.length).toBe(toate.length);

    const divergente = [];
    for (const r of rows) {
      const js = parseGeneratedDocName(r.nume) !== null;
      if (js !== !!r.sql_verdict) divergente.push(`${r.nume}: js=${js} sql=${r.sql_verdict}`);
    }
    expect(divergente, `Verdict diferit JS↔SQL: ${divergente.join(' | ')}`).toEqual([]);

    // Și clasa G raportează exact pozitivele (toate sunt vii, cu meta gol).
    const audit = await findFlowLinkDivergences(pool, { orgId });
    expect(audit.byClass.flux_fara_document).toBe(FIXTURES_POZITIVE.length);
  });
});
