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
  afterAll(() => pool.end());
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
