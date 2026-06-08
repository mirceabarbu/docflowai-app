// Anti-shadowing (Etapa 2 refactor — split formulare-db.mjs → routes/formulare/).
// Confirmă că ruta STATICĂ GET /api/formulare-df/aprobate NU e prinsă de ruta
// PARAM GET /api/formulare-df/:id după split. Express potrivește în ordinea
// înregistrării; dacă `:id` ar fi înaintea lui `aprobate`, am primi handlerul de
// document unic (cu id="aprobate") → 404/eroare în loc de lista de DF aprobate.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('GET /api/formulare-df/aprobate (anti-shadowing)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' }); // id 1, org 1
    app = buildApp();
  });
  afterAll(() => pool.end());
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  it('NU e prins de :id → 200 + listă (nu handler de document unic)', async () => {
    const res = await request(app).get('/api/formulare-df/aprobate').set('Cookie', cookie());
    // handlerul corect (listă aprobate) răspunde 200; handlerul :id ar da 404 (id="aprobate" inexistent)
    expect(res.status).toBe(200);
    // forma de listă: { ok: true, documents: [...] }, nu un singur { document }
    expect(Array.isArray(res.body.documents)).toBe(true);
    expect(res.body.document).toBeUndefined();
  });
});
