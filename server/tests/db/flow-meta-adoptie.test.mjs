/**
 * #222 — DB real: ADOPȚIA META la POST /flows pentru documentele generate de platformă.
 *
 * Incident (ORD 45301, 21.08–18.09.2026): fluxul a fost creat din ecranul de semnare FĂRĂ
 * contextul de prefill ⇒ `data.meta = {}` ⇒ invizibil pentru poarta #170, PASUL 3/4, garda
 * de reinițiere și auditul #120 (toate citesc `meta`). Documentul a stat „Completat" fără
 * să știe că e semnat, dosarul ALOP blocat în `ordonantare` 4 săptămâni.
 *
 * Fixul NU adaugă o a doua poartă: serverul recunoaște tiparul de nume pe care tot el îl
 * generează, identifică documentul după număr în org-ul actorului și scrie `body.meta`
 * ÎNAINTE de poarta #170 ⇒ cererea trece prin porțile existente. Fail-closed: 0 sau ≥2
 * potriviri ⇒ 409 `document_generat_neidentificat`.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { hasTestDb, migrate, truncateAll, pool, seedOrgUser, seedDf, seedOrd, makeAuthCookie } from '../helpers/db-real.mjs';

const flowsRouter = (await import('../../routes/flows.mjs')).default;
const { injectFlowDeps } = await import('../../routes/flows.mjs');

injectFlowDeps({
  newFlowId: () => `flow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  notify: async () => {},
  wsPush: () => {},
});

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use('/', flowsRouter);
  return app;
}

async function insertFlow({ orgId, meta = {}, status = 'pending', docName = 'Doc existent' }) {
  const fid = `flow-seed-${Math.random().toString(36).slice(2, 10)}`;
  const data = { docName, initName: 'Inițiator', initEmail: 'init@x.ro', signers: [], meta, status, completed: status === 'completed' };
  await pool.query(`INSERT INTO flows (id, data, org_id) VALUES ($1,$2::jsonb,$3)`, [fid, JSON.stringify(data), orgId]);
  return fid;
}

async function countFlows() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM flows');
  return rows[0].n;
}

async function readMeta(flowId) {
  const { rows } = await pool.query(`SELECT data->'meta' AS meta FROM flows WHERE id=$1`, [flowId]);
  return rows[0]?.meta ?? null;
}

// `meta` ABSENT din payload — exact ce trimite clientul când contextul de prefill s-a pierdut
// (main.js:2420 întoarce `undefined`).
const payload = (docName, meta) => ({
  docName,
  initName: 'Actor Test',
  initEmail: 'actor@x.ro',
  signers: [
    { order: 1, rol: 'ÎNTOCMIT', name: 'Actor Test', email: 'actor@x.ro' },
    { order: 2, rol: 'APROBAT', name: 'Semnatar Doi', email: 'semnatar2@x.ro' },
  ],
  ...(meta !== undefined ? { meta } : {}),
});

const d = describe.skipIf(!hasTestDb());

d('#222 — adopția meta din docName la POST /flows', () => {
  let app, orgId, actorId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    const o = await seedOrgUser({ email: 'actor@x.ro', role: 'user' });
    orgId = o.orgId; actorId = o.userId;
    app = buildApp();
  });
  afterAll(() => pool.end());

  const cookie = () => makeAuthCookie({ userId: actorId, role: 'user', orgId, email: 'actor@x.ro' });

  // ── ⭐ 1 — ORD existent, docName pe tipar, FĂRĂ meta ⇒ adopție + pointer + meta.ordId ──
  it('⭐ ORD existent + docName pe tipar + fără meta → flux creat, formulare_ord.flow_id setat, meta.ordId adoptat', async () => {
    const ord = await seedOrd({ orgId, createdBy: actorId, status: 'completed', nrOrd: '45301' });

    const res = await request(app).post('/flows').set('Cookie', cookie())
      .send(payload('OrdonantarePlata_45301_20260821.pdf'));

    expect(res.status).toBe(200);
    expect(res.body.flowId).toBeTruthy();

    const { rows } = await pool.query('SELECT flow_id FROM formulare_ord WHERE id=$1', [ord]);
    expect(rows[0].flow_id).toBe(res.body.flowId);            // PASUL 3 a rulat — pointerul e scris

    const meta = await readMeta(res.body.flowId);
    expect(meta.ordId).toBe(String(ord));                      // fluxul își declară documentul
    expect(meta.docType).toBe('ordnt');
    expect(meta.dfId).toBeUndefined();
  });

  // ── 1b — simetric pe DF ──────────────────────────────────────────────────────
  it('DF existent + docName pe tipar + fără meta → meta.dfId adoptat, formulare_df.flow_id setat', async () => {
    const df = await seedDf({ orgId, createdBy: actorId, status: 'completed', nrUnic: '6744' });

    const res = await request(app).post('/flows').set('Cookie', cookie())
      .send(payload('DocumentFundamentare_6744_20260707.pdf'));

    expect(res.status).toBe(200);
    const { rows } = await pool.query('SELECT flow_id FROM formulare_df WHERE id=$1', [df]);
    expect(rows[0].flow_id).toBe(res.body.flowId);
    const meta = await readMeta(res.body.flowId);
    expect(meta.dfId).toBe(String(df));
    expect(meta.docType).toBe('notafd');
  });

  // ── ⭐ 2 — ORD cu flux VIU ⇒ 409 de la poarta #170, NU o poartă nouă ─────────────
  it('⭐ ORD cu flux VIU + docName pe tipar + fără meta → 409 document_are_flux_viu (poarta #170, prin adopție)', async () => {
    const ord = await seedOrd({ orgId, createdBy: actorId, status: 'completed', nrOrd: '45301' });
    const vechi = await insertFlow({ orgId, meta: { ordId: String(ord), docType: 'ordnt' }, status: 'completed' });

    const inainte = await countFlows();
    const res = await request(app).post('/flows').set('Cookie', cookie())
      .send(payload('OrdonantarePlata_45301_20260821.pdf'));

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('document_are_flux_viu');    // dovada: cererea a ajuns pe drumul existent
    expect(res.body.existingFlowId).toBe(vechi);
    expect(await countFlows()).toBe(inainte);                  // niciun flux orfan
  });

  // ── ⭐ 3 — număr inexistent ⇒ 409 document_generat_neidentificat, gasite=0 ──────
  it('⭐ docName pe tipar cu număr INEXISTENT → 409 document_generat_neidentificat, gasite=0, `flows` NU crește', async () => {
    const inainte = await countFlows();
    const res = await request(app).post('/flows').set('Cookie', cookie())
      .send(payload('OrdonantarePlata_99999_20260821.pdf'));

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'document_generat_neidentificat', formType: 'ord', nr: '99999', gasite: 0 });
    expect(typeof res.body.message).toBe('string');
    expect(await countFlows()).toBe(inainte);
  });

  // ── ⭐ 4 — două DF-uri cu același nr_unic_inreg (cazul #126) ⇒ 409, gasite=2 ──────
  it('⭐ două DF-uri cu același nr_unic_inreg în aceeași org → 409 document_generat_neidentificat, gasite=2', async () => {
    await seedDf({ orgId, createdBy: actorId, status: 'completed', nrUnic: '6744' });
    await seedDf({ orgId, createdBy: actorId, status: 'completed', nrUnic: '6744' });

    const inainte = await countFlows();
    const res = await request(app).post('/flows').set('Cookie', cookie())
      .send(payload('DocumentFundamentare_6744_20260707.pdf'));

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'document_generat_neidentificat', formType: 'df', nr: '6744', gasite: 2 });
    expect(await countFlows()).toBe(inainte);
  });

  // ── 4b — documentul există, dar în ALTĂ organizație ⇒ 409, gasite=0 (scoping) ────
  it('documentul cu acel număr există doar în ALTĂ org → 409, gasite=0 (adopția e scoped pe org_id)', async () => {
    const o2 = await seedOrgUser({ email: 'strain@y.ro', role: 'user', orgName: 'Org 2' });
    await seedOrd({ orgId: o2.orgId, createdBy: o2.userId, status: 'completed', nrOrd: '45301' });

    const res = await request(app).post('/flows').set('Cookie', cookie())
      .send(payload('OrdonantarePlata_45301_20260821.pdf'));
    expect(res.status).toBe(409);
    expect(res.body.gasite).toBe(0);
  });

  // ── 4c — documentul e soft-șters ⇒ nu se adoptă (deleted_at IS NULL) ──────────────
  it('documentul cu acel număr e soft-șters → 409, gasite=0', async () => {
    const ord = await seedOrd({ orgId, createdBy: actorId, status: 'completed', nrOrd: '45301' });
    await pool.query('UPDATE formulare_ord SET deleted_at = NOW() WHERE id=$1', [ord]);

    const res = await request(app).post('/flows').set('Cookie', cookie())
      .send(payload('OrdonantarePlata_45301_20260821.pdf'));
    expect(res.status).toBe(409);
    expect(res.body.gasite).toBe(0);
  });

  // ── ⭐ 5 — docName ÎN AFARA tiparului ⇒ comportamentul vechi, neatins ──────────────
  it('⭐ docName în afara tiparului (contract-servicii.pdf) + fără meta → 200, meta = {} (comportament vechi neatins)', async () => {
    const res = await request(app).post('/flows').set('Cookie', cookie())
      .send(payload('contract-servicii.pdf'));

    expect(res.status).toBe(200);
    expect(await readMeta(res.body.flowId)).toEqual({});
  });

  // ── ⭐ 6 — meta.ordId trimis explicit ⇒ adopția NU rulează ─────────────────────────
  it('⭐ meta.ordId trimis explicit de client → adopția NU rulează, meta rămâne exact cea trimisă', async () => {
    // Un ORD cu numărul din docName EXISTĂ (ar fi candidat), dar clientul a trimis ALT ordId:
    // adopția nu are voie să suprascrie ce a declarat clientul.
    await seedOrd({ orgId, createdBy: actorId, status: 'completed', nrOrd: '45301' });
    const ordClient = await seedOrd({ orgId, createdBy: actorId, status: 'completed', nrOrd: 'ALT-1' });

    const metaClient = { ordId: String(ordClient), docType: 'ordnt' };
    const res = await request(app).post('/flows').set('Cookie', cookie())
      .send(payload('OrdonantarePlata_45301_20260821.pdf', metaClient));

    expect(res.status).toBe(200);
    expect(await readMeta(res.body.flowId)).toEqual(metaClient);
    const { rows } = await pool.query('SELECT flow_id FROM formulare_ord WHERE id=$1', [ordClient]);
    expect(rows[0].flow_id).toBe(res.body.flowId);            // pointerul e pe documentul DECLARAT
  });

  // ── 6b — meta.dfId explicit pe un docName de ORD ⇒ tot fără adopție ────────────────
  it('meta.dfId trimis explicit → adopția NU rulează chiar dacă docName e pe tipar ORD', async () => {
    await seedOrd({ orgId, createdBy: actorId, status: 'completed', nrOrd: '45301' });
    const df = await seedDf({ orgId, createdBy: actorId, status: 'completed', nrUnic: 'DF-X' });

    const metaClient = { dfId: String(df), docType: 'notafd' };
    const res = await request(app).post('/flows').set('Cookie', cookie())
      .send(payload('OrdonantarePlata_45301_20260821.pdf', metaClient));
    expect(res.status).toBe(200);
    expect(await readMeta(res.body.flowId)).toEqual(metaClient);
  });

  // ── 7 — urma de audit: FLOW_CREATED poartă metaAdoptat ─────────────────────────────
  it('FLOW_CREATED în audit_log poartă payload.metaAdoptat când adopția a rulat, și NU îl poartă altfel', async () => {
    const ord = await seedOrd({ orgId, createdBy: actorId, status: 'completed', nrOrd: '45301' });

    const r1 = await request(app).post('/flows').set('Cookie', cookie())
      .send(payload('OrdonantarePlata_45301_20260821.pdf'));
    expect(r1.status).toBe(200);
    // writeAuditEvent e fire-and-forget — așteptăm scrierea.
    await new Promise((r) => setTimeout(r, 150));
    const { rows: a1 } = await pool.query(
      `SELECT payload FROM audit_log WHERE flow_id=$1 AND event_type='FLOW_CREATED'`, [r1.body.flowId]);
    expect(a1.length).toBe(1);
    expect(a1[0].payload.metaAdoptat).toEqual({ formType: 'ord', nr: '45301', docId: String(ord) });

    const r2 = await request(app).post('/flows').set('Cookie', cookie())
      .send(payload('contract-servicii.pdf'));
    expect(r2.status).toBe(200);
    await new Promise((r) => setTimeout(r, 150));
    const { rows: a2 } = await pool.query(
      `SELECT payload FROM audit_log WHERE flow_id=$1 AND event_type='FLOW_CREATED'`, [r2.body.flowId]);
    expect(a2.length).toBe(1);
    expect(a2[0].payload.metaAdoptat).toBeUndefined();
  });
});
