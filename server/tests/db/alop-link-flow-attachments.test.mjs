/**
 * DB caracterizare — fix 8: copierea atașamentelor formular→flux se declanșează ȘI pe calea ALOP
 * (POST /api/alop/:id/link-{df,ord}-flow), unde `linkFlowFormular` dă 409 (doc not completed /
 * already_on_flow) și nu copiază niciodată.
 *
 * Cauză reparată: frontend-ul cheamă AMBELE endpoint-uri la lansare; `link-flow` (formular) are
 * copierea dar dă 409 pe calea ALOP reală, iar `link-{df,ord}-flow` (alop.mjs) seta pointerul
 * NECONDIȚIONAT fără să copieze. Acum `link-{df,ord}-flow` cheamă helper-ul necondiționat.
 *
 * Asigură: DF + ORD copiază pe calea ALOP; idempotent (re-link → fără duplicate); fără atașamente
 * → 0, linkarea reușește; copierea e non-fatal (chiar pe ALOP fără DF/ORD legat).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedAlop, seedFlow, makeAuthCookie } from '../helpers/db-real.mjs';
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

d('POST /api/alop/:id/link-{df,ord}-flow — copiere atașamente (fix 8)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await pool.query('TRUNCATE flow_attachments, formulare_atasamente RESTART IDENTITY');
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' }); // user 1, org 1
    app = buildApp();
  });
  afterAll(() => pool.end());
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  it('link-df-flow copiază cele 2 atașamente ale DF în flux (chiar dacă linkFlowFormular ar da 409)', async () => {
    // DF în lucru (NU completed) → linkFlowFormular ar da 409 document_not_completed,
    // dar calea ALOP rulează copierea necondiționat.
    const df = await seedDf({ orgId: 1, createdBy: 1, status: 'in_lucru', nrUnic: 'DF-AL-1' });
    await insertFormAtt({ formId: df, filename: 'declaratie_interese.pdf', data: 'INT' });
    await insertFormAtt({ formId: df, filename: 'declaratie_avere.pdf', data: 'AV', slot: 2 });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', dfId: df });
    const flowId = await seedFlow({ completed: false });

    const res = await request(app).post(`/api/alop/${alopId}/link-df-flow`).set('Cookie', cookie()).send({ flow_id: flowId });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(await flowAtts(flowId)).toEqual(['declaratie_avere.pdf', 'declaratie_interese.pdf']);
  });

  it('link-ord-flow copiază atașamentul ORD în flux', async () => {
    const ord = await seedOrd({ orgId: 1, createdBy: 1, status: 'in_lucru', nrOrd: 'ORD-AL-1' });
    await insertFormAtt({ formType: 'ord', formId: ord, filename: 'factura.pdf', data: 'FACT' });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', ordId: ord });
    const flowId = await seedFlow({ completed: false });

    const res = await request(app).post(`/api/alop/${alopId}/link-ord-flow`).set('Cookie', cookie()).send({ flow_id: flowId });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(await flowAtts(flowId)).toEqual(['factura.pdf']);
  });

  it('link-ord-flow re-apelat pe acelaşi flux → idempotent, fără duplicate', async () => {
    const ord = await seedOrd({ orgId: 1, createdBy: 1, status: 'in_lucru', nrOrd: 'ORD-AL-2' });
    await insertFormAtt({ formType: 'ord', formId: ord, filename: 'factura.pdf', data: 'FACT' });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', ordId: ord });
    const flowId = await seedFlow({ completed: false });

    const r1 = await request(app).post(`/api/alop/${alopId}/link-ord-flow`).set('Cookie', cookie()).send({ flow_id: flowId });
    expect(r1.status).toBe(200);
    const r2 = await request(app).post(`/api/alop/${alopId}/link-ord-flow`).set('Cookie', cookie()).send({ flow_id: flowId });
    expect(r2.status).toBe(200);
    expect((await flowAtts(flowId)).length).toBe(1);
  });

  it('link-df-flow pe ALOP fără DF/ORD cu atașamente → 200, fără copiere (non-fatal/no-op)', async () => {
    const df = await seedDf({ orgId: 1, createdBy: 1, status: 'in_lucru', nrUnic: 'DF-AL-3' });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', dfId: df });
    const flowId = await seedFlow({ completed: false });

    const res = await request(app).post(`/api/alop/${alopId}/link-df-flow`).set('Cookie', cookie()).send({ flow_id: flowId });
    expect(res.status).toBe(200);
    expect((await flowAtts(flowId)).length).toBe(0);
  });
});
