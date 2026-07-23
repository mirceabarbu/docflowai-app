// TMPL-ORG (v3.9.739) — invariantul `templates_shared_needs_org` pe Postgres REAL.
// Un șablon shared=TRUE + org_id NULL e invizibil pentru toți în afară de proprietar
// (rând-fantomă dacă proprietarul e șters). Migrația 102 vindecă datele murdare ÎNTÂI,
// apoi adaugă CHECK (NOT (shared AND org_id IS NULL)).
// ⛔ Schema reală prin migrateForTests (helper db-real) — nu redeclara tabela.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { hasTestDb, migrate, truncateAll, pool } from '../helpers/db-real.mjs';

const d = describe.skipIf(!hasTestDb());

d('templates — invariant shared ⇒ org (migrația 102)', () => {
  let orgId;

  beforeAll(migrate);

  beforeEach(async () => {
    // truncateAll → TRUNCATE ... CASCADE curăță și tabelele care referențiază organizations
    // (formulare_df etc.) lăsate de alte fișiere de test; CASCADE golește și templates (FK org).
    await truncateAll();
    await pool.query('DELETE FROM templates');
    const { rows } = await pool.query(
      `INSERT INTO organizations (name) VALUES ('Org Invariant Test') RETURNING id`
    );
    orgId = rows[0].id;
  });

  const insert = (shared, org) => pool.query(
    `INSERT INTO templates (user_email, name, signers, shared, org_id)
     VALUES ('owner@x.ro', 'T', '[]'::jsonb, $1, $2) RETURNING id`,
    [shared, org]
  );

  it('constrângerea există (templates_shared_needs_org)', async () => {
    const { rows } = await pool.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'templates_shared_needs_org'`
    );
    expect(rows.length).toBe(1);
  });

  it('INSERT shared=TRUE, org_id=NULL → respins (23514)', async () => {
    await expect(insert(true, null)).rejects.toMatchObject({ code: '23514' });
  });

  it('INSERT shared=TRUE, org_id=<valid> → reușește', async () => {
    const { rows } = await insert(true, orgId);
    expect(rows[0].id).toBeGreaterThan(0);
  });

  it('INSERT shared=FALSE, org_id=NULL → reușește (privat fără org e permis)', async () => {
    const { rows } = await insert(false, null);
    expect(rows[0].id).toBeGreaterThan(0);
  });

  it('UPDATE shared=TRUE pe un rând cu org_id NULL → respins (23514)', async () => {
    const { rows } = await insert(false, null); // privat, permis
    await expect(
      pool.query(`UPDATE templates SET shared=TRUE WHERE id=$1`, [rows[0].id])
    ).rejects.toMatchObject({ code: '23514' });
  });
});
