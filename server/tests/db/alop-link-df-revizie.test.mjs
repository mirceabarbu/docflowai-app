/**
 * #185 — link-df recunoaște REVIZIILE ACELUIAȘI DOSAR.
 *
 * Simptom reparat: la fiecare salvare a unei revizii (R1) a unui DF legat la un dosar
 * ALOP, frontendul cheamă `POST /api/alop/:id/link-df` cu id-ul lui R1. Garda finală a
 * UPDATE-ului cere `df_id IS NULL OR df_id = $1`, iar pointerul stă pe R0 (#134f: se
 * mută EXCLUSIV la aprobare, prin selfHealAlopDfLink) ⇒ zero rânduri ⇒ 404 `not_found`
 * ⇒ bandă roșie „legarea la dosarul ALOP a eșuat", cu sfatul (periculos) de a relega
 * manual — adică fix mutarea pointerului pe o revizie nevalidată.
 *
 * 🔒 INVARIANTUL care contează cel mai mult: ramura nouă răspunde 200 și NU ATINGE NIMIC.
 *    Un 200 care ar muta pointerul ar fi mai rău decât eroarea pe care o reparăm.
 *
 * Cheia de comparație e DOSARUL (`dosarKeyExpr` = COALESCE(source_alop_id::text,
 * nr_unic_inreg)), NU numărul de înregistrare — în producție există numere duplicate
 * între dosare diferite (docs/incidents/DF-NR-DUPLICAT.md).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedAlop, seedFlowApproved,
         getAlop, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('#185 — link-df pe o revizie a aceluiași dosar', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' }); // user 1, org 1
    app = buildApp();
  });
  afterAll(() => pool.end());
  const p1 = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  // Dosar complet: ALOP + R0 aprobat (pointerul dosarului) + R1 în lucru.
  async function seedDosarCuRevizie({ status = 'angajare' } = {}) {
    const flowId = await seedFlowApproved();
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status, titlu: 'Dosar A' });
    const r0 = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId,
      nrUnic: 'DF-185-1', revizieNr: 0, sourceAlopId: alopId });
    const r1 = await seedDf({ orgId: 1, createdBy: 1, status: 'draft',
      nrUnic: 'DF-185-1', revizieNr: 1, parentDfId: r0, sourceAlopId: alopId });
    const completedAt = new Date('2026-05-04T10:00:00Z');
    await pool.query(
      `UPDATE alop_instances SET df_id=$2, df_flow_id=$3, df_completed_at=$4 WHERE id=$1`,
      [alopId, r0, flowId, completedAt]
    );
    return { alopId, r0, r1, flowId, completedAt };
  }

  // ── 1 ⭐ Cazul raportat ────────────────────────────────────────────────────
  it('ALOP pe R0, link-df cu R1 (același source_alop_id) → 200 ok:true noop:revizie_in_lucru', async () => {
    const { alopId, r1 } = await seedDosarCuRevizie();

    const res = await request(app).post(`/api/alop/${alopId}/link-df`)
      .set('Cookie', p1()).send({ df_id: r1 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.noop).toBe('revizie_in_lucru');
  });

  // ── 2 ⭐ Invariantul #134f — pointerul NU se mută ──────────────────────────
  it('🔒 după 200-ul de mai sus, df_id/df_flow_id/df_completed_at din DB sunt NESCHIMBATE (#134f)', async () => {
    const { alopId, r0, r1, flowId, completedAt } = await seedDosarCuRevizie();
    const inainte = await getAlop(alopId);

    const res = await request(app).post(`/api/alop/${alopId}/link-df`)
      .set('Cookie', p1()).send({ df_id: r1 });
    expect(res.status).toBe(200);

    const dupa = await getAlop(alopId);
    expect(dupa.df_id).toBe(r0);                       // NU s-a mutat pe R1
    expect(dupa.df_flow_id).toBe(flowId);
    expect(String(dupa.df_completed_at)).toBe(String(completedAt));
    expect(dupa.status).toBe(inainte.status);
    expect(String(dupa.updated_at)).toBe(String(inainte.updated_at)); // zero UPDATE
    // Răspunsul întoarce starea REALĂ din DB, nu una mutată.
    expect(res.body.alop.df_id).toBe(r0);
  });

  // ── 3 ⭐ Garda anti-deturnare (#120/#164) ──────────────────────────────────
  it('ALOP pointează spre un DF din ALT dosar → 404 not_found, pointer neschimbat', async () => {
    const alopA = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', titlu: 'Dosar A' });
    const alopB = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft', titlu: 'Dosar B' });
    const dfB = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat',
      nrUnic: 'DF-185-B', sourceAlopId: alopB });
    const dfA = await seedDf({ orgId: 1, createdBy: 1, status: 'draft',
      nrUnic: 'DF-185-A', sourceAlopId: alopA });
    // Pointer „deturnat": ALOP-ul A arată spre DF-ul dosarului B.
    await pool.query(`UPDATE alop_instances SET df_id=$2 WHERE id=$1`, [alopA, dfB]);

    const res = await request(app).post(`/api/alop/${alopA}/link-df`)
      .set('Cookie', p1()).send({ df_id: dfA });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
    expect((await getAlop(alopA)).df_id).toBe(dfB);
  });

  // ── 4 ⭐ Numerele duplicate NU păcălesc cheia ──────────────────────────────
  it('două DF din dosare DIFERITE cu ACELAȘI nr_unic_inreg → 404 (cheia e dosarul, nu numărul)', async () => {
    const alopP = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', titlu: 'Dosar P' });
    const alopQ = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft', titlu: 'Dosar Q' });
    const dfP = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat',
      nrUnic: '4711', sourceAlopId: alopP });
    const dfQ = await seedDf({ orgId: 1, createdBy: 1, status: 'draft',
      nrUnic: '4711', sourceAlopId: alopQ });   // ACELAȘI număr, ALT dosar
    await pool.query(`UPDATE alop_instances SET df_id=$2 WHERE id=$1`, [alopP, dfP]);

    const res = await request(app).post(`/api/alop/${alopP}/link-df`)
      .set('Cookie', p1()).send({ df_id: dfQ });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
    expect((await getAlop(alopP)).df_id).toBe(dfP);
  });

  // ── 5 Legacy (source_alop_id NULL) — fallback pe număr, apoi fail-closed ───
  it('legacy: source_alop_id NULL pe ambele + nr_unic_inreg egal → 200 (fallback documentat)', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare' });
    const vechi = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-LEG-1' });
    const nou = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', nrUnic: 'DF-LEG-1', revizieNr: 1 });
    await pool.query(`UPDATE alop_instances SET df_id=$2 WHERE id=$1`, [alopId, vechi]);

    const res = await request(app).post(`/api/alop/${alopId}/link-df`)
      .set('Cookie', p1()).send({ df_id: nou });

    expect(res.status).toBe(200);
    expect(res.body.noop).toBe('revizie_in_lucru');
    expect((await getAlop(alopId)).df_id).toBe(vechi);   // tot fără mutare
  });

  it('legacy fail-closed: source_alop_id NULL ȘI nr_unic_inreg NULL pe ambele → 404 (NULL = NULL e NULL)', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare' });
    const vechi = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: null });
    const nou = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', nrUnic: null });
    await pool.query(`UPDATE alop_instances SET df_id=$2 WHERE id=$1`, [alopId, vechi]);

    const res = await request(app).post(`/api/alop/${alopId}/link-df`)
      .set('Cookie', p1()).send({ df_id: nou });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
    expect((await getAlop(alopId)).df_id).toBe(vechi);
  });

  // ── 6 Nedeteriorare: calea normală (df_id NULL) ────────────────────────────
  it('nedeteriorare: ALOP fără DF → 200, pointer setat, status draft → angajare', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft' });
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', nrUnic: 'DF-185-N' });

    const res = await request(app).post(`/api/alop/${alopId}/link-df`)
      .set('Cookie', p1()).send({ df_id: dfId });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.noop).toBeUndefined();
    const a = await getAlop(alopId);
    expect(a.df_id).toBe(dfId);
    expect(a.status).toBe('angajare');
  });

  // ── 7 Nedeteriorare: idempotență pe ACELAȘI df_id (calea veche, prin UPDATE) ─
  it('nedeteriorare: link-df cu ACELAȘI df_id deja legat → 200 pe calea veche (fără noop)', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-185-I' });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', dfId });

    const res = await request(app).post(`/api/alop/${alopId}/link-df`)
      .set('Cookie', p1()).send({ df_id: dfId });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.noop).toBeUndefined();   // a trecut prin UPDATE, nu prin ramura nouă
    expect((await getAlop(alopId)).df_id).toBe(dfId);
  });

  // ── 8 Nedeteriorare: ALOP inexistent (ramura de dinaintea UPDATE-ului) ─────
  it('nedeteriorare: ALOP inexistent → 404 not_found', async () => {
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-185-X' });
    const fantoma = '00000000-0000-0000-0000-0000000000ff';

    const res = await request(app).post(`/api/alop/${fantoma}/link-df`)
      .set('Cookie', p1()).send({ df_id: dfId });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

  // ── 9 Configurația de pe staging: ALOP completat ───────────────────────────
  it('ALOP completed (ORD aprobat, lichidat, plătit) + link-df cu R1 → 200, pointer neschimbat', async () => {
    const { alopId, r0, r1 } = await seedDosarCuRevizie({ status: 'completed' });

    const res = await request(app).post(`/api/alop/${alopId}/link-df`)
      .set('Cookie', p1()).send({ df_id: r1 });

    expect(res.status).toBe(200);
    expect(res.body.noop).toBe('revizie_in_lucru');
    const a = await getAlop(alopId);
    expect(a.df_id).toBe(r0);
    expect(a.status).toBe('completed');
  });
});
