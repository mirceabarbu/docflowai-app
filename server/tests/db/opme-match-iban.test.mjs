/**
 * test:db — #126 Etapa C: al PATRULEA criteriu de potrivire OPME — IBAN beneficiar.
 *
 * Tripletul (cod_angajament, indicator_angajament, cif_beneficiar) nu dezambiguizează
 * ORD-urile cu mai multe CONTURI (același furnizor, conturi diferite). IBAN-ul din
 * ordonanțare devine al patrulea criteriu, cu DOUĂ reguli obligatorii:
 *   • normalizare (majuscule + fără separatori): „RO49 AAAA…" ≡ „RO49AAAA…";
 *   • se aplică DOAR când AMBELE părți au IBAN (documentele vechi n-au) — altfel
 *     toate ALOP-urile deja în „plata" ar deveni brusc nepotrivibile.
 * Regula trăiește într-un helper unic, aplicat IDENTIC în selecția candidaților ȘI în
 * `_processAlop` (divergența = clasa de bug #115, plată sub-numărată).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedAlop } from '../helpers/db-real.mjs';
import { matchImport, tryAutoConfirmAlop } from '../../services/opme-matcher.mjs';

const d = describe.skipIf(!hasTestDb());

const CIF  = '8971726';
const COD  = 'AAB358M476X';
const IND  = 'AAB';
const IBAN_A = 'RO49AAAA1B31007593840000';
const IBAN_B = 'RO12BTRL1234567890123456';

async function seedImport({ orgId, uploadedBy, nrDocument = '0000130' }) {
  const { rows } = await pool.query(
    `INSERT INTO opme_imports (org_id, uploaded_by, file_hash, file_name, nr_document, data_op)
     VALUES ($1,$2,$3,'f1129.pdf',$4, DATE '2026-05-06') RETURNING id`,
    [orgId, uploadedBy, 'hash-' + Math.random().toString(36).slice(2), nrDocument]
  );
  return rows[0].id;
}
async function seedLine({ importId, orgId, rowIndex = 1, nrOp = '123', cod = COD, ind = IND,
                          cif = CIF, iban = null, suma = 1000 }) {
  const { rows } = await pool.query(
    `INSERT INTO opme_lines (opme_import_id, org_id, row_index, nr_op, cod_angajament,
                             indicator_angajament, cif_beneficiar, iban_beneficiar, suma_op)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [importId, orgId, rowIndex, nrOp, cod, ind, cif, iban, suma]
  );
  return rows[0].id;
}
async function getLine(id) {
  const { rows } = await pool.query('SELECT * FROM opme_lines WHERE id=$1', [id]);
  return rows[0];
}
async function getAlopRow(id) {
  const { rows } = await pool.query('SELECT * FROM alop_instances WHERE id=$1', [id]);
  return rows[0];
}

d('#126 C — OPME: al patrulea criteriu (IBAN beneficiar)', () => {
  let userId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    const s = await seedOrgUser({ role: 'user', email: 'p1@x.ro' });
    userId = s.userId;
  });
  afterAll(() => pool.end());

  // ALOP în 'plata' cu ORD (CIF + triplet + IBAN configurabil), valoare 1000.
  async function seedAlopPlata({ iban, nrUnic = 'DF-1', suma = 1000, ind = IND } = {}) {
    const dfId  = await seedDf({ orgId: 1, createdBy: userId, status: 'aprobat', nrUnic });
    const ordId = await seedOrd({ orgId: 1, createdBy: userId, dfId, nrOrd: `ORD-${nrUnic}`,
      rows: [{ cod_angajament: COD, indicator_angajament: ind, suma_ordonantata_plata: suma }] });
    await pool.query(`UPDATE formulare_ord SET cif_beneficiar=$2, iban_beneficiar=$3 WHERE id=$1`,
      [ordId, CIF, iban ?? null]);
    const alopId = await seedAlop({ orgId: 1, createdBy: userId, status: 'plata', dfId, ordId });
    return { alopId, ordId, dfId };
  }

  it('1. triplet + IBAN identic ⇒ auto-confirmat', async () => {
    const { alopId } = await seedAlopPlata({ iban: IBAN_A });
    const impId = await seedImport({ orgId: 1, uploadedBy: userId });
    const lineId = await seedLine({ importId: impId, orgId: 1, iban: IBAN_A });

    const rep = await matchImport(impId);
    expect(rep.confirmed_alopuri).toContain(alopId);
    expect((await getLine(lineId)).match_status).toBe('auto');
    expect((await getAlopRow(alopId)).plata_confirmed_at).not.toBeNull();
  });

  it('2. triplet identic dar IBAN DIFERIT ⇒ NEPOTRIVIT (miezul cerinței)', async () => {
    const { alopId } = await seedAlopPlata({ iban: IBAN_A });
    const impId = await seedImport({ orgId: 1, uploadedBy: userId });
    const lineId = await seedLine({ importId: impId, orgId: 1, iban: IBAN_B });

    const rep = await matchImport(impId);
    expect(rep.confirmed_alopuri).not.toContain(alopId);
    expect(rep.unmatched).toBe(1);
    const ln = await getLine(lineId);
    expect(ln.match_status).toBe('unmatched');
    expect(ln.match_notes).toMatch(/IBAN diferit/i);           // C3: raportul spune de ce
    expect((await getAlopRow(alopId)).plata_confirmed_at).toBeNull();
  });

  it('3. același IBAN formatat diferit (spații/minuscule) ⇒ potrivire (normalizare)', async () => {
    const { alopId } = await seedAlopPlata({ iban: 'RO49 AAAA 1B31 0075 9384 0000' });
    const impId = await seedImport({ orgId: 1, uploadedBy: userId });
    const lineId = await seedLine({ importId: impId, orgId: 1, iban: 'ro49aaaa1b31007593840000' });

    const rep = await matchImport(impId);
    expect(rep.confirmed_alopuri).toContain(alopId);
    expect((await getLine(lineId)).match_status).toBe('auto');
  });

  it('4. ORD fără IBAN (document vechi) ⇒ potrivire pe cele trei criterii', async () => {
    const { alopId } = await seedAlopPlata({ iban: null });
    const impId = await seedImport({ orgId: 1, uploadedBy: userId });
    const lineId = await seedLine({ importId: impId, orgId: 1, iban: IBAN_A });

    const rep = await matchImport(impId);
    expect(rep.confirmed_alopuri).toContain(alopId);
    expect((await getLine(lineId)).match_status).toBe('auto');
  });

  it('5. linie OPME fără IBAN ⇒ potrivire pe cele trei criterii', async () => {
    const { alopId } = await seedAlopPlata({ iban: IBAN_A });
    const impId = await seedImport({ orgId: 1, uploadedBy: userId });
    const lineId = await seedLine({ importId: impId, orgId: 1, iban: null });

    const rep = await matchImport(impId);
    expect(rep.confirmed_alopuri).toContain(alopId);
    expect((await getLine(lineId)).match_status).toBe('auto');
  });

  it('6. două ALOP cu ACELAȘI triplet și IBAN-uri diferite ⇒ DEZAMBIGUIZATE (înainte: ambiguous)', async () => {
    const a = await seedAlopPlata({ iban: IBAN_A, nrUnic: 'DF-A' });
    const b = await seedAlopPlata({ iban: IBAN_B, nrUnic: 'DF-B' });
    const impId = await seedImport({ orgId: 1, uploadedBy: userId });
    const lineId = await seedLine({ importId: impId, orgId: 1, iban: IBAN_B });

    const rep = await matchImport(impId);
    expect(rep.ambiguous).toBe(0);
    expect(rep.confirmed_alopuri).toEqual([b.alopId]);
    const ln = await getLine(lineId);
    expect(ln.matched_alop_id).toBe(b.alopId);
    expect((await getAlopRow(a.alopId)).plata_confirmed_at).toBeNull();
  });

  it('6b. fără IBAN pe linie, două ALOP cu același triplet ⇒ rămâne ambiguous (regula lipsei)', async () => {
    await seedAlopPlata({ iban: IBAN_A, nrUnic: 'DF-A' });
    await seedAlopPlata({ iban: IBAN_B, nrUnic: 'DF-B' });
    const impId = await seedImport({ orgId: 1, uploadedBy: userId });
    const lineId = await seedLine({ importId: impId, orgId: 1, iban: null });

    const rep = await matchImport(impId);
    expect(rep.ambiguous).toBe(1);
    expect((await getLine(lineId)).match_status).toBe('ambiguous');
  });

  it('7. non-regresie #115: ORD multi-indicator plătit prin mai multe OP ⇒ suma agregată corectă', async () => {
    const dfId  = await seedDf({ orgId: 1, createdBy: userId, status: 'aprobat', nrUnic: 'DF-MULTI' });
    const parts = [
      { ind: 'AAB', suma: 836.69 },
      { ind: 'AA2', suma: 84.70 },
      { ind: 'AA3', suma: 393.25 },
    ];
    const total = 1314.64;
    const ordId = await seedOrd({ orgId: 1, createdBy: userId, dfId,
      rows: parts.map(p => ({ cod_angajament: COD, indicator_angajament: p.ind, suma_ordonantata_plata: p.suma })) });
    await pool.query(`UPDATE formulare_ord SET cif_beneficiar=$2, iban_beneficiar=$3 WHERE id=$1`,
      [ordId, CIF, IBAN_A]);
    const alopId = await seedAlop({ orgId: 1, createdBy: userId, status: 'plata', dfId, ordId });

    const impId = await seedImport({ orgId: 1, uploadedBy: userId });
    let i = 0;
    for (const p of parts) {
      await seedLine({ importId: impId, orgId: 1, rowIndex: ++i, nrOp: `OP-${i}`,
        ind: p.ind, iban: 'RO49 AAAA 1B31 0075 9384 0000', suma: p.suma });
    }

    const rep = await matchImport(impId);
    expect(rep.confirmed_alopuri).toEqual([alopId]);
    const a = await getAlopRow(alopId);
    expect(Number(a.plata_suma_efectiva)).toBeCloseTo(total, 2);   // suma TOTALĂ, nu primul OP
  });

  it('8. tryAutoConfirmAlop (absorbție retro) aplică ACEEAȘI regulă de IBAN', async () => {
    const { alopId } = await seedAlopPlata({ iban: IBAN_A });
    const impId = await seedImport({ orgId: 1, uploadedBy: userId });
    // linie deja încărcată, cu IBAN diferit → NU trebuie absorbită
    await seedLine({ importId: impId, orgId: 1, iban: IBAN_B });

    const out = await tryAutoConfirmAlop(alopId, { actorUserId: userId });
    expect(out.confirmed).toBe(false);
    expect((await getAlopRow(alopId)).plata_confirmed_at).toBeNull();
  });
});
