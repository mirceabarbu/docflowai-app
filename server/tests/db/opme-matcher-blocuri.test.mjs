/**
 * test:db — #128d: `opme-matcher` conștient de BLOCURI (un ORD, N beneficiari).
 *
 * Până la #128d matcher-ul citea `cif_beneficiar` / `iban_beneficiar` ca pe niște coloane
 * plate UNICE și lua tripletele din TOATE rândurile ORD-ului. Cu blocuri multiple asta
 * produce sub-numărare TĂCUTĂ (clasa de bug #115). Acum potrivirea e per PROFIL de bloc:
 * (cif, iban, tripletele rândurilor SALE).
 *
 * ⛔ Modelul de confirmare rămâne NESCHIMBAT: `expected` = valoarea TOTALĂ a ORD-ului
 *    (toate blocurile), confirmare O SINGURĂ DATĂ când `actual === expected`, `FOR UPDATE`
 *    pe ALOP, `plata_source='opme_auto'`, aceleași coduri de rezultat.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedAlop } from '../helpers/db-real.mjs';
import { matchImport, tryAutoConfirmAlop } from '../../services/opme-matcher.mjs';

const d = describe.skipIf(!hasTestDb());

const CIF_A = '8971726';
const CIF_B = '14399840';
const COD   = 'AAB358M476X';
const T1    = 'AAB';          // indicator blocul 0
const T2    = 'AA2';          // indicator blocul 1
const IBAN_A = 'RO49AAAA1B31007593840000';
const IBAN_B = 'RO12BTRL1234567890123456';
const IBAN_X = 'RO66INGB0000999900112233';   // al nimănui

async function seedImport({ orgId, uploadedBy, nrDocument = '0000130' }) {
  const { rows } = await pool.query(
    `INSERT INTO opme_imports (org_id, uploaded_by, file_hash, file_name, nr_document, data_op)
     VALUES ($1,$2,$3,'f1129.pdf',$4, DATE '2026-05-06') RETURNING id`,
    [orgId, uploadedBy, 'hash-' + Math.random().toString(36).slice(2), nrDocument]
  );
  return rows[0].id;
}
async function seedLine({ importId, orgId, rowIndex = 1, nrOp = '123', cod = COD, ind = T1,
                          cif = CIF_A, iban = null, suma = 1000 }) {
  const { rows } = await pool.query(
    `INSERT INTO opme_lines (opme_import_id, org_id, row_index, nr_op, cod_angajament,
                             indicator_angajament, cif_beneficiar, iban_beneficiar, suma_op)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [importId, orgId, rowIndex, nrOp, cod, ind, cif, iban, suma]
  );
  return rows[0].id;
}
const getLine = async (id) =>
  (await pool.query('SELECT * FROM opme_lines WHERE id=$1', [id])).rows[0];
const getAlopRow = async (id) =>
  (await pool.query('SELECT * FROM alop_instances WHERE id=$1', [id])).rows[0];

d('#128d — OPME matcher conștient de blocuri', () => {
  let userId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    const s = await seedOrgUser({ role: 'user', email: 'p1@x.ro' });
    userId = s.userId;
  });
  afterAll(() => pool.end());

  /**
   * ORD LEGACY: `blocuri` NULL, un singur beneficiar pe coloanele plate — exact forma
   * documentelor din producția de azi.
   */
  async function seedAlopLegacy({ nrUnic = 'DF-L', iban = IBAN_A, cif = CIF_A,
                                  rows = [{ cod_angajament: COD, indicator_angajament: T1, suma_ordonantata_plata: 1000 }] } = {}) {
    const dfId  = await seedDf({ orgId: 1, createdBy: userId, status: 'aprobat', nrUnic });
    const ordId = await seedOrd({ orgId: 1, createdBy: userId, dfId, nrOrd: `ORD-${nrUnic}`, rows });
    await pool.query(
      `UPDATE formulare_ord SET cif_beneficiar=$2, iban_beneficiar=$3, blocuri=NULL WHERE id=$1`,
      [ordId, cif, iban]);
    const alopId = await seedAlop({ orgId: 1, createdBy: userId, status: 'plata', dfId, ordId });
    return { alopId, ordId, dfId };
  }

  /**
   * ORD MULTI-BLOC: blocul 0 (CIF A / IBAN A / triplet T1) + blocul 1 (CIF B / IBAN B / T2).
   * Coloanele plate rămân oglinda blocului 1 (#128c) — matcher-ul NU trebuie să le citească
   * ca sursă unică de adevăr.
   */
  async function seedAlopDouaBlocuri({ nrUnic = 'DF-2B', sumaA = 100, sumaB = 220,
                                       ibanBloc0 = IBAN_A, ibanBloc1 = IBAN_B,
                                       cifBloc0 = CIF_A, cifBloc1 = CIF_B } = {}) {
    const dfId  = await seedDf({ orgId: 1, createdBy: userId, status: 'aprobat', nrUnic });
    const ordId = await seedOrd({ orgId: 1, createdBy: userId, dfId, nrOrd: `ORD-${nrUnic}`, rows: [
      { bloc_idx: 0, cod_angajament: COD, indicator_angajament: T1, suma_ordonantata_plata: sumaA },
      { bloc_idx: 1, cod_angajament: COD, indicator_angajament: T2, suma_ordonantata_plata: sumaB },
    ] });
    const blocuri = [
      { bloc_idx: 0, beneficiar: 'Furnizor A', cif_beneficiar: cifBloc0, iban_beneficiar: ibanBloc0 },
      { bloc_idx: 1, beneficiar: 'Furnizor B', cif_beneficiar: cifBloc1, iban_beneficiar: ibanBloc1 },
    ];
    await pool.query(
      `UPDATE formulare_ord SET blocuri=$2::jsonb, cif_beneficiar=$3, iban_beneficiar=$4 WHERE id=$1`,
      [ordId, JSON.stringify(blocuri), cifBloc0 ?? '', ibanBloc0 ?? '']);
    const alopId = await seedAlop({ orgId: 1, createdBy: userId, status: 'plata', dfId, ordId });
    return { alopId, ordId, dfId };
  }

  // ── 1 ⭐ NON-REGRESIE: comportamentul ORD-urilor de azi rămâne bit-identic ─────────────
  it('1. ⭐ ORD legacy (blocuri NULL, un beneficiar) — potrivire + confirmare NESCHIMBATE', async () => {
    const { alopId } = await seedAlopLegacy();
    const impId  = await seedImport({ orgId: 1, uploadedBy: userId });
    const lineId = await seedLine({ importId: impId, orgId: 1, iban: IBAN_A, suma: 1000 });

    const rep = await matchImport(impId);
    expect(rep.confirmed_alopuri).toEqual([alopId]);
    expect(rep.matched).toBe(1);
    expect(rep.ambiguous).toBe(0);
    expect(rep.unmatched).toBe(0);

    const ln = await getLine(lineId);
    expect(ln.match_status).toBe('auto');
    expect(ln.matched_alop_id).toBe(alopId);

    const a = await getAlopRow(alopId);
    expect(a.plata_confirmed_at).not.toBeNull();
    expect(Number(a.plata_suma_efectiva)).toBeCloseTo(1000, 2);
    expect(a.plata_source).toBe('opme_auto');
  });

  it('1b. ⭐ legacy multi-indicator, un beneficiar — suma agregată identică (non-regresie #115)', async () => {
    const parts = [{ ind: T1, suma: 836.69 }, { ind: T2, suma: 84.70 }, { ind: 'AA3', suma: 393.25 }];
    const { alopId } = await seedAlopLegacy({ nrUnic: 'DF-LM', rows: parts.map(p => ({
      cod_angajament: COD, indicator_angajament: p.ind, suma_ordonantata_plata: p.suma })) });
    const impId = await seedImport({ orgId: 1, uploadedBy: userId });
    let i = 0;
    for (const p of parts) {
      await seedLine({ importId: impId, orgId: 1, rowIndex: ++i, nrOp: `OP-${i}`,
        ind: p.ind, iban: IBAN_A, suma: p.suma });
    }
    const rep = await matchImport(impId);
    expect(rep.confirmed_alopuri).toEqual([alopId]);
    expect(Number((await getAlopRow(alopId)).plata_suma_efectiva)).toBeCloseTo(1314.64, 2);
  });

  // ── 2 ⭐ ACCEPTANȚA lotului: doi furnizori, plată completă, o singură confirmare ───────
  it('2. ⭐ două blocuri / doi furnizori, plată completă ⇒ ALOP confirmat O SINGURĂ DATĂ cu suma totală', async () => {
    const { alopId } = await seedAlopDouaBlocuri({ sumaA: 100, sumaB: 220 });
    const impId = await seedImport({ orgId: 1, uploadedBy: userId });
    const lA = await seedLine({ importId: impId, orgId: 1, rowIndex: 1, nrOp: 'OP-A',
      cif: CIF_A, ind: T1, iban: IBAN_A, suma: 100 });
    const lB = await seedLine({ importId: impId, orgId: 1, rowIndex: 2, nrOp: 'OP-B',
      cif: CIF_B, ind: T2, iban: IBAN_B, suma: 220 });

    const rep = await matchImport(impId);
    // O SINGURĂ confirmare, deși liniile vin de la doi beneficiari diferiți.
    expect(rep.confirmed_alopuri).toEqual([alopId]);
    expect(rep.matched).toBe(2);
    expect(rep.partial).toBe(0);
    expect(rep.unmatched).toBe(0);

    const det = rep.details.find(x => x.alop_id === alopId);
    expect(det.result).toBe('matched');
    expect(Number(det.expected)).toBeCloseTo(320, 2);   // expected = TOTAL ORD, nu per bloc
    expect(Number(det.actual)).toBeCloseTo(320, 2);

    const a = await getAlopRow(alopId);
    expect(a.plata_confirmed_at).not.toBeNull();
    expect(Number(a.plata_suma_efectiva)).toBeCloseTo(320, 2);
    expect(a.plata_source).toBe('opme_auto');
    expect((await getLine(lA)).match_status).toBe('auto');
    expect((await getLine(lB)).match_status).toBe('auto');
  });

  // ── 3. Plată parțială pe multi-bloc ──────────────────────────────────────────────────
  it('3. doar furnizorul A a fost plătit ⇒ partial, ALOP rămâne în „plata" neconfirmat', async () => {
    const { alopId } = await seedAlopDouaBlocuri({ nrUnic: 'DF-P', sumaA: 100, sumaB: 220 });
    const impId = await seedImport({ orgId: 1, uploadedBy: userId });
    const lA = await seedLine({ importId: impId, orgId: 1, nrOp: 'OP-A',
      cif: CIF_A, ind: T1, iban: IBAN_A, suma: 100 });

    const rep = await matchImport(impId);
    expect(rep.confirmed_alopuri).toEqual([]);
    expect(rep.partial).toBe(1);
    const det = rep.details.find(x => x.alop_id === alopId);
    expect(det.result).toBe('partial');
    expect(Number(det.expected)).toBeCloseTo(320, 2);
    expect(Number(det.actual)).toBeCloseTo(100, 2);

    expect((await getLine(lA)).match_status).toBe('partial');
    const a = await getAlopRow(alopId);
    expect(a.status).toBe('plata');
    expect(a.plata_confirmed_at).toBeNull();
  });

  // ── 4 ⭐ ACCEPTANȚA lotului: IBAN-ul se compară cu blocul LINIEI, nu cu blocul 0 ──────
  it('4. ⭐ IBAN per bloc — linia furnizorului B trece cu IBAN-ul blocului 1, deși diferă de blocul 0', async () => {
    // Blocul 0 are IBAN_A; înainte de #128d un mismatch pe el respingea linia GLOBAL.
    const { alopId } = await seedAlopDouaBlocuri({ nrUnic: 'DF-IB', sumaA: 100, sumaB: 220 });
    const impId = await seedImport({ orgId: 1, uploadedBy: userId });
    const lB = await seedLine({ importId: impId, orgId: 1, nrOp: 'OP-B',
      cif: CIF_B, ind: T2, iban: IBAN_B, suma: 220 });

    const rep = await matchImport(impId);
    expect(rep.unmatched).toBe(0);                       // NU respinsă de IBAN-ul blocului 0
    const ln = await getLine(lB);
    expect(ln.matched_alop_id).toBe(alopId);
    expect(ln.match_status).toBe('partial');             // 220 din 320 — potrivită, dar incompletă
    const det = rep.details.find(x => x.alop_id === alopId);
    expect(Number(det.actual)).toBeCloseTo(220, 2);
  });

  it('4b. IBAN normalizat per bloc (spații / minuscule) ⇒ tot potrivire', async () => {
    const { alopId } = await seedAlopDouaBlocuri({ nrUnic: 'DF-IBN',
      ibanBloc1: 'RO12 BTRL 1234 5678 9012 3456' });
    const impId = await seedImport({ orgId: 1, uploadedBy: userId });
    const lA = await seedLine({ importId: impId, orgId: 1, rowIndex: 1, nrOp: 'OP-A',
      cif: CIF_A, ind: T1, iban: IBAN_A, suma: 100 });
    const lB = await seedLine({ importId: impId, orgId: 1, rowIndex: 2, nrOp: 'OP-B',
      cif: CIF_B, ind: T2, iban: 'ro12btrl1234567890123456', suma: 220 });

    const rep = await matchImport(impId);
    expect(rep.confirmed_alopuri).toEqual([alopId]);
    expect((await getLine(lA)).match_status).toBe('auto');
    expect((await getLine(lB)).match_status).toBe('auto');
  });

  // ── 5. IBAN care nu e al niciunui bloc ⇒ respins ─────────────────────────────────────
  it('5. IBAN al nimănui ⇒ linia respinsă (unmatched), cu motivul „IBAN diferit"', async () => {
    const { alopId } = await seedAlopDouaBlocuri({ nrUnic: 'DF-IBX' });
    const impId = await seedImport({ orgId: 1, uploadedBy: userId });
    const lB = await seedLine({ importId: impId, orgId: 1, nrOp: 'OP-B',
      cif: CIF_B, ind: T2, iban: IBAN_X, suma: 220 });

    const rep = await matchImport(impId);
    expect(rep.unmatched).toBe(1);
    expect(rep.confirmed_alopuri).toEqual([]);
    const ln = await getLine(lB);
    expect(ln.match_status).toBe('unmatched');
    expect(ln.match_notes).toMatch(/IBAN diferit/i);     // contorul ibanRespinse a fost incrementat
    expect((await getAlopRow(alopId)).plata_confirmed_at).toBeNull();
  });

  // ── 6. Combinație încrucișată: triplet dintr-un bloc, CIF din altul ──────────────────
  it('6. triplet al blocului 0 + CIF-ul blocului 1 (combinație inexistentă) ⇒ NEPOTRIVITĂ', async () => {
    const { alopId } = await seedAlopDouaBlocuri({ nrUnic: 'DF-X' });
    const impId = await seedImport({ orgId: 1, uploadedBy: userId });
    // CIF B (blocul 1) + indicatorul T1 (care aparține blocului 0) + IBAN B.
    const lX = await seedLine({ importId: impId, orgId: 1, nrOp: 'OP-X',
      cif: CIF_B, ind: T1, iban: IBAN_B, suma: 100 });

    const rep = await matchImport(impId);
    expect(rep.confirmed_alopuri).toEqual([]);
    expect(rep.unmatched).toBe(1);
    const ln = await getLine(lX);
    expect(ln.match_status).toBe('unmatched');
    expect(ln.matched_alop_id).toBeNull();
    expect((await getAlopRow(alopId)).plata_confirmed_at).toBeNull();
  });

  // ── 7. `ambiguous` neschimbat ────────────────────────────────────────────────────────
  it('7. două ALOP distincte cu același CIF + triplet (fără IBAN) ⇒ ambiguous, mesaj neschimbat', async () => {
    await seedAlopLegacy({ nrUnic: 'DF-AM1', iban: null });
    await seedAlopLegacy({ nrUnic: 'DF-AM2', iban: null });
    const impId  = await seedImport({ orgId: 1, uploadedBy: userId });
    const lineId = await seedLine({ importId: impId, orgId: 1, iban: null, suma: 1000 });

    const rep = await matchImport(impId);
    expect(rep.ambiguous).toBe(1);
    expect(rep.confirmed_alopuri).toEqual([]);
    const ln = await getLine(lineId);
    expect(ln.match_status).toBe('ambiguous');
    expect(ln.match_notes).toMatch(/^Mai multe ALOP active potrivite: /);
  });

  // ── 8. Bloc fără CIF (document incomplet) ────────────────────────────────────────────
  it('8. bloc fără CIF ⇒ profilul e ignorat, restul blocurilor funcționează normal', async () => {
    // Blocul 0 e incomplet (fără CIF/IBAN); blocul 1 e valid. Suma ORD = 320.
    const { alopId } = await seedAlopDouaBlocuri({ nrUnic: 'DF-NOCIF',
      cifBloc0: '', ibanBloc0: '' });
    const impId = await seedImport({ orgId: 1, uploadedBy: userId });
    const lB = await seedLine({ importId: impId, orgId: 1, nrOp: 'OP-B',
      cif: CIF_B, ind: T2, iban: IBAN_B, suma: 220 });

    const rep = await matchImport(impId);
    expect(rep.unmatched).toBe(0);
    const ln = await getLine(lB);
    expect(ln.matched_alop_id).toBe(alopId);             // blocul 1 a potrivit
    const det = rep.details.find(x => x.alop_id === alopId);
    expect(det.result).toBe('partial');                  // 220 din 320 (blocul 0 rămâne neplătit)
    expect(Number(det.actual)).toBeCloseTo(220, 2);
  });

  // ── 9. Absorbția retro aplică ACEEAȘI regulă per bloc ────────────────────────────────
  it('9. tryAutoConfirmAlop absoarbe retro liniile ambilor furnizori (aceeași regulă per bloc)', async () => {
    const { alopId } = await seedAlopDouaBlocuri({ nrUnic: 'DF-RETRO', sumaA: 100, sumaB: 220 });
    const impId = await seedImport({ orgId: 1, uploadedBy: userId });
    await seedLine({ importId: impId, orgId: 1, rowIndex: 1, nrOp: 'OP-A',
      cif: CIF_A, ind: T1, iban: IBAN_A, suma: 100 });
    await seedLine({ importId: impId, orgId: 1, rowIndex: 2, nrOp: 'OP-B',
      cif: CIF_B, ind: T2, iban: IBAN_B, suma: 220 });

    const out = await tryAutoConfirmAlop(alopId, { actorUserId: userId });
    expect(out.confirmed).toBe(true);
    const a = await getAlopRow(alopId);
    expect(Number(a.plata_suma_efectiva)).toBeCloseTo(320, 2);
    expect(a.plata_source).toBe('opme_auto');
  });
});
