/**
 * test:db — #210: poarta de acceptare a unei linii OPME se lărgește la
 * `admin OR (org_admin cu orgId) OR isCabDept`.
 *
 * Context: #209 pusese poarta strict pe `isCabDept` (așa cerea promptul). Consecință în
 * producție (15.09.2026): un cont `admin` vedea liniile respinse dar butonul „Acceptă
 * potrivirea" nu apărea (`can_accept` calculat doar din `isCabDept`) — fluxul introdus la
 * #209 era inaccesibil contului de operare. Regula nouă NU folosește `_hasOpmeImportRole`
 * (mult mai largă — assigned_to + colegi de compartiment) — doar cele trei ramuri aprobate.
 *
 * Matricea acoperă atât ruta de acceptare (`POST /api/opme/lines/:id/accept`) cât și
 * `can_accept` din raportul importului (`GET /api/opme/imports/:id`) — cele două TREBUIE
 * să rămână identice (testul 16 din `caracterizare` e în `npm test`; aici verificăm inline
 * pe fiecare caz din matrice, vezi și 'can_accept oglindește...').
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
const IBAN_ORD = 'RO49TREZ0000000000000001';
const IBAN_ALT = 'RO12BTRL0000000000000002';
const TOTAL  = 20891.04;
const SUMA_A = 19164.51;
const SUMA_B = 1726.53;
const MOTIV  = 'Verificat extrasul de cont: IBAN secundar al aceluiași furnizor.';

async function seedImport({ orgId, uploadedBy, nrDocument = '0000903' }) {
  const { rows } = await pool.query(
    `INSERT INTO opme_imports (org_id, uploaded_by, file_hash, file_name, nr_document, data_op)
     VALUES ($1,$2,$3,'f1129.pdf',$4, DATE '2026-09-03') RETURNING id`,
    [orgId, uploadedBy, 'hash-' + Math.random().toString(36).slice(2), nrDocument]
  );
  return rows[0].id;
}
async function seedLine({ importId, orgId, rowIndex = 1, nrOp, iban = null, suma, status = 'pending',
                          alopId = null, notes = null }) {
  const { rows } = await pool.query(
    `INSERT INTO opme_lines (opme_import_id, org_id, row_index, nr_op, cod_angajament,
                             indicator_angajament, cif_beneficiar, iban_beneficiar, suma_op,
                             match_status, matched_alop_id, match_notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [importId, orgId, rowIndex, nrOp, COD, IND, CIF, iban, suma, status, alopId, notes]
  );
  return rows[0].id;
}
const getLine = async (id) => (await pool.query('SELECT * FROM opme_lines WHERE id=$1', [id])).rows[0];
const getAlop = async (id) => (await pool.query('SELECT * FROM alop_instances WHERE id=$1', [id])).rows[0];

d('#210 — POST /api/opme/lines/:id/accept: poarta admin/org_admin/CAB', () => {
  let app, initId, cabId, altId, admId, oadmId;

  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await pool.query(`DELETE FROM opme_lines; DELETE FROM opme_imports;`);
    const s = await seedOrgUser({ role: 'user', email: 'init@x.ro', compartiment: ALT });
    initId = s.userId;
    cabId  = await seedUser({ orgId: 1, email: 'cab@x.ro',  compartiment: CAB, nume: 'CAB' });
    altId  = await seedUser({ orgId: 1, email: 'alt@x.ro',  compartiment: ALT, nume: 'ALT' });
    admId  = await seedUser({ orgId: 1, email: 'adm@x.ro',  role: 'admin',     compartiment: ALT, nume: 'ADM' });
    oadmId = await seedUser({ orgId: 1, email: 'oadm@x.ro', role: 'org_admin', compartiment: ALT, nume: 'OADM' });
    await pool.query('UPDATE organizations SET cab_compartiment=$2 WHERE id=$1', [1, CAB]);
    app = buildApp();
  });
  afterAll(() => pool.end());

  const ck = (userId, role = 'user', orgId = 1) => makeAuthCookie({ userId, role, orgId, email: `u${userId}@x.ro` });

  async function seedScenariu8836() {
    const dfId  = await seedDf({ orgId: 1, createdBy: initId, status: 'aprobat' });
    const ordId = await seedOrd({ orgId: 1, createdBy: initId, dfId,
      rows: [{ cod_angajament: COD, indicator_angajament: IND, suma_ordonantata_plata: TOTAL }] });
    await pool.query('UPDATE formulare_ord SET cif_beneficiar=$2, iban_beneficiar=$3 WHERE id=$1',
      [ordId, CIF, IBAN_ORD]);
    const alopId = await seedAlop({ orgId: 1, createdBy: initId, status: 'plata', dfId, ordId, compartiment: ALT });
    const importId = await seedImport({ orgId: 1, uploadedBy: initId });
    const lineA = await seedLine({ importId, orgId: 1, rowIndex: 1, nrOp: '2791', iban: IBAN_ORD, suma: SUMA_A,
      status: 'partial', alopId, notes: 'Plată parțială 19164.51 din 20891.04 RON' });
    const lineB = await seedLine({ importId, orgId: 1, rowIndex: 2, nrOp: '2792', iban: IBAN_ALT, suma: SUMA_B,
      status: 'unmatched', notes: 'IBAN diferit față de ordonanțare (beneficiar și triplet potrivite)' });
    return { alopId, importId, lineA, lineB };
  }

  it('1. ⭐ admin (platform) ⇒ 200, linia acceptată', async () => {
    const { alopId, lineB } = await seedScenariu8836();
    const res = await request(app).post(`/api/opme/lines/${lineB}/accept`)
      .set('Cookie', ck(admId, 'admin')).send({ alopId, motiv: MOTIV });
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('matched');
    expect((await getLine(lineB)).match_status).toBe('manual');
  });

  it('2. ⭐ org_admin din aceeași organizație ⇒ 200', async () => {
    const { alopId, lineB } = await seedScenariu8836();
    const res = await request(app).post(`/api/opme/lines/${lineB}/accept`)
      .set('Cookie', ck(oadmId, 'org_admin')).send({ alopId, motiv: MOTIV });
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('matched');
  });

  it('3. cab_dept ⇒ 200 (neregresie #209)', async () => {
    const { alopId, lineB } = await seedScenariu8836();
    const res = await request(app).post(`/api/opme/lines/${lineB}/accept`)
      .set('Cookie', ck(cabId)).send({ alopId, motiv: MOTIV });
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('matched');
  });

  it('4. ⭐ inspector obișnuit, nici CAB nici admin ⇒ 403 doar_responsabil_cab, zero scrieri', async () => {
    const { alopId, lineB } = await seedScenariu8836();
    const res = await request(app).post(`/api/opme/lines/${lineB}/accept`)
      .set('Cookie', ck(altId)).send({ alopId, motiv: MOTIV });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('doar_responsabil_cab');
    const lb = await getLine(lineB);
    expect(lb.match_status).toBe('unmatched');
    expect(lb.matched_alop_id).toBeNull();
  });

  it('5. inițiatorul documentului, care nu e CAB ⇒ 403', async () => {
    const { alopId, lineB } = await seedScenariu8836();
    const res = await request(app).post(`/api/opme/lines/${lineB}/accept`)
      .set('Cookie', ck(initId)).send({ alopId, motiv: MOTIV });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('doar_responsabil_cab');
  });

  it('6. ⭐⭐ admin care încearcă o linie din ALTĂ organizație ⇒ 404, zero scrieri (lărgirea de rol nu slăbește izolarea)', async () => {
    const { alopId } = await seedScenariu8836();
    const { rows: o2 } = await pool.query(
      `INSERT INTO organizations (name, cab_compartiment) VALUES ('Org 2', $1) RETURNING id`, [CAB]);
    const org2 = o2[0].id;
    const u2 = await seedUser({ orgId: org2, email: 'cab2@x.ro', compartiment: CAB, nume: 'CAB2' });
    const imp2 = await seedImport({ orgId: org2, uploadedBy: u2 });
    const lineOrg2 = await seedLine({ importId: imp2, orgId: org2, rowIndex: 1, nrOp: '7777', suma: SUMA_B,
      status: 'unmatched', iban: IBAN_ALT });

    const res = await request(app).post(`/api/opme/lines/${lineOrg2}/accept`)
      .set('Cookie', ck(admId, 'admin')).send({ alopId, motiv: MOTIV });
    expect(res.status).toBe(404);
    const l = await getLine(lineOrg2);
    expect(l.match_status).toBe('unmatched');
    expect(l.matched_alop_id).toBeNull();
  });

  it('7. org_admin fără orgId ⇒ NU trece prin ramura admin-like (respins mai devreme, de auth)', async () => {
    // Observat: fără orgId, middleware-ul de auth respinge cererea (org_required) înainte
    // să ajungă la poarta de rol din opme.mjs — deci ramura `&& actor.orgId` nu produce
    // niciodată `doar_responsabil_cab` pe acest cod de status; verificăm doar că cererea
    // NU e acceptată (nu 200).
    const { alopId, lineB } = await seedScenariu8836();
    const cookie = makeAuthCookie({ userId: oadmId, role: 'org_admin', orgId: null, email: 'oadm@x.ro' });
    const res = await request(app).post(`/api/opme/lines/${lineB}/accept`)
      .set('Cookie', cookie).send({ alopId, motiv: MOTIV });
    expect(res.status).not.toBe(200);
    expect((await getLine(lineB)).match_status).toBe('unmatched');
  });

  it('8. admin fără motiv / cu motiv sub 10 caractere ⇒ 400, zero scrieri (lărgirea de rol nu dispensează de motiv)', async () => {
    const { alopId, lineB } = await seedScenariu8836();
    for (const body of [{ alopId }, { alopId, motiv: '' }, { alopId, motiv: 'scurt' }]) {
      const res = await request(app).post(`/api/opme/lines/${lineB}/accept`)
        .set('Cookie', ck(admId, 'admin')).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('motiv_obligatoriu');
    }
    expect((await getLine(lineB)).match_status).toBe('unmatched');
  });

  it('can_accept din raportul importului oglindește verdictul porții de acceptare, pentru fiecare rol', async () => {
    const { importId } = await seedScenariu8836();
    const cases = [
      [admId, 'admin', 1, true],
      [oadmId, 'org_admin', 1, true],
      [cabId, 'user', 1, true],
      [altId, 'user', 1, false],
      [initId, 'user', 1, false],
    ];
    for (const [uid, role, orgId, expected] of cases) {
      const res = await request(app).get(`/api/opme/imports/${importId}`).set('Cookie', ck(uid, role, orgId));
      expect(res.status).toBe(200);
      expect(res.body.can_accept).toBe(expected);
    }
  });
});
