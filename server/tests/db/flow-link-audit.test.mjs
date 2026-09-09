/**
 * #120 — Detecția divergențelor document↔flux (flow-link-audit) + garda la creare
 * (PAS 3) + igiena stării anulate (PAS 4).
 *
 * Trei incidente în șase zile, aceeași familie: „un document semnat care nu știe că
 * e semnat". Testele acoperă cele patru clase de detecție, filtrul de org, garda din
 * crud.mjs (nu se mai suprascrie orb flow_id la dublu-click) și helper-ul de igienă.
 *
 * ⛔ IMPORTĂ din producție — nu redeclară logica.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import {
  hasTestDb, migrate, truncateAll, pool,
  seedOrgUser, seedDf, seedOrd, seedAlop, getDf, makeAuthCookie,
} from '../helpers/db-real.mjs';

// Mock-uri ortogonale (NU db) — aceeași strategie ca helpers/app.mjs.
vi.mock('../../middleware/csrf.mjs', () => ({ csrfMiddleware: (_req, _res, next) => next() }));
vi.mock('../../middleware/require-module.mjs', () => ({
  requireModule: () => (_req, _res, next) => next(),
  default: () => (_req, _res, next) => next(),
}));
vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  redactUrl: (u) => u,
}));

const { findFlowLinkDivergences } = await import('../../services/flow-link-audit.mjs');
const { sanitizeCancelledCompletion, isFullySigned } = await import('../../services/flow-completion.mjs');
const crudMod = await import('../../routes/flows/crud.mjs');
const lifecycleMod = await import('../../routes/flows/lifecycle.mjs');

let _flowSeq = 0;
crudMod._injectDeps({
  notify: async () => {}, fireWebhook: null, wsPush: () => {},
  PDFLib: null, stampFooterOnPdf: null, isSignerTokenExpired: () => false,
  newFlowId: () => `flow-new-${++_flowSeq}`, buildSignerLink: () => '', stripSensitive: (x) => x,
  stripPdfB64: (x) => x, sendSignerEmail: async () => {},
});
lifecycleMod._injectDeps({ notify: async () => {}, fireWebhook: null, wsPush: () => {} });

// Inserează un flux cu control total pe status/meta/deleted (seedFlow nu expune meta/cancelled).
async function insertFlow(id, { orgId = 1, status = 'active', completed = false, completedAt = null, deletedAt = null, meta = null, initEmail = 'init@x.ro', signers = [] } = {}) {
  const data = { flowId: id, docName: 'Doc', initName: 'Init', initEmail, signers, status };
  if (completed) data.completed = true;
  if (completedAt != null) data.completedAt = completedAt;
  if (meta) data.meta = meta;
  await pool.query(
    `INSERT INTO flows (id, data, org_id, deleted_at) VALUES ($1, $2::jsonb, $3, $4)`,
    [id, JSON.stringify(data), orgId, deletedAt]
  );
  return id;
}
async function readFlow(id) {
  const { rows } = await pool.query('SELECT data FROM flows WHERE id=$1', [id]);
  return rows[0]?.data || null;
}

const d = describe.skipIf(!hasTestDb());

// Un singur cleanup de pool pentru tot fișierul (3 describe-uri) — pool.end() per-describe
// ar închide pool-ul după primul bloc și ar rupe restul.
afterAll(() => pool.end());

// ═══════════════════════════════════════════════════════════════════════════════
// PAS 1 — detecție (cele 4 clase + org scoping)
// ═══════════════════════════════════════════════════════════════════════════════
d('flow-link-audit — detecția divergențelor', () => {
  let orgId, userId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    const s = await seedOrgUser({ role: 'user', email: 'p1@x.ro' });
    orgId = s.orgId; userId = s.userId;
  });

  it('(1) Clasa A — DF fără flow_id + flux valid semnat care-l revendică ⇒ detectat', async () => {
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'completed', flowId: null });
    await insertFlow('flow-a', { orgId, status: 'completed', meta: { dfId } });

    const r = await findFlowLinkDivergences(pool, { orgId, limit: 200 });
    expect(r.byClass.doc_fara_flux).toBe(1);
    const row = r.rows.find(x => x.clasa === 'doc_fara_flux');
    expect(row.tip).toBe('df');
    expect(row.doc_id).toBe(String(dfId));
    expect(row.flux).toBe('flow-a');
  });

  it('(2) Clasa A NEGATIV — flux ANULAT cu completed=true (PZ_8C34C4E842) ⇒ NU e detectat', async () => {
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'completed', flowId: null });
    await insertFlow('flow-cancel-completed', { orgId, status: 'cancelled', completed: true, meta: { dfId } });

    const r = await findFlowLinkDivergences(pool, { orgId, limit: 200 });
    expect(r.byClass.doc_fara_flux).toBe(0);
    expect(r.total).toBe(0);
  });

  it('(3) Clasa B — ORD pe flux semnat, alop.ord_flow_id NULL ⇒ detectat', async () => {
    await insertFlow('flow-b', { orgId, status: 'completed' });
    const ordId = await seedOrd({ orgId, createdBy: userId, status: 'completed', flowId: 'flow-b' });
    const alopId = await seedAlop({ orgId, createdBy: userId, status: 'ordonantare', ordId, ordFlowId: null });

    const r = await findFlowLinkDivergences(pool, { orgId, limit: 200 });
    expect(r.byClass.alop_fara_flux).toBe(1);
    const row = r.rows.find(x => x.clasa === 'alop_fara_flux');
    expect(row.tip).toBe('ord');
    expect(row.doc_id).toBe(String(ordId));
    expect(row.alop_id).toBe(String(alopId));
    expect(row.flux).toBe('flow-b');
  });

  it('(4) Clasa C — ALOP cu df_id NULL + DF cu source_alop_id ⇒ detectat', async () => {
    const alopId = await seedAlop({ orgId, createdBy: userId, status: 'draft', dfId: null });
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'draft' });
    await pool.query('UPDATE formulare_df SET source_alop_id=$1 WHERE id=$2', [alopId, dfId]);

    const r = await findFlowLinkDivergences(pool, { orgId, limit: 200 });
    expect(r.byClass.alop_fara_document).toBe(1);
    const row = r.rows.find(x => x.clasa === 'alop_fara_document');
    expect(row.tip).toBe('df');
    expect(row.doc_id).toBe(String(dfId));
    expect(row.alop_id).toBe(String(alopId));
  });

  it('(5) Clasa D — două fluxuri vii pe același doc ⇒ detectat; unul viu + unul șters ⇒ NU', async () => {
    // Scenariu detectabil: două fluxuri vii pe doc-par-1.
    await insertFlow('flow-par-1a', { orgId, status: 'active', meta: { dfId: 'doc-par-1' } });
    await insertFlow('flow-par-1b', { orgId, status: 'active', meta: { dfId: 'doc-par-1' } });
    // Scenariu NEdetectabil: unul viu + unul șters pe doc-par-2.
    await insertFlow('flow-par-2a', { orgId, status: 'active', meta: { dfId: 'doc-par-2' } });
    await insertFlow('flow-par-2b', { orgId, status: 'active', deletedAt: new Date().toISOString(), meta: { dfId: 'doc-par-2' } });

    const r = await findFlowLinkDivergences(pool, { orgId, limit: 200 });
    expect(r.byClass.fluxuri_paralele).toBe(1); // doar doc-par-1
    const row = r.rows.find(x => x.clasa === 'fluxuri_paralele');
    expect(row.doc_id).toBe('doc-par-1');
    expect(row.flux).toContain('flow-par-1a');
    expect(row.flux).toContain('flow-par-1b');
  });

  it('(6) Bază curată (documente legate corect) ⇒ total = 0', async () => {
    await insertFlow('flow-ok', { orgId, status: 'completed' });
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'completed', flowId: 'flow-ok' });
    await seedAlop({ orgId, createdBy: userId, status: 'lichidare', dfId, dfFlowId: 'flow-ok' });

    const r = await findFlowLinkDivergences(pool, { orgId, limit: 200 });
    expect(r.total).toBe(0);
    expect(r.rows).toHaveLength(0);
  });

  it('(7) orgId respectat — divergențele org B nu apar la interogarea pe org A', async () => {
    const b = await seedOrgUser({ orgName: 'Org B', role: 'user', email: 'b@x.ro' });
    // Divergență clasa A în org B.
    const dfB = await seedDf({ orgId: b.orgId, createdBy: b.userId, status: 'completed', flowId: null });
    await insertFlow('flow-b-org', { orgId: b.orgId, status: 'completed', meta: { dfId: dfB } });

    const onA = await findFlowLinkDivergences(pool, { orgId, limit: 200 });
    expect(onA.total).toBe(0);
    const onB = await findFlowLinkDivergences(pool, { orgId: b.orgId, limit: 200 });
    expect(onB.total).toBe(1);
    const all = await findFlowLinkDivergences(pool, { orgId: null, limit: 200 });
    expect(all.total).toBe(1);
  });

  it('(extra) limit:0 ⇒ numărătoare fără rânduri', async () => {
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'completed', flowId: null });
    await insertFlow('flow-a0', { orgId, status: 'completed', meta: { dfId } });
    const r = await findFlowLinkDivergences(pool, { orgId, limit: 0 });
    expect(r.total).toBe(1);
    expect(r.rows).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PAS 3 — garda la creare (crud.mjs pre-set flow_id nu mai suprascrie orb)
// ═══════════════════════════════════════════════════════════════════════════════
d('PAS 3 — garda pre-set flow_id la creare flux', () => {
  let app, orgId, userId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    const s = await seedOrgUser({ role: 'user', email: 'p1@x.ro' });
    orgId = s.orgId; userId = s.userId;
    const a = express();
    a.set('trust proxy', 1);
    a.use(express.json({ limit: '50mb' }));
    a.use(cookieParser());
    a.use('/', crudMod.default);
    app = a;
  });
  const cookie = () => makeAuthCookie({ userId, role: 'user', orgId, email: 'p1@x.ro' });
  const postFlow = (dfId) => request(app).post('/flows').set('Cookie', cookie()).send({
    docName: 'Doc test', initName: 'Initiator', initEmail: 'ini@x.ro',
    signers: [{ name: 'Semnatar Extern', email: 'extern@example.com', order: 1, rol: 'APROBAT' }],
    meta: { dfId }, flowType: 'tabel',
  });

  it('(8a) document pe flux VIU ⇒ flow_id rămâne pe fluxul vechi; fluxul nou se creează', async () => {
    await insertFlow('old-live', { orgId, status: 'active' }); // flux viu (nefinalizat, neanulat)
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'transmis_flux', flowId: 'old-live' });

    const res = await postFlow(dfId);
    expect(res.status).toBe(200);
    expect(res.body.flowId).toBeTruthy();        // fluxul nou s-a creat
    const df = await getDf(dfId);
    expect(df.flow_id).toBe('old-live');          // documentul a rămas agățat de fluxul vechi
  });

  it('(8b) document pe flux ANULAT ⇒ documentul e preluat de fluxul nou', async () => {
    await insertFlow('old-cancelled', { orgId, status: 'cancelled' });
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'transmis_flux', flowId: 'old-cancelled' });

    const res = await postFlow(dfId);
    expect(res.status).toBe(200);
    const df = await getDf(dfId);
    expect(df.flow_id).toBe(res.body.flowId);     // fluxul mort a fost înlocuit de cel nou
    expect(df.flow_id).not.toBe('old-cancelled');
  });

  it('(8c) document LIBER (flow_id NULL) ⇒ preluat de fluxul nou (non-regresie)', async () => {
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'completed', flowId: null });
    const res = await postFlow(dfId);
    expect(res.status).toBe(200);
    const df = await getDf(dfId);
    expect(df.flow_id).toBe(res.body.flowId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PAS 4 — igiena stării anulate (helper pur + rută cancel)
// ═══════════════════════════════════════════════════════════════════════════════
d('PAS 4 — igiena completed la anulare', () => {
  let app, orgId, userId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    const s = await seedOrgUser({ role: 'user', email: 'p1@x.ro' });
    orgId = s.orgId; userId = s.userId;
    const a = express();
    a.set('trust proxy', 1);
    a.use(express.json({ limit: '50mb' }));
    a.use(cookieParser());
    a.use('/', lifecycleMod.default);
    app = a;
  });

  it('(9a) helper — anulare cu 0/5 semnături + completed=true ⇒ completed=false', () => {
    const data = { completed: true, completedAt: '2026-01-01T00:00:00Z',
      signers: [{ status: 'pending' }, { status: 'pending' }, { status: 'pending' }, { status: 'pending' }, { status: 'pending' }] };
    const changed = sanitizeCancelledCompletion(data);
    expect(changed).toBe(true);
    expect(data.completed).toBe(false);
    expect(data.completedAt).toBeNull();
  });

  it('(9b) helper — flux complet semnat ⇒ completed rămâne true (nu rescrie istoria)', () => {
    const data = { completed: true, completedAt: '2026-01-01T00:00:00Z',
      signers: [{ status: 'signed', pdfUploaded: true }, { status: 'signed', pdfUploaded: true }] };
    expect(isFullySigned(data)).toBe(true);
    const changed = sanitizeCancelledCompletion(data);
    expect(changed).toBe(false);
    expect(data.completed).toBe(true);
    expect(data.completedAt).toBe('2026-01-01T00:00:00Z');
  });

  it('(9c) rută cancel — flux activ neparafat ⇒ completedAt curățat la anulare', async () => {
    await insertFlow('flow-hyg', { orgId, status: 'active', completed: false, completedAt: '2026-01-01T00:00:00Z',
      initEmail: 'p1@x.ro', signers: [{ status: 'pending' }] });
    const res = await request(app).post('/flows/flow-hyg/cancel')
      .set('Cookie', makeAuthCookie({ userId, role: 'user', orgId, email: 'p1@x.ro' }))
      .send({ reason: 'test' });
    expect(res.status).toBe(200);
    const d2 = await readFlow('flow-hyg');
    expect(d2.status).toBe('cancelled');
    expect(!!d2.completed).toBe(false);
    expect(d2.completedAt).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// #190 — clasa E `pointer_alt_flux`: pointerul documentului e NON-NULL, dar nu e
// pe un flux valid semnat, în timp ce ALT flux valid semnat revendică documentul.
// (DF 45748, 01.09.2026 — dublă lansare, anulat fluxul pe care stătea pointerul.)
// ═══════════════════════════════════════════════════════════════════════════════
d('#190 — clasa E: pointer pe alt flux decât cel semnat', () => {
  let orgId, userId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    const s = await seedOrgUser({ role: 'user', email: 'p1@x.ro' });
    orgId = s.orgId; userId = s.userId;
  });

  it('(E1) ⭐ DF 45748 reprodus — pointer pe flux ANULAT + flux semnat care revendică ⇒ detectat', async () => {
    // Pointerul poartă și el meta.dfId (starea reală după prima lansare) — self-join-ul
    // `fv.id <> d.flow_id` trebuie să-l excludă ca revendicator.
    await insertFlow('PZ_01BA62F89A', { orgId, status: 'cancelled' });
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'completed', flowId: 'PZ_01BA62F89A' });
    await pool.query(`UPDATE flows SET data = jsonb_set(data, '{meta}', $2::jsonb) WHERE id=$1`,
      ['PZ_01BA62F89A', JSON.stringify({ dfId })]);
    await insertFlow('PZ_3E88B4147C', { orgId, status: 'completed', completed: true, meta: { dfId } });

    const r = await findFlowLinkDivergences(pool, { orgId, limit: 200 });
    expect(r.byClass.pointer_alt_flux).toBe(1);
    const row = r.rows.find(x => x.clasa === 'pointer_alt_flux');
    expect(row.tip).toBe('df');
    expect(row.doc_id).toBe(String(dfId));
    expect(row.flux).toBe('PZ_3E88B4147C');   // fluxul SEMNAT, nu pointerul mort
  });

  it('(E2) ⭐⭐ NEGATIV CRUCIAL — pointer pe flux ANULAT, NICIUN flux semnat care să revendice ⇒ NU e detectat', async () => {
    // Starea NORMALĂ după orice anulare: pointerul rămâne ca proveniență. Dacă testul
    // ăsta pică, clasa raportează sute de cazuri legitime și cardul devine zgomot.
    await insertFlow('flow-anulat-simplu', { orgId, status: 'cancelled' });
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'completed', flowId: 'flow-anulat-simplu' });
    await pool.query(`UPDATE flows SET data = jsonb_set(data, '{meta}', $2::jsonb) WHERE id=$1`,
      ['flow-anulat-simplu', JSON.stringify({ dfId })]);

    const r = await findFlowLinkDivergences(pool, { orgId, limit: 200 });
    expect(r.byClass.pointer_alt_flux).toBe(0);
    expect(r.total).toBe(0);
  });

  it('(E3) NEGATIV — pointer pe flux valid semnat (stare sănătoasă) + un flux vechi anulat care revendică ⇒ nedetectat', async () => {
    await insertFlow('flow-sanatos', { orgId, status: 'completed' });
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'completed', flowId: 'flow-sanatos' });
    await pool.query(`UPDATE flows SET data = jsonb_set(data, '{meta}', $2::jsonb) WHERE id=$1`,
      ['flow-sanatos', JSON.stringify({ dfId })]);
    await insertFlow('flow-vechi-anulat', { orgId, status: 'cancelled', meta: { dfId } });

    const r = await findFlowLinkDivergences(pool, { orgId, limit: 200 });
    expect(r.byClass.pointer_alt_flux).toBe(0);
    expect(r.total).toBe(0);
  });

  it('(E4) NEGATIV — revendicatorul e ANULAT dar păstrează completed=true (PZ_8C34C4E842) ⇒ nedetectat', async () => {
    await insertFlow('flow-ptr-mort', { orgId, status: 'cancelled' });
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'completed', flowId: 'flow-ptr-mort' });
    await insertFlow('PZ_8C34C4E842', { orgId, status: 'cancelled', completed: true, meta: { dfId } });

    const r = await findFlowLinkDivergences(pool, { orgId, limit: 200 });
    expect(r.byClass.pointer_alt_flux).toBe(0);
    expect(r.total).toBe(0);
  });

  it('(E5) ⭐ pointer pe flux FĂRĂ cheia `completed` (status active) + flux semnat care revendică ⇒ detectat', async () => {
    // Apărătorul lui `IS NOT TRUE`: predicatul întoarce NULL pe fluxul ăsta, iar
    // `NOT (…)` ar fi tot NULL ⇒ rândul ar dispărea TĂCUT din WHERE.
    await insertFlow('flow-fara-completed', { orgId, status: 'active' });
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'transmis_flux', flowId: 'flow-fara-completed' });
    const { rows: pf } = await pool.query(`SELECT data ? 'completed' AS are FROM flows WHERE id='flow-fara-completed'`);
    expect(pf[0].are).toBe(false);   // fixtura chiar NU are cheia
    await insertFlow('flow-semnat-e5', { orgId, status: 'completed', completed: true, meta: { dfId } });

    const r = await findFlowLinkDivergences(pool, { orgId, limit: 200 });
    expect(r.byClass.pointer_alt_flux).toBe(1);
    const row = r.rows.find(x => x.clasa === 'pointer_alt_flux');
    expect(row.doc_id).toBe(String(dfId));
    expect(row.flux).toBe('flow-semnat-e5');
  });

  it('(E6) ORD, simetric — pointer pe flux anulat + flux semnat care revendică prin meta.ordId ⇒ detectat', async () => {
    await insertFlow('flow-ord-anulat', { orgId, status: 'cancelled' });
    const ordId = await seedOrd({ orgId, createdBy: userId, status: 'completed', flowId: 'flow-ord-anulat' });
    await insertFlow('flow-ord-semnat', { orgId, status: 'completed', completed: true, meta: { ordId } });

    const r = await findFlowLinkDivergences(pool, { orgId, limit: 200 });
    expect(r.byClass.pointer_alt_flux).toBe(1);
    const row = r.rows.find(x => x.clasa === 'pointer_alt_flux');
    expect(row.tip).toBe('ord');
    expect(row.doc_id).toBe(String(ordId));
    expect(row.flux).toBe('flow-ord-semnat');
  });

  it('(E7) disjuncție față de clasa A — pointer NULL ⇒ doar doc_fara_flux, pointer_alt_flux = 0', async () => {
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'completed', flowId: null });
    await insertFlow('flow-a-disj', { orgId, status: 'completed', meta: { dfId } });

    const r = await findFlowLinkDivergences(pool, { orgId, limit: 200 });
    expect(r.byClass.doc_fara_flux).toBe(1);
    expect(r.byClass.pointer_alt_flux).toBe(0);
    expect(r.total).toBe(1);
  });

  it('(E8) orgId respectat — divergența clasei E din org B nu apare la interogarea pe org A', async () => {
    const b = await seedOrgUser({ orgName: 'Org B', role: 'user', email: 'b@x.ro' });
    await insertFlow('flow-b-anulat', { orgId: b.orgId, status: 'cancelled' });
    const dfB = await seedDf({ orgId: b.orgId, createdBy: b.userId, status: 'completed', flowId: 'flow-b-anulat' });
    await insertFlow('flow-b-semnat', { orgId: b.orgId, status: 'completed', completed: true, meta: { dfId: dfB } });

    const onA = await findFlowLinkDivergences(pool, { orgId, limit: 200 });
    expect(onA.byClass.pointer_alt_flux).toBe(0);
    expect(onA.total).toBe(0);
    const onB = await findFlowLinkDivergences(pool, { orgId: b.orgId, limit: 200 });
    expect(onB.byClass.pointer_alt_flux).toBe(1);
  });
});
