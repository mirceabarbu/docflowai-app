/**
 * server/bootstrap.mjs — application startup and shutdown lifecycle.
 */

import config from './config.mjs';
import { pool } from './db/index.mjs';
import { runMigrations } from './db/migrate.mjs';
import { seedAdminUser } from './db/seeds/admin.mjs';
import { logger } from './middleware/logger.mjs';

export async function bootstrap() {
  logger.info(`DocFlowAI v4.0 starting... (env=${config.NODE_ENV})`);

  if (!pool) {
    throw new Error('DATABASE_URL is not configured — cannot start.');
  }

  // Connectivity check
  try {
    await pool.query('SELECT 1');
    logger.info('DB connection OK.');
  } catch (err) {
    throw new Error(`DB connection failed: ${err.message}`);
  }

  // Run pending SQL migrations
  await runMigrations(pool);

  // Seed default org + admin user (idempotent)
  await seedAdminUser();

  logger.info('Ready.');
}

export async function shutdown() {
  logger.info('Shutting down...');
  try {
    if (pool) await pool.end();
  } catch (err) {
    logger.warn({ err }, 'Error closing DB pool during shutdown.');
  }
  logger.info('Bye.');
}
