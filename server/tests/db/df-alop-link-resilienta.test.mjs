/**
 * Reziliența legăturii DF↔ALOP pe calea de semnare CLOUD (v3.9.746).
 *
 * Incident 04.08.2026: `formulare_df.status='aprobat'` se scria DOAR pe calea
 * `upload-signed-pdf`. Instituțiile care semnează prin STS Cloud lăsau DF-ul cu
 * `status='completed'` pe un flux FINALIZAT ⇒ orice comparație `status === 'aprobat'`
 * decidea greșit, iar self-heal-ul DF→ALOP nu rula niciodată. Efect: ștergerea unei
 * revizii R1 draft golea `alop.df_id` (ramura `else` din relinkAlopOnDfDelete), iar
 * `/revizuieste` nu mai potrivea niciun rând (UPDATE ... WHERE df_id=$2) — în tăcere.
 *
 * Testele lovesc rutele REALE peste Postgres real; `finalizeDfOnFlowCompleted` e
 * importat din producție (NU reimplementat).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedAlop, seedFlowApproved, seedFlow,
         getAlop, getDf, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';
import { finalizeDfOnFlowCompleted, selfHealAlopDfLinkByAlop } from '../../services/alop-link.mjs';

const d = describe.skipIf(!hasTestDb());

// Flux MORT (refuzat) — nu face părintele „aprobat" (regresie #115).
async function seedFlowRefused(id = `flow-ref-${Math.random().toString(36).slice(2, 8)}`) {
  await pool.query(
    `INSERT INTO flows (id, data) VALUES ($1, $2::jsonb)`,
    [id, JSON.stringify({ status: 'refused', signers: [] })]
  );
  return id;
}

// Flux ANULAT — self-heal-ul lazy nu-l consideră finalizat.
async function seedFlowCancelled(id = `flow-cxl-${Math.random().toString(36).slice(2, 8)}`) {
  await pool.query(
    `INSERT INTO flows (id, data) VALUES ($1, $2::jsonb)`,
    [id, JSON.stringify({ status: 'cancelled', signers: [] })]
  );
  return id;
}

d('DF↔ALOP — reziliența legăturii pe calea de semnare cloud', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' });
    app = buildApp();
  });
  const p1 = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  // ── 1. Reproducerea incidentului 04.08.2026 ────────────────────────────────
  it('ștergerea R1 draft cu părinte R0 semnat CLOUD (status=completed, flux finalizat) → ALOP păstrează df_id=R0', async () => {
    const flowId = await seedFlowApproved();
    // R0 exact ca după semnarea cloud: flux FINALIZAT, dar coloana `status` a rămas 'completed'
    const r0 = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', flowId, nrUnic: 'DF-CLOUD-1' });
    const r1 = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', nrUnic: 'DF-CLOUD-1', revizieNr: 1, parentDfId: r0 });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId: r1 });

    const res = await request(app).post(`/api/formulare-df/${r1}/sterge`).set('Cookie', p1()).send({});
    expect(res.status).toBe(200);

    const a = await getAlop(alopId);
    expect(a.df_id).toBe(r0);          // înainte de fix: NULL („Fără DF")
    expect(a.df_flow_id).toBe(flowId);
    expect(a.df_completed_at).not.toBeNull();
  });

  it('non-regresie: părinte cu status persistat „aprobat" → restore identic', async () => {
    const flowId = await seedFlowApproved();
    const r0 = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-CLOUD-2' });
    const r1 = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', nrUnic: 'DF-CLOUD-2', revizieNr: 1, parentDfId: r0 });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId: r1 });

    expect((await request(app).post(`/api/formulare-df/${r1}/sterge`).set('Cookie', p1()).send({})).status).toBe(200);
    expect((await getAlop(alopId)).df_id).toBe(r0);
  });

  // ── 5. Flux mort NU aprobă părintele (regresie #115) ───────────────────────
  it('părinte pe flux REFUZAT → ștergerea R1 NU-l restaurează (df_id eliberat)', async () => {
    const deadFlow = await seedFlowRefused();
    const r0 = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', flowId: deadFlow, nrUnic: 'DF-DEAD-1' });
    const r1 = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', nrUnic: 'DF-DEAD-1', revizieNr: 1, parentDfId: r0 });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId: r1 });

    expect((await request(app).post(`/api/formulare-df/${r1}/sterge`).set('Cookie', p1()).send({})).status).toBe(200);

    const a = await getAlop(alopId);
    expect(a.df_id).toBeNull();        // părintele nu e aprobat ⇒ ALOP „DF în lucru"
    expect(a.df_flow_id).toBeNull();
  });

  // ── 2. /revizuieste cu legătura deja ruptă → fallback pe source_alop_id ─────
  it('/revizuieste cu alop.df_id=NULL → fallback prin source_alop_id releagă ALOP-ul la revizia nouă', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare' }); // df_id NULL (legătură ruptă)
    const flowId = await seedFlowApproved();
    const r0 = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', flowId, nrUnic: 'DF-FB-1' });
    await pool.query(`UPDATE formulare_df SET source_alop_id=$2 WHERE id=$1`, [r0, alopId]);

    const res = await request(app).post(`/api/formulare-df/${r0}/revizuieste`).set('Cookie', p1()).send({ motiv: 'suplimentare' });
    expect(res.status).toBe(200);
    const revId = res.body.df.id;

    const a = await getAlop(alopId);
    expect(a.df_id).toBe(revId);
    expect(a.df_flow_id).toBeNull();
    expect(a.df_completed_at).toBeNull();
  });

  it('/revizuieste cu legătura INTACTĂ → calea normală (fără fallback), ALOP mutat pe revizie', async () => {
    const flowId = await seedFlowApproved();
    const r0 = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', flowId, nrUnic: 'DF-FB-2' });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId: r0, dfFlowId: flowId });

    const res = await request(app).post(`/api/formulare-df/${r0}/revizuieste`).set('Cookie', p1()).send({});
    expect(res.status).toBe(200);
    expect((await getAlop(alopId)).df_id).toBe(res.body.df.id);
  });

  // ── 3. Fallback-ul NU fură un ALOP legat între timp de alt document ─────────
  it('/revizuieste: ALOP-ul are deja df_id = ALT document → fallback-ul NU-l modifică', async () => {
    const altDf = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', nrUnic: 'DF-ALTUL' });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId: altDf });
    const flowId = await seedFlowApproved();
    const r0 = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', flowId, nrUnic: 'DF-FB-3' });
    await pool.query(`UPDATE formulare_df SET source_alop_id=$2 WHERE id=$1`, [r0, alopId]);

    const res = await request(app).post(`/api/formulare-df/${r0}/revizuieste`).set('Cookie', p1()).send({});
    expect(res.status).toBe(200);      // revizia se creează oricum
    expect((await getAlop(alopId)).df_id).toBe(altDf); // legătura manuală rămâne
  });

  it('/revizuieste: ALOP anulat (cancelled_at) → fallback-ul nu-l atinge', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', cancelledAt: new Date() });
    const flowId = await seedFlowApproved();
    const r0 = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', flowId, nrUnic: 'DF-FB-4' });
    await pool.query(`UPDATE formulare_df SET source_alop_id=$2 WHERE id=$1`, [r0, alopId]);

    expect((await request(app).post(`/api/formulare-df/${r0}/revizuieste`).set('Cookie', p1()).send({})).status).toBe(200);
    expect((await getAlop(alopId)).df_id).toBeNull();
  });

  // ── 4. finalizeDfOnFlowCompleted — calea cloud aliniată cu upload manual ────
  it('finalizeDfOnFlowCompleted: DF „completed" pe flux finalizat → status=aprobat ȘI ALOP relegat', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare' }); // df_id NULL
    const flowId = await seedFlowApproved();
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', flowId, nrUnic: 'DF-FIN-1' });
    await pool.query(`UPDATE formulare_df SET source_alop_id=$2 WHERE id=$1`, [dfId, alopId]);

    await finalizeDfOnFlowCompleted(pool, flowId);

    expect((await getDf(dfId)).status).toBe('aprobat');
    const a = await getAlop(alopId);
    expect(a.df_id).toBe(dfId);
    expect(a.df_flow_id).toBe(flowId);
    expect(a.status).toBe('lichidare');    // angajare → lichidare (self-heal)
  });

  it('finalizeDfOnFlowCompleted: idempotent — a doua rulare nu schimbă nimic', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare' });
    const flowId = await seedFlowApproved();
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', flowId, nrUnic: 'DF-FIN-2' });
    await pool.query(`UPDATE formulare_df SET source_alop_id=$2 WHERE id=$1`, [dfId, alopId]);

    await finalizeDfOnFlowCompleted(pool, flowId);
    const df1 = await getDf(dfId); const a1 = await getAlop(alopId);
    await finalizeDfOnFlowCompleted(pool, flowId);
    const df2 = await getDf(dfId); const a2 = await getAlop(alopId);

    expect(df2.status).toBe('aprobat');
    expect(String(df2.updated_at)).toBe(String(df1.updated_at)); // garda IS DISTINCT FROM → fără scriere
    expect(a2.df_id).toBe(a1.df_id);
    expect(a2.status).toBe(a1.status);
  });

  it('finalizeDfOnFlowCompleted: DF soft-șters pe același flux → neatins', async () => {
    const flowId = await seedFlowApproved();
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', flowId, nrUnic: 'DF-FIN-3' });
    await pool.query(`UPDATE formulare_df SET deleted_at=NOW() WHERE id=$1`, [dfId]);

    await finalizeDfOnFlowCompleted(pool, flowId);

    expect((await getDf(dfId)).status).toBe('completed');
  });

  it('finalizeDfOnFlowCompleted pe un flux fără DF (ex. flux ORD) → no-op, fără eroare', async () => {
    const flowId = await seedFlowApproved();
    await expect(finalizeDfOnFlowCompleted(pool, flowId)).resolves.toBeUndefined();
  });

  // ── 7. Efect secundar ACCEPTAT: DF aprobat e blocat la PUT (nu se resetează la draft) ──
  it('PUT pe DF cu status=aprobat → 409 document_locked (comportament DORIT: calea corectă e /revizuieste)', async () => {
    const flowId = await seedFlowApproved();
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId, nrUnic: 'DF-LOCK-1' });

    const res = await request(app).put(`/api/formulare-df/${dfId}`).set('Cookie', p1()).send({ subtitlu_df: 'modificat' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('document_locked');
    expect((await getDf(dfId)).status).toBe('aprobat');
  });
});

// ═══ v3.9.750 — self-heal DF LAZY (cheiat pe alopId), din GET /api/alop/:id ═══
// selfHealAlopDfLinkByAlop e importat din producție (NU reimplementat).
d('DF↔ALOP — self-heal lazy cheiat pe ALOP (selfHealAlopDfLinkByAlop)', () => {
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' });
  });

  const linkDf = (dfId, alopId) =>
    pool.query(`UPDATE formulare_df SET source_alop_id=$2 WHERE id=$1`, [dfId, alopId]);

  // ── 1. Self-heal lazy + idempotent ─────────────────────────────────────────
  it('ALOP df_id=NULL + DF source_alop_id pe flux FINALIZAT → reataşează, marchează aprobat, idempotent', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare' }); // df_id NULL
    const flowId = await seedFlowApproved();
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', flowId, nrUnic: 'LZ-1' });
    await linkDf(dfId, alopId);

    const healed = await selfHealAlopDfLinkByAlop(pool, alopId);
    expect(healed).not.toBeNull();
    expect(healed.df_id).toBe(dfId);

    const a1 = await getAlop(alopId);
    expect(a1.df_id).toBe(dfId);
    expect(a1.df_flow_id).toBe(flowId);
    expect((await getDf(dfId)).status).toBe('aprobat');

    // A doua rulare: df_id nu mai e NULL → no-op (returnează null, nu schimbă nimic)
    const again = await selfHealAlopDfLinkByAlop(pool, alopId);
    expect(again).toBeNull();
    expect((await getAlop(alopId)).df_id).toBe(dfId);
  });

  // ── 2. Nu fură un ALOP deja legat ──────────────────────────────────────────
  it('ALOP cu df_id = alt document → funcția NU modifică nimic', async () => {
    const altDf = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', nrUnic: 'LZ-ALT' });
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId: altDf });
    const flowId = await seedFlowApproved();
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', flowId, nrUnic: 'LZ-2' });
    await linkDf(dfId, alopId);

    expect(await selfHealAlopDfLinkByAlop(pool, alopId)).toBeNull();
    expect((await getAlop(alopId)).df_id).toBe(altDf);
    expect((await getDf(dfId)).status).toBe('completed'); // NU marcat aprobat
  });

  // ── 3. Flux nefinalizat / refuzat / anulat → NU reataşează ─────────────────
  it('flux ÎN CURS → NU reataşează', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare' });
    const flowId = await seedFlow({ completed: false });
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', flowId, nrUnic: 'LZ-3a' });
    await linkDf(dfId, alopId);
    expect(await selfHealAlopDfLinkByAlop(pool, alopId)).toBeNull();
    expect((await getAlop(alopId)).df_id).toBeNull();
  });

  it('flux REFUZAT → NU reataşează', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare' });
    const flowId = await seedFlowRefused();
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', flowId, nrUnic: 'LZ-3b' });
    await linkDf(dfId, alopId);
    expect(await selfHealAlopDfLinkByAlop(pool, alopId)).toBeNull();
    expect((await getAlop(alopId)).df_id).toBeNull();
  });

  it('flux ANULAT → NU reataşează', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare' });
    const flowId = await seedFlowCancelled();
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', flowId, nrUnic: 'LZ-3c' });
    await linkDf(dfId, alopId);
    expect(await selfHealAlopDfLinkByAlop(pool, alopId)).toBeNull();
    expect((await getAlop(alopId)).df_id).toBeNull();
  });

  // ── 4. Ambiguitate: două DF pe aceeași revizie maximă → SKIP + warn ─────────
  // Starea (2 DF nedeleted cu ACEEAȘI source_alop_id + revizie_nr) e împiedicată în
  // producție de indexul parțial `df_source_alop_revizie_uniq` — garda din funcție e
  // DEFENSIVĂ față de coruperea acelui invariant. Ca s-o exersăm, coborâm temporar
  // indexul, apoi îl restaurăm (try/finally) — restul suitei rulează secvențial.
  it('două DF nedeleted cu ACEEAȘI revizie_nr maximă, ambele finalizate → SKIP, df_id rămâne NULL', async () => {
    await pool.query('DROP INDEX IF EXISTS df_source_alop_revizie_uniq');
    try {
      const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare' });
      const f1 = await seedFlowApproved(`flow-amb-1-${Math.random().toString(36).slice(2, 7)}`);
      const f2 = await seedFlowApproved(`flow-amb-2-${Math.random().toString(36).slice(2, 7)}`);
      const d1 = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', flowId: f1, nrUnic: 'LZ-AMB', revizieNr: 0 });
      const d2 = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', flowId: f2, nrUnic: 'LZ-AMB2', revizieNr: 0 });
      await linkDf(d1, alopId);
      await linkDf(d2, alopId);

      expect(await selfHealAlopDfLinkByAlop(pool, alopId)).toBeNull();
      expect((await getAlop(alopId)).df_id).toBeNull();
    } finally {
      // Curăță rândurile duplicate ÎNAINTE de a reface indexul unic (altfel CREATE
      // eșuează pe cheia duplicată). beforeEach truncă oricum înaintea testului următor.
      await pool.query('DELETE FROM formulare_df');
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS df_source_alop_revizie_uniq
        ON public.formulare_df (source_alop_id, revizie_nr)
        WHERE (source_alop_id IS NOT NULL AND deleted_at IS NULL)`);
    }
  });

  // ── 5. Revizie mai nouă câștigă ────────────────────────────────────────────
  it('R0 și R1 ambele finalizate → se leagă R1 (revizia maximă)', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare' });
    const f0 = await seedFlowApproved(`flow-r0-${Math.random().toString(36).slice(2, 7)}`);
    const f1 = await seedFlowApproved(`flow-r1-${Math.random().toString(36).slice(2, 7)}`);
    const r0 = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', flowId: f0, nrUnic: 'LZ-REV', revizieNr: 0 });
    const r1 = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', flowId: f1, nrUnic: 'LZ-REV', revizieNr: 1, parentDfId: r0 });
    await linkDf(r0, alopId);
    await linkDf(r1, alopId);

    const healed = await selfHealAlopDfLinkByAlop(pool, alopId);
    expect(healed).not.toBeNull();
    expect(healed.df_id).toBe(r1);
    expect((await getAlop(alopId)).df_id).toBe(r1);
  });

  // ── 6. ALOP completed se vindecă; cancelled NU (invariant CLAUDE.md:499) ────
  it('ALOP status=completed, df_id=NULL, cancelled_at NULL → reataşat', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'completed' });
    const flowId = await seedFlowApproved();
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', flowId, nrUnic: 'LZ-6a' });
    await linkDf(dfId, alopId);

    expect(await selfHealAlopDfLinkByAlop(pool, alopId)).not.toBeNull();
    expect((await getAlop(alopId)).df_id).toBe(dfId);
  });

  it('ALOP cancelled_at ne-null → NU reataşat', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', cancelledAt: new Date() });
    const flowId = await seedFlowApproved();
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', flowId, nrUnic: 'LZ-6b' });
    await linkDf(dfId, alopId);

    expect(await selfHealAlopDfLinkByAlop(pool, alopId)).toBeNull();
    expect((await getAlop(alopId)).df_id).toBeNull();
  });
});

// ═══ v3.9.750 — PAS 4: blocarea PUT derivată din flux, nu din coloana status ═══
d('DF PUT — blocare derivată din fluxul de semnare (nu din coloana status)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' });
    app = buildApp();
  });
  afterAll(() => pool.end());
  const p1 = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  it('DF status=completed pe flux FINALIZAT → 409 document_locked (semnat prin cloud, nu resetat la draft)', async () => {
    const flowId = await seedFlowApproved();
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', flowId, nrUnic: 'PUT-LOCK-1' });

    const res = await request(app).put(`/api/formulare-df/${dfId}`).set('Cookie', p1()).send({ subtitlu_df: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('document_locked');
    expect((await getDf(dfId)).status).toBe('completed');
  });

  it('DF status=completed pe flux ÎN CURS → reset la draft (comportament neschimbat)', async () => {
    const flowId = await seedFlow({ completed: false });
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', flowId, nrUnic: 'PUT-LOCK-2' });

    const res = await request(app).put(`/api/formulare-df/${dfId}`).set('Cookie', p1()).send({ subtitlu_df: 'x' });
    expect(res.status).toBe(200);
    expect((await getDf(dfId)).status).toBe('draft');
  });

  it('DF status=completed pe flux REFUZAT → reset la draft (rămâne editabil pentru corectare)', async () => {
    const flowId = await seedFlowRefused();
    const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', flowId, nrUnic: 'PUT-LOCK-3' });

    const res = await request(app).put(`/api/formulare-df/${dfId}`).set('Cookie', p1()).send({ subtitlu_df: 'x' });
    expect(res.status).toBe(200);
    expect((await getDf(dfId)).status).toBe('draft');
  });
});
