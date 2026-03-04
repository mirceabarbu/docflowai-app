/**
 * DocFlowAI — DB layer
 * Pool PostgreSQL, migrări schema, helpers saveFlow / getFlowData.
 * Import: import { pool, DB_READY, DB_LAST_ERROR, initDbWithRetry, saveFlow, getFlowData, requireDb } from './db/index.mjs';
 */

import pg from 'pg';
import crypto from 'crypto';

const { Pool } = pg;

export const DATABASE_URL = process.env.DATABASE_URL;
export const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 })
  : null;

export let DB_READY = false;
export let DB_LAST_ERROR = null;

// ══════════════════════════════════════════════════════════════════════════════
// SCHEMA MIGRATIONS
// ══════════════════════════════════════════════════════════════════════════════
const MIGRATIONS = [
  {
    id: '001_initial_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS flows (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_flows_updated_at ON flows(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_flows_init_email ON flows((data->>'initEmail'));
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        plain_password TEXT,
        nume TEXT NOT NULL DEFAULT '',
        functie TEXT NOT NULL DEFAULT '',
        institutie TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'user',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_email TEXT NOT NULL,
        flow_id TEXT,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        read BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_notif_email ON notifications(user_email, read, created_at DESC);
    `
  },
  {
    id: '002_users_extra_cols',
    sql: `
      ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_inapp BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_email BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_whatsapp BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS compartiment TEXT NOT NULL DEFAULT '';
    `
  },
  {
    id: '003_drop_username',
    sql: `ALTER TABLE users DROP COLUMN IF EXISTS username;`
  },
  {
    id: '004_templates',
    sql: `
      CREATE TABLE IF NOT EXISTS templates (
        id SERIAL PRIMARY KEY,
        user_email TEXT NOT NULL,
        institutie TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL,
        signers JSONB NOT NULL DEFAULT '[]',
        shared BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_tmpl_user ON templates(user_email, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tmpl_inst ON templates(institutie, shared) WHERE shared=TRUE;
    `
  },
  {
    id: '005_login_blocks',
    sql: `
      CREATE TABLE IF NOT EXISTS login_blocks (
        key TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0,
        first_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        blocked_until TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `
  },
  {
    id: '006_delegations',
    sql: `
      CREATE TABLE IF NOT EXISTS delegations (
        id SERIAL PRIMARY KEY,
        from_email TEXT NOT NULL,
        to_email TEXT NOT NULL,
        institutie TEXT NOT NULL DEFAULT '',
        valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        valid_until TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_delegations_from ON delegations(from_email, valid_until);
    `
  },
  {
    id: '007_flows_indexes_pagination',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_flows_created_at ON flows(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_flows_completed ON flows((data->>'completed'));
      CREATE INDEX IF NOT EXISTS idx_flows_status ON flows((data->>'status'));
    `
  },
  {
    id: '008_push_subscriptions',
    sql: `
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id SERIAL PRIMARY KEY,
        user_email TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_email, endpoint)
      );
      CREATE INDEX IF NOT EXISTS idx_push_sub_email ON push_subscriptions(user_email);
    `
  }
];

async function runMigrations(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  const { rows: applied } = await client.query('SELECT id FROM schema_migrations');
  const appliedIds = new Set(applied.map(r => r.id));
  let ranCount = 0;
  for (const migration of MIGRATIONS) {
    if (appliedIds.has(migration.id)) continue;
    console.log(`⏳ Migrare: ${migration.id}...`);
    await client.query(migration.sql);
    await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
    console.log(`✅ Migrare aplicată: ${migration.id}`);
    ranCount++;
  }
  if (ranCount === 0) console.log('✅ Schema DB actualizată (0 migrări noi).');
  else console.log(`✅ ${ranCount} migrare(i) aplicate.`);
}

// hashPassword e necesar pentru admin init — importat din middleware/auth.mjs
// dar pentru a evita dependenta circulara, il definim local here
function _hashPasswordLocal(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha256').toString('hex');
  return `${salt}:${hash}`;
}

async function initDbOnce() {
  if (!pool) throw new Error('DATABASE_URL missing');
  await pool.query('SELECT 1');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await runMigrations(client);
    await client.query('COMMIT');
  } catch(e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  // Admin user implicit
  const { rows: uc } = await pool.query('SELECT COUNT(*) FROM users');
  if (parseInt(uc[0].count) === 0 && process.env.ADMIN_INIT_PASSWORD) {
    const pwd = process.env.ADMIN_INIT_PASSWORD;
    await pool.query(
      "INSERT INTO users (email, password_hash, plain_password, nume, functie, role) VALUES ($1,$2,$3,$4,$5,'admin') ON CONFLICT DO NOTHING",
      ['admin@docflowai.ro', _hashPasswordLocal(pwd), pwd, 'Administrator', 'Administrator sistem']
    );
    console.log('✅ Admin user creat.');
  }
  DB_READY = true; DB_LAST_ERROR = null;
  console.log('✅ DB ready.');
}

export async function initDbWithRetry() {
  const delays = [1000, 2000, 4000, 8000, 15000];
  for (let i = 0; i < delays.length; i++) {
    try {
      console.log(`⏳ DB init attempt ${i+1}/${delays.length}...`);
      await initDbOnce();
      return;
    } catch(e) {
      DB_READY = false; DB_LAST_ERROR = String(e?.message || e);
      console.error('❌ DB init failed:', e);
      await new Promise(r => setTimeout(r, delays[i]));
    }
  }
  console.error('❌ DB init failed permanently.');
}

export function requireDb(res) {
  if (!DB_READY) { res.status(503).json({ error: 'db_not_ready', dbLastError: DB_LAST_ERROR }); return true; }
  return false;
}

export async function saveFlow(id, data) {
  await pool.query(
    `INSERT INTO flows (id,data) VALUES ($1,$2::jsonb) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()`,
    [id, JSON.stringify(data)]
  );
}

export async function getFlowData(id) {
  const r = await pool.query('SELECT data FROM flows WHERE id=$1', [id]);
  return r.rows[0]?.data ?? null;
}
