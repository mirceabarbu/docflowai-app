/**
 * Inbox durabil „📥 Primite" + confirmare luare la cunoștință per-persoană — Etapa 2c.
 *
 * Verifică rutele REALE GET /api/my-received și POST /flows/:flowId/acknowledge peste
 * Postgres real (server/tests/db/**, auto-skip fără TEST_DATABASE_URL; sursa de adevăr = CI).
 *
 * Acoperă:
 *  (1) GET /api/my-received — user cu repartizare directă → o vede; user din compartiment
 *      repartizat → o vede; user fără nicio repartizare → listă goală; flux șters → exclus.
 *  (2) POST /flows/:id/acknowledge — destinatar user → 200, rând în flow_recipient_acks;
 *      a doua oară → 200 idempotent (același acknowledged_at, fără duplicat); străin → 403;
 *      anonim → 401.
 *  (3) confirmare PER-PERSOANĂ pe compartiment — un membru confirmă, celălalt rămâne
 *      acknowledged_at=null în my-received.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import {
  hasTestDb, migrate, truncateAll, pool,
  seedOrgUser, seedUser, makeAuthCookie,
} from '../helpers/db-real.mjs';

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  redactUrl: (u) => u,
}));

const transmitRouter = (await import('../../routes/flows/transmit.mjs')).default;
const transmitMod = await import('../../routes/flows/transmit.mjs');

transmitMod._injectDeps({ notify: async () => {} });

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use('/', transmitRouter);
  return app;
}

async function seedFlow(id, { orgId, initEmail = 'init@x.ro', completed = true, deleted = false } = {}) {
  await pool.query(
    `INSERT INTO flows (id, data, org_id, deleted_at) VALUES ($1, $2::jsonb, $3, $4)`,
    [id, JSON.stringify({
      status: completed ? 'completed' : 'pending', completed, orgId, initEmail,
      docName: 'Doc Primit Test', signers: [],
    }), orgId, deleted ? new Date() : null]
  );
  return id;
}

async function seedRecipient(flowId, orgId, { userId, comp, transmittedBy } = {}) {
  await pool.query(
    `INSERT INTO flow_recipients (flow_id, org_id, recipient_user_id, recipient_compartiment, source, transmitted_by)
     VALUES ($1,$2,$3,$4,'manual',$5)`,
    [flowId, orgId, userId ?? null, comp ?? null, transmittedBy ?? null]
  );
}

const d = describe.skipIf(!hasTestDb());

d('Inbox Primite + acknowledge — GET /api/my-received, POST /flows/:id/acknowledge', () => {
  let app, orgId, initId, destId, compAId, compBId, strangerId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    const o = await seedOrgUser({ email: 'init@x.ro', role: 'user' });
    orgId = o.orgId; initId = o.userId;
    destId = await seedUser({ orgId, email: 'dest@x.ro', compartiment: '' });
    compAId = await seedUser({ orgId, email: 'compa@x.ro', compartiment: 'Contabilitate' });
    compBId = await seedUser({ orgId, email: 'compb@x.ro', compartiment: 'Contabilitate' });
    strangerId = await seedUser({ orgId, email: 'stranger@x.ro', compartiment: '' });
    app = buildApp();
  });
  afterAll(() => pool.end());

  const cookieFor = (userId, email) => makeAuthCookie({ userId, role: 'user', orgId, email });

  it('(1a) user cu repartizare directă → o vede în my-received', async () => {
    const flowId = await seedFlow('flow-r1a', { orgId });
    await seedRecipient(flowId, orgId, { userId: destId, transmittedBy: initId });
    const res = await request(app).get('/api/my-received').set('Cookie', cookieFor(destId, 'dest@x.ro'));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].flow_id).toBe(flowId);
    expect(res.body[0].doc_name).toBe('Doc Primit Test');
    expect(res.body[0].acknowledged_at).toBeNull();
  });

  it('(1b) user din compartiment repartizat → o vede', async () => {
    const flowId = await seedFlow('flow-r1b', { orgId });
    await seedRecipient(flowId, orgId, { comp: 'Contabilitate', transmittedBy: initId });
    const res = await request(app).get('/api/my-received').set('Cookie', cookieFor(compAId, 'compa@x.ro'));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].flow_id).toBe(flowId);
  });

  it('(1c) user fără nicio repartizare → listă goală', async () => {
    const flowId = await seedFlow('flow-r1c', { orgId });
    await seedRecipient(flowId, orgId, { userId: destId, transmittedBy: initId });
    const res = await request(app).get('/api/my-received').set('Cookie', cookieFor(strangerId, 'stranger@x.ro'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('(1d) flux șters (deleted_at) → exclus din my-received', async () => {
    const flowId = await seedFlow('flow-r1d', { orgId, deleted: true });
    await seedRecipient(flowId, orgId, { userId: destId, transmittedBy: initId });
    const res = await request(app).get('/api/my-received').set('Cookie', cookieFor(destId, 'dest@x.ro'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('(2a) destinatar user → 200, rând în flow_recipient_acks', async () => {
    const flowId = await seedFlow('flow-r2a', { orgId });
    await seedRecipient(flowId, orgId, { userId: destId, transmittedBy: initId });
    const res = await request(app).post(`/flows/${flowId}/acknowledge`).set('Cookie', cookieFor(destId, 'dest@x.ro'));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.acknowledged_at).toBeTruthy();
    const { rows } = await pool.query(
      'SELECT * FROM flow_recipient_acks WHERE flow_id=$1 AND user_id=$2', [flowId, destId]);
    expect(rows).toHaveLength(1);
  });

  it('(2b) a doua oară → 200 idempotent, același acknowledged_at, fără duplicat', async () => {
    const flowId = await seedFlow('flow-r2b', { orgId });
    await seedRecipient(flowId, orgId, { userId: destId, transmittedBy: initId });
    const first = await request(app).post(`/flows/${flowId}/acknowledge`).set('Cookie', cookieFor(destId, 'dest@x.ro'));
    const second = await request(app).post(`/flows/${flowId}/acknowledge`).set('Cookie', cookieFor(destId, 'dest@x.ro'));
    expect(second.status).toBe(200);
    expect(new Date(second.body.acknowledged_at).getTime()).toBe(new Date(first.body.acknowledged_at).getTime());
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int n FROM flow_recipient_acks WHERE flow_id=$1 AND user_id=$2', [flowId, destId]);
    expect(rows[0].n).toBe(1);
  });

  it('(2c) străin (ne-destinatar) → 403', async () => {
    const flowId = await seedFlow('flow-r2c', { orgId });
    await seedRecipient(flowId, orgId, { userId: destId, transmittedBy: initId });
    const res = await request(app).post(`/flows/${flowId}/acknowledge`).set('Cookie', cookieFor(strangerId, 'stranger@x.ro'));
    expect(res.status).toBe(403);
  });

  it('(2d) anonim → 401', async () => {
    const flowId = await seedFlow('flow-r2d', { orgId });
    await seedRecipient(flowId, orgId, { userId: destId, transmittedBy: initId });
    const res = await request(app).post(`/flows/${flowId}/acknowledge`);
    expect(res.status).toBe(401);
  });

  it('(3) confirmare PER-PERSOANĂ pe compartiment — un membru confirmă, celălalt rămâne neconfirmat', async () => {
    const flowId = await seedFlow('flow-r3', { orgId });
    await seedRecipient(flowId, orgId, { comp: 'Contabilitate', transmittedBy: initId });

    const ack = await request(app).post(`/flows/${flowId}/acknowledge`).set('Cookie', cookieFor(compAId, 'compa@x.ro'));
    expect(ack.status).toBe(200);

    const viewA = await request(app).get('/api/my-received').set('Cookie', cookieFor(compAId, 'compa@x.ro'));
    expect(viewA.body[0].acknowledged_at).toBeTruthy();

    const viewB = await request(app).get('/api/my-received').set('Cookie', cookieFor(compBId, 'compb@x.ro'));
    expect(viewB.body[0].acknowledged_at).toBeNull();
  });

  it('(4) corelare exactă: FLOW_ACKNOWLEDGED are recipientKey identic cu FLOW_TRANSMITTED (user direct, fix 30)', async () => {
    const flowId = await seedFlow('flow-r4', { orgId });
    await request(app).post(`/flows/${flowId}/transmit`).set('Cookie', cookieFor(initId, 'init@x.ro'))
      .send({ recipients: [{ type: 'user', value: destId }] });

    await request(app).post(`/flows/${flowId}/acknowledge`).set('Cookie', cookieFor(destId, 'dest@x.ro'));

    const { rows } = await pool.query('SELECT data FROM flows WHERE id=$1', [flowId]);
    const events = rows[0].data.events || [];
    const transmitEv = events.find(e => e.type === 'FLOW_TRANSMITTED');
    const ackEv = events.find(e => e.type === 'FLOW_ACKNOWLEDGED');
    expect(transmitEv).toBeTruthy();
    expect(ackEv).toBeTruthy();
    expect(ackEv.recipientKey).toBe(transmitEv.recipientKey);
    expect(ackEv.recipientKey).toBe(`user:${destId}`);
    expect(ackEv.by).toBe('dest@x.ro');

    const { rows: auditRows } = await pool.query(
      `SELECT payload FROM audit_log WHERE flow_id=$1 AND event_type='FLOW_ACKNOWLEDGED'`, [flowId]);
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    expect(auditRows[0].payload.recipientKey).toBe(`user:${destId}`);
  });

  it('(5) compartiment cu 2 confirmatori → 2 evenimente FLOW_ACKNOWLEDGED, ambele corelabile cu ACEEAȘI transmitere (fix 30)', async () => {
    const flowId = await seedFlow('flow-r5', { orgId });
    await request(app).post(`/flows/${flowId}/transmit`).set('Cookie', cookieFor(initId, 'init@x.ro'))
      .send({ recipients: [{ type: 'comp', value: 'Contabilitate' }] });

    await request(app).post(`/flows/${flowId}/acknowledge`).set('Cookie', cookieFor(compAId, 'compa@x.ro'));
    await request(app).post(`/flows/${flowId}/acknowledge`).set('Cookie', cookieFor(compBId, 'compb@x.ro'));

    const { rows } = await pool.query('SELECT data FROM flows WHERE id=$1', [flowId]);
    const events = rows[0].data.events || [];
    const transmitEvs = events.filter(e => e.type === 'FLOW_TRANSMITTED');
    const ackEvs = events.filter(e => e.type === 'FLOW_ACKNOWLEDGED');
    expect(transmitEvs).toHaveLength(1);
    expect(ackEvs).toHaveLength(2);
    expect(transmitEvs[0].recipientKey).toBe('comp:contabilitate');
    expect(ackEvs.every(a => a.recipientKey === 'comp:contabilitate')).toBe(true);
    expect(ackEvs.map(a => a.by).sort()).toEqual(['compa@x.ro', 'compb@x.ro']);
  });
});
