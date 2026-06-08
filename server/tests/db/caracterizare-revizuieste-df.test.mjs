// Caracterizare (Etapa 0 refactor) — POST /api/formulare-df/:id/revizuieste (+ alias /revizie).
// GOL anterior. Reviziile sunt DF-ONLY: ORD NU are această rută (cimentat cu test 404).
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedFlowApproved, getDf, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('POST /api/formulare-df/:id/revizuieste (caracterizare)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' }); // id 1, org 1 (creator)
    app = buildApp();
  });
  afterAll(() => pool.end());
  const p1 = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  // ── happy path: DF aprobat (flux finalizat) → R1 ────────────────────────────────
  it('DF aprobat cu flux → 200, creează R1 (revizie_nr=1), parent neatins', async () => {
    const flowId = await seedFlowApproved();
    const parentId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-REV-001' });
    const res = await request(app).post(`/api/formulare-df/${parentId}/revizuieste`).set('Cookie', p1()).send({ motiv: 'corectură' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.df.revizie_nr).toBe(1);
    expect(res.body.df.parent_df_id).toBe(parentId);
    expect(res.body.df.status).toBe('draft');
    // parent neatins
    const parent = await getDf(parentId);
    expect(parent.deleted_at).toBeNull();
    expect(parent.revizie_nr).toBe(0);
  });

  it('alias /revizie funcționează identic → 200, R1', async () => {
    const flowId = await seedFlowApproved();
    const parentId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-REV-ALIAS' });
    const res = await request(app).post(`/api/formulare-df/${parentId}/revizie`).set('Cookie', p1()).send({ motiv: 'x' });
    expect(res.status).toBe(200);
    expect(res.body.df.revizie_nr).toBe(1);
  });

  // ── DF neaprobat (refuz) poate fi revizuit fără flux ────────────────────────────
  it('DF neaprobat (fără flux) → 200, creează R1', async () => {
    const parentId = await seedDf({ orgId: 1, createdBy: 1, status: 'neaprobat', nrUnic: 'DF-REV-NEAP' });
    const res = await request(app).post(`/api/formulare-df/${parentId}/revizuieste`).set('Cookie', p1()).send({ motiv: 'refuz' });
    expect(res.status).toBe(200);
    expect(res.body.df.revizie_nr).toBe(1);
  });

  // ── regula „an următor" (mig. 057): flag propagat din checkbox ──────────────────
  it('DF aprobat cu ckbx_ang_leg_emise_ct_an_urm="1" → revizia are este_revizie_an_urmator=true', async () => {
    const flowId = await seedFlowApproved();
    const parentId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-REV-ANURM' });
    await pool.query(`UPDATE formulare_df SET ckbx_ang_leg_emise_ct_an_urm='1' WHERE id=$1`, [parentId]);
    const res = await request(app).post(`/api/formulare-df/${parentId}/revizuieste`).set('Cookie', p1()).send({ motiv: 'an urm' });
    expect(res.status).toBe(200);
    expect(res.body.df.este_revizie_an_urmator).toBe(true);
  });

  it('DF aprobat fără checkbox → revizia are este_revizie_an_urmator=false', async () => {
    const flowId = await seedFlowApproved();
    const parentId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-REV-NOURM' });
    const res = await request(app).post(`/api/formulare-df/${parentId}/revizuieste`).set('Cookie', p1()).send({ motiv: 'x' });
    expect(res.status).toBe(200);
    expect(res.body.df.este_revizie_an_urmator).toBe(false);
  });

  // ── restricții de status ─────────────────────────────────────────────────────────
  it('DF draft (nici aprobat, nici neaprobat) → 400 „doar aprobate sau neaprobate"', async () => {
    const parentId = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', nrUnic: 'DF-REV-DRAFT' });
    const res = await request(app).post(`/api/formulare-df/${parentId}/revizuieste`).set('Cookie', p1()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/aprobate sau neaprobate/i);
  });

  it('DF inexistent (UUID valid, dar fără rând) → 404 „DF negăsit"', async () => {
    const res = await request(app).post(`/api/formulare-df/00000000-0000-0000-0000-000000000000/revizuieste`).set('Cookie', p1()).send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('DF negăsit');
  });

  // FINDING (preexistent, NU se repară în Etapa 0): formulare_df.id e UUID, iar un id
  // malformat (ex. "999999") face SELECT-ul să arunce `invalid input syntax for type uuid`
  // → handler-ul întoarce 500 (server_error) în loc de 404. Edge-case ne-fatal pe UI
  // (frontend-ul trimite mereu UUID-uri reale). De curățat la consolidare (validare id / cast guard).
  it.todo('FINDING: revizuieste cu id malformat (non-UUID) → 500 în loc de 404 (de remediat la consolidare)');

  // ── guard istoric liniar: doar revizia curentă poate fi revizuită ────────────────
  it('DF R0 când există deja R1 (aceeași nr_unic) → 400 „revizia curentă"', async () => {
    const flowId = await seedFlowApproved();
    const parentId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-REV-LIN', revizieNr: 0 });
    await seedDf({ orgId: 1, createdBy: 1, status: 'draft', nrUnic: 'DF-REV-LIN', revizieNr: 1, parentDfId: parentId });
    const res = await request(app).post(`/api/formulare-df/${parentId}/revizuieste`).set('Cookie', p1()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/curent/i);
  });

  // ── ORD NU are rută de revizuire (revizii = DF-only) ─────────────────────────────
  // Notă: același describe (NU al doilea bloc) — pool e singleton; un al doilea
  // afterAll(pool.end) ar închide pool-ul partajat și ar sparge restul fișierului.
  it('ORD: POST /api/formulare-ord/:id/revizuieste → 404 (rută inexistentă)', async () => {
    const id = await seedOrd({ orgId: 1, createdBy: 1, status: 'aprobat' });
    const res = await request(app).post(`/api/formulare-ord/${id}/revizuieste`).set('Cookie', p1()).send({});
    expect(res.status).toBe(404);
  });

  it('ORD: POST /api/formulare-ord/:id/revizie → 404 (alias inexistent pe ORD)', async () => {
    const id = await seedOrd({ orgId: 1, createdBy: 1, status: 'aprobat' });
    const res = await request(app).post(`/api/formulare-ord/${id}/revizie`).set('Cookie', p1()).send({});
    expect(res.status).toBe(404);
  });
});
