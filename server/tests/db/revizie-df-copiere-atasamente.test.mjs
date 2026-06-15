/**
 * FIX v3.9.555 — revizia DF copiază atașamentele și capturile părintelui.
 *
 * Înainte: INSERT...SELECT pe formulare_df nu copia rândurile satelit din
 * formulare_atasamente / formulare_capturi (legate prin form_type+form_id) —
 * revizia (id nou) pornea fără anexe, care rămâneau pe R0 (istoric, blocat la editare).
 *
 * Acoperă: copiere în tranzacție (atașamente + capturi), independență R0↔R1 după
 * ștergere, caracterizare „fără atașamente → zero rânduri copiate", și filtrarea
 * atașamentelor soft-deleted (NU se copiază).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedFlowApproved, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

async function insertAtasament({ formId, uploadedBy = 1, filename = 'doc.pdf', mimeType = 'application/pdf', data = 'ATT-DATA', slot = 1, deletedAt = null }) {
  const { rows } = await pool.query(
    `INSERT INTO formulare_atasamente (form_type, form_id, uploaded_by, filename, mime_type, size_bytes, data, slot, deleted_at)
     VALUES ('df',$1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [formId, uploadedBy, filename, mimeType, Buffer.byteLength(data), Buffer.from(data), slot, deletedAt]
  );
  return rows[0].id;
}

async function insertCaptura({ formId, uploadedBy = 1, filename = 'captura.png', mimetype = 'image/png', data = 'PNG-DATA', slot = 1 }) {
  const { rows } = await pool.query(
    `INSERT INTO formulare_capturi (form_type, form_id, uploaded_by, filename, mimetype, size_bytes, data, slot)
     VALUES ('df',$1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [formId, uploadedBy, filename, mimetype, Buffer.byteLength(data), Buffer.from(data), slot]
  );
  return rows[0].id;
}

async function getAtasamente(formId) {
  const { rows } = await pool.query(
    `SELECT id, uploaded_by, filename, mime_type, size_bytes, data, slot, deleted_at
     FROM formulare_atasamente WHERE form_id=$1 ORDER BY created_at ASC`,
    [formId]
  );
  return rows;
}

async function getCapturi(formId) {
  const { rows } = await pool.query(
    `SELECT id, uploaded_by, filename, mimetype, size_bytes, data, slot
     FROM formulare_capturi WHERE form_id=$1 ORDER BY created_at ASC`,
    [formId]
  );
  return rows;
}

d('POST /api/formulare-df/:id/revizuieste — copiere atașamente + capturi (v3.9.555)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' }); // user 1, org 1 (creator)
    app = buildApp();
  });
  afterAll(() => pool.end());
  const p1 = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  it('R0 cu 2 atașamente (slot 1) + 1 captură → R1 are propriile copii, conținut identic, R0 neatins', async () => {
    const flowId = await seedFlowApproved();
    const r0 = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-ATT-COPY-1' });
    await insertAtasament({ formId: r0, data: 'CONTENT-1', filename: 'a1.pdf' });
    await insertAtasament({ formId: r0, data: 'CONTENT-2', filename: 'a2.pdf' });
    await insertCaptura({ formId: r0, data: 'CAPTURA-1' });

    const res = await request(app).post(`/api/formulare-df/${r0}/revizuieste`).set('Cookie', p1()).send({ motiv: 'cu anexe' });
    expect(res.status).toBe(200);
    const r1 = res.body.df.id;

    // R1 are propriile rânduri (form_id = r1), conținut identic
    const attsR1 = await getAtasamente(r1);
    expect(attsR1.length).toBe(2);
    const contents = attsR1.map(a => a.data.toString()).sort();
    expect(contents).toEqual(['CONTENT-1', 'CONTENT-2']);
    for (const a of attsR1) {
      expect(a.uploaded_by).toBe(1);
      expect(a.slot).toBe(1);
      expect(a.deleted_at).toBeNull();
    }

    const capsR1 = await getCapturi(r1);
    expect(capsR1.length).toBe(1);
    expect(capsR1[0].data.toString()).toBe('CAPTURA-1');

    // R0 își păstrează rândurile originale (id-uri diferite — sunt rânduri noi pe R1)
    const attsR0 = await getAtasamente(r0);
    expect(attsR0.length).toBe(2);
    const idsR0 = attsR0.map(a => a.id).sort();
    const idsR1 = attsR1.map(a => a.id).sort();
    expect(idsR0).not.toEqual(idsR1);

    const capsR0 = await getCapturi(r0);
    expect(capsR0.length).toBe(1);
  });

  it('ștergerea unui atașament de pe R1 NU afectează atașamentele R0', async () => {
    const flowId = await seedFlowApproved();
    const r0 = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-ATT-COPY-2' });
    await insertAtasament({ formId: r0, data: 'CONTENT-A' });
    await insertAtasament({ formId: r0, data: 'CONTENT-B' });

    const res = await request(app).post(`/api/formulare-df/${r0}/revizuieste`).set('Cookie', p1()).send({ motiv: 'x' });
    expect(res.status).toBe(200);
    const r1 = res.body.df.id;

    const attsR1 = await getAtasamente(r1);
    expect(attsR1.length).toBe(2);

    const del = await request(app)
      .delete(`/api/formulare-atasamente/df/${r1}/${attsR1[0].id}`)
      .set('Cookie', p1());
    expect(del.status).toBe(200);

    // R1 are 1 rând activ; R0 își păstrează ambele rânduri intacte
    const { rows: activeR1 } = await pool.query(
      `SELECT id FROM formulare_atasamente WHERE form_id=$1 AND deleted_at IS NULL`, [r1]
    );
    expect(activeR1.length).toBe(1);

    const attsR0 = await getAtasamente(r0);
    expect(attsR0.length).toBe(2);
    expect(attsR0.every(a => a.deleted_at === null)).toBe(true);
  });

  it('caracterizare: revizie pe DF fără atașamente/capturi → zero rânduri copiate', async () => {
    const flowId = await seedFlowApproved();
    const r0 = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-ATT-COPY-3' });

    const res = await request(app).post(`/api/formulare-df/${r0}/revizuieste`).set('Cookie', p1()).send({ motiv: 'fara anexe' });
    expect(res.status).toBe(200);
    const r1 = res.body.df.id;

    expect((await getAtasamente(r1)).length).toBe(0);
    expect((await getCapturi(r1)).length).toBe(0);
  });

  it('atașament soft-deleted pe R0 NU se copiază pe R1', async () => {
    const flowId = await seedFlowApproved();
    const r0 = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-ATT-COPY-4' });
    await insertAtasament({ formId: r0, data: 'ACTIV', filename: 'activ.pdf' });
    await insertAtasament({ formId: r0, data: 'STERS', filename: 'sters.pdf', deletedAt: new Date() });

    const res = await request(app).post(`/api/formulare-df/${r0}/revizuieste`).set('Cookie', p1()).send({ motiv: 'x' });
    expect(res.status).toBe(200);
    const r1 = res.body.df.id;

    const attsR1 = await getAtasamente(r1);
    expect(attsR1.length).toBe(1);
    expect(attsR1[0].data.toString()).toBe('ACTIV');
  });
});
