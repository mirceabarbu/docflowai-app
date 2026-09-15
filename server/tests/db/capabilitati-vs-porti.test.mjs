/**
 * test:db — #211: plasă generică împotriva divergenței capabilitate ↔ poartă.
 *
 * Pentru fiecare rol din matrice, `capabilities.can_reia_plata` întors de
 * `GET /api/alop/:id` trebuie să coincidă cu verdictul real al porții
 * `POST /api/alop/:id/plata/reia` (200 vs 403). Motivul divergenței reparate la #211:
 * capabilitatea era calculată doar din `caps.is_cab`, în timp ce poarta rutei fusese deja
 * lărgită la `admin OR (org_admin cu orgId) OR isCabDept` la #210 — un `admin` nu vedea
 * butonul „Reia confirmarea plății", deși ruta l-ar fi acceptat.
 *
 * Fiecare rol primește PROPRIUL ALOP (seedat identic: completed + plată confirmată în
 * ciclul curent) — nu se refolosește un singur dosar între cazuri, altfel al doilea rol ar
 * primi 409 nu_e_confirmata (dosarul deja reluat de primul rol) și testul ar măsura altceva
 * decât autorizarea.
 *
 * Perechea din OPME (`can_accept` din GET /api/opme/imports/:id vs POST
 * /api/opme/lines/:id/accept) e deja acoperită de #210 — vezi testul „can_accept din
 * raportul importului oglindește verdictul porții de acceptare, pentru fiecare rol" în
 * `opme-accept-poarta.test.mjs`. Nu se duplică aici.
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
const MOTIV  = 'Verificare capabilitate vs poartă (#211).';

d('#211 — can_reia_plata (capabilitate) vs POST /plata/reia (poartă), pe toată matricea de roluri', () => {
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

  async function seedConfirmat() {
    const dfId  = await seedDf({ orgId: 1, createdBy: initId, status: 'aprobat' });
    const ordId = await seedOrd({ orgId: 1, createdBy: initId, dfId,
      rows: [{ cod_angajament: COD, indicator_angajament: IND, suma_ordonantata_plata: TOTAL }] });
    await pool.query('UPDATE formulare_ord SET cif_beneficiar=$2, iban_beneficiar=$3 WHERE id=$1',
      [ordId, CIF, IBAN_ORD]);
    const alopId = await seedAlop({ orgId: 1, createdBy: initId, status: 'completed', dfId, ordId,
      compartiment: ALT, cicluCurent: 1, sumaTotalaPlatita: 5000 });
    await pool.query(`UPDATE alop_instances SET
        completed_at=NOW(), plata_confirmed_at=NOW() - INTERVAL '1 hour', plata_confirmed_by=$2,
        plata_suma_efectiva=$3, plata_nr_ordin='2792', plata_data=DATE '2026-09-03',
        plata_source='manual', plata_observatii='obs', plata_notes='note'
      WHERE id=$1`, [alopId, cabId, SUMA_B]);
    return alopId;
  }

  const CASES = () => ([
    { label: 'admin (platform)',                cookie: () => makeAuthCookie({ userId: admId,  role: 'admin',     orgId: 1, email: 'adm@x.ro' }),  expectTrue: true },
    { label: 'org_admin cu orgId',               cookie: () => makeAuthCookie({ userId: oadmId, role: 'org_admin', orgId: 1, email: 'oadm@x.ro' }), expectTrue: true },
    { label: 'cab_dept',                         cookie: () => makeAuthCookie({ userId: cabId,  role: 'user',      orgId: 1, email: 'cab@x.ro' }),  expectTrue: true },
    { label: 'inspector obișnuit (non-CAB, non-owner)', cookie: () => makeAuthCookie({ userId: altId, role: 'user', orgId: 1, email: 'alt@x.ro' }),  expectTrue: false },
    { label: 'inițiator dosarului, care nu e CAB', cookie: () => makeAuthCookie({ userId: initId, role: 'user',    orgId: 1, email: 'init@x.ro' }),  expectTrue: false },
  ]);

  for (const { label, cookie, expectTrue } of CASES()) {
    it(`${label}: capabilitatea și poarta dau ACELAȘI verdict`, async () => {
      const alopId = await seedConfirmat();
      const ck = cookie();

      const getRes = await request(app).get(`/api/alop/${alopId}`).set('Cookie', ck);
      expect(getRes.status).toBe(200);
      const capVerdict = getRes.body.alop.capabilities.can_reia_plata;
      expect(capVerdict).toBe(expectTrue);

      const postRes = await request(app).post(`/api/alop/${alopId}/plata/reia`)
        .set('Cookie', ck).send({ motiv: MOTIV });
      const routeAllows = postRes.status === 200;
      expect(routeAllows,
        `can_reia_plata spune ${capVerdict} pentru rolul "${label}", dar ruta a răspuns ` +
        `${postRes.status} — capabilitatea afișată și poarta rutei trebuie să dea același ` +
        `verdict (#211).`
      ).toBe(capVerdict);
    });
  }
});
