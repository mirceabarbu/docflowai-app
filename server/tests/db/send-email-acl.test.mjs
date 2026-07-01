/**
 * v3.9.605 — IDOR de exfiltrare pe POST /flows/:id/send-email (server/tests/db/**, sursă CI).
 *
 * Înainte, ruta era protejată DOAR de requireAuth → orice user autentificat putea trimite
 * PDF-ul semnat + atașamentele + raportul de conformitate al ORICĂRUI flux finalizat către
 * adrese externe arbitrare, știind doar flowId. Acum aplică authz la nivel de obiect prin
 * canActorReadFlow (inițiator / semnatar / admin same-org) — aliniat cu email-stats.
 *
 * Miezul fix-ului: străinul autentificat primește 403 (era 200/livrare). Legitimii (init /
 * semnatar / admin same-org) trec de poarta de authz (NU primesc 403 — se opresc mai departe
 * la config-ul de mail lipsă, ceea ce dovedește că authz a fost trecut). Anonim → 401.
 *
 * Validăm DOAR poarta de authz — RESEND_API_KEY e golit pentru a NU trimite email real:
 * legitimii ajung la 503 mail_not_configured (≠ 403), străinul e blocat la 403 înainte.
 *
 * Auto-skip fără TEST_DATABASE_URL (npm test rămâne verde); rulează în CI cu Postgres real.
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

const emailRouter = (await import('../../routes/flows/email.mjs')).default;

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use('/', emailRouter);
  return app;
}

const FLOW_ID = 'flow-sendmail-acl-1';
const B64 = Buffer.from('hello-pdf').toString('base64');

const d = describe.skipIf(!hasTestDb());

d('IDOR exfiltrare send-email — authz la nivel de obiect (v3.9.605)', () => {
  let app, orgId, initId, signerId, strangerId, adminId;
  let prevResendKey;

  beforeAll(async () => {
    await migrate();
    // Golim cheia Resend → send-email se oprește la 503 mail_not_configured DUPĂ poarta de
    // authz, deci NU trimite email real, dar dovedește că authz a fost trecut (≠ 403).
    prevResendKey = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
  });
  afterAll(async () => {
    if (prevResendKey !== undefined) process.env.RESEND_API_KEY = prevResendKey;
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll();
    await pool.query('DELETE FROM flows_pdfs');

    const o = await seedOrgUser({ email: 'init@x.ro', role: 'user' });
    orgId = o.orgId; initId = o.userId;
    signerId   = await seedUser({ orgId, email: 'sig@x.ro' });
    strangerId = await seedUser({ orgId, email: 'stranger@x.ro' });
    adminId    = await seedUser({ orgId, email: 'admin@x.ro', role: 'org_admin' });

    await pool.query(
      `INSERT INTO flows (id, data, org_id) VALUES ($1, $2::jsonb, $3)`,
      [FLOW_ID, JSON.stringify({
        flowId: FLOW_ID, status: 'completed', completed: true, orgId,
        initEmail: 'init@x.ro', docName: 'Doc', flowType: 'ancore',
        signers: [{ name: 'S', email: 'sig@x.ro' }],
      }), orgId]
    );
    await pool.query(`INSERT INTO flows_pdfs (flow_id, key, data) VALUES ($1, 'signedPdfB64', $2)`, [FLOW_ID, B64]);

    app = buildApp();
  });

  const cookie = (u) => makeAuthCookie(u);
  const send = (u) => {
    const r = request(app).post(`/flows/${FLOW_ID}/send-email`).send({ to: 'ext@example.com', subject: 'Test' });
    return u ? r.set('Cookie', cookie(u)) : r;
  };

  it('străin autentificat (same-org, non-init/signer/admin) → 403 [miezul fix-ului]', async () => {
    const res = await send({ userId: strangerId, role: 'user', orgId, email: 'stranger@x.ro' });
    expect(res.status).toBe(403);
  });

  it('inițiator → NU 403 (trece de authz)', async () => {
    const res = await send({ userId: initId, role: 'user', orgId, email: 'init@x.ro' });
    expect(res.status).not.toBe(403);
  });

  it('semnatar (după email) → NU 403', async () => {
    const res = await send({ userId: signerId, role: 'user', orgId, email: 'sig@x.ro' });
    expect(res.status).not.toBe(403);
  });

  it('admin same-org → NU 403', async () => {
    const res = await send({ userId: adminId, role: 'org_admin', orgId, email: 'admin@x.ro' });
    expect(res.status).not.toBe(403);
  });

  it('anonim → 401', async () => {
    const res = await send(null);
    expect(res.status).toBe(401);
  });
});
