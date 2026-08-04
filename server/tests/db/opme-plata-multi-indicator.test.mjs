/**
 * test:db — opme-matcher: plată OPME pe ORD cu MAI MULȚI indicatori de angajament
 * (fix v3.9.745, prompt #115).
 *
 * Bug: un ORD cu N rânduri (N indicatori distincți, ex. AAB/AA2/AA3/AA4/AA5) plătit
 * de N OP-uri separate se confirma la PRIMUL triplet matchat, iar garda
 * `WHERE status='plata' AND plata_confirmed_at IS NULL` bloca restul → doar prima
 * plată intra în `plata_suma_efectiva`, restul „dispăreau" (linii marcate matched,
 * dar suma lor nu se aduna).
 *
 * Fix: unitatea de confirmare devine ALOP-ul întreg (`_processAlop`) — expected =
 * SUM peste TOATE rândurile ORD, actual = SUM peste toate liniile OPME care
 * matchează CIF-ul + oricare triplet al ORD-ului. Confirmă o singură dată cu
 * suma TOTALĂ.
 *
 * Rulează pe Postgres 17 efemer (vezi CLAUDE.md §test:db).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedAlop } from '../helpers/db-real.mjs';
import { tryAutoConfirmAlop } from '../../services/opme-matcher.mjs';

const d = describe.skipIf(!hasTestDb());

// ── Seed helpers locale pentru OPME (identice cu opme-per-group-isolation.test.mjs) ──
async function seedImport({ orgId, uploadedBy, nrDocument = '0000130' }) {
  const { rows } = await pool.query(
    `INSERT INTO opme_imports (org_id, uploaded_by, file_hash, file_name, nr_document, data_op)
     VALUES ($1,$2,$3,'f1129.pdf',$4, DATE '2026-05-06') RETURNING id`,
    [orgId, uploadedBy, 'hash-' + Math.random().toString(36).slice(2), nrDocument]
  );
  return rows[0].id;
}
async function seedLine({ importId, orgId, rowIndex, nrOp, cod, ind, cif, suma }) {
  const { rows } = await pool.query(
    `INSERT INTO opme_lines
       (opme_import_id, org_id, row_index, nr_op, cod_angajament, indicator_angajament, cif_beneficiar, suma_op)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [importId, orgId, rowIndex, nrOp, cod, ind, cif, suma]
  );
  return rows[0].id;
}
async function setOrdCif(ordId, cif) {
  await pool.query(`UPDATE formulare_ord SET cif_beneficiar=$2 WHERE id=$1`, [ordId, cif]);
}
async function getLine(id) {
  const { rows } = await pool.query(`SELECT * FROM opme_lines WHERE id=$1`, [id]);
  return rows[0];
}
async function getAlopRow(id) {
  const { rows } = await pool.query(`SELECT * FROM alop_instances WHERE id=$1`, [id]);
  return rows[0];
}

const CIF = '8971726';
const COD = 'AAB358M476X';
// 5 indicatori distincți, aceeași cod_angajament + cif → total 1314.64
const INDICATORS = [
  { ind: 'AAB', suma: 836.69 },
  { ind: 'AA2', suma: 84.70 },
  { ind: 'AA3', suma: 84.70 },
  { ind: 'AA4', suma: 266.20 },
  { ind: 'AA5', suma: 42.35 },
];
const TOTAL = 1314.64;

async function seedMultiIndicatorAlop({ orgId, userId }) {
  const dfId = await seedDf({ orgId, createdBy: userId, status: 'aprobat', nrUnic: `DF-${CIF}` });
  const ordId = await seedOrd({
    orgId, createdBy: userId, dfId,
    rows: INDICATORS.map(({ ind, suma }) => ({
      cod_angajament: COD, indicator_angajament: ind, suma_ordonantata_plata: suma,
    })),
  });
  await setOrdCif(ordId, CIF);
  const alopId = await seedAlop({ orgId, createdBy: userId, status: 'plata', dfId, ordId });
  return { dfId, ordId, alopId };
}

d('opme plată — ORD cu mai mulți indicatori de angajament (v3.9.745)', () => {
  let orgId, userId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    ({ orgId, userId } = await seedOrgUser({ role: 'user' }));
  });
  afterAll(() => pool.end());

  it('confirmă o singură dată cu suma TOTALĂ a celor 5 OP-uri', async () => {
    const { alopId } = await seedMultiIndicatorAlop({ orgId, userId });
    const importId = await seedImport({ orgId, uploadedBy: userId });

    const lineIds = [];
    for (let i = 0; i < INDICATORS.length; i++) {
      const { ind, suma } = INDICATORS[i];
      const id = await seedLine({
        importId, orgId, rowIndex: i, nrOp: String(2333 + i),
        cod: COD, ind, cif: CIF, suma,
      });
      lineIds.push(id);
    }

    const out = await tryAutoConfirmAlop(alopId);
    expect(out.confirmed).toBe(true);
    expect(out.reason).toBe('matched');

    const alop = await getAlopRow(alopId);
    expect(alop.status).toBe('completed');
    expect(alop.plata_confirmed_at).not.toBeNull();
    expect(Number(alop.plata_suma_efectiva)).toBeCloseTo(TOTAL, 2);
    for (let i = 0; i < INDICATORS.length; i++) {
      expect(alop.plata_nr_ordin).toContain(String(2333 + i));
    }

    for (const id of lineIds) {
      const line = await getLine(id);
      expect(line.match_status).toBe('auto');
      expect(line.matched_alop_id).toBe(alopId);
    }
  });

  it('plată parțială când lipsesc OP-uri, apoi absoarbe restul la re-apel', async () => {
    const { alopId } = await seedMultiIndicatorAlop({ orgId, userId });
    const importId = await seedImport({ orgId, uploadedBy: userId });

    // Doar 3 din 5 linii pending.
    const first3 = INDICATORS.slice(0, 3);
    const first3Ids = [];
    for (let i = 0; i < first3.length; i++) {
      const { ind, suma } = first3[i];
      const id = await seedLine({
        importId, orgId, rowIndex: i, nrOp: String(2333 + i),
        cod: COD, ind, cif: CIF, suma,
      });
      first3Ids.push(id);
    }

    const out1 = await tryAutoConfirmAlop(alopId);
    expect(out1.confirmed).toBe(false);

    let alop = await getAlopRow(alopId);
    expect(alop.status).toBe('plata');
    expect(alop.plata_suma_efectiva).toBeNull();
    for (const id of first3Ids) {
      const line = await getLine(id);
      expect(line.match_status).toBe('partial');
    }

    // Adaugă celelalte 2 linii pending.
    const rest2 = INDICATORS.slice(3);
    for (let i = 0; i < rest2.length; i++) {
      const { ind, suma } = rest2[i];
      await seedLine({
        importId, orgId, rowIndex: 3 + i, nrOp: String(2333 + 3 + i),
        cod: COD, ind, cif: CIF, suma,
      });
    }

    const out2 = await tryAutoConfirmAlop(alopId);
    expect(out2.confirmed).toBe(true);

    alop = await getAlopRow(alopId);
    expect(alop.status).toBe('completed');
    expect(Number(alop.plata_suma_efectiva)).toBeCloseTo(TOTAL, 2);
  });

  it('regresie: ORD cu un singur indicator confirmă normal (comportament neschimbat)', async () => {
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'aprobat', nrUnic: 'DF-SINGLE' });
    const ordId = await seedOrd({
      orgId, createdBy: userId, dfId,
      rows: [{ cod_angajament: 'CODX', indicator_angajament: 'IND1', suma_ordonantata_plata: 500 }],
    });
    await setOrdCif(ordId, '111222333');
    const alopId = await seedAlop({ orgId, createdBy: userId, status: 'plata', dfId, ordId });

    const importId = await seedImport({ orgId, uploadedBy: userId });
    await seedLine({
      importId, orgId, rowIndex: 0, nrOp: '5000',
      cod: 'CODX', ind: 'IND1', cif: '111222333', suma: 500,
    });

    const out = await tryAutoConfirmAlop(alopId);
    expect(out.confirmed).toBe(true);

    const alop = await getAlopRow(alopId);
    expect(alop.status).toBe('completed');
    expect(Number(alop.plata_suma_efectiva)).toBeCloseTo(500, 2);
  });
});
