// Endpoint export XML oficial (v3.9.591): GET /api/formulare-{df,ord}/:id/xml.
// Validează XSD ÎNAINTE de servire (422 dacă neconform), gate prin capabilities (409 dacă
// documentul nu e validat A+B), nume fișier în stil MF. Rute REALE peste Postgres efemer.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, seedOrd, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';
import { validateXml } from '../../services/alop-xml/validate.mjs';

const d = describe.skipIf(!hasTestDb());

// Completează coloanele scalare obligatorii (XSD `use="required"`) pe un DF/ORD deja seedat.
async function fillDfScalars(id, over = {}) {
  const v = {
    cif: '4221306', den_inst_pb: 'Primăria Comunei Exemplu', subtitlu_df: 'Achiziție licență IT',
    revizuirea: '0', data_revizuirii: '15.01.2026', compartiment_specialitate: 'Compartiment IT',
    obiect_fd_reviz_scurt: 'Achiziție licență software',
    obiect_fd_reviz_lung: 'Achiziția unei licențe IT necesară activității curente.', ...over,
  };
  await pool.query(
    `UPDATE formulare_df SET cif=$2, den_inst_pb=$3, subtitlu_df=$4, revizuirea=$5,
       data_revizuirii=$6, compartiment_specialitate=$7, obiect_fd_reviz_scurt=$8, obiect_fd_reviz_lung=$9
     WHERE id=$1`,
    [id, v.cif, v.den_inst_pb, v.subtitlu_df, v.revizuirea, v.data_revizuirii,
     v.compartiment_specialitate, v.obiect_fd_reviz_scurt, v.obiect_fd_reviz_lung]
  );
}
async function fillOrdScalars(id) {
  await pool.query(
    `UPDATE formulare_ord SET cif=$2, den_inst_pb=$3, nr_ordonant_pl=$4, data_ordont_pl=$5,
       beneficiar=$6, documente_justificative=$7, iban_beneficiar=$8, cif_beneficiar=$9,
       banca_beneficiar=$10, inf_pv_plata=$11, nr_unic_inreg=$12
     WHERE id=$1`,
    [id, '4267117', 'Unitatea Administrativ-Teritorială Exemplu', '121', '05.02.2026',
     'Telekom România', 'Factura', 'RO51 RNCB 0080 0029 7151 0001', '427320', 'BCR',
     'Contravaloare factură ianuarie', '111']
  );
}

const VALID_VAL  = [{ element_fd: 'Licență IT', program: '6102', codSSI: '20.01.30', param_fd: '1 buc', valt_rev_prec: '0', influente: '560', valt_actualiz: '560' }];
const VALID_PLATI = [{ program: '6102', codSSI: '20.01.30', plati_estim_ancrt: '560' }];
const VALID_CTRL  = [{ cod_angajament: '20260002', indicator_angajament: 'A', program: '6102', cod_SSI: '20.01.30', sum_rezv_crdt_ang_act: '560', sum_rezv_crdt_bug_act: '560' }];
const VALID_ORD_ROWS = [{ cod_angajament: 'AABBD7P9XP6', indicator_angajament: 'AAB', program: '0000000541', cod_SSI: '01A510103200108', receptii: '50', plati_anterioare: '0', suma_ordonantata_plata: '50', receptii_neplatite: '0' }];

d('GET /api/formulare-*/:id/xml — export XML oficial', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' });  // id 1, org 1
    await seedUser({ orgId: 1, email: 'p2@x.ro' });          // id 2
    app = buildApp();
  });
  afterAll(() => pool.end());
  const p1 = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  it('DF validat (completed) → 200, content-type XML, nume MF, corp validează XSD', async () => {
    const id = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', nrUnic: 'DF-2026-0002',
      rowsVal: VALID_VAL, rowsPlati: VALID_PLATI, rowsCtrl: VALID_CTRL });
    await fillDfScalars(id);
    const res = await request(app).get(`/api/formulare-df/${id}/xml`).set('Cookie', p1());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/xml');
    expect(res.headers['content-disposition']).toContain('DocumentFundamentare_2026_01_15_DF-2026-0002.xml');
    expect(res.text).toContain('<NOTAFD');
    const { valid } = await validateXml(res.text, 'notafd_v0');
    expect(valid).toBe(true);
  });

  it('DF ne-validat (draft incomplet) → 409 not_exportable', async () => {
    const id = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', nrUnic: 'DF-2026-0003' });
    const res = await request(app).get(`/api/formulare-df/${id}/xml`).set('Cookie', p1());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_exportable');
  });

  it('DF cu influență negativă (revizie cu diminuare) → 422 xml_invalid (limitarea schemei v0)', async () => {
    const id = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', nrUnic: 'DF-2026-0004',
      rowsVal: [{ element_fd: 'Diminuare', program: '6102', codSSI: '20.01.30', param_fd: 'rev', valt_rev_prec: '10', influente: '-10', valt_actualiz: '0' }],
      rowsPlati: VALID_PLATI, rowsCtrl: VALID_CTRL });
    await fillDfScalars(id, { revizuirea: '1' });
    const res = await request(app).get(`/api/formulare-df/${id}/xml`).set('Cookie', p1());
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('xml_invalid');
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  it('ORD validat (completed) → 200, nume MF, corp validează XSD', async () => {
    const id = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', nrOrd: '121', rows: VALID_ORD_ROWS });
    await fillOrdScalars(id);
    const res = await request(app).get(`/api/formulare-ord/${id}/xml`).set('Cookie', p1());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/xml');
    expect(res.headers['content-disposition']).toContain('OrdonantareDePlata_2026_02_05_121.xml');
    const { valid } = await validateXml(res.text, 'ordnt_v0');
    expect(valid).toBe(true);
  });

  it('404 pe id inexistent', async () => {
    const res = await request(app).get(`/api/formulare-df/99999999-9999-9999-9999-999999999999/xml`).set('Cookie', p1());
    expect(res.status).toBe(404);
  });
});
