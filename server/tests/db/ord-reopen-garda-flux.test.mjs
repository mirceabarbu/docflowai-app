/**
 * #129 — garda de flux pe redeschiderea ORD (PUT /api/formulare-ord/:id, ramura completed→draft).
 *
 * ASIMETRIE DF/ORD: DF-ul persistă `transmis_flux` la legarea de flux (deci cade pe
 * `document_locked`), ORD-ul NU — rămâne `completed` chiar cu un flux de semnare VIU.
 * Odată cu butonul „Redeschide document" (#129), ramura de reset devine accesibilă din UI,
 * deci garda e obligatorie în ACELAȘI lot.
 *
 * Acoperă:
 *  (1) ORD completed + flux VIU (in_progress)      → 409 document_pe_flux, status NEschimbat;
 *  (2) ORD completed + flux SEMNAT (completed)     → 409 document_pe_flux;
 *  (3) ORD completed + flux CANCELLED / REFUSED / soft-șters → 200, reset la draft (NU blochează);
 *  (4) ORD completed FĂRĂ flow_id                  → 200, reset la draft;
 *  (5) POZIȚIA gărzii: actor neîndreptățit (alt org / fără drept) primește 403, NU 409
 *      — autorizarea rulează ÎNAINTEA gărzii, ca 409-ul să nu scurgă starea documentului.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool, seedOrgUser, seedOrd, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

async function seedFlow(id, data, deletedAt = null) {
  await pool.query(
    `INSERT INTO flows (id, data, org_id, deleted_at) VALUES ($1, $2::jsonb, $3, $4)`,
    [id, JSON.stringify({ orgId: 1, docName: 'Doc', ...data }), 1, deletedAt]
  );
  return id;
}

const getOrd = async (id) => (await pool.query('SELECT * FROM formulare_ord WHERE id=$1', [id])).rows[0];

d('#129 — PUT ORD completed→draft: garda de flux', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await seedOrgUser({ role: 'user' }); app = buildApp(); });
  afterAll(() => pool.end());

  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });
  const reopen = (id, ck = cookie()) =>
    request(app).put(`/api/formulare-ord/${id}`).set('Cookie', ck).send({});

  it('(1) flux VIU (in_progress) → 409 document_pe_flux, status neschimbat', async () => {
    const flowId = await seedFlow('flx-live', { status: 'in_progress', completed: false });
    const id = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId });
    const res = await reopen(id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('document_pe_flux');
    expect(res.body.message).toBeTruthy();
    expect((await getOrd(id)).status).toBe('completed');
  });

  it('(2) flux SEMNAT (completed) → 409 document_pe_flux', async () => {
    const flowId = await seedFlow('flx-done', { status: 'completed', completed: true });
    const id = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId });
    const res = await reopen(id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('document_pe_flux');
    expect((await getOrd(id)).status).toBe('completed');
  });

  it('(3a) flux CANCELLED → 200, reset la draft (NU blochează)', async () => {
    const flowId = await seedFlow('flx-canc', { status: 'cancelled', completed: false });
    const id = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId });
    const res = await reopen(id);
    expect(res.status).toBe(200);
    expect((await getOrd(id)).status).toBe('draft');
  });

  it('(3b) flux REFUSED → 200, reset la draft', async () => {
    const flowId = await seedFlow('flx-ref', { status: 'refused', completed: false });
    const id = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId });
    expect((await reopen(id)).status).toBe(200);
    expect((await getOrd(id)).status).toBe('draft');
  });

  it('(3c) flux soft-șters → 200, reset la draft', async () => {
    const flowId = await seedFlow('flx-del', { status: 'in_progress', completed: false }, new Date());
    const id = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId });
    expect((await reopen(id)).status).toBe(200);
    expect((await getOrd(id)).status).toBe('draft');
  });

  it('(4) fără flow_id → 200, reset la draft + version++ + completed_at NULL', async () => {
    const id = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed' });
    await pool.query(`UPDATE formulare_ord SET completed_at=NOW(), submitted_at=NOW() WHERE id=$1`, [id]);
    const before = await getOrd(id);
    const res = await reopen(id);
    expect(res.status).toBe(200);
    const after = await getOrd(id);
    expect(after.status).toBe('draft');
    expect(after.version).toBe(before.version + 1);
    expect(after.completed_at).toBeNull();
    expect(after.submitted_at).toBeNull();
    // corpul GOL (#129 C.3.a) nu scrie un spațiu peste `cif`
    expect(after.cif).toBe(before.cif);
  });

  it('(5) POZIȚIA gărzii: actor neîndreptățit primește 403, NU 409 (authz înaintea gărzii)', async () => {
    const flowId = await seedFlow('flx-live2', { status: 'in_progress', completed: false });
    const id = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId });
    // alt utilizator din aceeași organizație, fără compartiment / fără drept pe document
    await pool.query(
      `INSERT INTO users (email, password_hash, nume, role, compartiment, org_id)
       VALUES ('strain@x.ro','x','Strain','user','Altul',1)`
    );
    const res = await reopen(id, makeAuthCookie({ userId: 2, role: 'user', orgId: 1 }));
    expect(res.status).toBe(403);
    expect(res.body.error).not.toBe('document_pe_flux');
  });
});
