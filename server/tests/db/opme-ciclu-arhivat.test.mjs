/**
 * test:db — #213: o plată dintr-un ciclu ÎNCHIS nu mai poate ajunge pe ciclul curent.
 *
 * Incident producție (16.09.2026), dosarul RATBV: trei OP-uri din august (2666–2668, 32.852,00),
 * plata ciclului 2 deja confirmată manual, au fost acceptate din raportul OPME pe dosarul aflat
 * în `ordonantare` (ciclul 4). Acceptarea le-a pus `matched_ciclu_id = NULL`; la intrarea
 * ciclului 4 în `plata`, matcher-ul le-ar fi adunat la OP-urile din septembrie.
 *
 * Regula: o linie legată de un ciclu arhivat e istorie — nici rematch, nici agregare, nici
 * acceptare nu o mai ating. Acceptarea se face DOAR pe un dosar în `plata` sau `completed`
 * (calea de corectare #209, test 13/13b din `plata-reia-confirmare.test.mjs`).
 *
 * Seed-urile oglindesc `opme-accept-linie.test.mjs` (#209); `seedLine` e EXTINS aici cu
 * `cicluId` (matched_ciclu_id) — helper-ul din testul #209 rămâne neatins.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, seedOrd, seedAlop, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';
import { matchImport, tryAutoConfirmAlop } from '../../services/opme-matcher.mjs';

const d = describe.skipIf(!hasTestDb());

const CAB = 'Contabilitate';
const ALT = 'Achizitii';
// Același CIF / triplet / IBAN pe ORD-ul curent, pe ORD-ul ciclului arhivat și pe TOATE liniile —
// altfel regula de bloc (cif+triplet+IBAN) le respinge și testele de agregare nu măsoară nimic.
const CIF  = '1234567';
const COD  = 'RATBV0001';
const IND  = 'AAB';
const IBAN = 'RO49TREZ0000000000000001';
const X = 217526.49;   // valoarea ORD-ului ciclului curent
const S = 32852.00;    // suma unei linii din ciclul arhivat

async function seedImport({ orgId, uploadedBy, nrDocument = '0000903' }) {
  const { rows } = await pool.query(
    `INSERT INTO opme_imports (org_id, uploaded_by, file_hash, file_name, nr_document, data_op)
     VALUES ($1,$2,$3,'f1129.pdf',$4, DATE '2026-09-03') RETURNING id`,
    [orgId, uploadedBy, 'hash-' + Math.random().toString(36).slice(2), nrDocument]
  );
  return rows[0].id;
}
async function seedLine({ importId, orgId, rowIndex = 1, nrOp, cod = COD, ind = IND, cif = CIF,
                          iban = IBAN, suma, status = 'pending', alopId = null, cicluId = null, notes = null }) {
  const { rows } = await pool.query(
    `INSERT INTO opme_lines (opme_import_id, org_id, row_index, nr_op, cod_angajament,
                             indicator_angajament, cif_beneficiar, iban_beneficiar, suma_op,
                             match_status, matched_alop_id, matched_ciclu_id, match_notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [importId, orgId, rowIndex, nrOp, cod, ind, cif, iban, suma, status, alopId, cicluId, notes]
  );
  return rows[0].id;
}
const getLine = async (id) => (await pool.query('SELECT * FROM opme_lines WHERE id=$1', [id])).rows[0];
const getAlop = async (id) => (await pool.query('SELECT * FROM alop_instances WHERE id=$1', [id])).rows[0];
// Filtrat pe dosar: `audit_log` NU e truncat între teste/rulări (vezi flaky-db-transmit-audit-log).
const auditAccept = async (alopId) => (await pool.query(
  `SELECT * FROM audit_log WHERE event_type='opme_line_accepted_manual' AND payload->>'alop_id'=$1`,
  [alopId])).rows;
const snap = (l) => ({ match_status: l.match_status, matched_alop_id: l.matched_alop_id,
  matched_ciclu_id: l.matched_ciclu_id, match_notes: l.match_notes });

d('#213 — OPME: liniile unui ciclu arhivat sunt istorie', () => {
  let app, initId, cabId, orgAdminId;

  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await pool.query(`DELETE FROM opme_lines; DELETE FROM opme_imports;`);
    const s = await seedOrgUser({ role: 'user', email: 'init@x.ro', compartiment: ALT });
    initId = s.userId;
    cabId  = await seedUser({ orgId: 1, email: 'cab@x.ro', compartiment: CAB, nume: 'CAB' });
    orgAdminId = await seedUser({ orgId: 1, email: 'oa@x.ro', role: 'org_admin', compartiment: ALT, nume: 'OA' });
    await pool.query('UPDATE organizations SET cab_compartiment=$2 WHERE id=$1', [1, CAB]);
    app = buildApp();
  });
  afterAll(() => pool.end());

  const ck = (userId, role = 'user') => makeAuthCookie({ userId, role, orgId: 1, email: `u${userId}@x.ro` });
  const MOTIV = 'Verificat extrasul de cont: OP-ul aparține acestui dosar.';

  // Un ORD cu CIF/triplet/IBAN standard și valoarea `total`.
  async function seedOrdCu({ dfId, total, nrOrd }) {
    const ordId = await seedOrd({ orgId: 1, createdBy: initId, dfId, nrOrd,
      rows: [{ cod_angajament: COD, indicator_angajament: IND, suma_ordonantata_plata: total }] });
    await pool.query('UPDATE formulare_ord SET cif_beneficiar=$2, iban_beneficiar=$3 WHERE id=$1',
      [ordId, CIF, IBAN]);
    return ordId;
  }

  // Scenariul „RATBV": dosar cu ciclul 1 ARHIVAT (plată manuală) și ciclul curent (nr. 2) cu ORD = X.
  async function seedRatbv({ status = 'plata', ordTotal = X } = {}) {
    const dfId = await seedDf({ orgId: 1, createdBy: initId, status: 'aprobat', nrUnic: 'DF-RATBV' });
    const ordArhivat = await seedOrdCu({ dfId, total: 231117.77, nrOrd: 'ORD-43702' });
    const ordCurent  = await seedOrdCu({ dfId, total: ordTotal, nrOrd: 'ORD-47842' });
    const alopId = await seedAlop({ orgId: 1, createdBy: initId, status, dfId, ordId: ordCurent,
      compartiment: ALT, cicluCurent: 2, sumaTotalaPlatita: 231117.77, titlu: 'DIFERENTA DE TARIF' });
    const { rows } = await pool.query(
      `INSERT INTO alop_ord_cicluri (alop_id, org_id, ciclu_nr, ord_id, plata_confirmed_at,
                                     plata_confirmed_by, plata_suma_efectiva, an_exercitiu, status)
       VALUES ($1, 1, 1, $2, NOW() - INTERVAL '30 days', $3, 231117.77, 2026, 'completed') RETURNING id`,
      [alopId, ordArhivat, cabId]);
    const cicluId = rows[0].id;
    const importId = await seedImport({ orgId: 1, uploadedBy: initId, nrDocument: '0000800' });
    return { alopId, dfId, ordCurent, ordArhivat, cicluId, importId };
  }

  // ─── A — acceptarea ────────────────────────────────────────────────────────────

  it('1. ⭐⭐ reproducerea exactă: linie unmatched cu pointer stale, dosar în ordonantare ⇒ 409 dosar_nu_e_in_plata, zero scrieri', async () => {
    const { alopId, importId } = await seedRatbv({ status: 'ordonantare' });
    // exact ce a măsurat SQL-213: match_status=unmatched ȘI matched_alop_id=RATBV, ciclu NULL
    const lineId = await seedLine({ importId, orgId: 1, rowIndex: 1, nrOp: '2666', suma: S,
      status: 'unmatched', alopId, notes: 'Nu există ALOP activ în plată cu acest beneficiar și angajament.' });
    const before = snap(await getLine(lineId));

    const res = await request(app).post(`/api/opme/lines/${lineId}/accept`)
      .set('Cookie', ck(cabId)).send({ alopId, motiv: MOTIV });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('dosar_nu_e_in_plata');
    expect(res.body.status).toBe('ordonantare');

    expect(snap(await getLine(lineId))).toEqual(before);
    expect((await auditAccept(alopId)).length).toBe(0);
    expect((await getAlop(alopId)).status).toBe('ordonantare');
  });

  for (const status of ['lichidare', 'angajare', 'draft']) {
    it(`2. dosar în ${status} ⇒ 409 dosar_nu_e_in_plata, zero scrieri`, async () => {
      const { alopId, importId } = await seedRatbv({ status });
      const lineId = await seedLine({ importId, orgId: 1, rowIndex: 1, nrOp: '2667', suma: S, status: 'unmatched' });
      const before = snap(await getLine(lineId));
      const res = await request(app).post(`/api/opme/lines/${lineId}/accept`)
        .set('Cookie', ck(cabId)).send({ alopId, motiv: MOTIV });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('dosar_nu_e_in_plata');
      expect(snap(await getLine(lineId))).toEqual(before);
      expect((await auditAccept(alopId)).length).toBe(0);
    });
  }

  it('3. ⭐ linie cu matched_ciclu_id setat (arhivată), dosar în plata ⇒ 409 linie_ciclu_arhivat, zero scrieri', async () => {
    const { alopId, cicluId, importId } = await seedRatbv({ status: 'plata' });
    const lineId = await seedLine({ importId, orgId: 1, rowIndex: 1, nrOp: '2666', suma: S,
      status: 'partial', alopId, cicluId, notes: 'Plată parțială 32852.00 din 231117.77 RON' });
    const before = snap(await getLine(lineId));

    const res = await request(app).post(`/api/opme/lines/${lineId}/accept`)
      .set('Cookie', ck(cabId)).send({ alopId, motiv: MOTIV });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('linie_ciclu_arhivat');

    expect(snap(await getLine(lineId))).toEqual(before);
    expect((await auditAccept(alopId)).length).toBe(0);
    const a = await getAlop(alopId);
    expect(a.status).toBe('plata');
    expect(a.plata_confirmed_at).toBeNull();
  });

  // 4. Neregresie: dosar în `plata` ⇒ 200 (matched) și dosar `completed` ⇒ 200 `already_confirmed`.
  //    Calea `completed` e acoperită exact de #209: `opme-accept-linie.test.mjs` test 8 și
  //    `plata-reia-confirmare.test.mjs` 13b (accept pe completed → reia → reagregare). Aici doar `plata`.
  it('4. neregresie: dosar în plata ⇒ 200 matched (calea #209 rămâne deschisă)', async () => {
    const { alopId, importId } = await seedRatbv({ status: 'plata' });
    const lineId = await seedLine({ importId, orgId: 1, rowIndex: 1, nrOp: '2900', suma: X,
      status: 'unmatched', notes: 'IBAN diferit față de ordonanțare', iban: 'RO12BTRL0000000000000002' });
    const res = await request(app).post(`/api/opme/lines/${lineId}/accept`)
      .set('Cookie', ck(cabId)).send({ alopId, motiv: MOTIV });
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('matched');
    const a = await getAlop(alopId);
    expect(a.status).toBe('completed');
    expect(Number(a.plata_suma_efectiva)).toBeCloseTo(X, 2);
    expect((await getLine(lineId)).match_status).toBe('manual');
  });

  // ─── B — agregarea ─────────────────────────────────────────────────────────────

  it('5. ⭐⭐ linie partial arhivată pe ciclul 1 (același CIF/triplet/IBAN) NU e reabsorbită: confirmă cu X, nu X+S', async () => {
    const { alopId, cicluId, importId } = await seedRatbv({ status: 'plata' });
    const arhivata = await seedLine({ importId, orgId: 1, rowIndex: 1, nrOp: '2666', suma: S,
      status: 'partial', alopId, cicluId, notes: 'Plată parțială 32852.00 din 231117.77 RON' });
    const imp2 = await seedImport({ orgId: 1, uploadedBy: initId, nrDocument: '0000903' });
    const noua = await seedLine({ importId: imp2, orgId: 1, rowIndex: 1, nrOp: '2999', suma: X, status: 'pending' });
    const before = snap(await getLine(arhivata));

    const out = await tryAutoConfirmAlop(alopId, { actorUserId: cabId });
    expect(out.reason, `pe codul vechi: ${JSON.stringify(out.details?.[0])}`).toBe('matched');
    expect(Number(out.details[0].actual)).toBeCloseTo(X, 2);

    const a = await getAlop(alopId);
    expect(a.status).toBe('completed');
    expect(Number(a.plata_suma_efectiva)).toBeCloseTo(X, 2);
    expect(a.plata_nr_ordin).toBe('2999');
    expect((await getLine(noua)).match_status).toBe('auto');
    // linia arhivată: identică — status, ciclu, notă
    expect(snap(await getLine(arhivata))).toEqual(before);
    expect(before.matched_ciclu_id).toBe(cicluId);
  });

  it('6. aceeași configurație cu o linie unmatched arhivată (pointer spre dosar) ⇒ neabsorbită', async () => {
    const { alopId, cicluId, importId } = await seedRatbv({ status: 'plata' });
    const arhivata = await seedLine({ importId, orgId: 1, rowIndex: 1, nrOp: '2667', suma: S,
      status: 'unmatched', alopId, cicluId, notes: 'Nu există ALOP activ în plată cu acest beneficiar și angajament.' });
    const imp2 = await seedImport({ orgId: 1, uploadedBy: initId, nrDocument: '0000903' });
    await seedLine({ importId: imp2, orgId: 1, rowIndex: 1, nrOp: '2999', suma: X, status: 'pending' });
    const before = snap(await getLine(arhivata));

    const out = await tryAutoConfirmAlop(alopId, { actorUserId: cabId });
    expect(out.reason).toBe('matched');
    expect(Number((await getAlop(alopId)).plata_suma_efectiva)).toBeCloseTo(X, 2);
    expect(snap(await getLine(arhivata))).toEqual(before);
  });

  // ─── C — rematch ───────────────────────────────────────────────────────────────

  it('7. ⭐ POST /api/opme/imports/:id/rematch: linia arhivată neatinsă, linia curentă reevaluată', async () => {
    const { alopId, cicluId, importId } = await seedRatbv({ status: 'plata' });
    const arhivata = await seedLine({ importId, orgId: 1, rowIndex: 1, nrOp: '2666', suma: S,
      status: 'partial', alopId, cicluId, notes: 'Plată parțială 32852.00 din 231117.77 RON' });
    const curenta = await seedLine({ importId, orgId: 1, rowIndex: 2, nrOp: '2999', suma: X,
      status: 'unmatched', notes: 'Nu există ALOP activ în plată cu acest beneficiar și angajament.' });
    const before = snap(await getLine(arhivata));

    const res = await request(app).post(`/api/opme/imports/${importId}/rematch`)
      .set('Cookie', ck(orgAdminId, 'org_admin')).send({});
    expect(res.status).toBe(200);

    expect(snap(await getLine(arhivata))).toEqual(before);
    const c = await getLine(curenta);
    expect(c.match_status).toBe('auto');
    expect(c.matched_alop_id).toBe(alopId);
    expect(Number((await getAlop(alopId)).plata_suma_efectiva)).toBeCloseTo(X, 2);
  });

  it('8. ⭐ POST /api/opme/rematch-all: la fel', async () => {
    const { alopId, cicluId, importId } = await seedRatbv({ status: 'plata' });
    const arhivata = await seedLine({ importId, orgId: 1, rowIndex: 1, nrOp: '2666', suma: S,
      status: 'partial', alopId, cicluId, notes: 'Plată parțială 32852.00 din 231117.77 RON' });
    const curenta = await seedLine({ importId, orgId: 1, rowIndex: 2, nrOp: '2999', suma: X,
      status: 'unmatched', notes: 'Nu există ALOP activ în plată cu acest beneficiar și angajament.' });
    const before = snap(await getLine(arhivata));

    const res = await request(app).post(`/api/opme/rematch-all`)
      .set('Cookie', ck(orgAdminId, 'org_admin')).send({});
    expect(res.status).toBe(200);

    expect(snap(await getLine(arhivata))).toEqual(before);
    const c = await getLine(curenta);
    expect(c.match_status).toBe('auto');
    expect(c.matched_alop_id).toBe(alopId);
    expect(Number((await getAlop(alopId)).plata_suma_efectiva)).toBeCloseTo(X, 2);
  });

  // ─── D — _markLine ─────────────────────────────────────────────────────────────

  it('9. ⭐ linie pending cu matched_alop_id stale, niciun dosar în plată ⇒ unmatched cu AMBII pointeri NULL', async () => {
    const { alopId, importId } = await seedRatbv({ status: 'ordonantare' });
    const lineId = await seedLine({ importId, orgId: 1, rowIndex: 1, nrOp: '2666', suma: S,
      status: 'pending', alopId });
    const rep = await matchImport(importId);
    expect(rep.unmatched).toBe(1);
    const l = await getLine(lineId);
    expect(l.match_status).toBe('unmatched');
    expect(l.matched_alop_id).toBeNull();
    expect(l.matched_ciclu_id).toBeNull();
  });

  // ─── E — raportul ──────────────────────────────────────────────────────────────

  it('10. GET /api/opme/imports/:id expune alop_status pe liniile legate (null pe cele nelegate)', async () => {
    const { alopId, cicluId, importId } = await seedRatbv({ status: 'ordonantare' });
    const legata   = await seedLine({ importId, orgId: 1, rowIndex: 1, nrOp: '2666', suma: S, status: 'partial', alopId, cicluId });
    const nelegata = await seedLine({ importId, orgId: 1, rowIndex: 2, nrOp: '2999', suma: X, status: 'unmatched' });
    const res = await request(app).get(`/api/opme/imports/${importId}`).set('Cookie', ck(cabId));
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.lines.map(l => [l.id, l]));
    expect(byId[legata].alop_status).toBe('ordonantare');
    expect(byId[legata].matched_ciclu_id).toBe(cicluId);
    expect(byId[nelegata].alop_status).toBeNull();
  });

  // ─── F — cap-coadă ─────────────────────────────────────────────────────────────

  it('11. ⭐⭐ secvența din producție: rematch → acceptare pe ordonantare (409) → dosarul intră în plata → OP nou = X ⇒ confirmat cu exact X', async () => {
    const { alopId, cicluId, importId } = await seedRatbv({ status: 'ordonantare' });
    const l1 = await seedLine({ importId, orgId: 1, rowIndex: 1, nrOp: '2666', suma: 10000,
      status: 'partial', alopId, cicluId, notes: 'Plată parțială 10000.00 din 231117.77 RON' });
    const l2 = await seedLine({ importId, orgId: 1, rowIndex: 2, nrOp: '2667', suma: 12852,
      status: 'partial', alopId, cicluId, notes: 'Plată parțială 12852.00 din 231117.77 RON' });
    const l3 = await seedLine({ importId, orgId: 1, rowIndex: 3, nrOp: '2668', suma: 10000,
      status: 'partial', alopId, cicluId, notes: 'Plată parțială 10000.00 din 231117.77 RON' });
    const before = { l1: snap(await getLine(l1)), l2: snap(await getLine(l2)), l3: snap(await getLine(l3)) };

    // (a) rematch pe importul din august — istoria rămâne istorie
    const r1 = await request(app).post(`/api/opme/imports/${importId}/rematch`)
      .set('Cookie', ck(orgAdminId, 'org_admin')).send({});
    expect(r1.status).toBe(200);
    expect(snap(await getLine(l1))).toEqual(before.l1);

    // (b) administratorul încearcă să accepte 2666 pe dosarul aflat în ordonantare
    const r2 = await request(app).post(`/api/opme/lines/${l1}/accept`)
      .set('Cookie', ck(orgAdminId, 'org_admin')).send({ alopId, motiv: MOTIV });
    expect(r2.status).toBe(409);
    expect(['dosar_nu_e_in_plata', 'linie_ciclu_arhivat']).toContain(r2.body.error);
    expect(snap(await getLine(l1))).toEqual(before.l1);

    // (c) fluxul ORD 47842 se finalizează: dosarul trece în plata (tranziție legală în matrice)
    await pool.query(`UPDATE alop_instances SET status='plata', ord_completed_at=NOW() WHERE id=$1`, [alopId]);
    const r3 = await tryAutoConfirmAlop(alopId, { actorUserId: cabId });
    expect(r3.reason).toBe('no_match');   // nimic de agregat încă (liniile ciclului 1 nu contează)

    // (d) sosește OP-ul din septembrie, exact X
    const imp2 = await seedImport({ orgId: 1, uploadedBy: initId, nrDocument: '0000903' });
    const nou = await seedLine({ importId: imp2, orgId: 1, rowIndex: 1, nrOp: '2999', suma: X, status: 'pending' });
    const rep = await matchImport(imp2);
    expect(rep.confirmed_alopuri).toEqual([alopId]);

    const a = await getAlop(alopId);
    expect(a.status).toBe('completed');
    expect(Number(a.plata_suma_efectiva)).toBeCloseTo(X, 2);
    expect(a.plata_nr_ordin).toBe('2999');
    expect((await getLine(nou)).match_status).toBe('auto');
    expect(snap(await getLine(l1))).toEqual(before.l1);
    expect(snap(await getLine(l2))).toEqual(before.l2);
    expect(snap(await getLine(l3))).toEqual(before.l3);
  });
});
