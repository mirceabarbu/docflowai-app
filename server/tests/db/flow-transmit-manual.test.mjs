/**
 * Transmitere internă MANUALĂ (repartizare ad-hoc) pe flux finalizat — Etapa 2b.
 *
 * Verifică ruta REALĂ POST /flows/:flowId/transmit peste Postgres real (server/tests/db/**,
 * auto-skip fără TEST_DATABASE_URL; sursa de adevăr = CI).
 *
 * Acoperă:
 *  (1) inițiator transmite user → 200 added:1; rând source='manual' în flow_recipients;
 *      destinatarul primește notificare REPARTIZAT.
 *  (2) a doua oară aceiași destinatari → 200 added:0 alreadyPresent:1 (idempotent ON CONFLICT).
 *  (3) destinatar tip comp → 200; toți userii din compartiment primesc REPARTIZAT.
 *  (4) străin autentificat → 403; flux nefinalizat → 409; recipients gol/invalid → 400; anonim → 401.
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

let _notified = [];
transmitMod._injectDeps({ notify: async (n) => { _notified.push(n); } });

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use('/', transmitRouter);
  return app;
}

async function seedFlow(id, { orgId, initEmail = 'init@x.ro', completed = true, signers = [] } = {}) {
  await pool.query(
    `INSERT INTO flows (id, data, org_id) VALUES ($1, $2::jsonb, $3)`,
    [id, JSON.stringify({
      status: completed ? 'completed' : 'pending', completed, orgId, initEmail,
      docName: 'Doc Test', signers,
    }), orgId]
  );
  return id;
}

const d = describe.skipIf(!hasTestDb());

d('Transmitere internă manuală — POST /flows/:id/transmit', () => {
  let app, orgId, initId, destId, compId, comp2Id, strangerId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    const o = await seedOrgUser({ email: 'init@x.ro', role: 'user' });
    orgId = o.orgId; initId = o.userId;
    destId = await seedUser({ orgId, email: 'dest@x.ro', compartiment: '' });
    compId = await seedUser({ orgId, email: 'compu@x.ro', compartiment: 'Contabilitate' });
    comp2Id = await seedUser({ orgId, email: 'compu2@x.ro', compartiment: 'Contabilitate' });
    strangerId = await seedUser({ orgId, email: 'stranger@x.ro', compartiment: '' });
    app = buildApp();
    _notified = [];
  });
  afterAll(() => pool.end());

  const initCookie = () => makeAuthCookie({ userId: initId, role: 'user', orgId, email: 'init@x.ro' });

  it('(1) inițiator transmite user → 200 added:1, rând source=manual, notificare REPARTIZAT', async () => {
    const flowId = await seedFlow('flow-m1', { orgId });
    const res = await request(app)
      .post(`/flows/${flowId}/transmit`)
      .set('Cookie', initCookie())
      .send({ recipients: [{ type: 'user', value: destId }] });
    expect(res.status).toBe(200);
    expect(res.body.added).toBe(1);

    const { rows } = await pool.query(
      `SELECT recipient_user_id, source FROM flow_recipients WHERE flow_id=$1`, [flowId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient_user_id).toBe(destId);
    expect(rows[0].source).toBe('manual');

    const rep = _notified.filter(n => n.type === 'REPARTIZAT');
    expect(rep.map(n => n.userEmail)).toContain('dest@x.ro');
  });

  it('(2) a doua transmitere aceiași destinatari → 200 added:0 alreadyPresent:1', async () => {
    const flowId = await seedFlow('flow-m2', { orgId });
    await request(app).post(`/flows/${flowId}/transmit`).set('Cookie', initCookie())
      .send({ recipients: [{ type: 'user', value: destId }] });
    _notified = [];
    const res = await request(app).post(`/flows/${flowId}/transmit`).set('Cookie', initCookie())
      .send({ recipients: [{ type: 'user', value: destId }] });
    expect(res.status).toBe(200);
    expect(res.body.added).toBe(0);
    expect(res.body.alreadyPresent).toBe(1);
    // niciun rând nou → nicio re-notificare
    expect(_notified.filter(n => n.type === 'REPARTIZAT')).toHaveLength(0);
    const { rows } = await pool.query('SELECT COUNT(*)::int n FROM flow_recipients WHERE flow_id=$1', [flowId]);
    expect(rows[0].n).toBe(1);
  });

  it('(3) destinatar tip comp → 200; toți userii din compartiment primesc REPARTIZAT', async () => {
    const flowId = await seedFlow('flow-m3', { orgId });
    const res = await request(app).post(`/flows/${flowId}/transmit`).set('Cookie', initCookie())
      .send({ recipients: [{ type: 'comp', value: 'Contabilitate', rezolutie: 'Spre conformare' }] });
    expect(res.status).toBe(200);
    expect(res.body.added).toBe(1);
    const emails = _notified.filter(n => n.type === 'REPARTIZAT').map(n => n.userEmail).sort();
    expect(emails).toEqual(['compu2@x.ro', 'compu@x.ro'].sort());
    // rezoluția persistată
    const { rows } = await pool.query(
      `SELECT recipient_compartiment, rezolutie FROM flow_recipients WHERE flow_id=$1`, [flowId]);
    expect(rows[0].recipient_compartiment).toBe('Contabilitate');
    expect(rows[0].rezolutie).toBe('Spre conformare');
  });

  it('(4a) străin autentificat → 403', async () => {
    const flowId = await seedFlow('flow-m4a', { orgId });
    const res = await request(app).post(`/flows/${flowId}/transmit`)
      .set('Cookie', makeAuthCookie({ userId: strangerId, role: 'user', orgId, email: 'stranger@x.ro' }))
      .send({ recipients: [{ type: 'user', value: destId }] });
    expect(res.status).toBe(403);
  });

  it('(4b) flux nefinalizat → 409', async () => {
    const flowId = await seedFlow('flow-m4b', { orgId, completed: false });
    const res = await request(app).post(`/flows/${flowId}/transmit`).set('Cookie', initCookie())
      .send({ recipients: [{ type: 'user', value: destId }] });
    expect(res.status).toBe(409);
  });

  it('(4c) recipients gol/invalid → 400', async () => {
    const flowId = await seedFlow('flow-m4c', { orgId });
    const empty = await request(app).post(`/flows/${flowId}/transmit`).set('Cookie', initCookie())
      .send({ recipients: [] });
    expect(empty.status).toBe(400);
    const invalid = await request(app).post(`/flows/${flowId}/transmit`).set('Cookie', initCookie())
      .send({ recipients: [{ type: 'bogus', value: 1 }] });
    expect(invalid.status).toBe(400);
  });

  it('(4d) anonim → 401', async () => {
    const flowId = await seedFlow('flow-m4d', { orgId });
    const res = await request(app).post(`/flows/${flowId}/transmit`)
      .send({ recipients: [{ type: 'user', value: destId }] });
    expect(res.status).toBe(401);
  });

  it('(6) destinatar = chiar un semnatar → 200 added:0 skippedHasAccess:1, mesaj informativ, ZERO notificări (fix 44)', async () => {
    const flowId = await seedFlow('flow-m6', { orgId, signers: [{ email: 'dest@x.ro', status: 'signed' }] });
    const res = await request(app).post(`/flows/${flowId}/transmit`).set('Cookie', initCookie())
      .send({ recipients: [{ type: 'user', value: destId }] });
    expect(res.status).toBe(200);
    expect(res.body.added).toBe(0);
    expect(res.body.skippedHasAccess).toBe(1);
    expect(res.body.message).toMatch(/deja acces/);
    expect(_notified.filter(n => n.type === 'REPARTIZAT')).toHaveLength(0);
    const { rows } = await pool.query('SELECT COUNT(*)::int n FROM flow_recipients WHERE flow_id=$1', [flowId]);
    expect(rows[0].n).toBe(0);
  });

  it('(7) destinatar = compartiment cu semnatar + ne-semnatar → rândul se creează, doar ne-semnatarul e notificat (fix 44)', async () => {
    const flowId = await seedFlow('flow-m7', { orgId, signers: [{ email: 'compu@x.ro', status: 'signed' }] });
    const res = await request(app).post(`/flows/${flowId}/transmit`).set('Cookie', initCookie())
      .send({ recipients: [{ type: 'comp', value: 'Contabilitate' }] });
    expect(res.status).toBe(200);
    expect(res.body.added).toBe(1);
    const emails = _notified.filter(n => n.type === 'REPARTIZAT').map(n => n.userEmail);
    expect(emails).toEqual(['compu2@x.ro']);
  });

  it('(8) destinatari user = semnatar + user = ne-semnatar → doar ne-semnatarul primește rând+notificare (fix 44)', async () => {
    const flowId = await seedFlow('flow-m8', { orgId, signers: [{ email: 'dest@x.ro', status: 'signed' }] });
    const res = await request(app).post(`/flows/${flowId}/transmit`).set('Cookie', initCookie())
      .send({ recipients: [{ type: 'user', value: destId }, { type: 'user', value: strangerId }] });
    expect(res.status).toBe(200);
    expect(res.body.added).toBe(1);
    expect(res.body.skippedHasAccess).toBe(1);
    const { rows } = await pool.query(
      `SELECT recipient_user_id FROM flow_recipients WHERE flow_id=$1`, [flowId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient_user_id).toBe(strangerId);
    const emails = _notified.filter(n => n.type === 'REPARTIZAT').map(n => n.userEmail);
    expect(emails).toEqual(['stranger@x.ro']);
  });

  it('(5) transmitere manuală scrie FLOW_TRANSMITTED în data.events[] și audit_log (fix 30 — trasabilitate)', async () => {
    const flowId = await seedFlow('flow-m5', { orgId });
    const res = await request(app).post(`/flows/${flowId}/transmit`).set('Cookie', initCookie())
      .send({ recipients: [{ type: 'user', value: destId, rezolutie: 'Verifică te rog' }] });
    expect(res.status).toBe(200);

    const { rows } = await pool.query('SELECT data FROM flows WHERE id=$1', [flowId]);
    const ev = (rows[0].data.events || []).find(e => e.type === 'FLOW_TRANSMITTED');
    expect(ev).toBeTruthy();
    expect(ev.recipientKey).toBe(`user:${destId}`);
    expect(ev.recipientLabel).toBeTruthy();
    expect(ev.source).toBe('manual');
    expect(ev.by).toBe('init@x.ro');
    expect(ev.rezolutie).toBe('Verifică te rog');

    const { rows: auditRows } = await pool.query(
      `SELECT payload FROM audit_log WHERE flow_id=$1 AND event_type='FLOW_TRANSMITTED'`, [flowId]);
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    expect(auditRows[0].payload.recipientKey).toBe(`user:${destId}`);
  });
});
