/**
 * #131b Etapa A — GET /api/formulare/utilizatori-org exclude utilizatorii soft-șterși
 * (deleted_at, migrația 067). Ruta scăpase de regula #52 ("dezactivații ies din toate
 * dropdown-urile de semnatari și destinatari"); fără filtru, modalul de Responsabil CAB
 * listează conturi șterse.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { hasTestDb, migrate, truncateAll, pool, seedOrgUser, seedUser, makeAuthCookie } from '../helpers/db-real.mjs';

vi.mock('../../middleware/csrf.mjs', () => ({ csrfMiddleware: (_req, _res, next) => next() }));
vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  redactUrl: (u) => u,
}));

const { formulareDbRouter } = await import('../../routes/formulare/index.mjs');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/', formulareDbRouter);
  return app;
}

const d = describe.skipIf(!hasTestDb());

d('#131b — utilizatori-org filtrează utilizatorii dezactivați', () => {
  let app;
  beforeAll(async () => { if (hasTestDb()) { await migrate(); app = buildApp(); } });
  beforeEach(async () => { if (hasTestDb()) await truncateAll(); });
  afterAll(async () => { if (hasTestDb()) await pool.end(); });

  it('un utilizator soft-șters lipsește din răspuns; unul activ e prezent', async () => {
    const { orgId, userId: actorId } = await seedOrgUser({ email: 'actor@x.ro', role: 'user', compartiment: 'CAB' });
    const activeId = await seedUser({ orgId, email: 'activ@x.ro', nume: 'Activ', compartiment: 'CAB' });
    const deletedId = await seedUser({ orgId, email: 'sters@x.ro', nume: 'Sters', compartiment: 'CAB' });
    await pool.query('UPDATE users SET deleted_at=NOW() WHERE id=$1', [deletedId]);

    const res = await request(app).get('/api/formulare/utilizatori-org')
      .set('Cookie', makeAuthCookie({ userId: actorId, role: 'user', orgId }));

    expect(res.status).toBe(200);
    const ids = (res.body.users || []).map((u) => u.id);
    expect(ids).toContain(activeId);
    expect(ids).not.toContain(deletedId);
  });
});
