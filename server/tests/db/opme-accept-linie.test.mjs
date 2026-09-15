/**
 * test:db — #209 Etapa A: acceptarea unei linii OPME respinse de responsabilul CAB.
 *
 * Incident producție (15.09.2026): furnizor plătit din DOUĂ conturi — OP 2791 (19.164,51,
 * `partial`) + OP 2792 (1.726,53, `unmatched`, „IBAN diferit") = 20.891,04, exact valoarea
 * ORD-ului. Matcher-ul confirmă doar când actual === expected ⇒ nu avea cale de finalizare.
 *
 * Ruta `POST /api/opme/lines/:id/accept` marchează linia 'manual' (motiv scris, nota veche
 * păstrată, audit) și recheamă matcher-ul ÎN ACEEAȘI TRANZACȚIE — confirmarea rămâne a lui.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, seedOrd, seedAlop, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

const CAB = 'Contabilitate';
const ALT = 'Achizitii';
const CIF = '31306329';
const COD = 'AAB3AE5XPX3';
const IND = 'AAB';
const IBAN_ORD   = 'RO49TREZ0000000000000001';
const IBAN_ALT   = 'RO12BTRL0000000000000002';
const TOTAL      = 20891.04;
const SUMA_A     = 19164.51;
const SUMA_B     = 1726.53;

async function seedImport({ orgId, uploadedBy, nrDocument = '0000903' }) {
  const { rows } = await pool.query(
    `INSERT INTO opme_imports (org_id, uploaded_by, file_hash, file_name, nr_document, data_op)
     VALUES ($1,$2,$3,'f1129.pdf',$4, DATE '2026-09-03') RETURNING id`,
    [orgId, uploadedBy, 'hash-' + Math.random().toString(36).slice(2), nrDocument]
  );
  return rows[0].id;
}
async function seedLine({ importId, orgId, rowIndex = 1, nrOp, cod = COD, ind = IND, cif = CIF,
                          iban = null, suma, status = 'pending', alopId = null, notes = null }) {
  const { rows } = await pool.query(
    `INSERT INTO opme_lines (opme_import_id, org_id, row_index, nr_op, cod_angajament,
                             indicator_angajament, cif_beneficiar, iban_beneficiar, suma_op,
                             match_status, matched_alop_id, match_notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [importId, orgId, rowIndex, nrOp, cod, ind, cif, iban, suma, status, alopId, notes]
  );
  return rows[0].id;
}
const getLine = async (id) => (await pool.query('SELECT * FROM opme_lines WHERE id=$1', [id])).rows[0];
const getAlop = async (id) => (await pool.query('SELECT * FROM alop_instances WHERE id=$1', [id])).rows[0];
const audit = async (type, alopId) => (await pool.query(
  `SELECT * FROM audit_log WHERE event_type=$1 AND payload->>'alop_id'=$2 ORDER BY created_at DESC`,
  [type, alopId])).rows;

d('#209 A — POST /api/opme/lines/:id/accept', () => {
  let app, initId, cabId, altId;

  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await pool.query(`DELETE FROM opme_lines; DELETE FROM opme_imports;`);
    const s = await seedOrgUser({ role: 'user', email: 'init@x.ro', compartiment: ALT });
    initId = s.userId;
    cabId  = await seedUser({ orgId: 1, email: 'cab@x.ro', compartiment: CAB, nume: 'CAB' });
    altId  = await seedUser({ orgId: 1, email: 'alt@x.ro', compartiment: ALT, nume: 'ALT' });
    await pool.query('UPDATE organizations SET cab_compartiment=$2 WHERE id=$1', [1, CAB]);
    app = buildApp();
  });
  afterAll(() => pool.end());

  const ck = (userId, role = 'user') => makeAuthCookie({ userId, role, orgId: 1, email: `u${userId}@x.ro` });

  // Scenariul 8836: ORD 20.891,04 cu IBAN; linie A (partial, legată) + linie B (unmatched, IBAN diferit).
  async function seedScenariu8836({ ordTotal = TOTAL } = {}) {
    const dfId  = await seedDf({ orgId: 1, createdBy: initId, status: 'aprobat' });
    const ordId = await seedOrd({ orgId: 1, createdBy: initId, dfId,
      rows: [{ cod_angajament: COD, indicator_angajament: IND, suma_ordonantata_plata: ordTotal }] });
    await pool.query('UPDATE formulare_ord SET cif_beneficiar=$2, iban_beneficiar=$3 WHERE id=$1',
      [ordId, CIF, IBAN_ORD]);
    const alopId = await seedAlop({ orgId: 1, createdBy: initId, status: 'plata', dfId, ordId, compartiment: ALT });
    const importId = await seedImport({ orgId: 1, uploadedBy: initId });
    const lineA = await seedLine({ importId, orgId: 1, rowIndex: 1, nrOp: '2791', iban: IBAN_ORD, suma: SUMA_A,
      status: 'partial', alopId, notes: 'Plată parțială 19164.51 din 20891.04 RON' });
    const lineB = await seedLine({ importId, orgId: 1, rowIndex: 2, nrOp: '2792', iban: IBAN_ALT, suma: SUMA_B,
      status: 'unmatched', notes: 'IBAN diferit față de ordonanțare (beneficiar și triplet potrivite)' });
    return { alopId, ordId, importId, lineA, lineB };
  }

  const MOTIV = 'Verificat extrasul de cont: IBAN secundar al aceluiași furnizor.';

  it('1. ⭐ scenariul 8836: CAB acceptă linia B ⇒ matcher-ul confirmă cu 20.891,04 și AMBELE OP-uri', async () => {
    const { alopId, lineA, lineB } = await seedScenariu8836();
    const res = await request(app).post(`/api/opme/lines/${lineB}/accept`)
      .set('Cookie', ck(cabId)).send({ alopId, motiv: MOTIV });
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('matched');

    const a = await getAlop(alopId);
    expect(a.status).toBe('completed');
    expect(Number(a.plata_suma_efectiva)).toBeCloseTo(TOTAL, 2);
    expect(a.plata_nr_ordin).toContain('2791');
    expect(a.plata_nr_ordin).toContain('2792');
    expect(a.plata_source).toBe('opme_auto');

    const la = await getLine(lineA);
    const lb = await getLine(lineB);
    expect(la.match_status).toBe('auto');
    expect(la.matched_alop_id).toBe(alopId);
    expect(lb.match_status).toBe('manual');
    expect(lb.matched_alop_id).toBe(alopId);
    // audit-ul acceptării
    const ev = await audit('opme_line_accepted_manual', alopId);
    expect(ev.length).toBe(1);
    expect(ev[0].payload.match_status_vechi).toBe('unmatched');
    expect(ev[0].payload.motiv).toBe(MOTIV);
    expect(ev[0].payload.nr_op).toBe('2792');
  });

  it('2. ⭐ non-CAB ⇒ 403 doar_responsabil_cab, zero scrieri', async () => {
    const { alopId, lineB } = await seedScenariu8836();
    for (const uid of [initId, altId]) {
      const res = await request(app).post(`/api/opme/lines/${lineB}/accept`)
        .set('Cookie', ck(uid)).send({ alopId, motiv: MOTIV });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('doar_responsabil_cab');
    }
    const lb = await getLine(lineB);
    expect(lb.match_status).toBe('unmatched');
    expect(lb.matched_alop_id).toBeNull();
    expect((await getAlop(alopId)).status).toBe('plata');
    expect((await audit('opme_line_accepted_manual', alopId)).length).toBe(0);
  });

  it('3. linie deja potrivită (auto/manual) ⇒ 409 deja_potrivita', async () => {
    const { alopId, importId } = await seedScenariu8836();
    const lAuto = await seedLine({ importId, orgId: 1, rowIndex: 3, nrOp: '9001', suma: 1, status: 'auto', alopId });
    const lMan  = await seedLine({ importId, orgId: 1, rowIndex: 4, nrOp: '9002', suma: 1, status: 'manual', alopId });
    for (const id of [lAuto, lMan]) {
      const res = await request(app).post(`/api/opme/lines/${id}/accept`)
        .set('Cookie', ck(cabId)).send({ alopId, motiv: MOTIV });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('deja_potrivita');
    }
  });

  it('4. ⭐ linie din ALTĂ organizație ⇒ 404, zero scrieri', async () => {
    const { alopId } = await seedScenariu8836();
    // org 2 cu propria linie
    const { rows: o2 } = await pool.query(
      `INSERT INTO organizations (name, cab_compartiment) VALUES ('Org 2', $1) RETURNING id`, [CAB]);
    const org2 = o2[0].id;
    const u2 = await seedUser({ orgId: org2, email: 'cab2@x.ro', compartiment: CAB, nume: 'CAB2' });
    const imp2 = await seedImport({ orgId: org2, uploadedBy: u2 });
    const lineOrg2 = await seedLine({ importId: imp2, orgId: org2, rowIndex: 1, nrOp: '7777', suma: SUMA_B,
      status: 'unmatched', iban: IBAN_ALT });

    // CAB-ul din org 1 încearcă să lege linia org-ului 2 de dosarul org-ului 1
    const r1 = await request(app).post(`/api/opme/lines/${lineOrg2}/accept`)
      .set('Cookie', ck(cabId)).send({ alopId, motiv: MOTIV });
    expect(r1.status).toBe(404);
    // CAB-ul din org 2 încearcă să-și lege linia de dosarul org-ului 1
    const r2 = await request(app).post(`/api/opme/lines/${lineOrg2}/accept`)
      .set('Cookie', makeAuthCookie({ userId: u2, role: 'user', orgId: org2, email: 'cab2@x.ro' }))
      .send({ alopId, motiv: MOTIV });
    expect(r2.status).toBe(404);

    const l = await getLine(lineOrg2);
    expect(l.match_status).toBe('unmatched');
    expect(l.matched_alop_id).toBeNull();
    expect((await getAlop(alopId)).status).toBe('plata');
  });

  it('5. motiv lipsă sau sub 10 caractere ⇒ 400, zero scrieri', async () => {
    const { alopId, lineB } = await seedScenariu8836();
    for (const body of [{ alopId }, { alopId, motiv: '' }, { alopId, motiv: 'scurt' }]) {
      const res = await request(app).post(`/api/opme/lines/${lineB}/accept`)
        .set('Cookie', ck(cabId)).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('motiv_obligatoriu');
    }
    expect((await getLine(lineB)).match_status).toBe('unmatched');
    expect((await getAlop(alopId)).status).toBe('plata');
  });

  it('6. ⭐ nota veche se PĂSTREAZĂ în match_notes, alături de motiv și de actor', async () => {
    const { alopId, lineB } = await seedScenariu8836();
    const res = await request(app).post(`/api/opme/lines/${lineB}/accept`)
      .set('Cookie', ck(cabId)).send({ alopId, motiv: MOTIV });
    expect(res.status).toBe(200);
    const lb = await getLine(lineB);
    expect(lb.match_notes).toContain('Acceptat manual de');
    expect(lb.match_notes).toContain(MOTIV);
    expect(lb.match_notes).toContain('IBAN diferit față de ordonanțare');
    expect(lb.matched_at).not.toBeNull();
  });

  it('7. acceptare care NU completează suma ⇒ linia devine manual, dosarul NU se confirmă, răspunsul spune partial', async () => {
    // ORD mai mare decât A + B: după acceptare rămâne sub total.
    const { alopId, lineA, lineB } = await seedScenariu8836({ ordTotal: 25000 });
    const res = await request(app).post(`/api/opme/lines/${lineB}/accept`)
      .set('Cookie', ck(cabId)).send({ alopId, motiv: MOTIV });
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('partial');
    expect(Number(res.body.details.actual)).toBeCloseTo(SUMA_A + SUMA_B, 2);

    const a = await getAlop(alopId);
    expect(a.status).toBe('plata');
    expect(a.plata_confirmed_at).toBeNull();
    const lb = await getLine(lineB);
    expect(lb.match_status).toBe('manual');          // nu retrogradată la partial
    expect(lb.match_notes).toContain(MOTIV);          // motivul supraviețuiește
    expect((await getLine(lineA)).match_status).toBe('partial');
  });

  it('8. dosar deja confirmat ⇒ linia e acceptată, răspunsul spune already_confirmed (reluare mai întâi)', async () => {
    const { alopId, lineB } = await seedScenariu8836();
    await pool.query(`UPDATE alop_instances SET status='completed', completed_at=NOW(),
      plata_confirmed_at=NOW(), plata_confirmed_by=$2, plata_suma_efectiva=$3, plata_nr_ordin='2792',
      plata_source='manual' WHERE id=$1`, [alopId, cabId, SUMA_B]);
    const res = await request(app).post(`/api/opme/lines/${lineB}/accept`)
      .set('Cookie', ck(cabId)).send({ alopId, motiv: MOTIV });
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('already_confirmed');
    expect((await getLine(lineB)).match_status).toBe('manual');
    const a = await getAlop(alopId);
    expect(Number(a.plata_suma_efectiva)).toBeCloseTo(SUMA_B, 2); // NEatins
  });

  it('9. can_accept în raportul importului: true pentru CAB, false pentru ceilalți', async () => {
    const { importId } = await seedScenariu8836();
    const rc = await request(app).get(`/api/opme/imports/${importId}`).set('Cookie', ck(cabId));
    expect(rc.status).toBe(200);
    expect(rc.body.can_accept).toBe(true);
    const ra = await request(app).get(`/api/opme/imports/${importId}`).set('Cookie', ck(altId));
    expect(ra.status).toBe(200);
    expect(ra.body.can_accept).toBe(false);
  });
});
