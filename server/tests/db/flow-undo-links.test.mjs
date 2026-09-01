/**
 * #164 — Integritatea legăturilor document↔flux la anulare și desfacere (PostgreSQL REAL).
 *
 * Trei incidente de producție din 31.08.2026, aceeași cauză: legătura document↔flux e ținută
 * în patru locuri scrise de rute diferite, cu condiții diferite.
 *
 *  A. `link-ord-flow` (alop.mjs) scria `ord_flow_id` NECONDIȚIONAT ⇒ al doilea flux al
 *     aceluiași ORD deturna pointerul de pe primul (ORD 46055).
 *  B. `cancel` (lifecycle.mjs) golea pointerul ALOP cheiat DOAR pe `df_id`/`ord_id` ⇒ anularea
 *     unui flux ștergea legătura către CELĂLALT flux al aceluiași document (ORD 46055).
 *  C. `undoCompletedFlowLinks` (flow-undo.mjs) reseta DF-ul cu predicatul `status='transmis_flux'`
 *     (o singură stare din trei) ȘI ținea curățarea pointerilor ALOP ÎN INTERIORUL acelui `if`
 *     ⇒ pe calea cloud (statusul rămâne `completed`) ALOP-ul rămânea agățat de fluxul desfăcut,
 *     blocat în `lichidare`, cu fluxul DF nerelansabil (DF 46149).
 *  D. Migrația 110 legalizează `lichidare → angajare` în matricea porții ALOP — fără ea,
 *     C ar arunca `check_violation` și admin-cancel ar da 500.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedAlop, getAlop, getDf, makeAuthCookie } from '../helpers/db-real.mjs';

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

const { formulareDbRouter } = await import('../../routes/formulare/index.mjs');
const alopRouter = (await import('../../routes/alop.mjs')).default;
const lifecycleMod = await import('../../routes/flows/lifecycle.mjs');
const lifecycleRouter = lifecycleMod.default;
lifecycleMod._injectDeps({ notify: async () => {}, fireWebhook: null, wsPush: () => {} });

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use('/', lifecycleRouter);
  app.use('/', formulareDbRouter);
  app.use('/', alopRouter);
  return app;
}

// Flux „viu" (în derulare). `meta` e OBLIGATORIU pentru poarta de proveniență P0-03.
async function seedLiveFlow(id, { meta, status = 'in_progress' } = {}) {
  await pool.query(
    `INSERT INTO flows (id, data, org_id) VALUES ($1, $2::jsonb, $3)`,
    [id, JSON.stringify({ status, completed: false, orgId: 1, initEmail: 'p1@x.ro', docName: 'Doc', signers: [], ...(meta ? { meta } : {}) }), 1]
  );
  return id;
}
// Flux FINALIZAT (ținta lui admin-cancel).
async function seedCompletedFlow(id, { meta } = {}) {
  await pool.query(
    `INSERT INTO flows (id, data, org_id) VALUES ($1, $2::jsonb, $3)`,
    [id, JSON.stringify({ status: 'completed', completed: true, orgId: 1, initEmail: 'p1@x.ro', docName: 'Doc', signers: [], ...(meta ? { meta } : {}) }), 1]
  );
  return id;
}
async function markFlowCancelled(id) {
  await pool.query(`UPDATE flows SET data = jsonb_set(data,'{status}','"cancelled"') WHERE id=$1`, [id]);
}

const d = describe.skipIf(!hasTestDb());
const REASON = 'Semnat gresit - desfacere administrativa';
// Drenaj pentru scrierile de audit fire-and-forget (vezi scenariuDf).
const settle = () => new Promise((r) => setTimeout(r, 200));

d('#164 — integritatea legăturilor document↔flux', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await seedOrgUser({ role: 'user' }); app = buildApp(); });
  afterAll(() => pool.end());

  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1, email: 'p1@x.ro' });
  const adminCookie = () => makeAuthCookie({ userId: 1, role: 'org_admin', orgId: 1, email: 'p1@x.ro' });

  // ── A. link-ord-flow ──────────────────────────────────────────────────────
  describe('A — POST /api/alop/:id/link-ord-flow: garda anti-deturnare', () => {
    it('(1) ALOP fără pointer + flux viu ⇒ ord_flow_id se setează', async () => {
      const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed' });
      const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', ordId });
      const flowB = await seedLiveFlow('flow-A1-b', { meta: { ordId } });

      const res = await request(app).post(`/api/alop/${alopId}/link-ord-flow`)
        .set('Cookie', cookie()).send({ flow_id: flowB });
      expect(res.status).toBe(200);
      expect((await getAlop(alopId)).ord_flow_id).toBe(flowB);
    });

    it('(2) ⭐ pointer pe fluxul A VIU + cerere de legare B ⇒ rămâne A, răspuns 200 (ORD 46055)', async () => {
      const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed' });
      const flowA = await seedLiveFlow('flow-A2-a', { meta: { ordId } });
      const flowB = await seedLiveFlow('flow-A2-b', { meta: { ordId } });
      const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', ordId, ordFlowId: flowA });

      const res = await request(app).post(`/api/alop/${alopId}/link-ord-flow`)
        .set('Cookie', cookie()).send({ flow_id: flowB });
      expect(res.status).toBe(200);
      expect(res.body.alop.ord_flow_id).toBe(flowA);   // starea REALĂ, nu cea cerută
      expect((await getAlop(alopId)).ord_flow_id).toBe(flowA);
    });

    it('(3) pointer pe fluxul A ANULAT ⇒ legarea lui B reușește', async () => {
      const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed' });
      const flowA = await seedLiveFlow('flow-A3-a', { meta: { ordId } });
      const flowB = await seedLiveFlow('flow-A3-b', { meta: { ordId } });
      const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', ordId, ordFlowId: flowA });
      await markFlowCancelled(flowA);

      const res = await request(app).post(`/api/alop/${alopId}/link-ord-flow`)
        .set('Cookie', cookie()).send({ flow_id: flowB });
      expect(res.status).toBe(200);
      expect((await getAlop(alopId)).ord_flow_id).toBe(flowB);
    });

    it('(3b) pointer pe fluxul A SOFT-ȘTERS ⇒ legarea lui B reușește', async () => {
      const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed' });
      const flowA = await seedLiveFlow('flow-A3b-a', { meta: { ordId } });
      const flowB = await seedLiveFlow('flow-A3b-b', { meta: { ordId } });
      const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', ordId, ordFlowId: flowA });
      await pool.query(`UPDATE flows SET deleted_at=NOW() WHERE id=$1`, [flowA]);

      const res = await request(app).post(`/api/alop/${alopId}/link-ord-flow`)
        .set('Cookie', cookie()).send({ flow_id: flowB });
      expect(res.status).toBe(200);
      expect((await getAlop(alopId)).ord_flow_id).toBe(flowB);
    });

    it('(4) legare repetată cu ACELAȘI flux ⇒ idempotent, fără eroare', async () => {
      const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed' });
      const flowA = await seedLiveFlow('flow-A4-a', { meta: { ordId } });
      const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', ordId, ordFlowId: flowA });

      for (let i = 0; i < 2; i++) {
        const res = await request(app).post(`/api/alop/${alopId}/link-ord-flow`)
          .set('Cookie', cookie()).send({ flow_id: flowA });
        expect(res.status).toBe(200);
        expect(res.body.alop.ord_flow_id).toBe(flowA);
      }
    });
  });

  // ── B. cancel scoped ──────────────────────────────────────────────────────
  describe('B — POST /flows/:flowId/cancel: curăță DOAR pointerul spre fluxul anulat', () => {
    it('(5) ⭐ ORD: formulare_ord.flow_id=A, alop.ord_flow_id=B; se anulează A ⇒ B rămâne (ORD 46055)', async () => {
      const flowA = await seedLiveFlow('flow-B5-a');
      const flowB = await seedLiveFlow('flow-B5-b');
      const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId: flowA });
      const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', ordId, ordFlowId: flowB });

      const res = await request(app).post(`/flows/${flowA}/cancel`).set('Cookie', cookie());
      expect(res.status).toBe(200);
      expect((await getAlop(alopId)).ord_flow_id).toBe(flowB);
    });

    it('(6) ORD: se anulează chiar fluxul pointat ⇒ pointerul se golește (comportament păstrat)', async () => {
      const flowA = await seedLiveFlow('flow-B6-a');
      const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId: flowA });
      const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'ordonantare', ordId, ordFlowId: flowA,
                                     ordCompletedAt: new Date().toISOString() });

      const res = await request(app).post(`/flows/${flowA}/cancel`).set('Cookie', cookie());
      expect(res.status).toBe(200);
      const a = await getAlop(alopId);
      expect(a.ord_flow_id).toBeNull();
      expect(a.ord_completed_at).toBeNull();
    });

    it('(7a) ⭐ DF: formulare_df.flow_id=A (transmis_flux), alop.df_flow_id=B; se anulează A ⇒ B rămâne', async () => {
      const flowA = await seedLiveFlow('flow-B7-a');
      const flowB = await seedLiveFlow('flow-B7-b');
      const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'transmis_flux', flowId: flowA });
      const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId, dfFlowId: flowB });

      const res = await request(app).post(`/flows/${flowA}/cancel`).set('Cookie', cookie());
      expect(res.status).toBe(200);
      expect((await getDf(dfId)).status).toBe('completed');   // resetul DF rămâne neatins
      expect((await getAlop(alopId)).df_flow_id).toBe(flowB);
    });

    it('(7b) DF: se anulează chiar fluxul pointat ⇒ pointerul se golește (comportament păstrat)', async () => {
      const flowA = await seedLiveFlow('flow-B7b-a');
      const dfId = await seedDf({ orgId: 1, createdBy: 1, status: 'transmis_flux', flowId: flowA });
      const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'lichidare', dfId, dfFlowId: flowA,
                                     dfCompletedAt: new Date().toISOString() });

      const res = await request(app).post(`/flows/${flowA}/cancel`).set('Cookie', cookie());
      expect(res.status).toBe(200);
      const a = await getAlop(alopId);
      expect(a.df_flow_id).toBeNull();
      expect(a.df_completed_at).toBeNull();
    });
  });

  // ── C+D. undoCompletedFlowLinks prin admin-cancel ─────────────────────────
  describe('C+D — POST /flows/:flowId/admin-cancel: ramura DF completă + migrația 110', () => {
    it('(14) migrația 110: poarta rămâne ENFORCING — o tranziție ilegală tot aruncă', async () => {
      const alopId = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft' });
      await expect(
        pool.query(`UPDATE alop_instances SET status='ordonantare' WHERE id=$1`, [alopId])
      ).rejects.toThrow(/transition violation/i);
    });

    async function scenariuDf(dfStatus, { lichidareConfirmedAt, ordId } = {}) {
      const flowId = await seedCompletedFlow(`flow-C-${dfStatus}-${Math.random().toString(36).slice(2, 7)}`);
      const dfId = await seedDf({ orgId: 1, createdBy: 1, status: dfStatus, flowId });
      const alopId = await seedAlop({
        orgId: 1, createdBy: 1, status: 'lichidare', dfId, dfFlowId: flowId,
        dfCompletedAt: new Date().toISOString(),
        ...(lichidareConfirmedAt ? { lichidareConfirmedAt } : {}),
        ...(ordId ? { ordId } : {}),
      });
      const res = await request(app).post(`/flows/${flowId}/admin-cancel`)
        .set('Cookie', adminCookie()).send({ reason: REASON });
      // `admin-cancel` scrie auditul (writeAuditEvent / recordFormularAudit) FIRE-AND-FORGET,
      // dupa ce a raspuns. Lasam scrierile sa se aseze: altfel TRUNCATE-ul din `beforeEach`-ul
      // testului urmator (AccessExclusiveLock) intra in deadlock cu INSERT-ul intarziat.
      await settle();
      return { res, dfId, alopId, flowId };
    }

    it('(8) ⭐ DF `completed` (calea cloud) + ALOP `lichidare` neconfirmată ⇒ pointeri NULL + status `angajare` (DF 46149)', async () => {
      const { res, alopId } = await scenariuDf('completed');
      expect(res.status).toBe(200);
      expect(res.body.statusChanged).toBe(true);
      const a = await getAlop(alopId);
      expect(a.df_flow_id).toBeNull();
      expect(a.df_completed_at).toBeNull();
      expect(a.status).toBe('angajare');
    });

    it('(9) DF `transmis_flux` ⇒ identic, plus statusul DF revine la `completed`', async () => {
      const { res, dfId, alopId } = await scenariuDf('transmis_flux');
      expect(res.status).toBe(200);
      expect((await getDf(dfId)).status).toBe('completed');
      const a = await getAlop(alopId);
      expect(a.df_flow_id).toBeNull();
      expect(a.df_completed_at).toBeNull();
      expect(a.status).toBe('angajare');
    });

    it('(10) DF `aprobat` ⇒ identic (status DF resetat la `completed`)', async () => {
      const { res, dfId, alopId } = await scenariuDf('aprobat');
      expect(res.status).toBe(200);
      expect((await getDf(dfId)).status).toBe('completed');
      const a = await getAlop(alopId);
      expect(a.df_flow_id).toBeNull();
      expect(a.status).toBe('angajare');
    });

    it('(11) ⭐ ALOP cu lichidare CONFIRMATĂ ⇒ pointerii se curăță, statusul NU se schimbă', async () => {
      const { res, alopId } = await scenariuDf('completed', { lichidareConfirmedAt: new Date().toISOString() });
      expect(res.status).toBe(200);
      expect(res.body.statusChanged).toBe(false);
      const a = await getAlop(alopId);
      expect(a.df_flow_id).toBeNull();
      expect(a.status).toBe('lichidare');
    });

    it('(12) ALOP cu `ord_id` setat ⇒ pointerii se curăță, statusul NU se schimbă', async () => {
      const ordId = await seedOrd({ orgId: 1, createdBy: 1, status: 'draft' });
      const { res, alopId } = await scenariuDf('completed', { ordId });
      expect(res.status).toBe(200);
      const a = await getAlop(alopId);
      expect(a.df_flow_id).toBeNull();
      expect(a.status).toBe('lichidare');
    });

    it('(13) admin-cancel pe flux DF NU întoarce 500 (poarta acceptă lichidare→angajare) și lasă dosarul relansabil', async () => {
      const { res, alopId } = await scenariuDf('completed');
      expect(res.status).toBe(200);          // fără migrația 110: 500 (check_violation → ROLLBACK)
      expect(res.body.error).toBeUndefined();

      const det = await request(app).get(`/api/alop/${alopId}`).set('Cookie', cookie());
      expect(det.status).toBe(200);
      expect(det.body.alop.status).toBe('angajare');
      expect(det.body.alop.df_flow_id).toBeNull();
      expect(det.body.alop.capabilities.df_action).toBeTruthy();  // butonul DF revine
    });
  });
});
