/**
 * DB caracterizare — fix 7: copierea atașamentelor formular→flux se declanșează la LINK-FLOW
 * (punctul durabil), prin ruta reală POST /api/formulare-{df,ord}/:id/link-flow.
 *
 * Cauză reparată: înainte, copierea era agățată de `meta.dfId/ordId` în POST /flows (crud.mjs),
 * absent pe calea de link dedicat → atașamentele nu ajungeau niciodată în flux pe fluxurile ALOP.
 * Acum `linkFlowFormular` (formular-shared.mjs) cheamă helper-ul după UPDATE-urile de legătură
 * și întoarce `formAttachmentsCopied` în răspuns (citit de bannerul din semdoc-initiator).
 *
 * Asigură: DF + ORD copiază; răspunsul poartă numărul; idempotent (re-link pe flux completed →
 * fără duplicate); fără atașamente → 0, linkarea reușește oricum (copierea e non-fatal).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedFlow, seedFlowApproved, getDf, getOrd, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

async function insertFormAtt({ formType = 'df', formId, filename, mime = 'application/pdf', data = 'X', slot = 1, deletedAt = null }) {
  await pool.query(
    `INSERT INTO formulare_atasamente (form_type, form_id, uploaded_by, filename, mime_type, size_bytes, data, slot, deleted_at)
     VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8)`,
    [formType, formId, filename, mime, Buffer.byteLength(data), Buffer.from(data), slot, deletedAt]
  );
}

async function flowAtts(flowId) {
  const { rows } = await pool.query(
    `SELECT filename FROM flow_attachments WHERE flow_id=$1 ORDER BY filename ASC`, [flowId]
  );
  return rows.map(r => r.filename);
}

d('POST /api/formulare-*/:id/link-flow — copiere atașamente (fix 7)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await pool.query('TRUNCATE flow_attachments, formulare_atasamente RESTART IDENTITY');
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' }); // user 1, org 1
    app = buildApp();
  });
  // pool e PARTAJAT (import din db/index.mjs) → o singură închidere per FIȘIER, în afterAll-ul
  // ULTIMULUI describe (fix 10, mai jos). Aici NU închidem — altfel pool-ul moare înainte de
  // describe-ul următor și „Called end on pool more than once" în CI.
  const p1 = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  it('DF: link-flow copiază cele 2 atașamente, răspunsul poartă formAttachmentsCopied, status→transmis_flux', async () => {
    const df = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', nrUnic: 'DF-LF-1' });
    await insertFormAtt({ formId: df, filename: 'declaratie_interese.pdf', data: 'INT' });
    await insertFormAtt({ formId: df, filename: 'declaratie_avere.pdf', data: 'AV', slot: 2 });
    const flowId = await seedFlow({ completed: false });

    const res = await request(app).post(`/api/formulare-df/${df}/link-flow`).set('Cookie', p1()).send({ flow_id: flowId });
    expect(res.status).toBe(200);
    expect(res.body.formAttachmentsCopied).toBe(2);
    expect(await flowAtts(flowId)).toEqual(['declaratie_avere.pdf', 'declaratie_interese.pdf']);
    expect((await getDf(df)).status).toBe('transmis_flux');
    expect((await getDf(df)).flow_id).toBe(flowId);
  });

  it('ORD: link-flow copiază atașamentul, răspunsul poartă formAttachmentsCopied', async () => {
    const ord = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', nrOrd: 'ORD-LF-1' });
    await insertFormAtt({ formType: 'ord', formId: ord, filename: 'factura.pdf', data: 'FACT' });
    const flowId = await seedFlow({ completed: false });

    const res = await request(app).post(`/api/formulare-ord/${ord}/link-flow`).set('Cookie', p1()).send({ flow_id: flowId });
    expect(res.status).toBe(200);
    expect(res.body.formAttachmentsCopied).toBe(1);
    expect(await flowAtts(flowId)).toEqual(['factura.pdf']);
  });

  it('ORD: re-link pe acelaşi flux (completed) → idempotent, fără duplicate', async () => {
    const ord = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', nrOrd: 'ORD-LF-2' });
    await insertFormAtt({ formType: 'ord', formId: ord, filename: 'factura.pdf', data: 'FACT' });
    // flux completed → guard-ul „al doilea flux activ" trece, ORD nu schimbă status la link
    const flowId = await seedFlowApproved();

    const r1 = await request(app).post(`/api/formulare-ord/${ord}/link-flow`).set('Cookie', p1()).send({ flow_id: flowId });
    expect(r1.status).toBe(200);
    expect(r1.body.formAttachmentsCopied).toBe(1);

    const r2 = await request(app).post(`/api/formulare-ord/${ord}/link-flow`).set('Cookie', p1()).send({ flow_id: flowId });
    expect(r2.status).toBe(200);
    expect(r2.body.formAttachmentsCopied).toBe(0); // dedup helper → nimic nou
    expect((await flowAtts(flowId)).length).toBe(1);
  });

  it('DF fără atașamente → link-flow reușește, formAttachmentsCopied=0 (copierea e non-fatal/no-op)', async () => {
    const df = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', nrUnic: 'DF-LF-3' });
    const flowId = await seedFlow({ completed: false });

    const res = await request(app).post(`/api/formulare-df/${df}/link-flow`).set('Cookie', p1()).send({ flow_id: flowId });
    expect(res.status).toBe(200);
    expect(res.body.formAttachmentsCopied).toBe(0);
    expect((await getDf(df)).status).toBe('transmis_flux');
    expect((await flowAtts(flowId)).length).toBe(0);
  });
});

