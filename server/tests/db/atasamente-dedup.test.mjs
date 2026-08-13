/**
 * DB caracterizare — #124i: dedup atașamente la upload + DISTINCT ON la copierea spre flux.
 *
 * Defectul 1: POST /api/formulare-atasamente/:type/:id insera necondiționat — 25 de copii ale
 * aceluiași PDF pe același document/slot au fost găsite în producție (12.08.2026, #124b).
 * Defectul 2: copyFormularAttachmentsToFlow avea un guard NOT EXISTS care se evaluează față de
 * starea tabelei la ÎNCEPUTUL instrucțiunii, nu față de rândurile inserate de aceeași instrucțiune
 * → N rânduri sursă cu același filename produceau N rânduri în flow_attachments dintr-o execuție.
 *
 * ⚠️ Capcană: ruta de upload citește corpul brut din stream (req.on('data')), NU express.json().
 * Trimite un Buffer cu Content-Type non-JSON (application/pdf) + numele în header x-filename.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedFlow, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';
import { copyFormularAttachmentsToFlow } from '../../services/formular-flow-attachments.mjs';

const d = describe.skipIf(!hasTestDb());

async function insertFormAtt({ formType = 'df', formId, filename, mime = 'application/pdf', data = 'X', slot = 1, deletedAt = null }) {
  await pool.query(
    `INSERT INTO formulare_atasamente (form_type, form_id, uploaded_by, filename, mime_type, size_bytes, data, slot, deleted_at)
     VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8)`,
    [formType, formId, filename, mime, Buffer.byteLength(data), Buffer.from(data), slot, deletedAt]
  );
}

async function countAtt(formId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM formulare_atasamente WHERE form_id=$1 AND deleted_at IS NULL`, [formId]
  );
  return rows[0].n;
}

async function flowAtts(flowId) {
  const { rows } = await pool.query(
    `SELECT filename, size_bytes FROM flow_attachments WHERE flow_id=$1 ORDER BY filename ASC, size_bytes ASC`, [flowId]
  );
  return rows;
}

d('POST /api/formulare-atasamente/:type/:id — dedup la upload (#124i)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await pool.query('TRUNCATE flow_attachments, formulare_atasamente RESTART IDENTITY');
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' }); // user 1, org 1
    app = buildApp();
  });
  // pool e PARTAJAT (import din db/index.mjs) → o singură închidere per FIȘIER, în afterAll-ul
  // ULTIMULUI describe (mai jos). Aici NU închidem.
  const p1 = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  function upload(df, buf, { filename = 'test.pdf', slot } = {}) {
    let r = request(app)
      .post(`/api/formulare-atasamente/df/${df}`)
      .set('Cookie', p1())
      .set('Content-Type', 'application/pdf')
      .set('x-filename', encodeURIComponent(filename));
    if (slot) r = r.query({ slot });
    return r.send(buf);
  }

  it('1. același fișier (nume+dimensiune) de două ori pe același slot → al doilea răspuns e dedup, count=1', async () => {
    const df = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', nrUnic: 'DF-DD-1' });
    const buf = Buffer.from('CONTENT-A');

    const r1 = await upload(df, buf, { filename: 'ref.pdf' });
    expect(r1.status).toBe(200);
    expect(r1.body.deduplicated).toBeFalsy();
    const firstId = r1.body.atasament.id;

    const r2 = await upload(df, buf, { filename: 'ref.pdf' });
    expect(r2.status).toBe(200);
    expect(r2.body.deduplicated).toBe(true);
    expect(r2.body.atasament.id).toBe(firstId);

    expect(await countAtt(df)).toBe(1);
  });

  it('2. același nume, slot diferit → două atașamente', async () => {
    const df = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', nrUnic: 'DF-DD-2' });
    const buf = Buffer.from('CONTENT-B');

    const r1 = await upload(df, buf, { filename: 'ref.pdf', slot: 1 });
    expect(r1.status).toBe(200);
    const r2 = await upload(df, buf, { filename: 'ref.pdf', slot: 2 });
    expect(r2.status).toBe(200);
    expect(r2.body.deduplicated).toBeFalsy();

    expect(await countAtt(df)).toBe(2);
  });

  it('3. același nume, dimensiune diferită (fișier corectat) → două atașamente', async () => {
    const df = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', nrUnic: 'DF-DD-3' });

    const r1 = await upload(df, Buffer.from('SHORT'), { filename: 'ref.pdf' });
    expect(r1.status).toBe(200);
    const r2 = await upload(df, Buffer.from('MUCH-LONGER-CONTENT'), { filename: 'ref.pdf' });
    expect(r2.status).toBe(200);
    expect(r2.body.deduplicated).toBeFalsy();

    expect(await countAtt(df)).toBe(2);
  });

  it('4. primul atașament soft-șters, apoi reîncărcare → se creează unul nou (nu dedup)', async () => {
    const df = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', nrUnic: 'DF-DD-4' });
    const buf = Buffer.from('CONTENT-D');

    const r1 = await upload(df, buf, { filename: 'ref.pdf' });
    expect(r1.status).toBe(200);
    await pool.query(`UPDATE formulare_atasamente SET deleted_at=NOW() WHERE id=$1`, [r1.body.atasament.id]);

    const r2 = await upload(df, buf, { filename: 'ref.pdf' });
    expect(r2.status).toBe(200);
    expect(r2.body.deduplicated).toBeFalsy();
    expect(r2.body.atasament.id).not.toBe(r1.body.atasament.id);

    expect(await countAtt(df)).toBe(1); // doar cel nesters
  });

  it('5. alt form_id → atașament nou (nu dedup peste documente)', async () => {
    const df1 = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', nrUnic: 'DF-DD-5A' });
    const df2 = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', nrUnic: 'DF-DD-5B' });
    const buf = Buffer.from('CONTENT-E');

    const r1 = await upload(df1, buf, { filename: 'ref.pdf' });
    expect(r1.status).toBe(200);
    const r2 = await upload(df2, buf, { filename: 'ref.pdf' });
    expect(r2.status).toBe(200);
    expect(r2.body.deduplicated).toBeFalsy();

    expect(await countAtt(df1)).toBe(1);
    expect(await countAtt(df2)).toBe(1);
  });
});

d('copyFormularAttachmentsToFlow — idempotență reală față de duplicate în sursă (#124i)', () => {
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await pool.query('TRUNCATE flow_attachments, formulare_atasamente RESTART IDENTITY');
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' });
  });
  afterAll(() => pool.end());

  it('6. 3 rânduri sursă identice (filename+size_bytes) → EXACT 1 rând în flow_attachments', async () => {
    const df = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', nrUnic: 'DF-DD-6' });
    const flowId = await seedFlow({ completed: false });
    await insertFormAtt({ formId: df, filename: 'dup.pdf', data: 'SAME' });
    await insertFormAtt({ formId: df, filename: 'dup.pdf', data: 'SAME' });
    await insertFormAtt({ formId: df, filename: 'dup.pdf', data: 'SAME' });

    const copied = await copyFormularAttachmentsToFlow(pool, { flowId, formType: 'df', formId: df });
    expect(copied).toBe(1);
    const rows = await flowAtts(flowId);
    expect(rows.length).toBe(1);
    expect(rows[0].filename).toBe('dup.pdf');
  });

  it('7. două fișiere diferite cu același filename (dimensiuni diferite) → EXACT 2 rânduri, ambele păstrate', async () => {
    const df = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', nrUnic: 'DF-DD-7' });
    const flowId = await seedFlow({ completed: false });
    await insertFormAtt({ formId: df, filename: 'anexa.pdf', data: 'SHORT', slot: 1 });
    await insertFormAtt({ formId: df, filename: 'anexa.pdf', data: 'MUCH-LONGER-CONTENT', slot: 2 });

    const copied = await copyFormularAttachmentsToFlow(pool, { flowId, formType: 'df', formId: df });
    expect(copied).toBe(2);
    const rows = await flowAtts(flowId);
    expect(rows.length).toBe(2);
    expect(rows.every(r => r.filename === 'anexa.pdf')).toBe(true);
    expect(new Set(rows.map(r => r.size_bytes)).size).toBe(2); // dimensiuni distincte, ambele păstrate
  });

  it('8. rulare de două ori → numărul de rânduri rămâne neschimbat (idempotență existentă)', async () => {
    const df = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', nrUnic: 'DF-DD-8' });
    const flowId = await seedFlow({ completed: false });
    await insertFormAtt({ formId: df, filename: 'dup.pdf', data: 'SAME' });
    await insertFormAtt({ formId: df, filename: 'dup.pdf', data: 'SAME' });

    const first = await copyFormularAttachmentsToFlow(pool, { flowId, formType: 'df', formId: df });
    expect(first).toBe(1);
    const second = await copyFormularAttachmentsToFlow(pool, { flowId, formType: 'df', formId: df });
    expect(second).toBe(0);

    const rows = await flowAtts(flowId);
    expect(rows.length).toBe(1);
  });
});
