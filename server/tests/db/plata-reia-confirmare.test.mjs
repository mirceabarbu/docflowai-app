/**
 * test:db — #209 Etapa B: RELUAREA confirmării plății (`POST /api/alop/:id/plata/reia`).
 *
 * Scriere FINANCIARĂ pe un dosar închis. Gărzi: doar CAB; doar dacă plata E confirmată;
 * doar în ciclul curent (ciclu avansat ⇒ 409, REFUZ); `suma_totala_platita` NEATINSĂ;
 * toate valorile vechi în audit; liniile OPME legate RĂMÂN legate.
 * Cap-coadă (13): dosar confirmat greșit cu 1.726,53 → reluare → acceptarea liniei respinse →
 * matcher ⇒ 20.891,04 cu ambele OP-uri.
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

async function seedImport({ orgId, uploadedBy }) {
  const { rows } = await pool.query(
    `INSERT INTO opme_imports (org_id, uploaded_by, file_hash, file_name, nr_document, data_op)
     VALUES ($1,$2,$3,'f1129.pdf','0000903', DATE '2026-09-03') RETURNING id`,
    [orgId, uploadedBy, 'hash-' + Math.random().toString(36).slice(2)]
  );
  return rows[0].id;
}
async function seedLine({ importId, orgId, rowIndex = 1, nrOp, iban = null, suma, status = 'pending',
                          alopId = null, notes = null }) {
  const { rows } = await pool.query(
    `INSERT INTO opme_lines (opme_import_id, org_id, row_index, nr_op, cod_angajament,
                             indicator_angajament, cif_beneficiar, iban_beneficiar, suma_op,
                             match_status, matched_alop_id, match_notes, matched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
             CASE WHEN $10 IN ('auto','manual') THEN NOW() ELSE NULL END) RETURNING id`,
    [importId, orgId, rowIndex, nrOp, COD, IND, CIF, iban, suma, status, alopId, notes]
  );
  return rows[0].id;
}
const getLine = async (id) => (await pool.query('SELECT * FROM opme_lines WHERE id=$1', [id])).rows[0];
const getAlop = async (id) => (await pool.query('SELECT * FROM alop_instances WHERE id=$1', [id])).rows[0];
const audit = async (type, alopId) => (await pool.query(
  `SELECT * FROM audit_log WHERE event_type=$1 AND payload->>'alop_id'=$2 ORDER BY created_at DESC`,
  [type, alopId])).rows;

d('#209 B — POST /api/alop/:id/plata/reia', () => {
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
  const MOTIV = 'Plata a fost confirmată doar cu al doilea OP; se reface cu suma totală.';

  // ALOP confirmat MANUAL (greșit) cu 1.726,53, în ciclul 1, cu suma_totala_platita din cicluri vechi.
  async function seedConfirmat({ sumaTotalaPlatita = 5000, cicluCurent = 1 } = {}) {
    const dfId  = await seedDf({ orgId: 1, createdBy: initId, status: 'aprobat' });
    const ordId = await seedOrd({ orgId: 1, createdBy: initId, dfId,
      rows: [{ cod_angajament: COD, indicator_angajament: IND, suma_ordonantata_plata: TOTAL }] });
    await pool.query('UPDATE formulare_ord SET cif_beneficiar=$2, iban_beneficiar=$3 WHERE id=$1',
      [ordId, CIF, IBAN_ORD]);
    const alopId = await seedAlop({ orgId: 1, createdBy: initId, status: 'completed', dfId, ordId,
      compartiment: ALT, cicluCurent, sumaTotalaPlatita });
    await pool.query(`UPDATE alop_instances SET
        completed_at=NOW(), plata_confirmed_at=NOW() - INTERVAL '1 hour', plata_confirmed_by=$2,
        plata_suma_efectiva=$3, plata_nr_ordin='2792', plata_data=DATE '2026-09-03',
        plata_source='manual', plata_observatii='obs', plata_notes='note'
      WHERE id=$1`, [alopId, cabId, SUMA_B]);
    return { alopId, ordId, dfId };
  }

  it('8. ⭐ ALOP confirmat ⇒ reluare de CAB ⇒ câmpurile de plată golite, status plata, completed_at NULL, suma_totala_platita NEATINSĂ', async () => {
    const { alopId } = await seedConfirmat({ sumaTotalaPlatita: 5000 });
    const res = await request(app).post(`/api/alop/${alopId}/plata/reia`)
      .set('Cookie', ck(cabId)).send({ motiv: MOTIV });
    expect(res.status).toBe(200);
    const a = await getAlop(alopId);
    expect(a.status).toBe('plata');
    expect(a.completed_at).toBeNull();
    expect(a.plata_confirmed_at).toBeNull();
    expect(a.plata_confirmed_by).toBeNull();
    expect(a.plata_nr_ordin).toBeNull();
    expect(a.plata_data).toBeNull();
    expect(a.plata_suma_efectiva).toBeNull();
    expect(a.plata_observatii).toBeNull();
    expect(a.plata_notes).toBeNull();
    expect(a.plata_source).toBe('manual');
    expect(Number(a.suma_totala_platita)).toBe(5000);   // ⛔ NEATINSĂ
    expect(a.ciclu_curent).toBe(1);
    expect(a.ord_id).not.toBeNull();                     // ord_* neatinse
  });

  it('9. ⭐ auditul conține TOATE valorile vechi (OP, sumă, dată, sursă, confirmator, status) + motivul', async () => {
    const { alopId } = await seedConfirmat();
    const res = await request(app).post(`/api/alop/${alopId}/plata/reia`)
      .set('Cookie', ck(cabId)).send({ motiv: MOTIV });
    expect(res.status).toBe(200);
    const ev = await audit('plata_confirmare_reluata', alopId);
    expect(ev.length).toBe(1);
    const v = ev[0].payload.vechi;
    expect(v.plata_nr_ordin).toBe('2792');
    expect(Number(v.plata_suma_efectiva)).toBeCloseTo(SUMA_B, 2);
    expect(String(v.plata_data)).toMatch(/2026-09-03/);
    expect(v.plata_source).toBe('manual');
    expect(v.plata_confirmed_by).toBe(cabId);
    expect(v.plata_confirmed_at).toBeTruthy();
    expect(v.status).toBe('completed');
    expect(ev[0].payload.motiv).toBe(MOTIV);
    expect(ev[0].payload.actor_user_id).toBe(cabId);
  });

  it('10. ⭐⭐ ciclu avansat ⇒ 409 ciclu_avansat, zero scrieri (apără istoricul)', async () => {
    // ciclu_curent=2 și un ciclu arhivat creat DUPĂ momentul confirmării ⇒ inconsecvență ⇒ refuz.
    const { alopId, ordId } = await seedConfirmat({ sumaTotalaPlatita: 9000, cicluCurent: 2 });
    await pool.query(`INSERT INTO alop_ord_cicluri (alop_id, org_id, ciclu_nr, ord_id, plata_suma_efectiva, status, created_at)
      VALUES ($1, 1, 1, $2, 9000, 'completed', NOW())`, [alopId, ordId]);
    const before = await getAlop(alopId);
    const res = await request(app).post(`/api/alop/${alopId}/plata/reia`)
      .set('Cookie', ck(cabId)).send({ motiv: MOTIV });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ciclu_avansat');
    const after = await getAlop(alopId);
    expect(after.status).toBe('completed');
    expect(after.plata_confirmed_at).toEqual(before.plata_confirmed_at);
    expect(Number(after.plata_suma_efectiva)).toBeCloseTo(SUMA_B, 2);
    expect(Number(after.suma_totala_platita)).toBe(9000);
    expect((await audit('plata_confirmare_reluata', alopId)).length).toBe(0);
  });

  it('10b. ciclu arhivat cu numărul ciclului curent ⇒ 409 ciclu_avansat (a doua față a criteriului)', async () => {
    const { alopId, ordId } = await seedConfirmat({ cicluCurent: 1 });
    await pool.query(`INSERT INTO alop_ord_cicluri (alop_id, org_id, ciclu_nr, ord_id, plata_suma_efectiva, status, created_at)
      VALUES ($1, 1, 1, $2, 100, 'completed', NOW() - INTERVAL '2 days')`, [alopId, ordId]);
    const res = await request(app).post(`/api/alop/${alopId}/plata/reia`)
      .set('Cookie', ck(cabId)).send({ motiv: MOTIV });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ciclu_avansat');
    expect((await getAlop(alopId)).status).toBe('completed');
  });

  it('11. ALOP neconfirmat ⇒ 409 nu_e_confirmata', async () => {
    const dfId  = await seedDf({ orgId: 1, createdBy: initId, status: 'aprobat' });
    const ordId = await seedOrd({ orgId: 1, createdBy: initId, dfId });
    const alopId = await seedAlop({ orgId: 1, createdBy: initId, status: 'plata', dfId, ordId, compartiment: ALT });
    const res = await request(app).post(`/api/alop/${alopId}/plata/reia`)
      .set('Cookie', ck(cabId)).send({ motiv: MOTIV });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('nu_e_confirmata');
    expect((await getAlop(alopId)).status).toBe('plata');
  });

  it('12. non-CAB (inițiator, coleg, org_admin) ⇒ 403, zero scrieri', async () => {
    const { alopId } = await seedConfirmat();
    const oadm = await seedUser({ orgId: 1, email: 'oadm@x.ro', role: 'org_admin', compartiment: ALT, nume: 'OADM' });
    for (const [uid, role] of [[initId, 'user'], [altId, 'user'], [oadm, 'org_admin']]) {
      const res = await request(app).post(`/api/alop/${alopId}/plata/reia`)
        .set('Cookie', ck(uid, role)).send({ motiv: MOTIV });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('doar_responsabil_cab');
    }
    const a = await getAlop(alopId);
    expect(a.status).toBe('completed');
    expect(a.plata_confirmed_at).not.toBeNull();
  });

  it('12b. motiv lipsă ⇒ 400, zero scrieri', async () => {
    const { alopId } = await seedConfirmat();
    const res = await request(app).post(`/api/alop/${alopId}/plata/reia`)
      .set('Cookie', ck(cabId)).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('motiv_obligatoriu');
    expect((await getAlop(alopId)).status).toBe('completed');
  });

  it('13. ⭐ cap-coadă: confirmat greșit cu 1.726,53 → reluare → acceptarea liniei respinse → matcher ⇒ 20.891,04, ambele OP-uri', async () => {
    const { alopId } = await seedConfirmat();
    const importId = await seedImport({ orgId: 1, uploadedBy: initId });
    // linia A (19.164,51) e potrivită de matcher (partial, legată); linia B (1.726,53) respinsă pe IBAN.
    const lineA = await seedLine({ importId, orgId: 1, rowIndex: 1, nrOp: '2791', iban: IBAN_ORD, suma: SUMA_A,
      status: 'partial', alopId, notes: 'Plată parțială 19164.51 din 20891.04 RON' });
    const lineB = await seedLine({ importId, orgId: 1, rowIndex: 2, nrOp: '2792', iban: IBAN_ALT, suma: SUMA_B,
      status: 'unmatched', notes: 'IBAN diferit față de ordonanțare' });

    const r1 = await request(app).post(`/api/alop/${alopId}/plata/reia`)
      .set('Cookie', ck(cabId)).send({ motiv: MOTIV });
    expect(r1.status).toBe(200);
    expect((await getAlop(alopId)).status).toBe('plata');

    const r2 = await request(app).post(`/api/opme/lines/${lineB}/accept`)
      .set('Cookie', ck(cabId)).send({ alopId, motiv: 'Verificat extrasul: IBAN secundar al furnizorului.' });
    expect(r2.status).toBe(200);
    expect(r2.body.result).toBe('matched');

    const a = await getAlop(alopId);
    expect(a.status).toBe('completed');
    expect(Number(a.plata_suma_efectiva)).toBeCloseTo(TOTAL, 2);
    expect(a.plata_nr_ordin).toContain('2791');
    expect(a.plata_nr_ordin).toContain('2792');
    expect(a.plata_source).toBe('opme_auto');
    expect(Number(a.suma_totala_platita)).toBe(5000);
    expect((await getLine(lineA)).match_status).toBe('auto');
    expect((await getLine(lineB)).match_status).toBe('manual');
  });

  it('13b. ordinea inversă: acceptare pe dosar confirmat (already_confirmed) → reluare → matcher reagregă la următoarea acceptare', async () => {
    const { alopId } = await seedConfirmat();
    const importId = await seedImport({ orgId: 1, uploadedBy: initId });
    const lineA = await seedLine({ importId, orgId: 1, rowIndex: 1, nrOp: '2791', iban: IBAN_ORD, suma: SUMA_A,
      status: 'partial', alopId });
    const lineB = await seedLine({ importId, orgId: 1, rowIndex: 2, nrOp: '2792', iban: IBAN_ALT, suma: SUMA_B,
      status: 'unmatched' });
    const r0 = await request(app).post(`/api/opme/lines/${lineB}/accept`)
      .set('Cookie', ck(cabId)).send({ alopId, motiv: 'Verificat extrasul: IBAN secundar al furnizorului.' });
    expect(r0.status).toBe(200);
    expect(r0.body.result).toBe('already_confirmed');

    const r1 = await request(app).post(`/api/alop/${alopId}/plata/reia`)
      .set('Cookie', ck(cabId)).send({ motiv: MOTIV });
    expect(r1.status).toBe(200);
    // linia manual RĂMÂNE manual după reluare
    expect((await getLine(lineB)).match_status).toBe('manual');
    // a doua linie parțială e acceptată explicit ⇒ matcher-ul reagregă A (partial) + B (manual)
    const r2 = await request(app).post(`/api/opme/lines/${lineA}/accept`)
      .set('Cookie', ck(cabId)).send({ alopId, motiv: 'Reagregare după reluarea confirmării.' });
    expect(r2.status).toBe(200);
    expect(r2.body.result).toBe('matched');
    const a = await getAlop(alopId);
    expect(Number(a.plata_suma_efectiva)).toBeCloseTo(TOTAL, 2);
    expect(a.plata_nr_ordin).toContain('2791');
    expect(a.plata_nr_ordin).toContain('2792');
  });

  it('14. liniile OPME auto/manual legate RĂMÂN legate după reluare', async () => {
    const { alopId } = await seedConfirmat();
    const importId = await seedImport({ orgId: 1, uploadedBy: initId });
    const lAuto = await seedLine({ importId, orgId: 1, rowIndex: 1, nrOp: '2791', suma: SUMA_A, status: 'auto', alopId });
    const lMan  = await seedLine({ importId, orgId: 1, rowIndex: 2, nrOp: '2792', suma: SUMA_B, status: 'manual', alopId,
      notes: 'Acceptat manual de cab@x.ro: motiv' });
    const res = await request(app).post(`/api/alop/${alopId}/plata/reia`)
      .set('Cookie', ck(cabId)).send({ motiv: MOTIV });
    expect(res.status).toBe(200);
    const a = await getLine(lAuto), m = await getLine(lMan);
    expect(a.match_status).toBe('auto');   expect(a.matched_alop_id).toBe(alopId);
    expect(m.match_status).toBe('manual'); expect(m.matched_alop_id).toBe(alopId);
    expect(m.match_notes).toContain('Acceptat manual');
  });

  it('15. confirmarea manuală acceptă listă de OP-uri ("2791, 2792") și normalizează; respinge ";"', async () => {
    const dfId  = await seedDf({ orgId: 1, createdBy: initId, status: 'aprobat' });
    const ordId = await seedOrd({ orgId: 1, createdBy: initId, dfId,
      rows: [{ cod_angajament: COD, indicator_angajament: IND, suma_ordonantata_plata: TOTAL }] });
    const alopId = await seedAlop({ orgId: 1, createdBy: initId, status: 'plata', dfId, ordId, compartiment: ALT });
    const bad = await request(app).post(`/api/alop/${alopId}/confirma-plata`)
      .set('Cookie', ck(cabId)).send({ nr_ordin_plata: '2791;2792', data_plata: '2026-09-03', suma_efectiva: TOTAL });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('nr_ordin_invalid');
    expect((await getAlop(alopId)).status).toBe('plata');

    const ok = await request(app).post(`/api/alop/${alopId}/confirma-plata`)
      .set('Cookie', ck(cabId)).send({ nr_ordin_plata: ' 2791 ,2792 ', data_plata: '2026-09-03', suma_efectiva: TOTAL });
    expect(ok.status).toBe(200);
    expect((await getAlop(alopId)).plata_nr_ordin).toBe('2791, 2792');
  });
});
