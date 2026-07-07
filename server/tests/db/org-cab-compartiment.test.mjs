/**
 * Compartiment CAB implicit la nivel de organizație (prompt-59).
 * PUT /admin/organizations/:id — validare cab_compartiment ∈ compartimente.
 * GET /api/formulare/utilizatori-org — expune cab_compartiment al org-ului actorului.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { hasTestDb, migrate, truncateAll, pool, seedOrgUser, makeAuthCookie } from '../helpers/db-real.mjs';

vi.mock('../../middleware/csrf.mjs', () => ({ csrfMiddleware: (_req, _res, next) => next() }));
vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  redactUrl: (u) => u,
}));

const orgRouter = (await import('../../routes/admin/organizations.mjs')).default;
const { formulareDbRouter } = await import('../../routes/formulare/index.mjs');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/', orgRouter);
  app.use('/', formulareDbRouter);
  return app;
}

const d = describe.skipIf(!hasTestDb());

d('Compartiment CAB implicit — org', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    app = buildApp();
  });
  afterAll(() => pool.end());

  it('PUT cab_compartiment valid (∈ compartimente) → 200 + persistă', async () => {
    const { orgId } = await seedOrgUser({ email: 'admin@x.ro', role: 'admin' });
    await pool.query('UPDATE organizations SET compartimente=$1 WHERE id=$2',
      [['Serviciul Buget', 'Alt Compartiment'], orgId]);
    const res = await request(app).put(`/admin/organizations/${orgId}`)
      .set('Cookie', makeAuthCookie({ userId: 1, role: 'admin', orgId }))
      .send({ cab_compartiment: 'Serviciul Buget' });
    expect(res.status).toBe(200);
    expect(res.body.org.cab_compartiment).toBe('Serviciul Buget');
    const { rows } = await pool.query('SELECT cab_compartiment FROM organizations WHERE id=$1', [orgId]);
    expect(rows[0].cab_compartiment).toBe('Serviciul Buget');
  });

  it('PUT cab_compartiment invalid (nu e în compartimente) → 400', async () => {
    const { orgId } = await seedOrgUser({ email: 'admin@x.ro', role: 'admin' });
    await pool.query('UPDATE organizations SET compartimente=$1 WHERE id=$2',
      [['Serviciul Buget'], orgId]);
    const res = await request(app).put(`/admin/organizations/${orgId}`)
      .set('Cookie', makeAuthCookie({ userId: 1, role: 'admin', orgId }))
      .send({ cab_compartiment: 'Compartiment Inexistent' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('cab_compartiment_invalid');
    const { rows } = await pool.query('SELECT cab_compartiment FROM organizations WHERE id=$1', [orgId]);
    expect(rows[0].cab_compartiment).toBeNull();
  });

  it('PUT cab_compartiment gol → NULL (dezactivează default-ul)', async () => {
    const { orgId } = await seedOrgUser({ email: 'admin@x.ro', role: 'admin' });
    await pool.query('UPDATE organizations SET compartimente=$1, cab_compartiment=$2 WHERE id=$3',
      [['Serviciul Buget'], 'Serviciul Buget', orgId]);
    const res = await request(app).put(`/admin/organizations/${orgId}`)
      .set('Cookie', makeAuthCookie({ userId: 1, role: 'admin', orgId }))
      .send({ cab_compartiment: '' });
    expect(res.status).toBe(200);
    expect(res.body.org.cab_compartiment).toBeNull();
    const { rows } = await pool.query('SELECT cab_compartiment FROM organizations WHERE id=$1', [orgId]);
    expect(rows[0].cab_compartiment).toBeNull();
  });

  it('GET /api/formulare/utilizatori-org întoarce cab_compartiment al org-ului actorului', async () => {
    const { orgId, userId } = await seedOrgUser({ email: 'p1@x.ro', role: 'user', compartiment: 'Alt Compartiment' });
    await pool.query('UPDATE organizations SET compartimente=$1, cab_compartiment=$2 WHERE id=$3',
      [['Serviciul Buget', 'Alt Compartiment'], 'Serviciul Buget', orgId]);
    const res = await request(app).get('/api/formulare/utilizatori-org')
      .set('Cookie', makeAuthCookie({ userId, role: 'user', orgId }));
    expect(res.status).toBe(200);
    expect(res.body.cab_compartiment).toBe('Serviciul Buget');
  });
});
