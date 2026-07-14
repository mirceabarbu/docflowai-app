/**
 * test:db — coduri de angajament CANONICE cu MAJUSCULE (v3.9.683).
 *
 * De ce contează (NU cosmetic): opme-matcher.mjs potrivește prin egalitate strictă
 * case-sensitive. Codurile ajung la matcher în `formulare_ord.rows` (opme-matcher.mjs:127),
 * copiate din DF `rows_ctrl` prin prefill DF→ORD (list.js:180). Un cod cu minuscule nu se
 * potrivește NICIODATĂ cu OPME (importat cu MAJUSCULE) → plată nelegată, tăcut.
 *
 * ⛔ Testele importă din producție: rutele reale (df/ord), SQL-ul migrării 096 din MIGRATIONS,
 *    și matchImport real. Nu redeclara logica.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedAlop, getDf, getOrd, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';
import { MIGRATIONS } from '../../db/index.mjs';
import { matchImport } from '../../services/opme-matcher.mjs';

const d = describe.skipIf(!hasTestDb());
const MIG_096 = MIGRATIONS.find(m => m.id === '096_uppercase_angajament_codes');

// ── seed helpers OPME (identice cu opme-per-group-isolation) ──────────────────
async function seedImport({ orgId, uploadedBy, nrDocument = '0000130' }) {
  const { rows } = await pool.query(
    `INSERT INTO opme_imports (org_id, uploaded_by, file_hash, file_name, nr_document, data_op)
     VALUES ($1,$2,$3,'f1129.pdf',$4, DATE '2026-05-06') RETURNING id`,
    [orgId, uploadedBy, 'hash-' + Math.random().toString(36).slice(2), nrDocument]);
  return rows[0].id;
}
async function seedLine({ importId, orgId, rowIndex, nrOp, cod, ind, cif, suma }) {
  const { rows } = await pool.query(
    `INSERT INTO opme_lines
       (opme_import_id, org_id, row_index, nr_op, cod_angajament, indicator_angajament, cif_beneficiar, suma_op)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [importId, orgId, rowIndex, nrOp, cod, ind, cif, suma]);
  return rows[0].id;
}
async function getAlopRow(id) {
  const { rows } = await pool.query(`SELECT * FROM alop_instances WHERE id=$1`, [id]);
  return rows[0];
}

d('coduri de angajament canonice cu MAJUSCULE', () => {
  let app, orgId, userId, cookie;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    ({ orgId, userId } = await seedOrgUser({ role: 'user', email: 'p1@x.ro' }));
    cookie = makeAuthCookie({ userId, role: 'user', orgId });
    app = buildApp();
  });
  afterAll(() => pool.end());

  // ── #8 — calea de scriere prin rute normalizează la MAJUSCULE ────────────────
  it('#8 DF PUT rows_ctrl cod minuscul ⇒ în bază e MAJUSCULE', async () => {
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'draft' });
    const r = await request(app).put(`/api/formulare-df/${dfId}`).set('Cookie', cookie)
      .send({ rows_ctrl: [{ cod_angajament: 'abc', indicator_angajament: 'x1', program: 'p' }] });
    expect(r.status).toBe(200);
    const df = await getDf(dfId);
    expect(df.rows_ctrl[0].cod_angajament).toBe('ABC');
    expect(df.rows_ctrl[0].indicator_angajament).toBe('X1');
    expect(df.rows_ctrl[0].program).toBe('p');   // restul intact
  });

  it('ORD create + PUT rows cod minuscul ⇒ în bază e MAJUSCULE', async () => {
    const cr = await request(app).post('/api/formulare-ord').set('Cookie', cookie)
      .send({ nr_ordonant_pl: 'ORD-UP-1',
              rows: [{ cod_angajament: 'coda', indicator_angajament: 'inda', suma_ordonantata_plata: '0' }] });
    expect(cr.status).toBe(200);
    const ordId = cr.body.document.id;
    expect((await getOrd(ordId)).rows[0].cod_angajament).toBe('CODA');

    const pu = await request(app).put(`/api/formulare-ord/${ordId}`).set('Cookie', cookie)
      .send({ rows: [{ cod_angajament: 'codb', indicator_angajament: 'indb', suma_ordonantata_plata: '0' }] });
    expect(pu.status).toBe(200);
    const ord = await getOrd(ordId);
    expect(ord.rows[0].cod_angajament).toBe('CODB');
    expect(ord.rows[0].indicator_angajament).toBe('INDB');
  });

  // ── #9 — migrarea 096: MAJUSCULE + ORDINEA păstrată (DF rows_ctrl) ───────────
  it('#9 migrarea 096 ridică la MAJUSCULE și PĂSTREAZĂ ordinea (3 rânduri distincte)', async () => {
    const dfId = await seedDf({ orgId, createdBy: userId, rowsCtrl: [
      { cod_angajament: 'zzz', indicator_angajament: 'i1', program: 'unu' },
      { cod_angajament: 'aaa', indicator_angajament: 'i2', program: 'doi' },
      { cod_angajament: 'mmm', indicator_angajament: 'i3', program: 'trei' },
    ] });
    await pool.query(MIG_096.sql);
    const df = await getDf(dfId);
    // ordinea NU s-a amestecat: zzz→ZZZ, aaa→AAA, mmm→MMM în aceeași poziție
    expect(df.rows_ctrl.map(r => r.cod_angajament)).toEqual(['ZZZ', 'AAA', 'MMM']);
    expect(df.rows_ctrl.map(r => r.indicator_angajament)).toEqual(['I1', 'I2', 'I3']);
    expect(df.rows_ctrl.map(r => r.program)).toEqual(['unu', 'doi', 'trei']);
  });

  it('migrarea 096 ridică la MAJUSCULE și ORD rows (câmpul potrivit de OPME)', async () => {
    const ordId = await seedOrd({ orgId, createdBy: userId, rows: [
      { cod_angajament: 'coda', indicator_angajament: 'inda', suma_ordonantata_plata: '50' },
    ] });
    await pool.query(MIG_096.sql);
    const ord = await getOrd(ordId);
    expect(ord.rows[0].cod_angajament).toBe('CODA');
    expect(ord.rows[0].indicator_angajament).toBe('INDA');
    expect(ord.rows[0].suma_ordonantata_plata).toBe('50');   // suma neatinsă
  });

  it('migrarea 096 NU adaugă chei pe rândurile care nu le au', async () => {
    const dfId = await seedDf({ orgId, createdBy: userId, rowsCtrl: [
      { program: 'doar-program', cod_SSI: '' },
    ] });
    await pool.query(MIG_096.sql);
    const df = await getDf(dfId);
    expect('cod_angajament' in df.rows_ctrl[0]).toBe(false);
    expect('indicator_angajament' in df.rows_ctrl[0]).toBe(false);
    expect(df.rows_ctrl[0].program).toBe('doar-program');
  });

  // ── #10 — idempotență ────────────────────────────────────────────────────────
  it('#10 migrarea 096 e idempotentă — a doua rulare nu schimbă nimic', async () => {
    const dfId = await seedDf({ orgId, createdBy: userId, rowsCtrl: [
      { cod_angajament: 'abc', indicator_angajament: 'x' }] });
    await pool.query(MIG_096.sql);
    const after1 = JSON.stringify((await getDf(dfId)).rows_ctrl);
    await pool.query(MIG_096.sql);
    const after2 = JSON.stringify((await getDf(dfId)).rows_ctrl);
    expect(after1).toBe(after2);
    expect(JSON.parse(after2)[0].cod_angajament).toBe('ABC');
  });

  // ── #11 — POTRIVIRE OPME end-to-end (testul care dovedește bug-ul) ────────────
  // ORD.rows e câmpul pe care matcher-ul îl citește. Cod minuscul ⇒ NU se potrivește;
  // după migrarea 096 (canonicalizare) ⇒ SE potrivește. Ăsta e testul care contează.
  it('#11 ORD.rows minuscul NU se potrivește cu OPME; după migrarea 096 SE potrivește', async () => {
    const CIF = '123456', COD = 'CODA', IND = 'INDA';
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'aprobat', nrUnic: 'DF-OPME' });
    // ORD.rows cu cod MINUSCUL (simulează date legacy / edit direct), cif setat.
    const ordId = await seedOrd({ orgId, createdBy: userId, dfId,
      rows: [{ cod_angajament: 'coda', indicator_angajament: 'inda', suma_ordonantata_plata: '100' }] });
    await pool.query(`UPDATE formulare_ord SET cif_beneficiar=$2 WHERE id=$1`, [ordId, CIF]);
    const alopId = await seedAlop({ orgId, createdBy: userId, status: 'plata', dfId, ordId });

    // linia OPME e cu MAJUSCULE (așa vin datele importate).
    const importId = await seedImport({ orgId, uploadedBy: userId });
    await seedLine({ importId, orgId, rowIndex: 0, nrOp: '900', cod: COD, ind: IND, cif: CIF, suma: 100 });

    // ── ÎNAINTE de normalizare: 'coda' ≠ 'CODA' ⇒ NU se potrivește ──
    const rep1 = await matchImport(importId);
    expect(rep1.matched).toBe(0);
    expect((await getAlopRow(alopId)).status).toBe('plata');           // rămâne neconfirmat
    expect((await getAlopRow(alopId)).plata_confirmed_at).toBeNull();

    // ── Canonicalizare prin migrarea 096 (ORD.rows: 'coda' → 'CODA') ──
    await pool.query(MIG_096.sql);
    expect((await getOrd(ordId)).rows[0].cod_angajament).toBe('CODA');

    // rep1 a marcat linia 'unmatched'; matchImport procesează DOAR liniile 'pending'
    // (opme-matcher.mjs step 2). Ruta reală /rematch re-deschide 'unmatched'→'pending'
    // ÎNAINTE de a re-rula matcher-ul (opme.mjs) — oglindim exact acel pas aici.
    await pool.query(
      `UPDATE opme_lines SET match_status='pending', match_notes=NULL
        WHERE opme_import_id=$1 AND match_status IN ('unmatched','ambiguous','partial')`,
      [importId]);

    // ── DUPĂ normalizare: 'CODA' = 'CODA' ⇒ SE potrivește + auto-confirm ──
    const rep2 = await matchImport(importId);
    expect(rep2.matched).toBe(1);
    const alop = await getAlopRow(alopId);
    expect(alop.status).toBe('completed');
    expect(alop.plata_confirmed_at).not.toBeNull();
    expect(alop.plata_source).toBe('opme_auto');
  });

  // ── #12 — revizia DF moștenește coduri canonice ──────────────────────────────
  it('#12 revizia (R1) dintr-un DF cu minuscule ⇒ R1 are MAJUSCULE', async () => {
    // status 'neaprobat' (refuz) e revizuibil fără flux completat (vezi garda din /revizuieste).
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'neaprobat', nrUnic: 'DF-REV',
      rowsCtrl: [{ cod_angajament: 'rev', indicator_angajament: 'ir', sum_rezv_crdt_ang_act: '10', sum_rezv_crdt_bug_act: '20' }] });
    const r = await request(app).post(`/api/formulare-df/${dfId}/revizuieste`).set('Cookie', cookie)
      .send({ motiv: 'test' });
    expect(r.status).toBe(200);
    // ruta /revizuieste returnează { ok, df, mesaj } — NU { document } (df.mjs).
    const r1 = await getDf(r.body.df.id);
    expect(r1.rows_ctrl[0].cod_angajament).toBe('REV');
    expect(r1.rows_ctrl[0].indicator_angajament).toBe('IR');
  });
});
