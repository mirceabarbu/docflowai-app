/**
 * migrations-advisory-lock.test.mjs (P0.1)
 *
 * runMigrations (migrate.mjs) ia un pg_advisory_lock pe o conexiune dedicată ÎNAINTE
 * de a aplica migrările și îl eliberează în finally. Asta serializează două instanțe
 * concurente (rolling deploy Railway) — fără lock, două INSERT-uri simultane în
 * schema_migrations (ex. force-rerun 014_alop) ar putea da unique-violation / cursă.
 *
 * Testul:
 *  1. pre-marchează toate fișierele *.sql ca applied → runMigrations devine ~no-op
 *     (singura excepție: 014_alop, force-rerun idempotent).
 *  2. rulează DOUĂ runMigrations CONCURENT → ambele trebuie să rezolve fără eroare
 *     și fără deadlock (dovedește lock acquire + unlock corecte pe conexiune dedicată).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasTestDb, migrate, pool } from '../helpers/db-real.mjs';
import { runMigrations } from '../../db/migrate.mjs';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../db/migrations');

const d = describe.skipIf(!hasTestDb())('runMigrations — advisory lock', () => {
  beforeAll(async () => {
    await migrate();
    // Marchează toate fișierele V4 ca applied → runMigrations nu re-aplică (cu excepția
    // force-rerun-ului idempotent 014_alop), ca să izolăm testul pe mecanismul de lock.
    const files = (await readdir(MIGRATIONS_DIR)).filter(f => f.endsWith('.sql'));
    const ids = files.map(f => f.replace(/\.sql$/, ''));
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`INSERT INTO schema_migrations (id) SELECT unnest($1::text[]) ON CONFLICT (id) DO NOTHING`, [ids]);
  });

  it('rulează idempotent (toate aplicate) fără eroare', async () => {
    await expect(runMigrations(pool)).resolves.toBeUndefined();
  });

  it('două rulări CONCURENTE rezolvă fără deadlock / unique-violation', async () => {
    await expect(Promise.all([runMigrations(pool), runMigrations(pool)])).resolves.toBeDefined();
    // lock-ul a fost eliberat → o nouă rulare reușește în continuare
    await expect(runMigrations(pool)).resolves.toBeUndefined();
  });

  it('014_alop rămâne marcat applied după force-rerun', async () => {
    await runMigrations(pool);
    const { rows } = await pool.query(`SELECT 1 FROM schema_migrations WHERE id='014_alop'`);
    expect(rows.length).toBe(1);
  });
});

export default d;
