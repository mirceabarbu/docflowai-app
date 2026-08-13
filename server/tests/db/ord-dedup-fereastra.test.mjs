/**
 * test:db — #124e′: idempotență POST /api/formulare-ord pe FEREASTRĂ DE TIMP (10s),
 * NU pe cheie unică — ORD nu are revizii, deci mai multe ordonanțări legitime pe același
 * dosar ALOP (fiecare cu alt nr_ordonant_pl) NU trebuie blocate. Vezi PROMPT-124e′.
 *
 * ⛔ Rută REALĂ (ord.mjs) peste Postgres real — nu se redeclară logica gărzii aici.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedAlop, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('#124e′ — ORD dedup pe fereastră de 10s (fără index unic)', () => {
  let app, orgId, userId, cookie;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    ({ orgId, userId } = await seedOrgUser({ role: 'user', email: 'p1@x.ro' }));
    cookie = makeAuthCookie({ userId, role: 'user', orgId });
    app = buildApp();
  });
  afterAll(() => pool.end());

  it('#1 două POST-uri consecutive, același source_alop_id ⇒ al doilea 200 dedup, ACELAȘI id', async () => {
    const alopId = await seedAlop({ orgId, createdBy: userId });

    const p1 = await request(app).post('/api/formulare-ord').set('Cookie', cookie).send({
      source_alop_id: alopId, nr_ordonant_pl: 'ORD-DEDUP-1',
    });
    expect(p1.status).toBe(200);
    expect(p1.body.deduplicated).toBeUndefined();

    const p2 = await request(app).post('/api/formulare-ord').set('Cookie', cookie).send({
      source_alop_id: alopId, nr_ordonant_pl: 'ORD-DEDUP-2',
    });
    expect(p2.status).toBe(200);
    expect(p2.body.deduplicated).toBe(true);
    expect(p2.body.document.id).toBe(p1.body.document.id);

    const { rows: count } = await pool.query(
      `SELECT COUNT(*) FROM formulare_ord WHERE source_alop_id = $1`, [alopId]
    );
    expect(Number(count[0].count)).toBe(1);
  });

  it('#2 ⭐ în afara ferestrei (>10s) ⇒ ORD nou (invariant de produs: ordonanțări multiple sunt legitime)', async () => {
    const alopId = await seedAlop({ orgId, createdBy: userId });

    const p1 = await request(app).post('/api/formulare-ord').set('Cookie', cookie).send({
      source_alop_id: alopId, nr_ordonant_pl: 'ORD-WIN-1',
    });
    expect(p1.status).toBe(200);

    await pool.query(
      `UPDATE formulare_ord SET created_at = NOW() - INTERVAL '1 minute' WHERE id = $1`,
      [p1.body.document.id]
    );

    const p2 = await request(app).post('/api/formulare-ord').set('Cookie', cookie).send({
      source_alop_id: alopId, nr_ordonant_pl: 'ORD-WIN-2',
    });
    expect(p2.status).toBe(200);
    expect(p2.body.deduplicated).toBeUndefined();
    expect(p2.body.document.id).not.toBe(p1.body.document.id);

    const { rows: count } = await pool.query(
      `SELECT COUNT(*) FROM formulare_ord WHERE source_alop_id = $1`, [alopId]
    );
    expect(Number(count[0].count)).toBe(2);
  });

  it('#3 alt utilizator, aceeași organizație, în fereastră ⇒ ORD nou (cheia include created_by)', async () => {
    const alopId = await seedAlop({ orgId, createdBy: userId });
    const user2 = await seedUser({ orgId, email: 'p2-same-org@x.ro' });
    const cookie2 = makeAuthCookie({ userId: user2, role: 'user', orgId });

    const p1 = await request(app).post('/api/formulare-ord').set('Cookie', cookie).send({
      source_alop_id: alopId, nr_ordonant_pl: 'ORD-USR-1',
    });
    expect(p1.status).toBe(200);

    const p2 = await request(app).post('/api/formulare-ord').set('Cookie', cookie2).send({
      source_alop_id: alopId, nr_ordonant_pl: 'ORD-USR-2',
    });
    expect(p2.status).toBe(200);
    expect(p2.body.deduplicated).toBeUndefined();
    expect(p2.body.document.id).not.toBe(p1.body.document.id);

    const { rows: count } = await pool.query(
      `SELECT COUNT(*) FROM formulare_ord WHERE source_alop_id = $1`, [alopId]
    );
    expect(Number(count[0].count)).toBe(2);
  });

  it('#4 primul ORD soft-șters ⇒ al doilea POST creează unul nou', async () => {
    const alopId = await seedAlop({ orgId, createdBy: userId });

    const p1 = await request(app).post('/api/formulare-ord').set('Cookie', cookie).send({
      source_alop_id: alopId, nr_ordonant_pl: 'ORD-DEL-1',
    });
    expect(p1.status).toBe(200);

    await pool.query(`UPDATE formulare_ord SET deleted_at = NOW() WHERE id = $1`, [p1.body.document.id]);

    const p2 = await request(app).post('/api/formulare-ord').set('Cookie', cookie).send({
      source_alop_id: alopId, nr_ordonant_pl: 'ORD-DEL-2',
    });
    expect(p2.status).toBe(200);
    expect(p2.body.deduplicated).toBeUndefined();
    expect(p2.body.document.id).not.toBe(p1.body.document.id);
  });

  it('#5 fără source_alop_id ⇒ garda nu se aplică, două POST-uri = două documente', async () => {
    const p1 = await request(app).post('/api/formulare-ord').set('Cookie', cookie).send({
      nr_ordonant_pl: 'ORD-NOALOP-1',
    });
    expect(p1.status).toBe(200);

    const p2 = await request(app).post('/api/formulare-ord').set('Cookie', cookie).send({
      nr_ordonant_pl: 'ORD-NOALOP-2',
    });
    expect(p2.status).toBe(200);
    expect(p2.body.deduplicated).toBeUndefined();
    expect(p2.body.document.id).not.toBe(p1.body.document.id);
  });

  it('#6 alt org_id, același source_alop_id, în fereastră ⇒ ORD nou (garda e org-scopată)', async () => {
    const alopId = await seedAlop({ orgId, createdBy: userId });
    const { orgId: org2, userId: user2 } = await seedOrgUser({ orgName: 'Org 2', role: 'user', email: 'other@y.ro' });
    const cookie2 = makeAuthCookie({ userId: user2, role: 'user', orgId: org2 });

    const p1 = await request(app).post('/api/formulare-ord').set('Cookie', cookie).send({
      source_alop_id: alopId, nr_ordonant_pl: 'ORD-ORG-1',
    });
    expect(p1.status).toBe(200);

    // alopId aparține org-ului 1; un ORD creat de org2 cu ACELAȘI source_alop_id (indiferent
    // de coerența datelor) nu trebuie deduplicat împotriva rândului din org1.
    const p2 = await request(app).post('/api/formulare-ord').set('Cookie', cookie2).send({
      source_alop_id: alopId, nr_ordonant_pl: 'ORD-ORG-2',
    });
    expect(p2.status).toBe(200);
    expect(p2.body.deduplicated).toBeUndefined();
    expect(p2.body.document.id).not.toBe(p1.body.document.id);
  });
});
