/**
 * server/db/seeds/admin.mjs — Bootstrap default org + superadmin user.
 * Called from bootstrap.mjs after runMigrations().
 */

import { pool } from '../index.mjs';
import { hashPassword } from '../../core/hashing.mjs';
import { logger } from '../../middleware/logger.mjs';

export async function seedAdminUser() {
  const adminEmail    = process.env.ADMIN_EMAIL    || 'admin@docflowai.ro';
  const adminPassword = process.env.ADMIN_INIT_PASSWORD || 'Admin1234!';
  const adminName     = process.env.ADMIN_NAME     || 'Administrator';

  // Ensure default organization exists
  const { rows: orgs } = await pool.query(
    `INSERT INTO organizations (name, slug, status, plan)
     VALUES ('DocFlowAI', 'default', 'active', 'enterprise')
     ON CONFLICT (slug) DO NOTHING
     RETURNING id`
  );

  let orgId;
  if (orgs.length > 0) {
    orgId = orgs[0].id;
    logger.info({ orgId }, 'Default organization created.');
  } else {
    const { rows } = await pool.query(
      "SELECT id FROM organizations WHERE slug='default' LIMIT 1"
    );
    orgId = rows[0]?.id;
  }

  if (!orgId) {
    const { rows } = await pool.query(
      'SELECT id FROM organizations ORDER BY id LIMIT 1'
    );
    orgId = rows[0]?.id;
  }

  if (!orgId) {
    logger.error('No organization found — cannot seed admin user.');
    return;
  }

  // Check if admin already exists
  const { rows: existing } = await pool.query(
    'SELECT id FROM users WHERE lower(email)=lower($1) LIMIT 1',
    [adminEmail]
  );

  if (existing.length > 0) {
    return; // Already seeded
  }

  const hash = await hashPassword(adminPassword);
  await pool.query(
    `INSERT INTO users
       (org_id, email, password_hash, hash_algo, name, role, status)
     VALUES ($1, $2, $3, 'bcrypt', $4, 'superadmin', 'active')
     ON CONFLICT (email) DO NOTHING`,
    [orgId, adminEmail.toLowerCase(), hash, adminName]
  );

  logger.info({ email: adminEmail }, 'Admin user seeded.');
}
