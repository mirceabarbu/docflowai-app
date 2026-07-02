/**
 * Bădge sidebar „📥 Primite" — GET /api/my-received/count (Etapa 37).
 *
 * Verifică ruta REALĂ peste Postgres real (server/tests/db/**, auto-skip fără
 * TEST_DATABASE_URL; sursa de adevăr = CI). Acoperă:
 *  (1) user cu 2 repartizări neconfirmate → count:2.
 *  (2) confirmă una → count:1.
 *  (3) user fără nicio repartizare → count:0.
 *  (4) anonim → 401.
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

async function seedFlow(id, { orgId, initEmail = 'init@x.ro' } = {}) {
  await pool.query(
    `INSERT INTO flows (id, data, org_id) VALUES ($1, $2::jsonb, $3)`,
    [id, JSON.stringify({ status: 'completed', completed: true, orgId, initEmail, docName: 'Doc Test', signers: [] }), orgId]
  );
  return id;
}

const d = describe.skipIf(!hasTestDb());

d('GET /api/my-received/count', () => {
  let app, orgId, initId, destId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    const o = await seedOrgUser({ email: 'init@x.ro', role: 'user' });
    orgId = o.orgId; initId = o.userId;
    destId = await seedUser({ orgId, email: 'dest@x.ro', compartiment: '' });
    app = buildApp();
  });
  afterAll(() => pool.end());

  const initCookie = () => makeAuthCookie({ userId: initId, role: 'user', orgId, email: 'init@x.ro' });
  const destCookie = () => makeAuthCookie({ userId: destId, role: 'user', orgId, email: 'dest@x.ro' });

  it('(1) user cu 2 repartizări neconfirmate → count:2', async () => {
    const flow1 = await seedFlow('flow-c1', { orgId });
    const flow2 = await seedFlow('flow-c2', { orgId });
    await request(app).post(`/flows/${flow1}/transmit`).set('Cookie', initCookie())
      .send({ recipients: [{ type: 'user', value: destId }] });
    await request(app).post(`/flows/${flow2}/transmit`).set('Cookie', initCookie())
      .send({ recipients: [{ type: 'user', value: destId }] });

    const res = await request(app).get('/api/my-received/count').set('Cookie', destCookie());
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
  });

  it('(2) confirmă una → count:1', async () => {
    const flow1 = await seedFlow('flow-c3', { orgId });
    const flow2 = await seedFlow('flow-c4', { orgId });
    await request(app).post(`/flows/${flow1}/transmit`).set('Cookie', initCookie())
      .send({ recipients: [{ type: 'user', value: destId }] });
    await request(app).post(`/flows/${flow2}/transmit`).set('Cookie', initCookie())
      .send({ recipients: [{ type: 'user', value: destId }] });

    await request(app).post(`/flows/${flow1}/acknowledge`).set('Cookie', destCookie());

    const res = await request(app).get('/api/my-received/count').set('Cookie', destCookie());
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });

  it('(3) user fără nicio repartizare → count:0', async () => {
    const res = await request(app).get('/api/my-received/count').set('Cookie', destCookie());
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });

  it('(4) anonim → 401', async () => {
    const res = await request(app).get('/api/my-received/count');
    expect(res.status).toBe(401);
  });
});
