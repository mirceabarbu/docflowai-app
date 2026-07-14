// DB (Postgres real) — validare Cod SSI blochează scrierea de coduri inexistente în
// bugetul Clasa 8. Verifică REZULTATUL (status code + starea din DB), nu ordinea apelurilor.
//
// Regula (owner, incident 13.07.2026):
//   - PUT / complete cu cod invalid ⇒ 400, documentul NU se modifică (rămâne editabil/reparabil).
//   - Buget Clasa 8 neimportat ⇒ 400 clasa8_neimportat (fail-closed).
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, getDf, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

const VALID = '02A670503710101'; // 15 caractere — codul valid din listă
const BAD   = '02A67050371010';  // 14 caractere — un caracter lipsă (cazul real observat)

async function seedClasa8(orgId, codes) {
  const { rows } = await pool.query(
    `INSERT INTO clasa8_buget_versions (org_id, version_no, row_count, total_value)
     VALUES ($1, 1, $2, 0) RETURNING id`,
    [orgId, codes.length]
  );
  const vid = rows[0].id;
  for (const c of codes) {
    await pool.query(
      `INSERT INTO clasa8_buget (version_id, org_id, cod_ssi, valoare) VALUES ($1,$2,$3,0)`,
      [vid, orgId, c]
    );
  }
}

d('Cod SSI — blocare server-side vs bugetul Clasa 8', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' }); // id 1, org 1
    await seedUser({ orgId: 1, email: 'p2@x.ro' });         // id 2, org 1
    app = buildApp();
  });
  afterAll(() => pool.end());
  const p1 = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });
  const p2 = () => makeAuthCookie({ userId: 2, role: 'user', orgId: 1 });

  // ── #9 PUT cu cod invalid ⇒ 400 și documentul NU se modifică ────────────────────
  it('#9 PUT cu cod invalid ⇒ 400 cod_ssi_invalid; updated_at neschimbat', async () => {
    await seedClasa8(1, [VALID]);
    const id = await seedDf({ orgId: 1, createdBy: 1, status: 'draft' });
    const before = await getDf(id);

    const res = await request(app)
      .put(`/api/formulare-df/${id}`)
      .set('Cookie', p1())
      .send({ rows_val: [{ element_fd: 'X', codSSI: BAD }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('cod_ssi_invalid');
    expect(res.body.invalid[0]).toMatchObject({ tabel: 'rows_val', index: 0, cod: BAD });

    const after = await getDf(id);
    expect(after.updated_at.getTime()).toBe(before.updated_at.getTime()); // nimic scris
    expect(after.rows_val).toEqual([]); // rows_val a rămas gol (seed default)
  });

  // ── #10 PUT cu cod valid ⇒ 200, se salvează ─────────────────────────────────────
  it('#10 PUT cu cod valid ⇒ 200, rows_val persistat', async () => {
    await seedClasa8(1, [VALID]);
    const id = await seedDf({ orgId: 1, createdBy: 1, status: 'draft' });

    const res = await request(app)
      .put(`/api/formulare-df/${id}`)
      .set('Cookie', p1())
      .send({ rows_val: [{ element_fd: 'X', codSSI: VALID }] });

    expect(res.status).toBe(200);
    const after = await getDf(id);
    expect(after.rows_val[0].codSSI).toBe(VALID);
  });

  // ── #11 POST /complete cu cod invalid (persistat) ⇒ 400 ─────────────────────────
  it('#11 POST /complete cu cod invalid persistat ⇒ 400 cod_ssi_invalid', async () => {
    await seedClasa8(1, [VALID]);
    const id = await seedDf({
      orgId: 1, createdBy: 1, status: 'pending_p2', assignedTo: 2,
      rowsVal: [{ element_fd: 'X', codSSI: BAD }],
    });
    const res = await request(app)
      .post(`/api/formulare-df/${id}/complete`)
      .set('Cookie', p2())
      .send({ rows_ctrl: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('cod_ssi_invalid');
    expect((await getDf(id)).status).toBe('pending_p2'); // NU a avansat la completed
  });

  // ── #12 Org fără buget importat ⇒ 400 clasa8_neimportat ─────────────────────────
  it('#12 PUT cu cod, dar clasa8_buget gol ⇒ 400 clasa8_neimportat', async () => {
    const id = await seedDf({ orgId: 1, createdBy: 1, status: 'draft' });
    const res = await request(app)
      .put(`/api/formulare-df/${id}`)
      .set('Cookie', p1())
      .send({ rows_val: [{ element_fd: 'X', codSSI: VALID }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('clasa8_neimportat');
    expect((await getDf(id)).rows_val).toEqual([]);
  });

  // ── rândurile cu cod gol NU se blochează, chiar și fără buget ────────────────────
  it('PUT fără coduri (rânduri goale) ⇒ 200 chiar și cu buget gol', async () => {
    const id = await seedDf({ orgId: 1, createdBy: 1, status: 'draft' });
    const res = await request(app)
      .put(`/api/formulare-df/${id}`)
      .set('Cookie', p1())
      .send({ subtitlu_df: 'doar titlu', rows_val: [{ element_fd: 'X', codSSI: '' }] });
    expect(res.status).toBe(200);
  });
});
