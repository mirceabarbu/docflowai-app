/**
 * #170 — DB real: poarta de lansare. Un document (DF sau ORD) nu mai poate avea DOUĂ fluxuri VII.
 *
 * Context: până la #170, a doua lansare pe același document crea fluxul oricum, iar pointerul
 * `formulare_X.flow_id` rămânea pe primul flux (blocul PASUL 3 refuza mutarea, cu un simplu
 * `logger.warn`). La finalizarea fluxului al doilea, `finalizeDfOnFlowCompleted` (WHERE flow_id=$1)
 * găsea ZERO rânduri ⇒ document neaprobat definitiv, fără eroare (DF 45749).
 *
 * Poarta se așază ÎNAINTE de crearea fluxului ⇒ miezul lotului e că `flows` NU crește la refuz.
 * Predicatul e `liveFlowSql` (flow-provenance.mjs): un flux `completed` E viu (ORD 44269 avea
 * două fluxuri amândouă finalizate); `cancelled`/`refused`/soft-șters NU sunt.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
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

// Flux „brut": control total pe status / deleted_at / meta / org — seedFlow nu expune
// cancelled/refused/soft-delete, iar exact acelea sunt cazurile care trebuie să TREACĂ.
async function insertFlow({ id, orgId, metaKey, docId, status = 'pending', deletedAt = null, signers = [] }) {
  const fid = id || `flow-seed-${Math.random().toString(36).slice(2, 10)}`;
  const data = {
    docName: 'Doc existent',
    initName: 'Inițiator',
    initEmail: 'init@x.ro',
    signers,
    meta: metaKey ? { [metaKey]: String(docId) } : {},
    status,
    completed: status === 'completed',
  };
  await pool.query(
    `INSERT INTO flows (id, data, org_id, deleted_at) VALUES ($1,$2::jsonb,$3,$4)`,
    [fid, JSON.stringify(data), orgId, deletedAt]
  );
  return fid;
}

async function countFlows() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM flows');
  return rows[0].n;
}

const payload = (meta) => ({
  docName: 'Document nou',
  initName: 'Actor Test',
  initEmail: 'actor@x.ro',
  signers: [
    { order: 1, rol: 'ÎNTOCMIT', name: 'Actor Test', email: 'actor@x.ro' },
    { order: 2, rol: 'APROBAT', name: 'Semnatar Doi', email: 'semnatar2@x.ro' },
  ],
  meta,
});

const d = describe.skipIf(!hasTestDb());

d('#170 — poarta de lansare: un document nu poate avea două fluxuri vii', () => {
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

  // ── ⭐ 1 — DF cu flux ACTIV ⇒ 409 și ZERO rânduri noi în `flows` ──────────────
  it('⭐ DF cu flux ACTIV → a doua lansare 409 document_are_flux_viu, `flows` NU crește', async () => {
    const df = await seedDf({ orgId, createdBy: actorId, status: 'completed', nrUnic: 'DF-170-1' });
    const vechi = await insertFlow({
      orgId, metaKey: 'dfId', docId: df, status: 'pending',
      signers: [{ email: 'a@x.ro', status: 'signed' }, { email: 'b@x.ro', status: 'current' }],
    });

    const inainte = await countFlows();
    const res = await request(app).post('/flows').set('Cookie', cookie()).send(payload({ dfId: df, docType: 'notafd' }));
    const dupa = await countFlows();

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('document_are_flux_viu');
    expect(res.body.existingFlowId).toBe(vechi);
    expect(dupa).toBe(inainte); // MIEZUL: niciun flux orfan creat
  });

  // ── ⭐ 2 — ORD, simetric ─────────────────────────────────────────────────────
  it('⭐ ORD cu flux ACTIV → 409, `flows` NU crește', async () => {
    const ord = await seedOrd({ orgId, createdBy: actorId, status: 'completed', nrOrd: 'ORD-170-1' });
    await insertFlow({ orgId, metaKey: 'ordId', docId: ord, status: 'pending' });

    const inainte = await countFlows();
    const res = await request(app).post('/flows').set('Cookie', cookie()).send(payload({ ordId: ord, docType: 'ordnt' }));
    const dupa = await countFlows();

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('document_are_flux_viu');
    expect(res.body.formType).toBe('ord');
    expect(dupa).toBe(inainte);
  });

  // ── ⭐ 3 — flux FINALIZAT (nu anulat) ⇒ tot 409 (cazul ORD 44269) ────────────
  it('⭐ document cu flux FINALIZAT → tot 409 (un flux completed E viu — cazul ORD 44269)', async () => {
    const df = await seedDf({ orgId, createdBy: actorId, status: 'completed', nrUnic: 'DF-170-2' });
    await insertFlow({ orgId, metaKey: 'dfId', docId: df, status: 'completed' });

    const inainte = await countFlows();
    const res = await request(app).post('/flows').set('Cookie', cookie()).send(payload({ dfId: df }));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('document_are_flux_viu');
    expect(res.body.existingFlowStatus).toBe('completed');
    expect(await countFlows()).toBe(inainte);
  });

  // ── 4 — flux ANULAT ⇒ lansarea REUȘEȘTE, pointerul se mută ───────────────────
  it('flux ANULAT → lansarea reușește și formulare_df.flow_id devine noul flux (tiparul „anulezi, apoi lansezi")', async () => {
    const vechi = await insertFlow({ orgId, metaKey: 'dfId', docId: '00000000-0000-0000-0000-000000000000', status: 'cancelled' });
    const df = await seedDf({ orgId, createdBy: actorId, status: 'completed', flowId: vechi, nrUnic: 'DF-170-3' });
    await pool.query(`UPDATE flows SET data = jsonb_set(data,'{meta,dfId}', to_jsonb($2::text)) WHERE id=$1`, [vechi, df]);

    const res = await request(app).post('/flows').set('Cookie', cookie()).send(payload({ dfId: df }));
    expect(res.status).toBe(200);
    expect(res.body.flowId).toBeTruthy();

    const { rows } = await pool.query('SELECT flow_id FROM formulare_df WHERE id=$1', [df]);
    expect(rows[0].flow_id).toBe(res.body.flowId); // pointerul s-a mutat pe fluxul NOU
  });

  // ── 5 — flux REFUZAT ⇒ reinițiere legitimă ──────────────────────────────────
  it('flux REFUZAT → lansarea reușește (reinițiere legitimă după refuz)', async () => {
    const df = await seedDf({ orgId, createdBy: actorId, status: 'completed', nrUnic: 'DF-170-4' });
    await insertFlow({ orgId, metaKey: 'dfId', docId: df, status: 'refused' });

    const res = await request(app).post('/flows').set('Cookie', cookie()).send(payload({ dfId: df }));
    expect(res.status).toBe(200);
  });

  // ── 6 — flux SOFT-ȘTERS ⇒ reușește ──────────────────────────────────────────
  it('flux SOFT-ȘTERS → lansarea reușește', async () => {
    const df = await seedDf({ orgId, createdBy: actorId, status: 'completed', nrUnic: 'DF-170-5' });
    await insertFlow({ orgId, metaKey: 'dfId', docId: df, status: 'pending', deletedAt: new Date() });

    const res = await request(app).post('/flows').set('Cookie', cookie()).send(payload({ dfId: df }));
    expect(res.status).toBe(200);
  });

  // ── 7 — fără niciun flux ⇒ calea normală, neatinsă ──────────────────────────
  it('document fără niciun flux → lansarea reușește (calea normală)', async () => {
    const df = await seedDf({ orgId, createdBy: actorId, status: 'completed', nrUnic: 'DF-170-6' });
    const res = await request(app).post('/flows').set('Cookie', cookie()).send(payload({ dfId: df }));
    expect(res.status).toBe(200);
    const { rows } = await pool.query('SELECT flow_id FROM formulare_df WHERE id=$1', [df]);
    expect(rows[0].flow_id).toBe(res.body.flowId);
  });

  // ── ⭐ 8 — fluxul viu al ALTUI document nu blochează ─────────────────────────
  it('⭐ fluxul viu al ALTUI document nu blochează lansarea (poarta e cheiată pe meta.dfId)', async () => {
    const dfAltul = await seedDf({ orgId, createdBy: actorId, status: 'completed', nrUnic: 'DF-170-7a' });
    const dfNostru = await seedDf({ orgId, createdBy: actorId, status: 'completed', nrUnic: 'DF-170-7b' });
    await insertFlow({ orgId, metaKey: 'dfId', docId: dfAltul, status: 'pending' });

    const res = await request(app).post('/flows').set('Cookie', cookie()).send(payload({ dfId: dfNostru }));
    expect(res.status).toBe(200);
  });

  // ── ⭐ 9 — scoping pe organizație ────────────────────────────────────────────
  it('⭐ fluxul viu al ALTEI organizații (același meta.dfId) NU blochează — poarta e scoped pe org_id', async () => {
    const df = await seedDf({ orgId, createdBy: actorId, status: 'completed', nrUnic: 'DF-170-8' });
    // Aceeași cheie meta.dfId, dar org_id diferit (org 2, creată separat).
    const o2 = await seedOrgUser({ email: 'strain@y.ro', role: 'user', orgName: 'Org 2' });
    await insertFlow({ orgId: o2.orgId, metaKey: 'dfId', docId: df, status: 'pending' });

    const res = await request(app).post('/flows').set('Cookie', cookie()).send(payload({ dfId: df }));
    expect(res.status).toBe(200);
  });

  // ── 10 — corpul răspunsului 409 ─────────────────────────────────────────────
  it('corpul 409 conține id-ul fluxului existent, statusul, data și numărul de semnături puse', async () => {
    const df = await seedDf({ orgId, createdBy: actorId, status: 'completed', nrUnic: 'DF-170-9' });
    const vechi = await insertFlow({
      orgId, metaKey: 'dfId', docId: df, status: 'pending',
      signers: [
        { email: 'a@x.ro', status: 'signed' },
        { email: 'b@x.ro', status: 'signed' },
        { email: 'c@x.ro', status: 'current' },
      ],
    });

    const res = await request(app).post('/flows').set('Cookie', cookie()).send(payload({ dfId: df }));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: 'document_are_flux_viu',
      formType: 'df',
      formId: String(df),
      existingFlowId: vechi,
      existingFlowStatus: 'pending',
      semnate: 2,
      totalSemnatari: 3,
    });
    expect(typeof res.body.message).toBe('string');
    expect(res.body.existingFlowCreatedAt).toBeTruthy();
  });
});

// ── C.3 — anti-regresie pe predicat (analiză statică, rulează și fără DB) ──────
const __dir = dirname(fileURLToPath(import.meta.url));
const crudSrc = readFileSync(join(__dir, '../../routes/flows/crud.mjs'), 'utf8');

describe('#170 — poarta folosește liveFlowSql (sursă unică), nu un predicat scris de mână', () => {
  it('crud.mjs importă liveFlowSql din services/flow-provenance.mjs', () => {
    expect(crudSrc).toMatch(/import\s*\{[^}]*liveFlowSql[^}]*\}\s*from\s*'\.\.\/\.\.\/services\/flow-provenance\.mjs'/);
  });

  it('blocul porții interpolează liveFlowSql, iar predicatul NU e rescris literal în crud.mjs', () => {
    expect(crudSrc).toMatch(/\$\{liveFlowSql\('f'\)\}/);
    // A cincea copie a predicatului = drift garantat: blocul porții NU are voie să-l
    // rescrie literal. (În PASUL 3 literalul rămâne intenționat — e un UPDATE atomic,
    // nu un SELECT; iar filtrele de listare de la /flows sunt cu totul alt predicat.)
    const poarta = crudSrc.slice(crudSrc.indexOf('POARTA DE LANSARE'), crudSrc.indexOf('PASUL 3: Leagă flow_id'));
    expect(poarta).not.toContain("IS DISTINCT FROM 'cancelled'");
    // `validSignedFlowSql` e alt predicat („valid semnat") — poarta NU-l APELEAZĂ.
    // (Numele apare în comentariul de avertizare al blocului; contează apelul.)
    expect(poarta).not.toMatch(/validSignedFlowSql\s*\(/);
  });

  it('poarta cheiază pe data->meta->>dfId/ordId, nu pe formulare_df.flow_id', () => {
    const poarta = crudSrc.slice(crudSrc.indexOf('POARTA DE LANSARE'), crudSrc.indexOf('PASUL 3: Leagă flow_id'));
    expect(poarta).toContain("f.data->'meta'->>'${col}'");
    expect(poarta).toContain('f.org_id = $1');
  });
});

// ── C.2 — cablarea din frontend (singurul apelant POST /flows) ─────────────────
const initiatorSrc = readFileSync(join(__dir, '../../../public/js/semdoc-initiator/main.js'), 'utf8');

describe('#170 — frontend tratează 409 document_are_flux_viu', () => {
  it('semdoc-initiator/main.js ramifică pe codul nou ÎNAINTE de throw-ul generic', () => {
    expect(initiatorSrc).toContain('document_are_flux_viu');
    const idxGate = initiatorSrc.indexOf('document_are_flux_viu');
    const idxThrow = initiatorSrc.indexOf('throw new Error(j?.error || "server_error")');
    expect(idxGate).toBeGreaterThan(-1);
    expect(idxThrow).toBeGreaterThan(idxGate); // altfel 409-ul ar cădea pe eroarea generică
  });

  it('mesajul spune ce s-a întâmplat, starea fluxului și ce are de făcut utilizatorul', () => {
    const bloc = initiatorSrc.slice(initiatorSrc.indexOf('document_are_flux_viu'), initiatorSrc.indexOf('document_are_flux_viu') + 1800);
    expect(bloc).toContain('are deja un flux de semnare pornit');
    expect(bloc).toContain('semnături puse');
    expect(bloc).toContain('Ce ai de făcut');
    expect(bloc).toContain('anulează fluxul existent');
    expect(bloc).not.toContain('alert(');   // convenția locală e $("createResult")
  });
});
