/**
 * #153 — accesul la CONȚINUTUL fluxului se derivă din DOCUMENT (DF/ORD), nu din rol.
 *
 * Simptom din producție: un membru al compartimentului Responsabil CAB
 * (organizations.cab_compartiment) vedea DF-ul aprobat, dar primea 403 la
 * „Descarcă PDF semnat" — `flow-access.mjs` nu știa nimic despre compartimente.
 *
 * Fixul NU e o ramură pe rol: fluxul se deschide DOAR dacă e fluxul de semnare al
 * unui DF/ORD pe care actorul are deja dreptul să-l vadă (`canViewFormular`).
 * Măsurat pe producție (Etapa A): 2.093 fluxuri vii, 177 cu DF/ORD, 1.916 (91,5%)
 * TREBUIE să rămână închise — de aici obligativitatea cazului 2.
 *
 * Cazuri (1/2/3 = ancorele lotului):
 *  1. membru CAB + flux legat de DF din org       → 200  (pe codul VECHI: 403)
 *  2. membru CAB + flux FĂRĂ DF/ORD, aceeași org  → 403  (nu am lărgit prea mult)
 *  3. membru CAB din ALTĂ organizație             → 403  (granița org nu se traversează)
 *  4. flux legat de un ORD                        → 200  (paritate DF↔ORD)
 *  5. user obișnuit, fără legătură, aceeași org   → 403  (neschimbat)
 *  6. inițiator / semnatar / destinatar           → 200  (neregresie pe căile existente)
 *  7. DF cu deleted_at IS NOT NULL                → 403
 *  8. eroare de DB pe ramura nouă                 → 403, nu 200 (fail-closed)
 *
 * Auto-skip fără TEST_DATABASE_URL (npm test rămâne verde); sursa de adevăr = CI.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import {
  hasTestDb, migrate, truncateAll, pool,
  seedOrgUser, seedUser, seedDf, seedOrd, makeAuthCookie,
} from '../helpers/db-real.mjs';
import { transmitFlowTo } from '../../services/flow-transmit.mjs';

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  redactUrl: (u) => u,
}));

const crudMod = await import('../../routes/flows/crud.mjs');
const crudRouter = crudMod.default;
const attachmentsRouter = (await import('../../routes/flows/attachments.mjs')).default;
crudMod._injectDeps({ stripSensitive: (d) => d });

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use('/', crudRouter);
  app.use('/', attachmentsRouter);
  return app;
}

const CAB_COMP  = 'Serviciul Buget';   // identic cu producția (Etapa A, Q1)
const FLOW_DF   = 'flow-153-df';
const FLOW_ORD  = 'flow-153-ord';
const FLOW_BARE = 'flow-153-bare';     // fără niciun DF/ORD — mulțimea de 1.916
const SIGNER_TOKEN = 'sig-token-153';
const B64 = Buffer.from('hello-pdf').toString('base64');

const d = describe.skipIf(!hasTestDb());

d('#153 — acces la conținutul fluxului derivat din DF/ORD', () => {
  let app;
  let orgId, org2Id;
  let initId, creatorId, cabId, strangerId, destId, cab2Id;
  let dfId;

  async function seedFlow(id, orgIdArg) {
    await pool.query(
      `INSERT INTO flows (id, data, org_id) VALUES ($1, $2::jsonb, $3)`,
      [id, JSON.stringify({
        flowId: id, status: 'completed', completed: true, orgId: orgIdArg,
        initEmail: 'init@x.ro', docName: 'Doc', flowType: 'ancore',
        signers: [{ name: 'S', email: 'sig@x.ro', token: SIGNER_TOKEN }],
      }), orgIdArg]
    );
    await pool.query(`INSERT INTO flows_pdfs (flow_id, key, data) VALUES ($1,'pdfB64',$2)`, [id, B64]);
    await pool.query(`INSERT INTO flows_pdfs (flow_id, key, data) VALUES ($1,'signedPdfB64',$2)`, [id, B64]);
  }

  const cookie = (u) => makeAuthCookie(u);
  const asCab  = () => cookie({ userId: cabId, role: 'user', orgId, email: 'cab@x.ro' });

  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await pool.query('DELETE FROM flows_pdfs');
    await pool.query('DELETE FROM flow_recipients');

    const o = await seedOrgUser({ orgName: 'Org 153', email: 'init@x.ro', role: 'user' });
    orgId = o.orgId; initId = o.userId;
    await pool.query(`UPDATE organizations SET cab_compartiment=$1 WHERE id=$2`, [CAB_COMP, orgId]);

    // Creatorul documentelor e în ALT compartiment decât CAB — altfel membrul CAB ar
    // trece prin ramura „coleg de compartiment cu creatorul" (#143) și testul 1 n-ar
    // demonstra nimic despre ramura CAB.
    creatorId  = await seedUser({ orgId, email: 'creator@x.ro',  compartiment: 'Achizitii' });
    cabId      = await seedUser({ orgId, email: 'cab@x.ro',      compartiment: CAB_COMP });
    strangerId = await seedUser({ orgId, email: 'stranger@x.ro', compartiment: 'Juridic' });
    destId     = await seedUser({ orgId, email: 'dest@x.ro',     compartiment: 'Juridic' });

    // A doua organizație, cu ACELAȘI nume de compartiment CAB — capcana cross-tenant.
    const o2 = await seedOrgUser({ orgName: 'Org 153 bis', email: 'init2@x.ro', role: 'user' });
    org2Id = o2.orgId;
    await pool.query(`UPDATE organizations SET cab_compartiment=$1 WHERE id=$2`, [CAB_COMP, org2Id]);
    cab2Id = await seedUser({ orgId: org2Id, email: 'cab2@x.ro', compartiment: CAB_COMP });

    await seedFlow(FLOW_DF, orgId);
    await seedFlow(FLOW_ORD, orgId);
    await seedFlow(FLOW_BARE, orgId);

    dfId = await seedDf({ orgId, createdBy: creatorId, status: 'aprobat', flowId: FLOW_DF });
    await seedOrd({ orgId, createdBy: creatorId, status: 'aprobat', flowId: FLOW_ORD });

    app = buildApp();
  });
  afterAll(() => pool.end());

  // ── 1 ⭐⭐ ancora lotului ────────────────────────────────────────────────────
  it('1. membru CAB + flux legat de un DF din org → 200 pe signed-pdf', async () => {
    const res = await request(app).get(`/flows/${FLOW_DF}/signed-pdf`).set('Cookie', asCab());
    expect(res.status).toBe(200);
  });

  // ── 2 ⭐⭐ testul care demonstrează că NU am lărgit prea mult ───────────────
  it('2. membru CAB + flux FĂRĂ DF/ORD, aceeași org → 403', async () => {
    const res = await request(app).get(`/flows/${FLOW_BARE}/signed-pdf`).set('Cookie', asCab());
    expect(res.status).toBe(403);
  });

  // ── 3 ⭐⭐ granița organizației ─────────────────────────────────────────────
  it('3. membru CAB din ALTĂ organizație + același flux → 403', async () => {
    const res = await request(app).get(`/flows/${FLOW_DF}/signed-pdf`)
      .set('Cookie', cookie({ userId: cab2Id, role: 'user', orgId: org2Id, email: 'cab2@x.ro' }));
    expect(res.status).toBe(403);
  });

  // ── 4 ⭐ paritate DF↔ORD ────────────────────────────────────────────────────
  it('4. membru CAB + flux legat de un ORD → 200', async () => {
    const res = await request(app).get(`/flows/${FLOW_ORD}/signed-pdf`).set('Cookie', asCab());
    expect(res.status).toBe(200);
  });

  // ── 5 ⭐ neschimbat ─────────────────────────────────────────────────────────
  it('5. user obișnuit, fără legătură, aceeași org → 403 chiar și pe fluxul cu DF', async () => {
    const res = await request(app).get(`/flows/${FLOW_DF}/signed-pdf`)
      .set('Cookie', cookie({ userId: strangerId, role: 'user', orgId, email: 'stranger@x.ro' }));
    expect(res.status).toBe(403);
  });

  // ── 6 ⭐ neregresie pe cele cinci căi existente ─────────────────────────────
  describe('6. căile existente rămân deschise (pe fluxul FĂRĂ DF/ORD, ca să nu ajute ramura nouă)', () => {
    it('inițiator → 200', async () => {
      const res = await request(app).get(`/flows/${FLOW_BARE}/signed-pdf`)
        .set('Cookie', cookie({ userId: initId, role: 'user', orgId, email: 'init@x.ro' }));
      expect(res.status).toBe(200);
    });
    it('semnatar via token → 200', async () => {
      const res = await request(app).get(`/flows/${FLOW_BARE}/signed-pdf?token=${SIGNER_TOKEN}`);
      expect(res.status).toBe(200);
    });
    it('destinatar repartizat → 200', async () => {
      await transmitFlowTo(pool, {
        flowId: FLOW_BARE, orgId, transmittedBy: null, source: 'manual',
        recipients: [{ type: 'user', value: destId }],
      });
      const res = await request(app).get(`/flows/${FLOW_BARE}/signed-pdf`)
        .set('Cookie', cookie({ userId: destId, role: 'user', orgId, email: 'dest@x.ro' }));
      expect(res.status).toBe(200);
    });
    it('anonim fără token → 403', async () => {
      const res = await request(app).get(`/flows/${FLOW_DF}/signed-pdf`);
      expect(res.status).toBe(403);
    });
  });

  // ── 5b ⭐⭐ proiecția îngustă chiar hrănește canEditFormular ────────────────
  // `isAllowedViaFormular` NU face `SELECT *`: proiectează exact câmpurile citite de
  // `canEditFormular` (created_by, assigned_to, p2_compartiment, flow_id). Prezența lor
  // în textul SQL nu e dovadă că ramura lor funcționează — testul ăsta o dă, pe calea
  // `p2_comp`, singura care depinde de o coloană pe care ramura CAB n-o atinge deloc.
  // Utilizatorul de aici NU e: creator, coleg de compartiment cu creatorul, membru CAB,
  // semnatar, inițiator sau destinatar repartizat. Singura lui revendicare e
  // doc.p2_compartiment — dacă acea coloană ar cădea din proiecție, ar primi 403.
  it('5b. user cu compartimentul = doc.p2_compartiment (nu CAB, nu semnatar) → 200', async () => {
    const p2CompUserId = await seedUser({ orgId, email: 'p2comp@x.ro', compartiment: 'Contabilitate' });
    await pool.query(`UPDATE formulare_df SET p2_compartiment=$1 WHERE id=$2`, ['Contabilitate', dfId]);

    const res = await request(app).get(`/flows/${FLOW_DF}/signed-pdf`)
      .set('Cookie', cookie({ userId: p2CompUserId, role: 'user', orgId, email: 'p2comp@x.ro' }));
    expect(res.status).toBe(200);

    // Contra-proba: același om, pe fluxul fără DF/ORD, rămâne închis.
    const res2 = await request(app).get(`/flows/${FLOW_BARE}/signed-pdf`)
      .set('Cookie', cookie({ userId: p2CompUserId, role: 'user', orgId, email: 'p2comp@x.ro' }));
    expect(res2.status).toBe(403);
  });

  // ── 7 ⭐ documentul șters nu mai deschide fluxul ────────────────────────────
  it('7. DF cu deleted_at IS NOT NULL → 403', async () => {
    await pool.query(`UPDATE formulare_df SET deleted_at=NOW() WHERE id=$1`, [dfId]);
    const res = await request(app).get(`/flows/${FLOW_DF}/signed-pdf`).set('Cookie', asCab());
    expect(res.status).toBe(403);
  });

  // ── 8 ⭐ fail-closed ────────────────────────────────────────────────────────
  it('8. eroare de DB pe ramura nouă → 403, nu 200 (fail-closed)', async () => {
    const orig = pool.query.bind(pool);
    const spy = vi.spyOn(pool, 'query').mockImplementation((text, params) => {
      const sql = typeof text === 'string' ? text : (text?.text || '');
      // Doar interogarea ramurii noi (DF UNION ALL ORD pe flow_id) explodează.
      if (sql.includes('FROM formulare_df') && sql.includes('UNION ALL')) {
        return Promise.reject(new Error('boom: DF/ORD lookup'));
      }
      return orig(text, params);
    });
    try {
      const res = await request(app).get(`/flows/${FLOW_DF}/signed-pdf`).set('Cookie', asCab());
      expect(res.status).toBe(403);
    } finally {
      spy.mockRestore();
    }
  });

  // Paritate pe restul siturilor porții: efectul se propagă automat, dar o dovadă
  // ieftină pe /pdf și pe atașamente previne un viitor „doar signed-pdf s-a deschis".
  describe('paritate pe celelalte endpointuri de conținut', () => {
    it('GET /flows/:id/pdf → 200 pentru CAB pe fluxul cu DF', async () => {
      const res = await request(app).get(`/flows/${FLOW_DF}/pdf`).set('Cookie', asCab());
      expect(res.status).toBe(200);
    });
    it('GET /flows/:id/attachments → 200 pentru CAB pe fluxul cu DF', async () => {
      const res = await request(app).get(`/flows/${FLOW_DF}/attachments`).set('Cookie', asCab());
      expect(res.status).toBe(200);
    });
    it('GET /flows/:id/attachments → 403 pentru CAB pe fluxul fără DF/ORD', async () => {
      const res = await request(app).get(`/flows/${FLOW_BARE}/attachments`).set('Cookie', asCab());
      expect(res.status).toBe(403);
    });
  });
});
