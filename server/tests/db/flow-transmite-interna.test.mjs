/**
 * Transmitere internă (repartizare) — motor + acces destinatar (Etapa 1, backend).
 *
 * NB privind locația: fișierul trăiește în server/tests/db/** (NU integration/) fiindcă
 * verifică comportament de Postgres REAL — CHECK „exact o țintă", ON CONFLICT idempotent,
 * expansiune compartiment→emailuri, acces GET /flows/:id. Aici se auto-skip fără
 * TEST_DATABASE_URL (npm test rămâne verde) și rulează în CI (sursa de adevăr).
 *
 * Acoperă:
 *  (1) transmitFlowTo de două ori pe aceeași țintă → a doua oară newlyAdded=[] (ON CONFLICT).
 *  (2) CHECK-ul respinge rând cu ambele ținte NULL ȘI unul cu ambele setate.
 *  (3) isFlowRecipient: user destinatar → true; user din compartimentul destinatar → true;
 *      user străin → false.
 *  (4) resolveRecipientEmails: user → email; comp → toți userii comp (dedup lowercase).
 *  (5) „Auto la COMPLETED" (motorul folosit de notify()): flow cu data.transmiteLaFinalizare
 *      → transmitFlowTo+resolve produc rând + emailuri; al doilea run nu dublează.
 *  (6) Acces: destinatarul ne-semnatar primește 200 pe GET /flows/:id; străinul rămâne 403.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import {
  hasTestDb, migrate, truncateAll, pool,
  seedOrgUser, seedUser, makeAuthCookie,
} from '../helpers/db-real.mjs';
import {
  normalizeRecipients, transmitFlowTo, isFlowRecipient, resolveRecipientEmails,
} from '../../services/flow-transmit.mjs';

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

const crudRouter = (await import('../../routes/flows/crud.mjs')).default;
const crudMod = await import('../../routes/flows/crud.mjs');
// getFlowHandler folosește DOAR _stripSensitive din deps — passthrough suficient (verificăm status codes).
crudMod._injectDeps({ stripSensitive: (d) => d });

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use('/', crudRouter);
  return app;
}

async function seedFlow(id, { orgId = 1, initEmail = 'init@x.ro' } = {}) {
  await pool.query(
    `INSERT INTO flows (id, data, org_id) VALUES ($1, $2::jsonb, $3)`,
    [id, JSON.stringify({ status: 'completed', completed: true, orgId, initEmail, docName: 'Doc', signers: [] }), orgId]
  );
  return id;
}

const d = describe.skipIf(!hasTestDb());

d('Transmitere internă (repartizare) — motor + acces', () => {
  let app, orgId, initId, destId, compId, strangerId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    const o = await seedOrgUser({ email: 'init@x.ro', role: 'user' });
    orgId = o.orgId; initId = o.userId;
    destId = await seedUser({ orgId, email: 'dest@x.ro', compartiment: '' });
    compId = await seedUser({ orgId, email: 'compu@x.ro', compartiment: 'Contabilitate' });
    strangerId = await seedUser({ orgId, email: 'stranger@x.ro', compartiment: '' });
    app = buildApp();
  });
  afterAll(() => pool.end());

  it('(1) transmitFlowTo idempotent — al doilea apel returnează newlyAdded=[]', async () => {
    const flowId = await seedFlow('flow-t1');
    const recipients = [{ type: 'user', value: destId }, { type: 'comp', value: 'Contabilitate' }];
    const first = await transmitFlowTo(pool, { flowId, orgId, recipients, transmittedBy: null, source: 'auto' });
    expect(first).toHaveLength(2);
    const second = await transmitFlowTo(pool, { flowId, orgId, recipients, transmittedBy: null, source: 'auto' });
    expect(second).toHaveLength(0);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM flow_recipients WHERE flow_id=$1', [flowId]);
    expect(rows[0].n).toBe(2);
  });

  it('(2) CHECK „exact o țintă" respinge zero ținte și ambele ținte', async () => {
    const flowId = await seedFlow('flow-t2');
    // zero ținte
    await expect(pool.query(
      `INSERT INTO flow_recipients (flow_id, recipient_user_id, recipient_compartiment) VALUES ($1, NULL, NULL)`,
      [flowId]
    )).rejects.toThrow();
    // ambele ținte
    await expect(pool.query(
      `INSERT INTO flow_recipients (flow_id, recipient_user_id, recipient_compartiment) VALUES ($1, $2, $3)`,
      [flowId, destId, 'Contabilitate']
    )).rejects.toThrow();
    // whitespace-only comp = zero ținte (NULLIF(TRIM))
    await expect(pool.query(
      `INSERT INTO flow_recipients (flow_id, recipient_user_id, recipient_compartiment) VALUES ($1, NULL, '   ')`,
      [flowId]
    )).rejects.toThrow();
  });

  it('(3) isFlowRecipient — user destinatar → true; user din comp → true; străin → false', async () => {
    const flowId = await seedFlow('flow-t3');
    await transmitFlowTo(pool, {
      flowId, orgId, transmittedBy: null, source: 'auto',
      recipients: [{ type: 'user', value: destId }, { type: 'comp', value: 'Contabilitate' }],
    });
    expect(await isFlowRecipient(pool, flowId, { userId: destId })).toBe(true);
    expect(await isFlowRecipient(pool, flowId, { userId: compId })).toBe(true); // membru comp Contabilitate
    expect(await isFlowRecipient(pool, flowId, { userId: strangerId })).toBe(false);
    expect(await isFlowRecipient(pool, flowId, { userId: initId })).toBe(false); // init ne-repartizat
  });

  it('(4) resolveRecipientEmails — user + expansiune comp, dedup lowercase', async () => {
    const flowId = await seedFlow('flow-t4');
    // al doilea membru al aceluiași compartiment
    const comp2 = await seedUser({ orgId, email: 'compu2@x.ro', compartiment: 'Contabilitate' });
    const newly = await transmitFlowTo(pool, {
      flowId, orgId, transmittedBy: null, source: 'auto',
      recipients: [{ type: 'user', value: destId }, { type: 'comp', value: 'Contabilitate' }],
    });
    const emails = (await resolveRecipientEmails(pool, newly)).map(e => e.email).sort();
    expect(emails).toEqual(['compu2@x.ro', 'compu@x.ro', 'dest@x.ro'].sort());
    expect(comp2).toBeGreaterThan(0);
  });

  it('(5) motor auto la COMPLETED — data.transmiteLaFinalizare → rând + emailuri; al doilea run nu dublează', async () => {
    const flowId = 'flow-t5';
    await pool.query(
      `INSERT INTO flows (id, data, org_id) VALUES ($1, $2::jsonb, $3)`,
      [flowId, JSON.stringify({
        status: 'completed', completed: true, orgId, initEmail: 'init@x.ro', docName: 'Contract',
        transmiteLaFinalizare: [{ type: 'user', value: destId }],
      }), orgId]
    );
    // Replică motorului din notify()/COMPLETED (server/index.mjs):
    const { rows: fr } = await pool.query('SELECT data FROM flows WHERE id=$1', [flowId]);
    const cfg = normalizeRecipients(fr[0].data.transmiteLaFinalizare);
    const newly = await transmitFlowTo(pool, { flowId, orgId, recipients: cfg, transmittedBy: null, source: 'auto' });
    expect(newly).toHaveLength(1);
    const emails = (await resolveRecipientEmails(pool, newly)).map(e => e.email);
    expect(emails).toEqual(['dest@x.ro']);
    // al doilea COMPLETED → ON CONFLICT → niciun rând nou (fără re-notificare)
    const again = await transmitFlowTo(pool, { flowId, orgId, recipients: cfg, transmittedBy: null, source: 'auto' });
    expect(again).toHaveLength(0);
  });

  it('(6) acces GET /flows/:id — destinatar ne-semnatar 200, străin 403', async () => {
    const flowId = await seedFlow('flow-t6', { orgId, initEmail: 'init@x.ro' });
    await transmitFlowTo(pool, {
      flowId, orgId, transmittedBy: null, source: 'auto',
      recipients: [{ type: 'user', value: destId }],
    });

    // destinatar (nu init, nu semnatar, nu admin) → 200 prin fallback isFlowRecipient
    const okRes = await request(app)
      .get(`/flows/${flowId}`)
      .set('Cookie', makeAuthCookie({ userId: destId, role: 'user', orgId, email: 'dest@x.ro' }));
    expect(okRes.status).toBe(200);

    // străin → 403
    const forbRes = await request(app)
      .get(`/flows/${flowId}`)
      .set('Cookie', makeAuthCookie({ userId: strangerId, role: 'user', orgId, email: 'stranger@x.ro' }));
    expect(forbRes.status).toBe(403);
  });
});
