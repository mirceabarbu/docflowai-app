/**
 * DB caracterizare — fix 11 (B+): copierea atașamentelor formular→flux ca PLASĂ în POST /flows
 * (crud.mjs) NU atinge sursa `formulare_atasamente`, e idempotentă față de a doua cale
 * (linkFlowFormular), iar sursa supraviețuiește ștergerii fluxului.
 *
 * Context: fix 11 readuce copierea în crud.mjs (după pre-setarea `flow_id`, acum `await`-uită ca
 * să elimine cursa cu linkFlowFormular). Copierea folosește `copyFormularAttachmentsToFlow`
 * (INSERT...SELECT — DUPLICĂ bytes-ul, nu mută, nu rereferențiază). Owner-ul a cerut explicit
 * dovada că `formulare_atasamente` rămâne NEATINSĂ după copiere, după aprobare și după ștergerea
 * fluxului (care șterge `flow_attachments`).
 *
 * Acoperă:
 *   - PLASĂ + idempotență: copiere (crud.mjs) apoi a doua copiere (linkFlowFormular) → fără dublare.
 *   - PROTECȚIA SURSEI: formulare_atasamente intact (aceleași rânduri, deleted_at NULL) după copiere.
 *   - PROTECȚIA SURSEI: după ștergerea flow_attachments (simulează soft-delete flux) → sursa intactă.
 *   - ORD simetric.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hasTestDb, migrate, truncateAll, pool, seedOrgUser, seedDf, seedOrd, seedFlow } from '../helpers/db-real.mjs';
import { copyFormularAttachmentsToFlow } from '../../services/formular-flow-attachments.mjs';

const d = describe.skipIf(!hasTestDb());

async function insertFormAtt({ formType = 'df', formId, filename, mime = 'application/pdf', data = 'X', slot = 1, deletedAt = null }) {
  const { rows } = await pool.query(
    `INSERT INTO formulare_atasamente (form_type, form_id, uploaded_by, filename, mime_type, size_bytes, data, slot, deleted_at)
     VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [formType, formId, filename, mime, Buffer.byteLength(data), Buffer.from(data), slot, deletedAt]
  );
  return rows[0].id;
}

async function flowAttNames(flowId) {
  const { rows } = await pool.query(
    `SELECT filename FROM flow_attachments WHERE flow_id=$1 ORDER BY filename ASC`, [flowId]
  );
  return rows.map(r => r.filename);
}

async function sourceAtts(formType, formId) {
  const { rows } = await pool.query(
    `SELECT id, filename, deleted_at, data FROM formulare_atasamente
      WHERE form_type=$1 AND form_id=$2 ORDER BY filename ASC`,
    [formType, formId]
  );
  return rows;
}

d('fix 11 — copiere atașamente PLASĂ + protecția sursei', () => {
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await pool.query('TRUNCATE flow_attachments, formulare_atasamente RESTART IDENTITY');
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' }); // user 1, org 1
  });
  afterAll(() => pool.end());

  it('DF: copiere (crud.mjs) + a doua cale (linkFlowFormular) → idempotent, fără dublare; sursa intactă', async () => {
    const flowId = await seedFlow({ completed: false });
    const df = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', flowId, nrUnic: 'DF-SP-1' });
    await insertFormAtt({ formId: df, filename: 'declaratie_interese.pdf', data: 'INT' });
    await insertFormAtt({ formId: df, filename: 'declaratie_avere.pdf',    data: 'AV', slot: 2 });

    // Calea 1 (crud.mjs, plasă): copiază cele 2.
    const n1 = await copyFormularAttachmentsToFlow(pool, { flowId, formType: 'df', formId: df });
    expect(n1).toBe(2);
    expect(await flowAttNames(flowId)).toEqual(['declaratie_avere.pdf', 'declaratie_interese.pdf']);

    // Calea 2 (linkFlowFormular, redundanță intenționată): a doua rulare NU duplică.
    const n2 = await copyFormularAttachmentsToFlow(pool, { flowId, formType: 'df', formId: df });
    expect(n2).toBe(0);
    expect((await flowAttNames(flowId)).length).toBe(2); // NU 4

    // PROTECȚIA SURSEI: formulare_atasamente intact — aceleași 2 rânduri, deleted_at NULL.
    const src = await sourceAtts('df', df);
    expect(src.length).toBe(2);
    expect(src.every(r => r.deleted_at === null)).toBe(true);
    expect(src.map(r => r.filename)).toEqual(['declaratie_avere.pdf', 'declaratie_interese.pdf']);
    expect(src.find(r => r.filename === 'declaratie_interese.pdf').data.toString()).toBe('INT');
  });

  it('PROTECȚIA SURSEI: ștergerea flow_attachments (simulează soft-delete flux) NU atinge formulare_atasamente', async () => {
    const flowId = await seedFlow({ completed: false });
    const df = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', flowId, nrUnic: 'DF-SP-2' });
    await insertFormAtt({ formId: df, filename: 'anexa.pdf', data: 'ANX' });

    await copyFormularAttachmentsToFlow(pool, { flowId, formType: 'df', formId: df });
    expect((await flowAttNames(flowId)).length).toBe(1);

    // Ștergerea fluxului curăță flow_attachments (cale separată). Sursa trebuie să rămână.
    await pool.query(`DELETE FROM flow_attachments WHERE flow_id=$1`, [flowId]);
    expect((await flowAttNames(flowId)).length).toBe(0);

    const src = await sourceAtts('df', df);
    expect(src.length).toBe(1);
    expect(src[0].deleted_at).toBeNull();
    expect(src[0].data.toString()).toBe('ANX');
  });

  it('ORD: copiere idempotentă ca plasă; sursa formulare_atasamente intactă', async () => {
    const flowId = await seedFlow({ completed: false });
    const ord = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId, nrOrd: 'ORD-SP-1' });
    await insertFormAtt({ formType: 'ord', formId: ord, filename: 'factura.pdf', data: 'FACT' });

    const n1 = await copyFormularAttachmentsToFlow(pool, { flowId, formType: 'ord', formId: ord });
    expect(n1).toBe(1);
    const n2 = await copyFormularAttachmentsToFlow(pool, { flowId, formType: 'ord', formId: ord });
    expect(n2).toBe(0);
    expect(await flowAttNames(flowId)).toEqual(['factura.pdf']);

    const src = await sourceAtts('ord', ord);
    expect(src.length).toBe(1);
    expect(src[0].deleted_at).toBeNull();
    expect(src[0].data.toString()).toBe('FACT');
  });
});
