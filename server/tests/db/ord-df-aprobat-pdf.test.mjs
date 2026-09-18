/**
 * #220 — Previzualizarea PDF-ului SEMNAT al DF-ului din formularul ORD + antetul ALOP.
 *
 * Ruta nouă `GET /api/formulare-ord/:id/df-aprobat.pdf` servește PDF-ul semnat al DF-ului
 * pe baza căruia s-a emis ordonanțarea — revizia ÎNGHEȚATĂ în `formulare_ord.df_id`
 * (#134b), NU ultima aprobată a dosarului.
 *
 * Decizia de acces (Mircea, 17.09.2026): dreptul se derivă din ORD — cine vede
 * ordonanțarea vede și DF-ul ei (același dosar). Gărzi: DF-ul legat, aceeași organizație,
 * același dosar (când ambele au proveniență), APROBAT.
 *
 * Cazuri (⭐ = ancorele lotului):
 *  1 ⭐ inițiatorul ORD → 200, application/pdf, bytes identici cu flows_pdfs
 *  2 ⭐ decizia 1: vede ORD-ul dar NU DF-ul prin regulile DF → 200 (și 403 pe signed-pdf)
 *  3   nu vede ORD-ul → 403; altă organizație → 404 (aliniat cu GET detaliu ORD)
 *  4   ORD fără df_id → 404 fara_df
 *  5 ⭐ DF neaprobat (flux refuzat / fără flux) → 409 df_neaprobat
 *  6 ⭐ DF din alt dosar → 409 df_alt_dosar
 *  7   DF aprobat fără PDF semnat și fără Drive → 404 signed_pdf_missing
 *  8 ⭐ revizia înghețată: R0 pe ORD + R1 aprobat ulterior → PDF-ul lui R0
 *  9 ⭐ neregresie GET /flows/:flowId/signed-pdf (antete identice)
 * 10 ⭐ detaliul ORD expune df_revizie_nr + df_aprobat_semnat
 * 11 ⭐ detaliul ALOP expune df_revizie_vigoare_flow_id (R1, nu R0; NULL fără aprobare)
 *
 * Seed-uri: `seedFlowApproved`/`seedFlow` din db-real.mjs NU scriu în `flows_pdfs` —
 * PDF-ul se inserează direct (ca în flow-access-df-ord.test.mjs).
 * Auto-skip fără TEST_DATABASE_URL (npm test rămâne verde); sursa de adevăr = CI.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import {
  hasTestDb, migrate, truncateAll, pool,
  seedOrgUser, seedUser, seedDf, seedOrd, seedAlop, makeAuthCookie,
} from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

// PDF minimal, distinct per flux — bytes-ul servit trebuie să fie EXACT cel din flows_pdfs.
function pdfBytes(tag) {
  return Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog /Tag (${tag}) >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`);
}

d('#220 — GET /api/formulare-ord/:id/df-aprobat.pdf + câmpurile de detaliu', () => {
  let app;
  let orgId, org2Id;
  let dfCreatorId, ordCreatorId, strangerId, adminId, user2Id;
  let alopId;

  const cookie = (userId, email, role = 'user', org = orgId) => makeAuthCookie({ userId, role, orgId: org, email });
  const asDfCreator  = () => cookie(dfCreatorId,  'dfcreator@x.ro');
  const asOrdCreator = () => cookie(ordCreatorId, 'ordcreator@x.ro');
  const asStranger   = () => cookie(strangerId,   'stranger@x.ro');
  const asAdmin      = () => cookie(adminId,      'admin@x.ro', 'org_admin');

  // Flux semnat, cu inițiatorul = creatorul DF-ului (initEmail) și PDF semnat în flows_pdfs.
  async function seedSignedFlow(id, { status = 'completed', pdf = pdfBytes(id), withPdf = true } = {}) {
    const completed = status === 'completed';
    const data = {
      flowId: id, docName: 'DF test', initName: 'Creator DF', initEmail: 'dfcreator@x.ro',
      signers: [], orgId,
      ...(completed ? { status: 'completed', completed: true } : { status }),
    };
    await pool.query(`INSERT INTO flows (id, data, org_id) VALUES ($1, $2::jsonb, $3)`,
      [id, JSON.stringify(data), orgId]);
    if (withPdf) {
      await pool.query(`INSERT INTO flows_pdfs (flow_id, key, data) VALUES ($1, 'signedPdfB64', $2)`,
        [id, pdf.toString('base64')]);
    }
    return id;
  }

  // Scenariul de bază: dosar A, DF R0 aprobat + semnat, ORD emis pe el.
  async function seedBase() {
    alopId = await seedAlop({ orgId, createdBy: dfCreatorId, status: 'ordonantare', titlu: 'Dosar A' });
    const flowId = await seedSignedFlow('flow-220-r0');
    const dfId = await seedDf({ orgId, createdBy: dfCreatorId, status: 'aprobat', flowId, nrUnic: 'DF-220', revizieNr: 0, sourceAlopId: alopId });
    await pool.query(`UPDATE alop_instances SET df_id=$1, df_flow_id=$2 WHERE id=$3`, [dfId, flowId, alopId]);
    const ordId = await seedOrd({ orgId, createdBy: ordCreatorId, status: 'draft', dfId, nrOrd: 'ORD-220' });
    await pool.query(`UPDATE formulare_ord SET source_alop_id=$1 WHERE id=$2`, [alopId, ordId]);
    return { dfId, flowId, ordId };
  }

  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await pool.query('DELETE FROM flows_pdfs');

    const o = await seedOrgUser({ orgName: 'Org 220', email: 'dfcreator@x.ro', role: 'user', compartiment: 'Achizitii' });
    orgId = o.orgId; dfCreatorId = o.userId;
    // Fără CAB pe organizație: nimeni nu capătă drepturi prin ramura cab_dept.
    // Creatorul ORD e în ALT compartiment decât creatorul DF ⇒ NU vede DF-ul prin regulile DF.
    ordCreatorId = await seedUser({ orgId, email: 'ordcreator@x.ro', compartiment: 'Juridic' });
    strangerId   = await seedUser({ orgId, email: 'stranger@x.ro',   compartiment: 'Urbanism' });
    adminId      = await seedUser({ orgId, email: 'admin@x.ro', role: 'org_admin', compartiment: '' });

    const o2 = await seedOrgUser({ orgName: 'Org 220 bis', email: 'user2@x.ro', role: 'user' });
    org2Id = o2.orgId; user2Id = o2.userId;

    app = buildApp();
  });
  afterAll(() => pool.end());

  // ── 1 ⭐ ──────────────────────────────────────────────────────────────────
  it('1. inițiatorul ORD → 200, application/pdf, bytes identici cu flows_pdfs', async () => {
    const { ordId } = await seedBase();
    const res = await request(app).get(`/api/formulare-ord/${ordId}/df-aprobat.pdf`)
      .set('Cookie', asOrdCreator()).buffer(true).parse((r, cb) => {
        const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf/);
    expect(res.headers['content-disposition']).toContain('DF_DF-220_R0_semnat.pdf');
    expect(Buffer.compare(res.body, pdfBytes('flow-220-r0'))).toBe(0);
  });

  // ── 2 ⭐ decizia 1 ─────────────────────────────────────────────────────────
  it('2. vede ORD-ul dar NU DF-ul prin regulile DF → 200 pe ruta nouă, 403 pe signed-pdf', async () => {
    const { ordId, flowId } = await seedBase();
    // Dovada că ruta nouă e cea care decide: pe fluxul DF, același actor e refuzat.
    const direct = await request(app).get(`/flows/${flowId}/signed-pdf`).set('Cookie', asOrdCreator());
    expect(direct.status).toBe(403);
    const res = await request(app).get(`/api/formulare-ord/${ordId}/df-aprobat.pdf`).set('Cookie', asOrdCreator());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf/);
  });

  // ── 3 ────────────────────────────────────────────────────────────────────
  it('3. nu vede ORD-ul → 403; altă organizație → 404 (același cod ca GET detaliu ORD)', async () => {
    const { ordId } = await seedBase();
    const s = await request(app).get(`/api/formulare-ord/${ordId}/df-aprobat.pdf`).set('Cookie', asStranger());
    expect(s.status).toBe(403);

    const detailOther = await request(app).get(`/api/formulare-ord/${ordId}`)
      .set('Cookie', cookie(user2Id, 'user2@x.ro', 'user', org2Id));
    const other = await request(app).get(`/api/formulare-ord/${ordId}/df-aprobat.pdf`)
      .set('Cookie', cookie(user2Id, 'user2@x.ro', 'user', org2Id));
    expect(detailOther.status).toBe(404);
    expect(other.status).toBe(detailOther.status);
    expect(other.body.error).toBe('not_found');
  });

  // ── 4 ────────────────────────────────────────────────────────────────────
  it('4. ORD fără df_id → 404 fara_df', async () => {
    const ordId = await seedOrd({ orgId, createdBy: ordCreatorId, status: 'draft', dfId: null, nrOrd: 'ORD-220-nodf' });
    const res = await request(app).get(`/api/formulare-ord/${ordId}/df-aprobat.pdf`).set('Cookie', asOrdCreator());
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('fara_df');
  });

  // ── 5 ⭐ ──────────────────────────────────────────────────────────────────
  it('5. DF neaprobat (flux refuzat) → 409 df_neaprobat, fără corp PDF', async () => {
    const flowId = await seedSignedFlow('flow-220-refuzat', { status: 'refused' });
    const dfId = await seedDf({ orgId, createdBy: dfCreatorId, status: 'completed', flowId, nrUnic: 'DF-220-R' });
    const ordId = await seedOrd({ orgId, createdBy: ordCreatorId, status: 'draft', dfId, nrOrd: 'ORD-220-R' });
    const res = await request(app).get(`/api/formulare-ord/${ordId}/df-aprobat.pdf`).set('Cookie', asOrdCreator());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('df_neaprobat');
    expect(res.headers['content-type']).not.toMatch(/pdf/);
  });

  it('5b. DF fără flux → 409 df_neaprobat', async () => {
    const dfId = await seedDf({ orgId, createdBy: dfCreatorId, status: 'completed', flowId: null, nrUnic: 'DF-220-NF' });
    const ordId = await seedOrd({ orgId, createdBy: ordCreatorId, status: 'draft', dfId, nrOrd: 'ORD-220-NF' });
    const res = await request(app).get(`/api/formulare-ord/${ordId}/df-aprobat.pdf`).set('Cookie', asOrdCreator());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('df_neaprobat');
  });

  // ── 6 ⭐ ──────────────────────────────────────────────────────────────────
  it('6. DF din alt dosar decât ORD-ul → 409 df_alt_dosar', async () => {
    const { dfId } = await seedBase();
    const alopB = await seedAlop({ orgId, createdBy: dfCreatorId, status: 'ordonantare', titlu: 'Dosar B' });
    const ordB = await seedOrd({ orgId, createdBy: ordCreatorId, status: 'draft', dfId, nrOrd: 'ORD-220-B' });
    await pool.query(`UPDATE formulare_ord SET source_alop_id=$1 WHERE id=$2`, [alopB, ordB]);
    const res = await request(app).get(`/api/formulare-ord/${ordB}/df-aprobat.pdf`).set('Cookie', asOrdCreator());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('df_alt_dosar');
  });

  // ── 7 ────────────────────────────────────────────────────────────────────
  it('7. DF aprobat fără PDF semnat și fără Drive → 404 signed_pdf_missing', async () => {
    const flowId = await seedSignedFlow('flow-220-nopdf', { withPdf: false });
    const dfId = await seedDf({ orgId, createdBy: dfCreatorId, status: 'aprobat', flowId, nrUnic: 'DF-220-NP' });
    const ordId = await seedOrd({ orgId, createdBy: ordCreatorId, status: 'draft', dfId, nrOrd: 'ORD-220-NP' });
    const res = await request(app).get(`/api/formulare-ord/${ordId}/df-aprobat.pdf`).set('Cookie', asOrdCreator());
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('signed_pdf_missing');
  });

  // ── 8 ⭐ revizia înghețată ─────────────────────────────────────────────────
  it('8. R0 pe ORD + R1 aprobat ulterior pe același dosar → ruta servește PDF-ul lui R0', async () => {
    const { ordId, dfId } = await seedBase();
    const flowR1 = await seedSignedFlow('flow-220-r1');
    const dfR1 = await seedDf({ orgId, createdBy: dfCreatorId, status: 'aprobat', flowId: flowR1, nrUnic: 'DF-220', revizieNr: 1, parentDfId: dfId, sourceAlopId: alopId });
    await pool.query(`UPDATE alop_instances SET df_id=$1, df_flow_id=$2 WHERE id=$3`, [dfR1, flowR1, alopId]);

    const res = await request(app).get(`/api/formulare-ord/${ordId}/df-aprobat.pdf`)
      .set('Cookie', asOrdCreator()).buffer(true).parse((r, cb) => {
        const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('_R0_semnat.pdf');
    expect(Buffer.compare(res.body, pdfBytes('flow-220-r0'))).toBe(0);
    expect(Buffer.compare(res.body, pdfBytes('flow-220-r1'))).not.toBe(0);
  });

  // ── 9 ⭐ neregresie ruta existentă ────────────────────────────────────────
  it('9. GET /flows/:flowId/signed-pdf pentru inițiatorul DF → 200, antete neschimbate', async () => {
    const { flowId } = await seedBase();
    const res = await request(app).get(`/flows/${flowId}/signed-pdf`)
      .set('Cookie', asDfCreator()).buffer(true).parse((r, cb) => {
        const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf/);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="DocFlowAI_${flowId}_signed.pdf"`);
    expect(Buffer.compare(res.body, pdfBytes('flow-220-r0'))).toBe(0);
  });

  it('9b. signed-pdf fără PDF și fără Drive → 404 signed_pdf_missing (neregresie)', async () => {
    const flowId = await seedSignedFlow('flow-220-nopdf2', { withPdf: false });
    const res = await request(app).get(`/flows/${flowId}/signed-pdf`).set('Cookie', asDfCreator());
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('signed_pdf_missing');
  });

  // ── 10 ⭐ detaliul ORD ─────────────────────────────────────────────────────
  it('10. GET /api/formulare-ord/:id expune df_revizie_nr + df_aprobat_semnat', async () => {
    const { ordId } = await seedBase();
    const ok = await request(app).get(`/api/formulare-ord/${ordId}`).set('Cookie', asOrdCreator());
    expect(ok.status).toBe(200);
    expect(ok.body.document.df_revizie_nr).toBe(0);
    expect(ok.body.document.df_aprobat_semnat).toBe(true);

    // DF neaprobat ⇒ false
    const flowRef = await seedSignedFlow('flow-220-ref2', { status: 'refused' });
    const dfRef = await seedDf({ orgId, createdBy: dfCreatorId, status: 'completed', flowId: flowRef, nrUnic: 'DF-220-X' });
    const ordRef = await seedOrd({ orgId, createdBy: ordCreatorId, status: 'draft', dfId: dfRef, nrOrd: 'ORD-220-X' });
    const neaprobat = await request(app).get(`/api/formulare-ord/${ordRef}`).set('Cookie', asOrdCreator());
    expect(neaprobat.body.document.df_aprobat_semnat).toBe(false);

    // ORD fără DF ⇒ false/absent
    const ordNoDf = await seedOrd({ orgId, createdBy: ordCreatorId, status: 'draft', dfId: null, nrOrd: 'ORD-220-Y' });
    const noDf = await request(app).get(`/api/formulare-ord/${ordNoDf}`).set('Cookie', asOrdCreator());
    expect(noDf.body.document.df_aprobat_semnat).toBeFalsy();
  });

  // ── 11 ⭐ detaliul ALOP ────────────────────────────────────────────────────
  it('11. GET /api/alop/:id expune df_revizie_vigoare_flow_id = fluxul reviziei ÎN VIGOARE (R1, nu R0)', async () => {
    const { dfId, flowId: flowR0 } = await seedBase();
    const r0 = await request(app).get(`/api/alop/${alopId}`).set('Cookie', asAdmin());
    expect(r0.status).toBe(200);
    expect(r0.body.alop.df_revizie_vigoare_flow_id).toBe(flowR0);

    const flowR1 = await seedSignedFlow('flow-220-r1b');
    await seedDf({ orgId, createdBy: dfCreatorId, status: 'aprobat', flowId: flowR1, nrUnic: 'DF-220', revizieNr: 1, parentDfId: dfId, sourceAlopId: alopId });
    const r1 = await request(app).get(`/api/alop/${alopId}`).set('Cookie', asAdmin());
    expect(r1.status).toBe(200);
    expect(r1.body.alop.df_revizie_vigoare_flow_id).toBe(flowR1);
  });

  it('11b. dosar fără revizie aprobată → df_revizie_vigoare_flow_id NULL', async () => {
    const alopN = await seedAlop({ orgId, createdBy: dfCreatorId, status: 'angajare', titlu: 'Dosar N' });
    const flowRef = await seedSignedFlow('flow-220-refN', { status: 'refused' });
    const dfN = await seedDf({ orgId, createdBy: dfCreatorId, status: 'completed', flowId: flowRef, nrUnic: 'DF-220-N', sourceAlopId: alopN });
    await pool.query(`UPDATE alop_instances SET df_id=$1 WHERE id=$2`, [dfN, alopN]);
    const res = await request(app).get(`/api/alop/${alopN}`).set('Cookie', asAdmin());
    expect(res.status).toBe(200);
    expect(res.body.alop).toHaveProperty('df_revizie_vigoare_flow_id');
    expect(res.body.alop.df_revizie_vigoare_flow_id).toBeNull();
  });
});
