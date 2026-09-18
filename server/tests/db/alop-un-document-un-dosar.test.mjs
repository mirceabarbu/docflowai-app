/**
 * #219 — „un document, un dosar" întărit pe CONSUMATORII care, dacă starea coruptă reapare,
 * aleg un dosar arbitrar sau le tratează pe toate.
 *
 * Incident 16.09.2026: ORD 47842 (RATBV) legat de două dosare ALOP. #215 a închis calea de
 * scriere (`link-ord`/`link-df`). Aici starea coruptă se FORȚEAZĂ direct în bază
 * (`UPDATE alop_instances SET ord_id=…`), ocolind garda — exact ce testăm e comportamentul
 * consumatorilor când garda a fost ocolită (SQL de mână, regresie, altă cale viitoare).
 *
 * Regula: PROVENIENȚA decide (`formulare_{df,ord}.source_alop_id`, scrisă la creare).
 *  - document CU proveniență  ⇒ doar dosarul din proveniență e afectat;
 *  - document FĂRĂ proveniență ⇒ comportamentul de azi, neschimbat;
 *  - ambiguitate nerezolvată   ⇒ NICIO tranziție + logger.error.
 *
 * Dosarul GREȘIT (B) se creează ÎNAINTEA celui corect (A), ca un `LIMIT 1`/`rows[0]` fără
 * ordine să aibă șanse reale să-l aleagă pe B.
 *
 * A — legarea fluxului la creare (crud.mjs)         B — pickAlopForFlow (signing.mjs)
 * C — tranzițiile leneșe din GET detaliu (alop.mjs) D — resolveAlopIdForBudget
 * E — detecția în auditul de legături (clasa document_alt_dosar)
 *
 * Scris ÎNAINTE de patch; roșiile pe codul nereparat sunt raportate în commit.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedAlop, seedFlow, getAlop, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';
import { logger } from '../../middleware/logger.mjs';
// Import de namespace: pe codul nereparat exportul lipsește și testele B cad cu TypeError
// (roșu clar), nu cu eroare de link a întregului fișier.
import * as alopLink from '../../services/alop-link.mjs';
const pickAlopForFlow = (...args) => alopLink.pickAlopForFlow(...args);
import { resolveAlopIdForBudget } from '../../services/formular-shared.mjs';
import { findFlowLinkDivergences } from '../../services/flow-link-audit.mjs';

const crudMod = await import('../../routes/flows/crud.mjs');
let _flowSeq = 0;
crudMod._injectDeps({
  notify: async () => {}, fireWebhook: null, wsPush: () => {},
  PDFLib: null, stampFooterOnPdf: null, isSignerTokenExpired: () => false,
  newFlowId: () => `flow-219-${++_flowSeq}`, buildSignerLink: () => '', stripSensitive: (x) => x,
  stripPdfB64: (x) => x, sendSignerEmail: async () => {},
});

const d = describe.skipIf(!hasTestDb());

afterAll(() => pool.end());

const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

async function seedOrdCuProvenienta({ sourceAlopId = null, nrOrd = 'ORD-219', flowId = null, status = 'draft' } = {}) {
  const ordId = await seedOrd({ orgId: 1, createdBy: 1, status, nrOrd, flowId });
  if (sourceAlopId) {
    await pool.query('UPDATE formulare_ord SET source_alop_id=$1 WHERE id=$2', [sourceAlopId, ordId]);
  }
  return ordId;
}

const setOrd = (alopId, ordId) => pool.query('UPDATE alop_instances SET ord_id=$1 WHERE id=$2', [ordId, alopId]);
const setDf  = (alopId, dfId)  => pool.query('UPDATE alop_instances SET df_id=$1 WHERE id=$2',  [dfId, alopId]);

async function insertCiclu({ alopId, ordId, cicluNr = 1 }) {
  await pool.query(
    `INSERT INTO alop_ord_cicluri (alop_id, org_id, ciclu_nr, ord_id, status)
     VALUES ($1, 1, $2, $3, 'completed')`,
    [alopId, cicluNr, ordId]
  );
}

const postFlow = (app, meta) =>
  request(app).post('/flows').set('Cookie', cookie()).send({
    docName: 'Doc 219', initName: 'Initiator', initEmail: 'p1@x.ro',
    signers: [{ name: 'Semnatar', email: 'extern@example.com', order: 1, rol: 'APROBAT' }],
    meta, flowType: 'tabel',
  });

d('#219 A — POST /flows: fluxul ajunge doar pe dosarul din proveniență', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', compartiment: 'Achizitii' });
    app = buildApp();
    vi.clearAllMocks();
  });

  it('1 ⭐ ORD cu source_alop_id = A; A și B au ord_id = ORD ⇒ ord_flow_id DOAR pe A', async () => {
    const B = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', titlu: 'B (gresit)' });
    const A = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', titlu: 'A (corect)' });
    const ord = await seedOrdCuProvenienta({ sourceAlopId: A });
    await setOrd(B, ord); await setOrd(A, ord);

    const res = await postFlow(app, { ordId: String(ord) });
    expect(res.status).toBe(200);
    const flowId = res.body.flowId;
    expect(flowId).toBeTruthy();

    expect((await getAlop(A)).ord_flow_id).toBe(flowId);
    expect((await getAlop(B)).ord_flow_id).toBeNull();
  });

  it('2 ORD FĂRĂ proveniență; A și B au ord_id = ORD ⇒ ambele primesc fluxul (neschimbat)', async () => {
    const B = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', titlu: 'B' });
    const A = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', titlu: 'A' });
    const ord = await seedOrdCuProvenienta({ sourceAlopId: null });
    await setOrd(B, ord); await setOrd(A, ord);

    const res = await postFlow(app, { ordId: String(ord) });
    expect(res.status).toBe(200);
    const flowId = res.body.flowId;

    expect((await getAlop(A)).ord_flow_id).toBe(flowId);
    expect((await getAlop(B)).ord_flow_id).toBe(flowId);
  });

  it('3 ⭐ DF cu source_alop_id = A; A (angajare) și B (draft) au df_id = DF ⇒ df_flow_id DOAR pe A', async () => {
    const B = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft', titlu: 'B (gresit)' });
    const A = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', titlu: 'A (corect)' });
    const df = await seedDf({ orgId: 1, createdBy: 1, status: 'completed', nrUnic: 'DF-219', sourceAlopId: A });
    await setDf(B, df); await setDf(A, df);

    const res = await postFlow(app, { dfId: String(df) });
    expect(res.status).toBe(200);
    const flowId = res.body.flowId;
    expect(flowId).toBeTruthy();

    expect((await getAlop(A)).df_flow_id).toBe(flowId);
    expect((await getAlop(B)).df_flow_id).toBeNull();
  });
});

d('#219 B — pickAlopForFlow: alegere deterministă la finalizarea semnării', () => {
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', compartiment: 'Achizitii' });
    vi.clearAllMocks();
  });

  it('4a [] ⇒ undefined; un singur rând ⇒ acel rând (fără filtrare)', async () => {
    expect(await pickAlopForFlow(pool, [], { flowId: 'x', formType: 'ord' })).toBeUndefined();
    const one = { id: 'abc', status: 'ordonantare' };
    expect(await pickAlopForFlow(pool, [one], { flowId: 'x', formType: 'ord' })).toBe(one);
    expect(await pickAlopForFlow(pool, [one], { flowId: 'x', formType: 'df' })).toBe(one);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('4b ⭐ [B, A], ORD pe flux cu source_alop_id = A ⇒ A', async () => {
    const flowId = await seedFlow({ id: 'flow-219-pick-ord', completed: true, orgId: 1 });
    const B = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', titlu: 'B' });
    const A = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', titlu: 'A' });
    await seedOrdCuProvenienta({ sourceAlopId: A, flowId });
    const rows = [{ id: B, status: 'ordonantare' }, { id: A, status: 'ordonantare' }];

    const pick = await pickAlopForFlow(pool, rows, { flowId, formType: 'ord' });
    expect(pick).toBe(rows[1]);
    expect(pick.id).toBe(A);
  });

  it('4c ⭐ [B, A], DF pe flux cu source_alop_id = A ⇒ A', async () => {
    const flowId = await seedFlow({ id: 'flow-219-pick-df', completed: true, orgId: 1 });
    const B = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', titlu: 'B' });
    const A = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', titlu: 'A' });
    await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-219', flowId, sourceAlopId: A });
    const rows = [{ id: B, status: 'angajare' }, { id: A, status: 'angajare' }];

    const pick = await pickAlopForFlow(pool, rows, { flowId, formType: 'df' });
    expect(pick.id).toBe(A);
  });

  it('4d ⭐ [B, A], document FĂRĂ proveniență ⇒ null + logger.error (nicio alegere arbitrară)', async () => {
    const flowId = await seedFlow({ id: 'flow-219-pick-noprov', completed: true, orgId: 1 });
    const B = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', titlu: 'B' });
    const A = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', titlu: 'A' });
    await seedOrdCuProvenienta({ sourceAlopId: null, flowId });
    const rows = [{ id: B, status: 'ordonantare' }, { id: A, status: 'ordonantare' }];

    const pick = await pickAlopForFlow(pool, rows, { flowId, formType: 'ord' });
    expect(pick).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ flowId, formType: 'ord', sourceAlopId: null }),
      expect.stringContaining('NICIO tranziție')
    );
  });

  it('4e ⭐ [B, A], proveniență spre un AL TREILEA dosar ⇒ null', async () => {
    const flowId = await seedFlow({ id: 'flow-219-pick-third', completed: true, orgId: 1 });
    const B = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', titlu: 'B' });
    const A = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', titlu: 'A' });
    const C = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', titlu: 'C' });
    await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-219', flowId, sourceAlopId: C });
    const rows = [{ id: B, status: 'angajare' }, { id: A, status: 'angajare' }];

    const pick = await pickAlopForFlow(pool, rows, { flowId, formType: 'df' });
    expect(pick).toBeNull();
    expect(logger.error).toHaveBeenCalled();
  });

  it('5 ⭐ static: signing.mjs cheamă pickAlopForFlow pentru df ȘI ord, fără rows[0] arbitrar', () => {
    const src = readFileSync(new URL('../../routes/flows/signing.mjs', import.meta.url), 'utf8');
    expect(src).toMatch(/pickAlopForFlow\(pool,\s*alopDf\.rows,\s*\{\s*flowId,\s*formType:\s*'df'\s*\}\)/);
    expect(src).toMatch(/pickAlopForFlow\(pool,\s*alopOrd\.rows,\s*\{\s*flowId,\s*formType:\s*'ord'\s*\}\)/);
    expect(src).not.toContain('alopDf.rows[0]');
    expect(src).not.toContain('alopOrd.rows[0] ||');
  });
});

d('#219 C — GET /api/alop/:id: tranzițiile leneșe respectă proveniența', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', compartiment: 'Achizitii' });
    app = buildApp();
    vi.clearAllMocks();
  });

  const getDetail = (id) => request(app).get(`/api/alop/${id}`).set('Cookie', cookie());

  it('6 ⭐ ORD aprobat cu source_alop_id = A; A și B în ordonantare cu ord_id = ORD ⇒ B rămâne, A trece în plata', async () => {
    const flowId = await seedFlow({ id: 'flow-219-c-ord', completed: true, orgId: 1 });
    const B = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', titlu: 'B (gresit)' });
    const A = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', titlu: 'A (corect)' });
    const ord = await seedOrdCuProvenienta({ sourceAlopId: A, flowId, status: 'aprobat' });
    await setOrd(B, ord); await setOrd(A, ord);

    const rb = await getDetail(B);
    expect(rb.status).toBe(200);
    const b = await getAlop(B);
    expect(b.status).toBe('ordonantare');
    expect(b.ord_flow_id).toBeNull();
    expect(b.ord_completed_at).toBeNull();

    const ra = await getDetail(A);
    expect(ra.status).toBe(200);
    const a = await getAlop(A);
    expect(a.status).toBe('plata');
    expect(a.ord_flow_id).toBe(flowId);
  });

  it('7 ⭐ DF aprobat cu source_alop_id = A; B în angajare cu df_id = DF ⇒ B rămâne angajare, A trece în lichidare', async () => {
    const flowId = await seedFlow({ id: 'flow-219-c-df', completed: true, orgId: 1 });
    const B = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', titlu: 'B (gresit)' });
    const A = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', titlu: 'A (corect)' });
    const df = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-219', flowId, sourceAlopId: A });
    await setDf(B, df); await setDf(A, df);

    const rb = await getDetail(B);
    expect(rb.status).toBe(200);
    expect((await getAlop(B)).status).toBe('angajare');

    const ra = await getDetail(A);
    expect(ra.status).toBe(200);
    const a = await getAlop(A);
    expect(a.status).toBe('lichidare');
    expect(a.df_flow_id).toBe(flowId);
  });

  it('8 neregresie documente vechi: ORD aprobat FĂRĂ proveniență, un singur dosar ⇒ plata', async () => {
    const flowId = await seedFlow({ id: 'flow-219-c-legacy', completed: true, orgId: 1 });
    const A = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', titlu: 'A' });
    const ord = await seedOrdCuProvenienta({ sourceAlopId: null, flowId, status: 'aprobat' });
    await setOrd(A, ord);

    const ra = await getDetail(A);
    expect(ra.status).toBe(200);
    const a = await getAlop(A);
    expect(a.status).toBe('plata');
    expect(a.ord_flow_id).toBe(flowId);
  });
});

d('#219 D — resolveAlopIdForBudget: plafonul pe dosarul din proveniență', () => {
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', compartiment: 'Achizitii' });
    vi.clearAllMocks();
  });

  it('9a ⭐ două dosare pe același ORD curent (B creat primul), proveniența = A ⇒ A', async () => {
    const B = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', titlu: 'B' });
    const A = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', titlu: 'A' });
    const ord = await seedOrdCuProvenienta({ sourceAlopId: A });
    await setOrd(B, ord); await setOrd(A, ord);

    expect(await resolveAlopIdForBudget({ ordId: ord, orgId: 1 })).toBe(A);
  });

  it('9b ⭐ ORD doar în ciclurile ARHIVATE ale ambelor dosare (B primul), proveniența = A ⇒ A', async () => {
    const B = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', titlu: 'B', cicluCurent: 2 });
    const A = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', titlu: 'A', cicluCurent: 2 });
    const ord = await seedOrdCuProvenienta({ sourceAlopId: A });
    await insertCiclu({ alopId: B, ordId: ord, cicluNr: 1 });
    await insertCiclu({ alopId: A, ordId: ord, cicluNr: 1 });

    expect(await resolveAlopIdForBudget({ ordId: ord, orgId: 1 })).toBe(A);
  });

  it('9c neregresie: un singur dosar, ORD fără proveniență ⇒ acel dosar', async () => {
    const A = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', titlu: 'A' });
    const ord = await seedOrdCuProvenienta({ sourceAlopId: null });
    await setOrd(A, ord);
    expect(await resolveAlopIdForBudget({ ordId: ord, orgId: 1 })).toBe(A);
  });
});

d('#219 E — detecția: clasa document_alt_dosar în auditul de legături', () => {
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', compartiment: 'Achizitii' });
  });

  it('10a ⭐ ORD cu proveniență A, legat și de B ⇒ 1 rând, alop_id = B', async () => {
    const B = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', titlu: 'B' });
    const A = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', titlu: 'A' });
    const ord = await seedOrdCuProvenienta({ sourceAlopId: A, nrOrd: '47842' });
    await setOrd(B, ord); await setOrd(A, ord);

    const r = await findFlowLinkDivergences(pool, { orgId: 1 });
    expect(r.byClass.document_alt_dosar).toBe(1);
    const rows = r.rows.filter((x) => x.clasa === 'document_alt_dosar');
    expect(rows).toHaveLength(1);
    expect(rows[0].alop_id).toBe(B);
    expect(rows[0].tip).toBe('ord');
    expect(rows[0].doc_id).toBe(ord);
    expect(rows[0].doc_nr).toBe('47842');
  });

  it('10b ORD FĂRĂ proveniență pe A și B ⇒ 2 rânduri (ambele suspecte)', async () => {
    const B = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', titlu: 'B' });
    const A = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', titlu: 'A' });
    const ord = await seedOrdCuProvenienta({ sourceAlopId: null });
    await setOrd(B, ord); await setOrd(A, ord);

    const r = await findFlowLinkDivergences(pool, { orgId: 1 });
    expect(r.byClass.document_alt_dosar).toBe(2);
    const ids = r.rows.filter((x) => x.clasa === 'document_alt_dosar').map((x) => x.alop_id).sort();
    expect(ids).toEqual([A, B].sort());
  });

  it('10c DF cu proveniență A, legat și de B ⇒ 1 rând, alop_id = B; dosar anulat NU se numără', async () => {
    const B = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', titlu: 'B' });
    const A = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', titlu: 'A' });
    const Z = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', titlu: 'Z (anulat)', cancelledAt: new Date() });
    const df = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-219', sourceAlopId: A });
    await setDf(B, df); await setDf(A, df); await setDf(Z, df);

    const r = await findFlowLinkDivergences(pool, { orgId: 1 });
    expect(r.byClass.document_alt_dosar).toBe(1);
    const rows = r.rows.filter((x) => x.clasa === 'document_alt_dosar');
    expect(rows[0].alop_id).toBe(B);
    expect(rows[0].tip).toBe('df');
  });

  it('10d bază curată (fiecare document pe dosarul lui) ⇒ 0', async () => {
    const A = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', titlu: 'A' });
    const ord = await seedOrdCuProvenienta({ sourceAlopId: A });
    await setOrd(A, ord);
    const df = await seedDf({ orgId: 1, createdBy: 1, status: 'aprobat', nrUnic: 'DF-219', sourceAlopId: A });
    await setDf(A, df);
    // ORD legacy, pe un singur dosar — nu e divergență.
    const L = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', titlu: 'L' });
    const ordL = await seedOrdCuProvenienta({ sourceAlopId: null, nrOrd: 'ORD-L' });
    await setOrd(L, ordL);

    const r = await findFlowLinkDivergences(pool, { orgId: 1 });
    expect(r.byClass.document_alt_dosar).toBe(0);
  });

  it('11 byClass conține cheia document_alt_dosar chiar și când e 0', async () => {
    const r = await findFlowLinkDivergences(pool, { orgId: 1, limit: 0 });
    expect(r.byClass).toHaveProperty('document_alt_dosar', 0);
  });
});
