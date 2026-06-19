/**
 * DB caracterizare — fix 3/4: atașamentele DF/ORD se copiază în flux ca documente suport.
 *
 * copyFormularAttachmentsToFlow (apelat din POST /flows, crud.mjs) copiază rândurile
 * non-șterse din formulare_atasamente în flow_attachments pentru noul flow_id:
 *   - DF cu 2 atașamente → 2 rânduri flow_attachments, nume/content-type/bytes identice
 *   - idempotent: a doua rulare NU duplică (dedup flow_id + filename)
 *   - atașament soft-deleted NU se copiază
 *   - ORD (form_type='ord') la fel
 *   - dedup și față de un flow_attachment preexistent cu același nume
 *   - fără atașamente → zero copiate (comportament neschimbat)
 *
 * Rândurile copiate sunt flow_attachments OBIȘNUITE → arhivarea Drive le ia prin aceeași
 * cale (drive.mjs citește SELECT ... FROM flow_attachments WHERE flow_id=$1), iar nullify-ul
 * BYTEA post-arhivare (admin/maintenance.mjs) le include — fără cale nouă.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hasTestDb, migrate, truncateAll, pool, seedOrgUser, seedDf, seedOrd, seedFlowApproved } from '../helpers/db-real.mjs';
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

async function getFlowAtts(flowId) {
  const { rows } = await pool.query(
    `SELECT filename, mime_type, size_bytes, data FROM flow_attachments WHERE flow_id=$1 ORDER BY filename ASC`,
    [flowId]
  );
  return rows;
}

d('copyFormularAttachmentsToFlow — DB caracterizare', () => {
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await pool.query('TRUNCATE flow_attachments, formulare_atasamente RESTART IDENTITY');
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' }); // user 1, org 1
  });
  afterAll(() => pool.end());

  it('DF cu 2 atașamente → 2 rânduri flow_attachments, conținut identic; a doua rulare NU duplică', async () => {
    const flowId = await seedFlowApproved();
    const df = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-CP-1' });
    await insertFormAtt({ formId: df, filename: 'declaratie_interese.pdf', data: 'INTERESE' });
    await insertFormAtt({ formId: df, filename: 'declaratie_avere.pdf',    data: 'AVERE', slot: 2 });

    const n = await copyFormularAttachmentsToFlow(pool, { flowId, formType: 'df', formId: df });
    expect(n).toBe(2);

    const atts = await getFlowAtts(flowId);
    expect(atts.map(a => a.filename)).toEqual(['declaratie_avere.pdf', 'declaratie_interese.pdf']);
    const byName = Object.fromEntries(atts.map(a => [a.filename, a]));
    expect(byName['declaratie_interese.pdf'].data.toString()).toBe('INTERESE');
    expect(byName['declaratie_interese.pdf'].mime_type).toBe('application/pdf');
    expect(byName['declaratie_avere.pdf'].data.toString()).toBe('AVERE');

    // idempotență: re-rulare → fără duplicate
    const n2 = await copyFormularAttachmentsToFlow(pool, { flowId, formType: 'df', formId: df });
    expect(n2).toBe(0);
    expect((await getFlowAtts(flowId)).length).toBe(2);
  });

  it('atașament soft-deleted NU se copiază', async () => {
    const flowId = await seedFlowApproved();
    const df = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-CP-2' });
    await insertFormAtt({ formId: df, filename: 'activ.pdf', data: 'ACTIV' });
    await insertFormAtt({ formId: df, filename: 'sters.pdf', data: 'STERS', deletedAt: new Date() });

    const n = await copyFormularAttachmentsToFlow(pool, { flowId, formType: 'df', formId: df });
    expect(n).toBe(1);
    const atts = await getFlowAtts(flowId);
    expect(atts.length).toBe(1);
    expect(atts[0].filename).toBe('activ.pdf');
  });

  it('ORD (form_type=ord) cu 1 atașament → copiat', async () => {
    const flowId = await seedFlowApproved();
    const ord = await seedOrd({ orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrOrd: 'ORD-CP-1' });
    await insertFormAtt({ formType: 'ord', formId: ord, filename: 'factura.pdf', data: 'FACT' });

    const n = await copyFormularAttachmentsToFlow(pool, { flowId, formType: 'ord', formId: ord });
    expect(n).toBe(1);
    expect((await getFlowAtts(flowId))[0].data.toString()).toBe('FACT');
  });

  it('dedup și față de un flow_attachment preexistent cu același nume', async () => {
    const flowId = await seedFlowApproved();
    const df = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-CP-3' });
    // upload manual prealabil în flux cu același nume
    await pool.query(
      `INSERT INTO flow_attachments (flow_id, filename, mime_type, size_bytes, data)
       VALUES ($1,'dup.pdf','application/pdf',3,$2)`,
      [flowId, Buffer.from('PRE')]
    );
    await insertFormAtt({ formId: df, filename: 'dup.pdf', data: 'FORM' });
    await insertFormAtt({ formId: df, filename: 'nou.pdf', data: 'NOU' });

    const n = await copyFormularAttachmentsToFlow(pool, { flowId, formType: 'df', formId: df });
    expect(n).toBe(1); // doar nou.pdf; dup.pdf există deja
    const atts = await getFlowAtts(flowId);
    expect(atts.map(a => a.filename)).toEqual(['dup.pdf', 'nou.pdf']);
    // dup.pdf rămâne cel preexistent (nu suprascris)
    expect(atts.find(a => a.filename === 'dup.pdf').data.toString()).toBe('PRE');
  });

  it('fără atașamente → zero copiate (comportament neschimbat)', async () => {
    const flowId = await seedFlowApproved();
    const df = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-CP-4' });
    const n = await copyFormularAttachmentsToFlow(pool, { flowId, formType: 'df', formId: df });
    expect(n).toBe(0);
    expect((await getFlowAtts(flowId)).length).toBe(0);
  });
});
