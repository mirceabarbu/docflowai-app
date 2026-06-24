// Caracterizare (Etapa 0 refactor) — POST /api/formulare-{df|ord}/:id/complete.
// GOL anterior — prioritate maximă: aici stă validarea de buget (asimetrică DF↔ORD)
// și recalculul de capabilities.
//
// FINDING cheie cimentat aici:
//   - DF complete NU are NICIO validare de buget pe backend. „Soft-warning depășire
//     credite bugetare" (v3.9.541) este EXCLUSIV frontend → backend întoarce 200 chiar
//     dacă Secțiunea B ar depăși bugetul.
//   - ORD complete ARE o validare HARD: col.5 (recepții neplătite) < 0 → 422
//     `receptii_neplatite_negative`. NU este soft.
// Această diferență NU trebuie uniformizată la consolidare.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, seedOrd, getDf, getOrd, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('POST /api/formulare-*/:id/complete (caracterizare)', () => {
  let app;
  beforeAll(migrate);
  // userId 1 = P1 (creator), userId 2 = P2 (assigned).
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' });   // id 1, org 1
    await seedUser({ orgId: 1, email: 'p2@x.ro' });           // id 2, org 1
    app = buildApp();
  });
  afterAll(() => pool.end());
  const p1 = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });
  const p2 = () => makeAuthCookie({ userId: 2, role: 'user', orgId: 1 });

  // ── happy path ──────────────────────────────────────────────────────────────
  it('DF: P2 atribuit completează din pending_p2 → 200, completed, capabilities reîmprospătate', async () => {
    const id = await seedDf({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2 });
    const res = await request(app).post(`/api/formulare-df/${id}/complete`).set('Cookie', p2()).send({});
    expect(res.status).toBe(200);
    expect(res.body.document.status).toBe('completed');
    // P2 + completed → is_completed_p2 (capabilities recalculate cu ft='notafd').
    expect(res.body.document.capabilities).toBeTruthy();
    expect(res.body.document.capabilities.is_completed_p2).toBe(true);
    expect((await getDf(id)).status).toBe('completed');
  });

  it('ORD: P2 atribuit completează din pending_p2 (rows valide) → 200, completed', async () => {
    const id = await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2 });
    const rows = [{ receptii: '100', plati_anterioare: '0', suma_ordonantata_plata: '60' }]; // c5 = 40 ≥ 0
    const res = await request(app).post(`/api/formulare-ord/${id}/complete`).set('Cookie', p2()).send({ rows });
    expect(res.status).toBe(200);
    expect(res.body.document.status).toBe('completed');
    expect(res.body.document.capabilities).toBeTruthy();
    expect((await getOrd(id)).status).toBe('completed');
  });

  // ── ASIMETRIE buget: DF soft (frontend) vs ORD hard (backend 422) ───────────────
  // NU uniformiza la consolidare.
  it('DF: complete cu Sec.B care ar depăși bugetul → tot 200 (soft-warning e DOAR frontend)', async () => {
    const id = await seedDf({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2 });
    // sum_fara_inreg_ctrl_crdbug + rows_ctrl cu valori mari — backend NU le validează.
    const body = {
      sum_fara_inreg_ctrl_crdbug: '999999999',
      rows_ctrl: [{ sum_rezv_crdt_bug_act: '999999999', sum_rezv_crdt_ang_act: '999999999' }],
    };
    const res = await request(app).post(`/api/formulare-df/${id}/complete`).set('Cookie', p2()).send(body);
    expect(res.status).toBe(200);
    expect(res.body.document.status).toBe('completed');
    // Nicio cheie de eroare/avertisment de buget în răspuns (soft-warning e calculat în client).
    expect(res.body.error).toBeUndefined();
    expect((await getDf(id)).status).toBe('completed');
  });

  // ── SecB DF: a doua sumă CFP „credite bugetare" persistă (v3.9.585, fix câmp-fantomă) ──
  // ROȘU înainte de migrarea 087 + whitelist (coloana lipsea, pick() o arunca → se pierdea).
  it('DF: complete persistă AMBELE sume CFP (crdbug pereche 1 + crd_bug credite bugetare)', async () => {
    const id = await seedDf({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2 });
    const body = {
      sum_fara_inreg_ctrl_crdbug: '50000',
      sum_fara_inreg_ctrl_crd_bug: '100000',
    };
    const res = await request(app).post(`/api/formulare-df/${id}/complete`).set('Cookie', p2()).send(body);
    expect(res.status).toBe(200);
    // round-trip din DB (GET / reload) — ambele sume se păstrează.
    const doc = await getDf(id);
    expect(doc.sum_fara_inreg_ctrl_crdbug).toBe('50000');
    expect(doc.sum_fara_inreg_ctrl_crd_bug).toBe('100000');
  });

  it('ORD: complete cu col.5 (recepții neplătite) negativă → 422 receptii_neplatite_negative, rămâne pending_p2', async () => {
    const id = await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2 });
    const rows = [{ receptii: '100', plati_anterioare: '0', suma_ordonantata_plata: '200' }]; // c5 = -100
    const res = await request(app).post(`/api/formulare-ord/${id}/complete`).set('Cookie', p2()).send({ rows });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('receptii_neplatite_negative');
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect((await getOrd(id)).status).toBe('pending_p2'); // neschimbat
  });

  // ── autorizare: doar P2-side completează ────────────────────────────────────────
  it('DF: P1 (creator, neasignat) încearcă complete → 403 forbidden', async () => {
    const id = await seedDf({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2 });
    const res = await request(app).post(`/api/formulare-df/${id}/complete`).set('Cookie', p1()).send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
    expect((await getDf(id)).status).toBe('pending_p2');
  });

  it('ORD: P1 (creator, neasignat) încearcă complete → 403 forbidden', async () => {
    const id = await seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2 });
    const res = await request(app).post(`/api/formulare-ord/${id}/complete`).set('Cookie', p1()).send({ rows: [] });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });

  // ── status invalid ──────────────────────────────────────────────────────────────
  it('DF: complete pe status non-pending_p2 (draft) → 409 status_invalid + status', async () => {
    const id = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', assignedTo: 2 });
    const res = await request(app).post(`/api/formulare-df/${id}/complete`).set('Cookie', p2()).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('status_invalid');
    expect(res.body.status).toBe('draft');
  });

  it('ORD: complete pe status non-pending_p2 (completed) → 409 status_invalid + status', async () => {
    const id = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', assignedTo: 2 });
    const res = await request(app).post(`/api/formulare-ord/${id}/complete`).set('Cookie', p2()).send({ rows: [] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('status_invalid');
    expect(res.body.status).toBe('completed');
  });
});
