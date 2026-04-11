/**
 * server/db/migrate.mjs — SQL-file-based migration runner.
 *
 * Reads all *.sql files from migrations/ in alphabetical order.
 * Checks schema_migrations for already-applied IDs.
 * Runs only new migrations, each in its own transaction.
 */

import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../middleware/logger.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dir, 'migrations');

/**
 * Run all pending migrations against the given pg Pool.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<void>}
 */
export async function runMigrations(pool) {
  // Ensure the tracking table exists first (runs outside any transaction to avoid
  // "CREATE TABLE IF NOT EXISTS inside transaction" issues on some PG versions)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT        PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Force re-run 014_alop — migration rescrisă cu ALTER TABLE idempotent
  await pool.query(
    "DELETE FROM schema_migrations WHERE id='014_alop'"
  ).catch(() => {});

  // Read applied migration IDs
  const { rows: applied } = await pool.query('SELECT id FROM schema_migrations');
  const appliedIds = new Set(applied.map(r => r.id));

  // Discover migration files
  const files = (await readdir(MIGRATIONS_DIR))
    .filter(f => f.endsWith('.sql'))
    .sort();   // alphabetical = numerical order (000_, 001_, ...)

  let ranCount = 0;

  for (const filename of files) {
    const migId = filename.replace(/\.sql$/, '');

    if (appliedIds.has(migId)) {
      logger.info(`→ ${migId} already applied`);
      continue;
    }

    const sql = await readFile(join(MIGRATIONS_DIR, filename), 'utf8');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (id) VALUES ($1)',
        [migId]
      );
      await client.query('COMMIT');
      logger.info(`✓ ${migId} applied`);
      ranCount++;
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ err, migId }, `✗ ${migId} FAILED — rolled back`);
      throw err;
    } finally {
      client.release();
    }
  }

  if (ranCount === 0) {
    logger.info('Schema up to date (0 new migrations).');
  } else {
    logger.info({ count: ranCount }, `${ranCount} migration(s) applied.`);
  }
}
