/**
 * #158 — self-heal ALOP→DF avansează pointerul și când `df_id` EXISTĂ, dar a rămas
 * pe o revizie VECHE a aceluiași dosar.
 *
 * Cauza rădăcină (confirmată pe producție, 3 dosare): `selfHealAlopDfLink` (cheiat pe
 * flowId — SINGURUL care avansa între revizii) se apelează doar din calea de upload
 * LOCAL (`signing.mjs`/`crud.mjs`); a fost scos din `cloud-signing.mjs` la #118 (zonă
 * NO-TOUCH). Cum toate fluxurile din producție merg prin STS Cloud, R1 se aproba fără
 * ca `alop_instances.df_id` să părăsească R0 — iar cifrele financiare din antet, care
 * se citesc prin JOIN pe pointerul BRUT, rămâneau cele ale lui R0.
 *
 * Fixture-urile reproduc forma REALĂ a fluxurilor semnate cloud: `data.status='active'`,
 * `completed=true`, `completedAt` setat (vezi #139). Funcțiile sunt importate din
 * producție, NU reimplementate; Postgres real, fără mock-uri pe `pool.query`.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedAlop, getAlop, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';
import { selfHealAlopDfLinkByAlop, backfillAlopFlowPointers } from '../../services/alop-link.mjs';

const d = describe.skipIf(!hasTestDb());

/** Flux „shape" real STS Cloud: status='active' + completed=true + completedAt. */
async function seedFlowCloudCompleted({ orgId = 1, completedAt } = {}) {
  const id = `flow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await pool.query(
    `INSERT INTO flows (id, data, org_id) VALUES ($1, $2::jsonb, $3)`,
    [id, JSON.stringify({
      flowId: id, docName: 'Nota de fundamentare', signers: [],
      status: 'active', completed: true,
      completedAt: completedAt || new Date().toISOString(),
    }), orgId]
  );
  return id;
}

const AT_R0 = '2026-01-15T08:00:00.000Z';
const AT_R1 = '2026-06-20T09:30:00.000Z';

/**
 * Dosarul din producție: R0 LEGACY (fără source_alop_id) pe care pointează ALOP-ul,
 * plus R1 aprobată prin cloud (cu source_alop_id), ambele pe același nr_unic_inreg.
 */
async function seedDosarCuRevizieNoua(nrUnic) {
  const f0 = await seedFlowCloudCompleted({ completedAt: AT_R0 });
  const r0 = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId: f0, nrUnic, revizieNr: 0 });
  const alopId = await seedAlop({
    orgId: 1, createdBy: 1, status: 'lichidare', titlu: nrUnic,
    dfId: r0, dfFlowId: f0, dfCompletedAt: AT_R0,
  });
  const f1 = await seedFlowCloudCompleted({ completedAt: AT_R1 });
  const r1 = await seedDf({
    orgId: 1, createdBy: 1, status: 'completed', flowId: f1, nrUnic,
    revizieNr: 1, parentDfId: r0, sourceAlopId: alopId,
  });
  return { alopId, r0, r1, f0, f1 };
}

d('#158 — self-heal ALOP→DF: pointer rămas pe o revizie veche', () => {
  let app;
  beforeAll(migrate);
  afterAll(() => pool.end());
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' }); // user 1, org 1
    app = buildApp();
  });
  const p1 = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  // ── 1. Avansare corectă ────────────────────────────────────────────────────
  it('⭐ df_id pe R0, R1 aprobată pe același nr_unic_inreg → pointerul avansează la R1, cu fluxul ȘI data lui R1', async () => {
    const { alopId, r0, r1, f1 } = await seedDosarCuRevizieNoua('DOS-158-1');

    const inainte = await getAlop(alopId);
    expect(inainte.df_id).toBe(r0);

    const healed = await selfHealAlopDfLinkByAlop(pool, alopId);
    expect(healed).not.toBeNull();
    expect(healed.df_id).toBe(r1);

    const dupa = await getAlop(alopId);
    expect(dupa.df_id).toBe(r1);
    // sub-câmpurile VECHI (ale lui R0) au fost înlocuite, nu păstrate prin COALESCE
    expect(dupa.df_flow_id).toBe(f1);
    expect(new Date(dupa.df_completed_at).toISOString()).toBe(AT_R1);
  });

  // ── 2. Siguranță: nr_unic_inreg diferit ⇒ relegare manuală, NU se atinge ────
  it('⭐⭐ df_id pointează la un DF din ALT dosar (nr_unic_inreg diferit) → null, pointerul rămâne neschimbat', async () => {
    const fAlt = await seedFlowCloudCompleted({ completedAt: AT_R0 });
    const altDf = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId: fAlt, nrUnic: 'ALT-DOSAR-158', revizieNr: 0 });
    const alopId = await seedAlop({
      orgId: 1, createdBy: 1, status: 'lichidare', titlu: 'DOS-158-2',
      dfId: altDf, dfFlowId: fAlt, dfCompletedAt: AT_R0,
    });
    const f1 = await seedFlowCloudCompleted({ completedAt: AT_R1 });
    await seedDf({
      orgId: 1, createdBy: 1, status: 'completed', flowId: f1, nrUnic: 'DOS-158-2',
      revizieNr: 1, sourceAlopId: alopId,
    });

    expect(await selfHealAlopDfLinkByAlop(pool, alopId)).toBeNull();

    const dupa = await getAlop(alopId);
    expect(dupa.df_id).toBe(altDf);
    expect(dupa.df_flow_id).toBe(fAlt);
    expect(new Date(dupa.df_completed_at).toISOString()).toBe(AT_R0);
  });

  // ── 3. Idempotență ─────────────────────────────────────────────────────────
  it('idempotent — a doua rulare imediat după avansare întoarce null și nu schimbă nimic', async () => {
    const { alopId, r1, f1 } = await seedDosarCuRevizieNoua('DOS-158-3');

    expect((await selfHealAlopDfLinkByAlop(pool, alopId)).df_id).toBe(r1);
    const dupaPrima = await getAlop(alopId);

    const aDoua = await selfHealAlopDfLinkByAlop(pool, alopId);
    expect(aDoua).toBeNull();                       // garda `df_id IS DISTINCT FROM $1`

    const dupaADoua = await getAlop(alopId);
    expect(dupaADoua.df_id).toBe(r1);
    expect(dupaADoua.df_flow_id).toBe(f1);
    expect(String(dupaADoua.updated_at)).toBe(String(dupaPrima.updated_at)); // zero scriere
  });

  // ── 4. Cazul VECHI (df_id NULL) rămâne bit-identic ─────────────────────────
  it('regresie zero — df_id NULL cu df_flow_id preexistent → se leagă, dar COALESCE PĂSTREAZĂ sub-câmpurile existente', async () => {
    const fZombi = await seedFlowCloudCompleted({ completedAt: AT_R0 });
    const alopId = await seedAlop({
      orgId: 1, createdBy: 1, status: 'angajare', titlu: 'DOS-158-4',
      dfFlowId: fZombi, dfCompletedAt: AT_R0,   // df_id rămâne NULL
    });
    const f1 = await seedFlowCloudCompleted({ completedAt: AT_R1 });
    const dfId = await seedDf({
      orgId: 1, createdBy: 1, status: 'completed', flowId: f1, nrUnic: 'DOS-158-4',
      revizieNr: 0, sourceAlopId: alopId,
    });

    const healed = await selfHealAlopDfLinkByAlop(pool, alopId);
    expect(healed).not.toBeNull();
    expect(healed.df_id).toBe(dfId);

    const dupa = await getAlop(alopId);
    expect(dupa.df_id).toBe(dfId);
    // ramura veche: COALESCE ⇒ valorile deja prezente NU se suprascriu
    expect(dupa.df_flow_id).toBe(fZombi);
    expect(new Date(dupa.df_completed_at).toISOString()).toBe(AT_R0);
  });

  it('regresie zero — df_id NULL fără nicio valoare preexistentă → se leagă cu fluxul și data candidatului', async () => {
    const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', titlu: 'DOS-158-4b' });
    const f1 = await seedFlowCloudCompleted({ completedAt: AT_R1 });
    const dfId = await seedDf({
      orgId: 1, createdBy: 1, status: 'completed', flowId: f1, nrUnic: 'DOS-158-4b',
      revizieNr: 0, sourceAlopId: alopId,
    });

    expect((await selfHealAlopDfLinkByAlop(pool, alopId)).df_id).toBe(dfId);
    const dupa = await getAlop(alopId);
    expect(dupa.df_flow_id).toBe(f1);
    expect(new Date(dupa.df_completed_at).toISOString()).toBe(AT_R1);
  });

  // ── 5. backfillAlopFlowPointers rămâne NEATINSĂ: nu mută df_id ──────────────
  it('backfillAlopFlowPointers tot NU mută df_id — nici în prezența unei revizii mai noi aprobate', async () => {
    const { alopId, r0, r1, f0 } = await seedDosarCuRevizieNoua('DOS-158-5');
    // pointerii de flux golim ca să existe ceva de back-fill-at
    await pool.query(`UPDATE alop_instances SET df_flow_id=NULL, df_completed_at=NULL WHERE id=$1`, [alopId]);

    const filled = await backfillAlopFlowPointers(pool, alopId);
    expect(filled).toBeTruthy();

    const dupa = await getAlop(alopId);
    expect(dupa.df_id).toBe(r0);            // ⭐ NU s-a mutat pe r1
    expect(dupa.df_id).not.toBe(r1);
    expect(dupa.df_flow_id).toBe(f0);       // fluxul lui R0, al pointerului existent
  });

  // ── 6. Ruta GET /api/alop/:id declanșează self-heal-ul ─────────────────────
  it('⭐ GET /api/alop/:id pe un dosar cu pointer vechi → declanșează self-heal-ul, DB-ul rămâne pe R1', async () => {
    const { alopId, r0, r1, f1 } = await seedDosarCuRevizieNoua('DOS-158-6');

    const r = await request(app).get(`/api/alop/${alopId}`).set('Cookie', p1());
    expect(r.status).toBe(200);
    expect(r.body.alop.df_id).toBe(r1);
    expect(r.body.alop.df_id).not.toBe(r0);

    const row = await getAlop(alopId);
    expect(row.df_id).toBe(r1);
    expect(row.df_flow_id).toBe(f1);

    // A doua deschidere e stabilă (heal-ul nu oscilează)
    const r2 = await request(app).get(`/api/alop/${alopId}`).set('Cookie', p1());
    expect(r2.status).toBe(200);
    expect(r2.body.alop.df_id).toBe(r1);
    expect(r2.body.alop.df_revizie_nr).toBe(r2.body.alop.df_revizie_vigoare_nr);
  });

  it('GET /api/alop/:id pe un dosar COERENT (pointer deja pe revizia în vigoare) → nimic nu se schimbă', async () => {
    const f0 = await seedFlowCloudCompleted({ completedAt: AT_R0 });
    const r0 = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', flowId: f0, nrUnic: 'DOS-158-7', revizieNr: 0 });
    const alopId = await seedAlop({
      orgId: 1, createdBy: 1, status: 'lichidare', titlu: 'DOS-158-7',
      dfId: r0, dfFlowId: f0, dfCompletedAt: AT_R0,
    });
    const inainte = await getAlop(alopId);

    const r = await request(app).get(`/api/alop/${alopId}`).set('Cookie', p1());
    expect(r.status).toBe(200);
    expect(r.body.alop.df_id).toBe(r0);

    const dupa = await getAlop(alopId);
    expect(dupa.df_id).toBe(r0);
    expect(String(dupa.updated_at)).toBe(String(inainte.updated_at));
  });
});
