/**
 * test:db — #210: poarta de reluare a confirmării plății (`POST /api/alop/:id/plata/reia`)
 * se lărgește la `admin OR (org_admin cu orgId) OR isCabDept`.
 *
 * Context: #209 pusese poarta strict pe `isCabDept`. Consecință în producție: un cont
 * `admin` nu putea relua confirmarea greșit făcută. Regula nouă e IDENTICĂ cu cea de la
 * acceptarea liniilor OPME (`opme-accept-poarta.test.mjs`) — controlul real rămâne motivul
 * scris obligatoriu + auditul cu valorile vechi, nu poarta de rol.
 *
 * ⛔ Garda de integritate „ciclu avansat" (409) rămâne NEATINSĂ — rolul nu trece peste ea.
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
const TOTAL  = 20891.04;
const SUMA_B = 1726.53;
const MOTIV  = 'Plata a fost confirmată doar cu al doilea OP; se reface cu suma totală.';

const getAlop = async (id) => (await pool.query('SELECT * FROM alop_instances WHERE id=$1', [id])).rows[0];

d('#210 — POST /api/alop/:id/plata/reia: poarta admin/org_admin/CAB', () => {
  let app, initId, cabId, altId, admId, oadmId;

  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
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

  async function seedConfirmat({ cicluCurent = 1 } = {}) {
    const dfId  = await seedDf({ orgId: 1, createdBy: initId, status: 'aprobat' });
    const ordId = await seedOrd({ orgId: 1, createdBy: initId, dfId,
      rows: [{ cod_angajament: COD, indicator_angajament: IND, suma_ordonantata_plata: TOTAL }] });
    await pool.query('UPDATE formulare_ord SET cif_beneficiar=$2, iban_beneficiar=$3 WHERE id=$1',
      [ordId, CIF, IBAN_ORD]);
    const alopId = await seedAlop({ orgId: 1, createdBy: initId, status: 'completed', dfId, ordId,
      compartiment: ALT, cicluCurent, sumaTotalaPlatita: 5000 });
    await pool.query(`UPDATE alop_instances SET
        completed_at=NOW(), plata_confirmed_at=NOW() - INTERVAL '1 hour', plata_confirmed_by=$2,
        plata_suma_efectiva=$3, plata_nr_ordin='2792', plata_data=DATE '2026-09-03',
        plata_source='manual', plata_observatii='obs', plata_notes='note'
      WHERE id=$1`, [alopId, cabId, SUMA_B]);
    return { alopId, ordId, dfId };
  }

  it('9. ⭐ admin (platform) ⇒ 200, reluare efectuată', async () => {
    const { alopId } = await seedConfirmat();
    const res = await request(app).post(`/api/alop/${alopId}/plata/reia`)
      .set('Cookie', ck(admId, 'admin')).send({ motiv: MOTIV });
    expect(res.status).toBe(200);
    const a = await getAlop(alopId);
    expect(a.status).toBe('plata');
    expect(a.plata_confirmed_at).toBeNull();
  });

  it('10. ⭐ org_admin din aceeași organizație ⇒ 200', async () => {
    const { alopId } = await seedConfirmat();
    const res = await request(app).post(`/api/alop/${alopId}/plata/reia`)
      .set('Cookie', ck(oadmId, 'org_admin')).send({ motiv: MOTIV });
    expect(res.status).toBe(200);
    expect((await getAlop(alopId)).status).toBe('plata');
  });

  it('11. cab_dept ⇒ 200 (neregresie #209)', async () => {
    const { alopId } = await seedConfirmat();
    const res = await request(app).post(`/api/alop/${alopId}/plata/reia`)
      .set('Cookie', ck(cabId)).send({ motiv: MOTIV });
    expect(res.status).toBe(200);
  });

  it('12. ⭐ inspector obișnuit, nici CAB nici admin ⇒ 403 doar_responsabil_cab, zero scrieri', async () => {
    const { alopId } = await seedConfirmat();
    const res = await request(app).post(`/api/alop/${alopId}/plata/reia`)
      .set('Cookie', ck(altId)).send({ motiv: MOTIV });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('doar_responsabil_cab');
    expect((await getAlop(alopId)).status).toBe('completed');
  });

  it('13. inițiatorul dosarului, care nu e CAB ⇒ 403', async () => {
    const { alopId } = await seedConfirmat();
    const res = await request(app).post(`/api/alop/${alopId}/plata/reia`)
      .set('Cookie', ck(initId)).send({ motiv: MOTIV });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('doar_responsabil_cab');
  });

  it('14. org_admin fără orgId ⇒ NU trece prin ramura admin-like (respins mai devreme — SELECT-ul filtrează pe org_id=NULL ⇒ 404)', async () => {
    // Observat: `WHERE id=$1 AND org_id=$2` cu actor.orgId=null nu găsește niciodată rândul
    // (org_id real e 1) ⇒ 404, înainte ca poarta de rol să fie evaluată. Ramura
    // `&& actor.orgId` din regulă nu se manifestă ca `doar_responsabil_cab` pe acest cod;
    // verificăm doar că cererea NU e acceptată.
    const { alopId } = await seedConfirmat();
    const cookie = makeAuthCookie({ userId: oadmId, role: 'org_admin', orgId: null, email: 'oadm@x.ro' });
    const res = await request(app).post(`/api/alop/${alopId}/plata/reia`)
      .set('Cookie', cookie).send({ motiv: MOTIV });
    expect(res.status).not.toBe(200);
    expect((await getAlop(alopId)).status).toBe('completed');
  });

  it('14b. admin fără motiv ⇒ 400, zero scrieri (lărgirea de rol nu dispensează de motiv)', async () => {
    const { alopId } = await seedConfirmat();
    const res = await request(app).post(`/api/alop/${alopId}/plata/reia`)
      .set('Cookie', ck(admId, 'admin')).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('motiv_obligatoriu');
    expect((await getAlop(alopId)).status).toBe('completed');
  });

  it('15. ⭐ admin pe un dosar cu ciclu avansat ⇒ tot 409 ciclu_avansat (rolul nu trece peste garda de integritate)', async () => {
    const { alopId, ordId } = await seedConfirmat({ cicluCurent: 2 });
    await pool.query(`INSERT INTO alop_ord_cicluri (alop_id, org_id, ciclu_nr, ord_id, plata_suma_efectiva, status, created_at)
      VALUES ($1, 1, 1, $2, 9000, 'completed', NOW())`, [alopId, ordId]);
    const res = await request(app).post(`/api/alop/${alopId}/plata/reia`)
      .set('Cookie', ck(admId, 'admin')).send({ motiv: MOTIV });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ciclu_avansat');
    expect((await getAlop(alopId)).status).toBe('completed');
  });
});
