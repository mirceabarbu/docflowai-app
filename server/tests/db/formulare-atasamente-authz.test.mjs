/**
 * B4 (v3.9.554) — atașamente DF/ORD prin lanțul REAL de middleware, peste DB real.
 *
 * Testele mock existente (server/tests/integration/formulare-atasamente*.test.mjs)
 * montează router-ul izolat cu csrf/authz mock-uite — au trecut 15/15 în timp ce
 * utilizatorii cu drepturi prin compartiment primeau 403 în producție. Acest fișier
 * exercită upload-ul binar (Content-Type non-JSON) printr-un app cu:
 *   - express.json adaptiv (ca în server/index.mjs — binarul trece raw la handler),
 *   - csrfMiddleware REAL (double-submit cookie + header),
 *   - authz-formular REAL (canEditFormular/canViewFormular cu compartimente din DB).
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, makeAuthCookie } from '../helpers/db-real.mjs';

// Doar logger-ul e mock-uit (zgomot în output) — csrf, require-module, authz, db: REALE.
vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  redactUrl: (u) => u,
}));

const { formulareDbRouter } = await import('../../routes/formulare/index.mjs');

function buildRealApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(cookieParser());
  // Mirror server/index.mjs: json adaptiv — parsează DOAR application/json;
  // upload-ul binar (application/pdf) trece raw la req.on('data') din handler.
  app.use((req, res, next) => express.json({ limit: '1mb' })(req, res, next));
  app.use('/', formulareDbRouter);
  return app;
}

const CSRF = 'test-csrf-token-atasamente';
// Cookie auth + cookie csrf (double-submit) — header-ul se setează separat per request.
const authz = (u) => `${makeAuthCookie(u)}; csrf_token=${CSRF}`;

const d = describe.skipIf(!hasTestDb());

d('formulare-atasamente — authz centralizat prin middleware real (B1/B4)', () => {
  let app, dfId;
  // user 1 = creator (comp Achizitii), 2 = assigned P2 (comp CAB),
  // 3 = coleg comp creator (Achizitii), 4 = coleg comp P2 (CAB), 5 = fără drepturi (Altul)
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    const { orgId } = await seedOrgUser({ role: 'user', email: 'p1@x.ro', compartiment: 'Achizitii' });
    await seedUser({ orgId, email: 'p2@x.ro',   compartiment: 'CAB' });
    await seedUser({ orgId, email: 'coleg-p1@x.ro', compartiment: 'Achizitii' });
    await seedUser({ orgId, email: 'coleg-p2@x.ro', compartiment: 'CAB' });
    await seedUser({ orgId, email: 'strain@x.ro',   compartiment: 'Altul' });
    dfId = await seedDf({ orgId, createdBy: 1, status: 'draft', assignedTo: 2, nrUnic: 'DF-ATT-1' });
    app = buildRealApp();
  });
  afterAll(() => pool.end());

  const upload = (userId, email, body = 'PDF-BYTES') =>
    request(app)
      .post(`/api/formulare-atasamente/df/${dfId}`)
      .set('Cookie', authz({ userId, role: 'user', orgId: 1, email }))
      .set('x-csrf-token', CSRF)
      .set('Content-Type', 'application/pdf')
      .set('X-Filename', 'doc.pdf')
      .send(Buffer.from(body));

  const countAtts = async () => {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM formulare_atasamente WHERE form_id=$1 AND deleted_at IS NULL`, [dfId]);
    return rows[0].n;
  };

  // ── upload binar per rol ──────────────────────────────────────────────────────
  it('creator → 200, rândul există în DB', async () => {
    const res = await upload(1, 'p1@x.ro');
    expect(res.status).toBe(200);
    expect(res.body.atasament.filename).toBe('doc.pdf');
    expect(await countAtts()).toBe(1);
  });

  it('assigned (P2) → 200', async () => {
    const res = await upload(2, 'p2@x.ro');
    expect(res.status).toBe(200);
    expect(await countAtts()).toBe(1);
  });

  it('coleg din compartimentul creatorului (comp) → 200 (fix B1 — vechiul authz dădea 403)', async () => {
    const res = await upload(3, 'coleg-p1@x.ro');
    expect(res.status).toBe(200);
    expect(await countAtts()).toBe(1);
  });

  it('coleg din compartimentul P2 (p2_comp) → 200 (fix B1)', async () => {
    const res = await upload(4, 'coleg-p2@x.ro');
    expect(res.status).toBe(200);
    expect(await countAtts()).toBe(1);
  });

  it('user fără drepturi → 403, niciun rând în DB', async () => {
    const res = await upload(5, 'strain@x.ro');
    expect(res.status).toBe(403);
    expect(await countAtts()).toBe(0);
  });

  // ── CSRF real pe lanț ─────────────────────────────────────────────────────────
  it('upload fără header x-csrf-token → 403 csrf_invalid (middleware real)', async () => {
    const res = await request(app)
      .post(`/api/formulare-atasamente/df/${dfId}`)
      .set('Cookie', authz({ userId: 1, role: 'user', orgId: 1, email: 'p1@x.ro' }))
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('x'));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('csrf_invalid');
  });

  // ── listă + download + delete cu drepturi prin compartiment ─────────────────────
  it('coleg comp: listă 200, download 200 cu bytes, delete 200 (soft)', async () => {
    const up = await upload(1, 'p1@x.ro', 'CONTENT-123');
    const attId = up.body.atasament.id;
    const cookie3 = authz({ userId: 3, role: 'user', orgId: 1, email: 'coleg-p1@x.ro' });

    const list = await request(app).get(`/api/formulare-atasamente/df/${dfId}`).set('Cookie', cookie3);
    expect(list.status).toBe(200);
    expect(list.body.atasamente.length).toBe(1);

    const dl = await request(app).get(`/api/formulare-atasamente/df/${dfId}/${attId}`).set('Cookie', cookie3);
    expect(dl.status).toBe(200);
    expect(dl.body.toString()).toBe('CONTENT-123');

    const del = await request(app).delete(`/api/formulare-atasamente/df/${dfId}/${attId}`)
      .set('Cookie', cookie3).set('x-csrf-token', CSRF);
    expect(del.status).toBe(200);
    expect(await countAtts()).toBe(0);
  });

  it('user fără drepturi: listă 403, download 403', async () => {
    const up = await upload(1, 'p1@x.ro');
    const attId = up.body.atasament.id;
    const cookie5 = authz({ userId: 5, role: 'user', orgId: 1, email: 'strain@x.ro' });

    const list = await request(app).get(`/api/formulare-atasamente/df/${dfId}`).set('Cookie', cookie5);
    expect(list.status).toBe(403);
    const dl = await request(app).get(`/api/formulare-atasamente/df/${dfId}/${attId}`).set('Cookie', cookie5);
    expect(dl.status).toBe(403);
  });

  // ── caracterizare păstrată: document_locked pe delete la completed (non-admin) ──
  it('delete pe DF completed (non-admin) → 409 document_locked (comportament păstrat)', async () => {
    const up = await upload(1, 'p1@x.ro');
    const attId = up.body.atasament.id;
    await pool.query(`UPDATE formulare_df SET status='completed' WHERE id=$1`, [dfId]);

    const del = await request(app).delete(`/api/formulare-atasamente/df/${dfId}/${attId}`)
      .set('Cookie', authz({ userId: 1, role: 'user', orgId: 1, email: 'p1@x.ro' }))
      .set('x-csrf-token', CSRF);
    expect(del.status).toBe(409);
    expect(del.body.error).toBe('document_locked');
    expect(await countAtts()).toBe(1);
  });

  // ── capturi: același authz centralizat (B1 acoperă și formulare-capturi) ────────
  it('capturi: coleg comp upload 200 + GET 200; user fără drepturi 403', async () => {
    const upC = await request(app)
      .post(`/api/formulare-capturi/df/${dfId}`)
      .set('Cookie', authz({ userId: 3, role: 'user', orgId: 1, email: 'coleg-p1@x.ro' }))
      .set('x-csrf-token', CSRF)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('PNG-BYTES'));
    expect(upC.status).toBe(200);

    const get3 = await request(app).get(`/api/formulare-capturi/df/${dfId}`)
      .set('Cookie', authz({ userId: 3, role: 'user', orgId: 1, email: 'coleg-p1@x.ro' }));
    expect(get3.status).toBe(200);

    const up5 = await request(app)
      .post(`/api/formulare-capturi/df/${dfId}`)
      .set('Cookie', authz({ userId: 5, role: 'user', orgId: 1, email: 'strain@x.ro' }))
      .set('x-csrf-token', CSRF)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('PNG'));
    expect(up5.status).toBe(403);
  });
});
