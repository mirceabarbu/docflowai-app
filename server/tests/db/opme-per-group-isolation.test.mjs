/**
 * test:db — opme-matcher: izolare tranzacțională PER GRUP (v3.9.562).
 *
 * Cerința owner: importul OPME NU are atomicitate de batch. Dacă un grup
 * eșuează, grupurile confirmate înainte RĂMÂN confirmate, iar grupul picat
 * e raportat în `errors[]` (nu se ascunde într-un 500).
 *
 * Fault injection DETERMINIST (fără 40P01 timing-flaky): un ORD primește
 * `suma_ordonantata_plata = 'BAD'` (text neparsabil). Query-ul de „expected"
 * din `_processGroup` face `::numeric` pe acea valoare → 22P02, DOAR în
 * tranzacția acelui grup. Celălalt grup (sumă validă) se confirmă normal.
 *
 * Rulează direct serviciul matchImport peste Postgres real.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedAlop } from '../helpers/db-real.mjs';
import { matchImport } from '../../services/opme-matcher.mjs';

const d = describe.skipIf(!hasTestDb());

// ── Seed helpers locale pentru OPME ──────────────────────────────────────────
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

// Construiește un grup (DF + ORD + ALOP în plata) cu tripletul dat.
async function seedGroup({ orgId, userId, cif, cod, ind, sumaOrd }) {
  const dfId = await seedDf({ orgId, createdBy: userId, status: 'aprobat', nrUnic: `DF-${cif}` });
  const ordId = await seedOrd({
    orgId, createdBy: userId, dfId,
    rows: [{ cod_angajament: cod, indicator_angajament: ind, suma_ordonantata_plata: sumaOrd }],
  });
  await setOrdCif(ordId, cif);
  const alopId = await seedAlop({ orgId, createdBy: userId, status: 'plata', dfId, ordId });
  return { dfId, ordId, alopId };
}

d('opme matchImport — izolare per-grup', () => {
  let orgId, userId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    ({ orgId, userId } = await seedOrgUser({ role: 'user' }));
  });
  afterAll(() => pool.end());

  it('un grup picat NU abortează importul: celelalte rămân confirmate + raport.errors', async () => {
    // Grup BAD: suma_ordonantata_plata neparsabilă → expected-query 22P02.
    const bad = await seedGroup({ orgId, userId, cif: '222', cod: 'CODB', ind: 'INDB', sumaOrd: 'BAD' });
    // Grup GOOD: sumă validă = suma_op → auto-confirm.
    const good = await seedGroup({ orgId, userId, cif: '111', cod: 'CODA', ind: 'INDA', sumaOrd: '100' });

    const importId = await seedImport({ orgId, uploadedBy: userId });
    // row_index 0 = BAD (procesat primul) ca să dovedim că un ROLLBACK nu strică grupul GOOD ce urmează.
    const badLineId  = await seedLine({ importId, orgId, rowIndex: 0, nrOp: '900', cod: 'CODB', ind: 'INDB', cif: '222', suma: 100 });
    const goodLineId = await seedLine({ importId, orgId, rowIndex: 1, nrOp: '901', cod: 'CODA', ind: 'INDA', cif: '111', suma: 100 });

    const rep = await matchImport(importId);

    // Grupul GOOD a fost confirmat ÎN DB.
    const goodAlop = await getAlopRow(good.alopId);
    expect(goodAlop.status).toBe('completed');
    expect(goodAlop.plata_confirmed_at).not.toBeNull();
    expect(goodAlop.plata_source).toBe('opme_auto');
    expect((await getLine(goodLineId)).match_status).toBe('auto');

    // Grupul BAD a făcut ROLLBACK: ALOP rămâne în plata, linia rămâne pending.
    const badAlop = await getAlopRow(bad.alopId);
    expect(badAlop.status).toBe('plata');
    expect(badAlop.plata_confirmed_at).toBeNull();
    expect((await getLine(badLineId)).match_status).toBe('pending');

    // Raportul reflectă rezultatul parțial.
    expect(rep.matched).toBe(1);
    expect(rep.confirmed_alopuri).toEqual([good.alopId]);
    expect(rep.error_count).toBe(1);
    expect(rep.errors).toHaveLength(1);
    expect(rep.errors[0].alop_id).toBe(bad.alopId);
    expect(rep.errors[0].reason).toBeTruthy();
  });

  it('idempotență: re-rularea NU re-confirmă grupul GOOD; grupul BAD rămâne eroare', async () => {
    const bad = await seedGroup({ orgId, userId, cif: '222', cod: 'CODB', ind: 'INDB', sumaOrd: 'BAD' });
    const good = await seedGroup({ orgId, userId, cif: '111', cod: 'CODA', ind: 'INDA', sumaOrd: '100' });

    const importId = await seedImport({ orgId, uploadedBy: userId });
    await seedLine({ importId, orgId, rowIndex: 0, nrOp: '900', cod: 'CODB', ind: 'INDB', cif: '222', suma: 100 });
    await seedLine({ importId, orgId, rowIndex: 1, nrOp: '901', cod: 'CODA', ind: 'INDA', cif: '111', suma: 100 });

    await matchImport(importId);
    const confirmedAt1 = (await getAlopRow(good.alopId)).plata_confirmed_at;

    // A doua rulare: linia GOOD e deja 'auto' (nu mai e pending) → grupul nu se re-procesează.
    const rep2 = await matchImport(importId);

    const goodAlop2 = await getAlopRow(good.alopId);
    expect(goodAlop2.status).toBe('completed');
    // confirmarea NU s-a re-scris (idempotență prin garda status='plata' AND plata_confirmed_at IS NULL)
    expect(goodAlop2.plata_confirmed_at.getTime()).toBe(confirmedAt1.getTime());
    expect(rep2.matched).toBe(0);
    // grupul BAD (linie încă pending) re-eșuează, raportat din nou
    expect(rep2.error_count).toBe(1);
    expect(rep2.errors[0].alop_id).toBe(bad.alopId);
    // ALOP-ul BAD tot în plata
    expect((await getAlopRow(bad.alopId)).status).toBe('plata');
  });
});
