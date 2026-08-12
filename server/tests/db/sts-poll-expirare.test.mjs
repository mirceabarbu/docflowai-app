/**
 * #125 — sts-poll expiră sesiunea STS pe VÂRSTĂ + rută POST /flows/:id/sts-cancel.
 *
 * Incidentul: `stsPending=true` nu expira NICIODATĂ. Clientul renunță la 3 minute, dar
 * `signer-status.shouldResumePoll` repornea polling-ul la fiecare refresh ⇒ semnatari
 * blocați zile întregi pe „Așteptăm aprobarea ta pe email / PUSH". Butonul „Anulează"
 * nu avea nicio rută de server care să elibereze flag-ul.
 *
 * ⛔ Zero apeluri reale către STS — providerul e mock-uit (răspuns TRANZITORIU, adică
 *    exact cazul în care înainte se răspundea „waiting" la infinit).
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { hasTestDb, migrate, truncateAll, pool, seedOrgUser } from '../helpers/db-real.mjs';

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

// Providerul STS — mock TOTAL, niciun apel de rețea. Întoarce un rezultat tranzitoriu
// (ready:false, transient:true), forma nouă introdusă de Etapa A1.
vi.mock('../../signing/providers/STSCloudProvider.mjs', () => ({
  STSCloudProvider: class {
    async pollSignatureResult() {
      return { ready: false, transient: true, message: 'Eroare de comunicare cu STS. Reîncercăm...' };
    }
  },
}));

const cloudMod = await import('../../routes/flows/cloud-signing.mjs');
const cloudRouter = cloudMod.default;
cloudMod._injectDeps({ notify: async () => {}, fireWebhook: null, wsPush: () => {} });

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use('/', cloudRouter);
  return app;
}

const TOKEN = 'tok-semnatar-1';

/** Seed flux cu un semnatar în stare stsPending. `pendingAt`/`updatedAt` = ISO sau null. */
async function seedStsFlow(id, { pendingAt, updatedAt, stsPending = true }) {
  const signer = {
    name: 'Ion Popescu', email: 's1@x.ro', role: 'SEMNATAR', order: 1,
    status: 'current', token: TOKEN,
    stsPending, stsOpId: 'op-abc', stsToken: 'access-tok', stsSignUrl: 'https://sign.example',
  };
  if (pendingAt) signer.stsPendingAt = pendingAt;
  const data = {
    status: 'in_progress', completed: false, orgId: 1,
    initEmail: 'p1@x.ro', docName: 'Doc', signers: [signer],
  };
  if (updatedAt) data.updatedAt = updatedAt;
  await pool.query(`INSERT INTO flows (id, data, org_id) VALUES ($1,$2::jsonb,$3)`,
    [id, JSON.stringify(data), 1]);
  return id;
}

async function getSigner(flowId) {
  const { rows } = await pool.query(`SELECT data FROM flows WHERE id=$1`, [flowId]);
  return rows[0].data.signers[0];
}
async function getEvents(flowId) {
  const { rows } = await pool.query(`SELECT data FROM flows WHERE id=$1`, [flowId]);
  return rows[0].data.events || [];
}

const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
const d = describe.skipIf(!hasTestDb());

d('#125 — expirare stsPending în sts-poll + rută sts-cancel', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await seedOrgUser({ role: 'user' }); app = buildApp(); });
  afterAll(() => pool.end());

  it('(1) sesiune proaspătă (stsPendingAt = acum) ⇒ waiting, stsPending rămâne true', async () => {
    const flowId = await seedStsFlow('flow-sts-fresh', { pendingAt: new Date().toISOString() });

    const res = await request(app).get(`/flows/${flowId}/sts-poll?token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('waiting');

    expect((await getSigner(flowId)).stsPending).toBe(true);
  });

  it('(2) stsPendingAt acum − 31 min ⇒ status error + stsPending false în DB', async () => {
    const flowId = await seedStsFlow('flow-sts-old', { pendingAt: minutesAgo(31) });

    const res = await request(app).get(`/flows/${flowId}/sts-poll?token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('error');
    expect(res.body.message).toMatch(/expirat/i);

    const s = await getSigner(flowId);
    expect(s.stsPending).toBe(false);
    // Sesiunea a expirat, semnătura NU a eșuat criptografic ⇒ fără status='error'/signError*
    expect(s.status).toBe('current');
    expect(s.signError).toBeUndefined();
    // Urma de audit rămâne
    expect(s.stsOpId).toBe('op-abc');
  });

  it('(3) flux vechi FĂRĂ stsPendingAt, data.updatedAt acum − 31 min ⇒ același rezultat', async () => {
    const flowId = await seedStsFlow('flow-sts-legacy', { pendingAt: null, updatedAt: minutesAgo(31) });

    const res = await request(app).get(`/flows/${flowId}/sts-poll?token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('error');
    expect((await getSigner(flowId)).stsPending).toBe(false);
  });

  it('(4) POST /sts-cancel cu token valid ⇒ 200, stsPending false, event STS_CANCELLED', async () => {
    const flowId = await seedStsFlow('flow-sts-cancel', { pendingAt: new Date().toISOString() });

    const res = await request(app).post(`/flows/${flowId}/sts-cancel?token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const s = await getSigner(flowId);
    expect(s.stsPending).toBe(false);
    expect(s.status).toBe('current');            // status-ul semnatarului NU se atinge
    expect(s.stsOpId).toBe('op-abc');            // urma de audit rămâne

    const ev = await getEvents(flowId);
    expect(ev.some(e => e.type === 'STS_CANCELLED' && e.by === 's1@x.ro')).toBe(true);
  });

  it('(5) POST /sts-cancel de două ori ⇒ a doua oară 200 alreadyCancelled', async () => {
    const flowId = await seedStsFlow('flow-sts-cancel2', { pendingAt: new Date().toISOString() });

    const r1 = await request(app).post(`/flows/${flowId}/sts-cancel?token=${TOKEN}`);
    expect(r1.status).toBe(200);

    const r2 = await request(app).post(`/flows/${flowId}/sts-cancel?token=${TOKEN}`);
    expect(r2.status).toBe(200);
    expect(r2.body.alreadyCancelled).toBe(true);

    // un singur event, nu două
    const ev = await getEvents(flowId);
    expect(ev.filter(e => e.type === 'STS_CANCELLED').length).toBe(1);
  });

  it('(6) POST /sts-cancel cu token străin ⇒ 400 invalid_token, stsPending NESCHIMBAT', async () => {
    const flowId = await seedStsFlow('flow-sts-foreign', { pendingAt: new Date().toISOString() });

    const res = await request(app).post(`/flows/${flowId}/sts-cancel?token=alt-token`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_token');

    expect((await getSigner(flowId)).stsPending).toBe(true);
    expect(await getEvents(flowId)).toEqual([]);
  });
});
