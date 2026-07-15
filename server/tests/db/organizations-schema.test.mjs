/**
 * Fresh-provision invariant (migrația 097_reconcile_organizations_columns): bootstrap-ul inline
 * creează `organizations` cu DOAR 3 coloane (id, name, created_at); V4 001 definește 17. Pe o bază
 * unde tabela există deja din bootstrap, CREATE TABLE IF NOT EXISTS din V4 e sărit → coloanele lipsesc
 * pe fresh-provision (a doua primărie = provisioning nou). Testul apără INVARIANTA: după migrații,
 * schema de test `organizations` are TOATE coloanele V4, iar un insert minimal aplică defaults.
 *
 * Golul ăsta a fost prins de #104 (7b) fiindcă schema de test diverge de producție (care a crescut
 * incremental). 097 îl reconciliază canonic; testul îl ține închis.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { hasTestDb, migrate, pool } from '../helpers/db-real.mjs';

const d = describe.skipIf(!hasTestDb());

// Toate cele 17 coloane din server/db/migrations/001_organizations.sql (sursa adevărului V4).
const V4_COLUMNS = [
  'id', 'name', 'slug', 'cif', 'status', 'plan',
  'signing_providers_enabled', 'signing_providers_config',
  'settings', 'branding', 'compartimente',
  'webhook_url', 'webhook_secret', 'webhook_events', 'webhook_enabled',
  'created_at', 'updated_at',
  // + cab_compartiment (migrația inline 092) — nu e în V4, dar face parte din schema curentă;
  //   nu-l cerem în invarianta V4, doar cele 17 de mai sus sunt obligatorii.
];

d('organizations — schema completă V4 după migrații (fresh-provision)', () => {
  beforeAll(migrate);

  it('conține toate cele 17 coloane V4 (comparație pe mulțime)', async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='organizations'`
    );
    const present = new Set(rows.map(r => r.column_name));
    const missing = V4_COLUMNS.filter(c => !present.has(c));
    expect(missing).toEqual([]);
  });

  it('INSERT minimal (name) reușește și aplică defaultul signing_providers_enabled', async () => {
    const { rows } = await pool.query(
      `INSERT INTO organizations (name) VALUES ('Test Fresh Org')
       RETURNING id, signing_providers_enabled, status, plan`
    );
    expect(rows[0].signing_providers_enabled).toEqual(['local-upload']);
    expect(rows[0].status).toBe('active');
    expect(rows[0].plan).toBe('starter');
  });

  it('SELECT signing_providers_enabled (path /my-flows) NU crapă pe rândul fresh', async () => {
    const { rows: ins } = await pool.query(
      `INSERT INTO organizations (name) VALUES ('Test My-Flows Org') RETURNING id`
    );
    const orgId = ins[0].id;
    // Exact proiecția pe care o face /my-flows (crud.mjs) — dovada că golul 7b e închis.
    const { rows } = await pool.query(
      `SELECT signing_providers_enabled FROM organizations WHERE id=$1`, [orgId]
    );
    expect(rows).toHaveLength(1);
    expect(Array.isArray(rows[0].signing_providers_enabled)).toBe(true);
  });
});
