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
  },
  {
  id: '009_organizations_tenancy',
  sql: `
    -- v3.1.1 Tenancy foundation (organizations + org_id)
    -- If an old/incorrect organizations table exists, rename it away (keeps data for inspection)
    DO $$
    DECLARE
      id_data_type TEXT;
      legacy_name TEXT;
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema='public' AND table_name='organizations'
      ) THEN
        SELECT data_type INTO id_data_type
        FROM information_schema.columns
        WHERE table_schema='public' AND table_name='organizations' AND column_name='id';

        -- If id isn't integer, we can't safely FK from org_id INTEGER -> organizations.id.
        IF id_data_type IS DISTINCT FROM 'integer' THEN
          legacy_name := 'organizations_legacy_' || to_char(now(), 'YYYYMMDD_HH24MISS');
          EXECUTE format('ALTER TABLE public.organizations RENAME TO %I', legacy_name);
        END IF;
      END IF;
    END $$;

    -- Canonical organizations table (INTEGER id)
    CREATE TABLE IF NOT EXISTS organizations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Ensure SERIAL default exists even if table pre-existed without it
    DO $$
    DECLARE
      id_default TEXT;
    BEGIN
      SELECT pg_get_expr(d.adbin, d.adrelid) INTO id_default
      FROM pg_attrdef d
      JOIN pg_class c ON c.oid = d.adrelid
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.adnum
      WHERE c.relname = 'organizations' AND a.attname = 'id';

      IF id_default IS NULL THEN
        EXECUTE 'CREATE SEQUENCE IF NOT EXISTS organizations_id_seq';
        EXECUTE 'ALTER TABLE organizations ALTER COLUMN id SET DEFAULT nextval(''organizations_id_seq'')';
        EXECUTE 'SELECT setval(''organizations_id_seq'', COALESCE((SELECT MAX(id) FROM organizations),0)+1, false)';
      END IF;
    END $$;

    -- Seed: Default Organization (idempotent)
    INSERT INTO organizations (name)
    SELECT 'Default Organization'
    WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE name='Default Organization');

    -- Tenancy columns
    ALTER TABLE users ADD COLUMN IF NOT EXISTS org_id INTEGER;
    ALTER TABLE templates ADD COLUMN IF NOT EXISTS org_id INTEGER;
    ALTER TABLE delegations ADD COLUMN IF NOT EXISTS org_id INTEGER;
    ALTER TABLE flows ADD COLUMN IF NOT EXISTS org_id INTEGER;

    -- Backfill org_id for existing rows
    WITH def AS (SELECT id FROM organizations WHERE name='Default Organization' LIMIT 1)
    UPDATE users u SET org_id = (SELECT id FROM def) WHERE u.org_id IS NULL;
    WITH def AS (SELECT id FROM organizations WHERE name='Default Organization' LIMIT 1)
    UPDATE templates t SET org_id = (SELECT id FROM def) WHERE t.org_id IS NULL;
    WITH def AS (SELECT id FROM organizations WHERE name='Default Organization' LIMIT 1)
    UPDATE delegations d SET org_id = (SELECT id FROM def) WHERE d.org_id IS NULL;
    WITH def AS (SELECT id FROM organizations WHERE name='Default Organization' LIMIT 1)
    UPDATE flows f SET org_id = (SELECT id FROM def) WHERE f.org_id IS NULL;

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);
    CREATE INDEX IF NOT EXISTS idx_templates_org ON templates(org_id);
    CREATE INDEX IF NOT EXISTS idx_delegations_org ON delegations(org_id);
    CREATE INDEX IF NOT EXISTS idx_flows_org ON flows(org_id);


    -- Ensure org_id columns are INTEGER and populated before adding FKs (auto-heal)
    DO $$
    DECLARE
      def_id integer;
      col_type text;
    BEGIN
      SELECT id INTO def_id FROM organizations WHERE name='Default Organization' ORDER BY id LIMIT 1;
      IF def_id IS NULL THEN
        INSERT INTO organizations(name) VALUES ('Default Organization') RETURNING id INTO def_id;
      END IF;

      -- USERS
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='org_id') THEN
        UPDATE users
          SET org_id = def_id::text
          WHERE org_id IS NULL OR org_id::text = '' OR org_id::text !~ '^\d+$';
        SELECT data_type INTO col_type FROM information_schema.columns
          WHERE table_schema='public' AND table_name='users' AND column_name='org_id';
        IF col_type <> 'integer' THEN
          EXECUTE 'ALTER TABLE users ALTER COLUMN org_id DROP DEFAULT';
          EXECUTE 'ALTER TABLE users ALTER COLUMN org_id TYPE integer USING org_id::integer';
        END IF;
      END IF;

      -- FLOWS
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='flows' AND column_name='org_id') THEN
        UPDATE flows
          SET org_id = def_id::text
          WHERE org_id IS NULL OR org_id::text = '' OR org_id::text !~ '^\d+$';
        SELECT data_type INTO col_type FROM information_schema.columns
          WHERE table_schema='public' AND table_name='flows' AND column_name='org_id';
        IF col_type <> 'integer' THEN
          EXECUTE 'ALTER TABLE flows ALTER COLUMN org_id DROP DEFAULT';
          EXECUTE 'ALTER TABLE flows ALTER COLUMN org_id TYPE integer USING org_id::integer';
        END IF;
      END IF;

      -- DELEGATIONS
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='delegations' AND column_name='org_id') THEN
        UPDATE delegations
          SET org_id = def_id::text
          WHERE org_id IS NULL OR org_id::text = '' OR org_id::text !~ '^\d+$';
        SELECT data_type INTO col_type FROM information_schema.columns
          WHERE table_schema='public' AND table_name='delegations' AND column_name='org_id';
        IF col_type <> 'integer' THEN
          EXECUTE 'ALTER TABLE delegations ALTER COLUMN org_id DROP DEFAULT';
          EXECUTE 'ALTER TABLE delegations ALTER COLUMN org_id TYPE integer USING org_id::integer';
        END IF;
      END IF;

      -- TEMPLATES
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='templates' AND column_name='org_id') THEN
        UPDATE templates
          SET org_id = def_id::text
          WHERE org_id IS NULL OR org_id::text = '' OR org_id::text !~ '^\d+$';
        SELECT data_type INTO col_type FROM information_schema.columns
          WHERE table_schema='public' AND table_name='templates' AND column_name='org_id';
        IF col_type <> 'integer' THEN
          EXECUTE 'ALTER TABLE templates ALTER COLUMN org_id DROP DEFAULT';
          EXECUTE 'ALTER TABLE templates ALTER COLUMN org_id TYPE integer USING org_id::integer';
        END IF;
      END IF;
    END $$;

    -- Foreign keys (deferred, idempotent)
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_users_org') THEN
        ALTER TABLE users
          ADD CONSTRAINT fk_users_org
          FOREIGN KEY (org_id) REFERENCES organizations(id)
          DEFERRABLE INITIALLY DEFERRED;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_templates_org') THEN
        ALTER TABLE templates
          ADD CONSTRAINT fk_templates_org
          FOREIGN KEY (org_id) REFERENCES organizations(id)
          DEFERRABLE INITIALLY DEFERRED;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_delegations_org') THEN
        ALTER TABLE delegations
          ADD CONSTRAINT fk_delegations_org
          FOREIGN KEY (org_id) REFERENCES organizations(id)
          DEFERRABLE INITIALLY DEFERRED;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_flows_org') THEN
        ALTER TABLE flows
          ADD CONSTRAINT fk_flows_org
          FOREIGN KEY (org_id) REFERENCES organizations(id)
          DEFERRABLE INITIALLY DEFERRED;
      END IF;
    END $$;
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

let _defaultOrgIdCache = null;
export async function getDefaultOrgId() {
  if (_defaultOrgIdCache) return _defaultOrgIdCache;
  const r = await pool.query('SELECT id FROM organizations ORDER BY id ASC LIMIT 1');
  _defaultOrgIdCache = r.rows[0]?.id || null;
  return _defaultOrgIdCache;
}

export function requireDb(res) {
  if (!DB_READY) { res.status(503).json({ error: 'db_not_ready', dbLastError: DB_LAST_ERROR }); return true; }
  return false;
}

export async function saveFlow(id, data) {
  const orgId = data?.orgId || data?.org_id || null;
  await pool.query(
    `INSERT INTO flows (id,data,org_id) VALUES ($1,$2::jsonb,$3) 
     ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, org_id=EXCLUDED.org_id, updated_at=NOW()`,
    [id, JSON.stringify(data), orgId]
  );
}

export async function getFlowData(id) {
  const r = await pool.query('SELECT data FROM flows WHERE id=$1', [id]);
  return r.rows[0]?.data ?? null;
}