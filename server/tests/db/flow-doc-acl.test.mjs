/**
 * v3.9.603 — IDOR pe documente de flux (server/tests/db/**, sursă de adevăr CI).
 *
 * GET /flows/:id/signed-pdf, /pdf, /attachments (listă) și /attachments/:attId
 * aplică acum authz la nivel de obiect: isFlowAccessAllowed = canActorReadFlow ∪
 * destinatar repartizat (flow_recipients). Înainte, ORICE user autentificat servea
 * PDF-ul semnat / atașamentele oricărui flux dacă știa flowId.
 *
 * Non-regresie (miezul): străinul autentificat primește acum 403 pe toate 4 (era 200).
 * Legitim: init / admin same-org / semnatar via token / destinatar (user) / destinatar
 * (compartiment) → 200; anonim fără token → 403.
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
import { transmitFlowTo } from '../../services/flow-transmit.mjs';

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  redactUrl: (u) => u,
}));

const crudMod = await import('../../routes/flows/crud.mjs');
const crudRouter = crudMod.default;
const attachmentsRouter = (await import('../../routes/flows/attachments.mjs')).default;
// signed-pdf/pdf nu folosesc deps injectate (lăsăm _PDFLib undefined → serve direct bytes).
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

const FLOW_ID = 'flow-acl-doc-1';
const SIGNER_TOKEN = 'sig-token-doc-001';
const B64 = Buffer.from('hello-pdf').toString('base64');

const d = describe.skipIf(!hasTestDb());

d('IDOR documente flux — authz la nivel de obiect (v3.9.603)', () => {
  let app, orgId, initId, signerId, destId, compUserId, strangerId, adminId, attId;

  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    // flow_attachments/flows_pdfs/flow_recipients nu au FK→flows (sau nu se golesc prin CASCADE) → curăț explicit.
    await pool.query('DELETE FROM flow_attachments');
    await pool.query('DELETE FROM flows_pdfs');
    await pool.query('DELETE FROM flow_recipients');

    const o = await seedOrgUser({ email: 'init@x.ro', role: 'user' });
    orgId = o.orgId; initId = o.userId;
    signerId   = await seedUser({ orgId, email: 'sig@x.ro',     compartiment: '' });
    destId     = await seedUser({ orgId, email: 'dest@x.ro',    compartiment: '' });
    compUserId = await seedUser({ orgId, email: 'compu@x.ro',   compartiment: 'Contabilitate' });
    strangerId = await seedUser({ orgId, email: 'stranger@x.ro', compartiment: '' });
    adminId    = await seedUser({ orgId, email: 'admin@x.ro',   role: 'org_admin', compartiment: '' });

    await pool.query(
      `INSERT INTO flows (id, data, org_id) VALUES ($1, $2::jsonb, $3)`,
      [FLOW_ID, JSON.stringify({
        flowId: FLOW_ID, status: 'completed', completed: true, orgId,
        initEmail: 'init@x.ro', docName: 'Doc', flowType: 'ancore',
        signers: [{ name: 'S', email: 'sig@x.ro', token: SIGNER_TOKEN }],
      }), orgId]
    );
    await pool.query(`INSERT INTO flows_pdfs (flow_id, key, data) VALUES ($1, 'pdfB64', $2)`, [FLOW_ID, B64]);
    await pool.query(`INSERT INTO flows_pdfs (flow_id, key, data) VALUES ($1, 'signedPdfB64', $2)`, [FLOW_ID, B64]);
    const att = await pool.query(
      `INSERT INTO flow_attachments (flow_id, filename, mime_type, size_bytes, data)
       VALUES ($1, 'a.pdf', 'application/pdf', 9, $2) RETURNING id`,
      [FLOW_ID, Buffer.from('hello-pdf')]
    );
    attId = att.rows[0].id;

    // Destinatari repartizați: user dest + compartiment Contabilitate (compUser e membru).
    await transmitFlowTo(pool, {
      flowId: FLOW_ID, orgId, transmittedBy: null, source: 'auto',
      recipients: [{ type: 'user', value: destId }, { type: 'comp', value: 'Contabilitate' }],
    });
    app = buildApp();
  });
  afterAll(() => pool.end());

  // Cele 4 endpointuri de conținut. `q(token)` întoarce query-string cu ?token= pentru semnatar.
  const endpoints = [
    { name: 'signed-pdf',       url: (t) => `/flows/${FLOW_ID}/signed-pdf${t}` },
    { name: 'pdf',              url: (t) => `/flows/${FLOW_ID}/pdf${t}` },
    { name: 'attachments list', url: (t) => `/flows/${FLOW_ID}/attachments${t}` },
    { name: 'attachment file',  url: (t) => `/flows/${FLOW_ID}/attachments/${attId}${t}` },
  ];

  const cookie = (u) => makeAuthCookie(u);

  for (const ep of endpoints) {
    describe(ep.name, () => {
      it('străin autentificat (same-org, non-init/signer/recipient) → 403 [non-regresie IDOR]', async () => {
        const res = await request(app).get(ep.url(''))
          .set('Cookie', cookie({ userId: strangerId, role: 'user', orgId, email: 'stranger@x.ro' }));
        expect(res.status).toBe(403);
      });

      it('inițiator → 200', async () => {
        const res = await request(app).get(ep.url(''))
          .set('Cookie', cookie({ userId: initId, role: 'user', orgId, email: 'init@x.ro' }));
        expect(res.status).toBe(200);
      });

      it('admin same-org → 200', async () => {
        const res = await request(app).get(ep.url(''))
          .set('Cookie', cookie({ userId: adminId, role: 'org_admin', orgId, email: 'admin@x.ro' }));
        expect(res.status).toBe(200);
      });

      it('semnatar via token → 200', async () => {
        const res = await request(app).get(ep.url(`?token=${SIGNER_TOKEN}`));
        expect(res.status).toBe(200);
      });

      it('destinatar repartizat (user) → 200', async () => {
        const res = await request(app).get(ep.url(''))
          .set('Cookie', cookie({ userId: destId, role: 'user', orgId, email: 'dest@x.ro' }));
        expect(res.status).toBe(200);
      });

      it('destinatar prin compartiment → 200', async () => {
        const res = await request(app).get(ep.url(''))
          .set('Cookie', cookie({ userId: compUserId, role: 'user', orgId, email: 'compu@x.ro' }));
        expect(res.status).toBe(200);
      });

      it('anonim fără token → 403', async () => {
        const res = await request(app).get(ep.url(''));
        expect(res.status).toBe(403);
      });
    });
  }
});
