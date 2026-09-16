/**
 * #215 — un ORD/DF nu mai poate fi legat de ALT dosar decât al lui.
 *
 * Incident 16.09.2026: ORD 47842 (RATBV, 217.526,49) apărea pe DOUĂ dosare ALOP —
 * „DIFERENTA DE TARIF" (ciclul 4, ordonanțare, corect) și „CONSUM CARBURANT" (ciclul 1,
 * lichidare, greșit). `POST /api/alop/:id/link-ord` e singurul scriitor al lui
 * `alop_instances.ord_id` și verifica doar că dosarul-țintă n-are încă un ORD. Frontendul
 * îl cheamă la FIECARE salvare cu dosarul reținut în browser (`window._alopContext`) ⇒ un
 * context rămas de la alt dosar leagă ORD-ul acolo.
 *
 * Gărzile se aplică DOAR la o legare NOUĂ (ORD-ul primit ≠ `ord_id` curent). Reapelul
 * idempotent trece ca înainte, în orice fază — altfel autosave-ul unui ORD aprobat, în
 * plată, ar produce 409 la fiecare salvare.
 *
 * Două dosare în aceeași organizație: A („RATBV") și B („CONSUM CARBURANT").
 * Scris ÎNAINTE de patch; roșiile pe codul nereparat sunt raportate în commit.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedAlop, getAlop, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

// POST /flows (crud.mjs) are dependențe injectate în producție din index.mjs; aici le
// stub-uim ca în flow-link-audit.test.mjs. Modulul e același cu cel montat de buildApp.
const crudMod = await import('../../routes/flows/crud.mjs');
let _flowSeq = 0;
crudMod._injectDeps({
  notify: async () => {}, fireWebhook: null, wsPush: () => {},
  PDFLib: null, stampFooterOnPdf: null, isSignerTokenExpired: () => false,
  newFlowId: () => `flow-215-${++_flowSeq}`, buildSignerLink: () => '', stripSensitive: (x) => x,
  stripPdfB64: (x) => x, sendSignerEmail: async () => {},
});

const d = describe.skipIf(!hasTestDb());

// Un singur cleanup de pool pentru tot fișierul (2 describe-uri) — pool.end() per-describe
// ar închide pool-ul după primul bloc și ar rupe al doilea.
afterAll(() => pool.end());

// seedOrd nu expune source_alop_id (proveniența ALOP, migrarea 084) — îl setăm aici.
async function seedOrdCuProvenienta({ sourceAlopId = null, nrOrd = 'ORD-215-1' } = {}) {
  const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'draft', nrOrd });
  if (sourceAlopId) {
    await pool.query('UPDATE formulare_ord SET source_alop_id=$1 WHERE id=$2', [sourceAlopId, ordId]);
  }
  return ordId;
}

// Ciclu arhivat minimal (alop_ord_cicluri) — doar coloanele relevante pentru gardă.
async function insertCiclu({ alopId, ordId, cicluNr = 1 }) {
  await pool.query(
    `INSERT INTO alop_ord_cicluri (alop_id, org_id, ciclu_nr, ord_id, status)
     VALUES ($1, 1, $2, $3, 'completed')`,
    [alopId, cicluNr, ordId]
  );
}

d('#215 — link-ord: un ORD nu poate fi legat de alt dosar decât al lui', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', compartiment: 'Achizitii' });
    app = buildApp();
  });

  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });
  const linkOrd = (alopId, ordId) =>
    request(app).post(`/api/alop/${alopId}/link-ord`).set('Cookie', cookie()).send({ ord_id: ordId });

  // Reproducerea exactă a incidentului: A în ordonanțare cu ORD-ul lui; B în lichidare, fără ORD.
  async function seedIncident() {
    const A = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', titlu: 'DIFERENTA DE TARIF (RATBV)' });
    const B = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', titlu: 'CONSUM CARBURANT' });
    const ord = await seedOrdCuProvenienta({ sourceAlopId: A, nrOrd: '47842' });
    await pool.query('UPDATE alop_instances SET ord_id=$1 WHERE id=$2', [ord, A]);
    return { A, B, ord };
  }

  it('1 ⭐⭐ incidentul reprodus: ORD al lui A (ordonantare), B în lichidare fără ORD → 409 ord_alt_dosar, B neatins', async () => {
    const { A, B, ord } = await seedIncident();
    const before = await getAlop(B);

    const res = await linkOrd(B, ord);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ord_alt_dosar');
    const after = await getAlop(B);
    expect(after.ord_id).toBeNull();
    expect(after.status).toBe('lichidare');
    expect(String(after.updated_at)).toBe(String(before.updated_at));
    // A rămâne cu ORD-ul lui.
    expect((await getAlop(A)).ord_id).toBe(ord);
  });

  it('2 B în ordonantare, ORD cu source_alop_id = A → 409 ord_alt_dosar (proveniența bate faza)', async () => {
    const A = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', titlu: 'A' });
    const B = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', titlu: 'B' });
    const ord = await seedOrdCuProvenienta({ sourceAlopId: A });

    const res = await linkOrd(B, ord);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ord_alt_dosar');
    expect((await getAlop(B)).ord_id).toBeNull();
  });

  it('3 ORD FĂRĂ proveniență, deja ORD curent pe A; B în ordonantare → 409 ord_deja_legat', async () => {
    const A = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', titlu: 'A' });
    const B = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', titlu: 'B' });
    const ord = await seedOrdCuProvenienta({ sourceAlopId: null });
    await pool.query('UPDATE alop_instances SET ord_id=$1 WHERE id=$2', [ord, A]);

    const res = await linkOrd(B, ord);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ord_deja_legat');
    expect((await getAlop(B)).ord_id).toBeNull();
    expect((await getAlop(A)).ord_id).toBe(ord);
  });

  it('4 ORD fără proveniență, doar într-un ciclu ARHIVAT al lui A; B în ordonantare → 409 ord_deja_legat', async () => {
    const A = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', titlu: 'A', cicluCurent: 2 });
    const B = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', titlu: 'B' });
    const ord = await seedOrdCuProvenienta({ sourceAlopId: null });
    await insertCiclu({ alopId: A, ordId: ord, cicluNr: 1 });
    // A.ord_id e NULL (noua-lichidare îl golește); ORD-ul trăiește doar în arhivă.
    expect((await getAlop(A)).ord_id).toBeNull();

    const res = await linkOrd(B, ord);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ord_deja_legat');
    expect((await getAlop(B)).ord_id).toBeNull();
  });

  it('5 ORD fără proveniență, liber; B în lichidare → 409 dosar_nu_e_in_ordonantare', async () => {
    const B = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', titlu: 'B' });
    const ord = await seedOrdCuProvenienta({ sourceAlopId: null });

    const res = await linkOrd(B, ord);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('dosar_nu_e_in_ordonantare');
    expect(res.body.status).toBe('lichidare');
    expect((await getAlop(B)).ord_id).toBeNull();
  });

  it('6 neregresie: ORD cu source_alop_id = A, liber, A în ordonantare → 200, ord_id setat', async () => {
    const A = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', titlu: 'A' });
    const ord = await seedOrdCuProvenienta({ sourceAlopId: A });

    const res = await linkOrd(A, ord);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect((await getAlop(A)).ord_id).toBe(ord);
  });

  it('7 ⭐ neregresie idempotență: A în PLATA cu ord_id = ORD; link-ord(A, același ORD) → 200', async () => {
    // Autosave-ul unui ORD aprobat cheamă link-ord la fiecare salvare — faza nu contează
    // când ORD-ul e deja cel legat.
    const A = await seedAlop({ orgId: 1, createdBy: 1, status: 'plata', titlu: 'A' });
    const ord = await seedOrdCuProvenienta({ sourceAlopId: A });
    await pool.query('UPDATE alop_instances SET ord_id=$1 WHERE id=$2', [ord, A]);

    const res = await linkOrd(A, ord);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const a = await getAlop(A);
    expect(a.ord_id).toBe(ord);
    expect(a.status).toBe('plata');
  });

  it('8 neregresie documente vechi: ORD fără proveniență, liber, A în ordonantare → 200', async () => {
    const A = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', titlu: 'A' });
    const ord = await seedOrdCuProvenienta({ sourceAlopId: null });

    const res = await linkOrd(A, ord);

    expect(res.status).toBe(200);
    expect((await getAlop(A)).ord_id).toBe(ord);
  });

  it('9 ⭐ consecința evitată: după 1, fluxul lansat cu meta.ordId pune ord_flow_id DOAR pe A', async () => {
    const { A, B, ord } = await seedIncident();
    await linkOrd(B, ord); // 409 pe codul reparat; 200 pe cel vechi (B primea ORD-ul)

    // Lansarea fluxului ORD, ca din semdoc-initiator (crud.mjs:~627: UPDATE … WHERE ord_id = $2).
    const res = await request(app).post('/flows').set('Cookie', cookie()).send({
      docName: 'ORD 47842', initName: 'Initiator', initEmail: 'p1@x.ro',
      signers: [{ name: 'Semnatar', email: 'extern@example.com', order: 1, rol: 'APROBAT' }],
      meta: { ordId: String(ord) }, flowType: 'tabel',
    });
    expect(res.status).toBe(200);
    const flowId = res.body.flowId;
    expect(flowId).toBeTruthy();

    expect((await getAlop(A)).ord_flow_id).toBe(flowId);
    const b = await getAlop(B);
    expect(b.ord_flow_id).toBeNull();
    expect(b.ord_id).toBeNull();
  });
});

d('#215 — link-df: un DF nu poate fi legat de alt dosar decât al lui', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', compartiment: 'Achizitii' });
    app = buildApp();
  });

  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });
  const linkDf = (alopId, dfId) =>
    request(app).post(`/api/alop/${alopId}/link-df`).set('Cookie', cookie()).send({ df_id: dfId });

  it('10 ⭐ DF (revizie în lucru) cu source_alop_id = A; B în draft, df_id NULL → 409 df_alt_dosar, B rămâne draft', async () => {
    // Fără gardă, UPDATE-ul de azi ar fi legat R1 de B și l-ar fi mutat pe B în `angajare`.
    const A = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', titlu: 'A' });
    const B = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft', titlu: 'B' });
    const r0 = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-215-A', revizieNr: 0, sourceAlopId: A });
    const r1 = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', nrUnic: 'DF-215-A', revizieNr: 1, parentDfId: r0, sourceAlopId: A });
    await pool.query('UPDATE alop_instances SET df_id=$1 WHERE id=$2', [r0, A]);

    const res = await linkDf(B, r1);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('df_alt_dosar');
    const b = await getAlop(B);
    expect(b.df_id).toBeNull();
    expect(b.status).toBe('draft');
    expect((await getAlop(A)).df_id).toBe(r0);
  });

  it('11 neregresie: DF cu source_alop_id = B; B în draft → 200, B trece în angajare', async () => {
    const B = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft', titlu: 'B' });
    const df = await seedDf({ orgId: 1, createdBy: 1, status: 'draft', nrUnic: 'DF-215-B', sourceAlopId: B });

    const res = await linkDf(B, df);

    expect(res.status).toBe(200);
    const b = await getAlop(B);
    expect(b.df_id).toBe(df);
    expect(b.status).toBe('angajare');
  });

  // 12 — neregresie #185 (revizie a ACELUIAȘI dosar, A pe R0, link-df cu R1 → 200
  // noop:'revizie_in_lucru') e acoperită exact de `alop-link-df-revizie.test.mjs` (testul 1,
  // seedDosarCuRevizie cu sourceAlopId = alopId pe ambele revizii). Nu o duplicăm aici.
});