/**
 * fix 10 — cauză rădăcină: `crud.mjs` (POST /flows) pre-setează `formulare_{df,ord}.flow_id`
 * la CREARE (din meta.dfId/ordId), ÎNAINTE de link-flow. Guard-ul `already_on_flow` din
 * linkFlowFormular verifica DOAR `doc.flow_id` activ, fără să excludă fluxul CURENT → 409 pe
 * propriul flux tocmai legat → copierea (542) era cod mort pe ORICE lansare DF/ORD standalone.
 * Fix: guard-ul 409-uie DOAR pe un flux DIFERIT activ (`doc.flow_id !== flow_id`).
 *
 * ⚠️ Pasul critic care reproduce bug-ul: flow_id PRE-SETAT la fluxul curent înainte de link.
 * Fără el, testul ar trece fals verde (doc.flow_id null → guard sărit oricum).
 */
d('POST /api/formulare-*/:id/link-flow — guard already_on_flow exclude fluxul curent (fix 10)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await pool.query('TRUNCATE flow_attachments, formulare_atasamente RESTART IDENTITY');
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' }); // user 1, org 1
    app = buildApp();
  });
  afterAll(() => pool.end());
  const p1 = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  it('DF: flow_id pre-setat la fluxul curent (mimează crud.mjs) → 200, copiază, NU 409 already_on_flow', async () => {
    const flowId = await seedFlow({ completed: false });
    // PASUL CRITIC: crud.mjs setează deja flow_id la creare, înainte de link-flow.
    const df = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', nrUnic: 'DF-F10-1', flowId });
    await insertFormAtt({ formId: df, filename: 'Asigurare RCA.pdf', data: 'RCA' });

    const res = await request(app).post(`/api/formulare-df/${df}/link-flow`).set('Cookie', p1()).send({ flow_id: flowId });
    expect(res.status).toBe(200);
    expect(res.body.formAttachmentsCopied).toBe(1);
    expect(await flowAtts(flowId)).toEqual(['Asigurare RCA.pdf']);
    expect((await getDf(df)).status).toBe('transmis_flux');
  });

  it('ORD: flow_id pre-setat la fluxul curent → 200, copiază, NU 409 already_on_flow', async () => {
    const flowId = await seedFlow({ completed: false });
    const ord = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', nrOrd: 'ORD-F10-1', flowId });
    await insertFormAtt({ formType: 'ord', formId: ord, filename: 'factura.pdf', data: 'FACT' });

    const res = await request(app).post(`/api/formulare-ord/${ord}/link-flow`).set('Cookie', p1()).send({ flow_id: flowId });
    expect(res.status).toBe(200);
    expect(res.body.formAttachmentsCopied).toBe(1);
    expect(await flowAtts(flowId)).toEqual(['factura.pdf']);
  });

  it('non-regresie DF: flow_id pre-setat la un flux DIFERIT activ → 409 already_on_flow (guard real intact)', async () => {
    const otherFlow = await seedFlow({ completed: false }); // flux zombi diferit, activ
    const df = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', nrUnic: 'DF-F10-2', flowId: otherFlow });
    await insertFormAtt({ formId: df, filename: 'Asigurare RCA.pdf', data: 'RCA' });
    const newFlow = await seedFlow({ completed: false });

    const res = await request(app).post(`/api/formulare-df/${df}/link-flow`).set('Cookie', p1()).send({ flow_id: newFlow });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already_on_active_flow/);
    expect((await flowAtts(newFlow)).length).toBe(0); // copierea NU a rulat — guard activ
  });

  it('non-regresie ORD: flow_id pre-setat la un flux DIFERIT activ → 409 already_on_flow', async () => {
    const otherFlow = await seedFlow({ completed: false });
    const ord = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', nrOrd: 'ORD-F10-2', flowId: otherFlow });
    await insertFormAtt({ formType: 'ord', formId: ord, filename: 'factura.pdf', data: 'FACT' });
    const newFlow = await seedFlow({ completed: false });

    const res = await request(app).post(`/api/formulare-ord/${ord}/link-flow`).set('Cookie', p1()).send({ flow_id: newFlow });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already_on_active_flow/);
    expect((await flowAtts(newFlow)).length).toBe(0);
  });
});
