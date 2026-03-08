/**
 * DocFlowAI — DB layer v3.2.1
 * Pool PostgreSQL, migrări schema, helpers saveFlow / getFlowData / getUserMapForOrg.
 * NOTA: plain_password pastrat intentionat pentru workflow admin actual.
 *       Migrarea la securitate fara plain_password se face intr-o versiune viitoare.
 */

import pg from 'pg';
import crypto from 'crypto';

const { Pool } = pg;

export const DATABASE_URL = process.env.DATABASE_URL;
export const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 10 })
  : null;

export let DB_READY = false;
export let DB_LAST_ERROR = null;

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
          IF id_data_type IS DISTINCT FROM 'integer' THEN
            legacy_name := 'organizations_legacy_' || to_char(now(), 'YYYYMMDD_HH24MISS');
            EXECUTE format('ALTER TABLE public.organizations RENAME TO %I', legacy_name);
          END IF;
        END IF;
      END $$;

      CREATE TABLE IF NOT EXISTS organizations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

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

      INSERT INTO organizations (name)
      SELECT 'Default Organization'
      WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE name='Default Organization');

      ALTER TABLE users ADD COLUMN IF NOT EXISTS org_id INTEGER;
      ALTER TABLE templates ADD COLUMN IF NOT EXISTS org_id INTEGER;
      ALTER TABLE delegations ADD COLUMN IF NOT EXISTS org_id INTEGER;
      ALTER TABLE flows ADD COLUMN IF NOT EXISTS org_id INTEGER;

      WITH def AS (SELECT id FROM organizations WHERE name='Default Organization' LIMIT 1)
      UPDATE users u SET org_id = (SELECT id FROM def) WHERE u.org_id IS NULL;
      WITH def AS (SELECT id FROM organizations WHERE name='Default Organization' LIMIT 1)
      UPDATE templates t SET org_id = (SELECT id FROM def) WHERE t.org_id IS NULL;
      WITH def AS (SELECT id FROM organizations WHERE name='Default Organization' LIMIT 1)
      UPDATE delegations d SET org_id = (SELECT id FROM def) WHERE d.org_id IS NULL;
      WITH def AS (SELECT id FROM organizations WHERE name='Default Organization' LIMIT 1)
      UPDATE flows f SET org_id = (SELECT id FROM def) WHERE f.org_id IS NULL;

      CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);
      CREATE INDEX IF NOT EXISTS idx_templates_org ON templates(org_id);
      CREATE INDEX IF NOT EXISTS idx_delegations_org ON delegations(org_id);
      CREATE INDEX IF NOT EXISTS idx_flows_org ON flows(org_id);

      DO $$
      DECLARE
        def_id integer;
        col_type text;
      BEGIN
        SELECT id INTO def_id FROM organizations WHERE name='Default Organization' ORDER BY id LIMIT 1;
        IF def_id IS NULL THEN
          INSERT INTO organizations(name) VALUES ('Default Organization') RETURNING id INTO def_id;
        END IF;

        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='org_id') THEN
          UPDATE users SET org_id = def_id WHERE org_id IS NULL;
          SELECT data_type INTO col_type FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='org_id';
          IF col_type <> 'integer' THEN
            EXECUTE 'ALTER TABLE users ALTER COLUMN org_id DROP DEFAULT';
            EXECUTE 'ALTER TABLE users ALTER COLUMN org_id TYPE integer USING org_id::integer';
          END IF;
        END IF;

        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='flows' AND column_name='org_id') THEN
          UPDATE flows SET org_id = def_id WHERE org_id IS NULL;
          SELECT data_type INTO col_type FROM information_schema.columns WHERE table_schema='public' AND table_name='flows' AND column_name='org_id';
          IF col_type <> 'integer' THEN
            EXECUTE 'ALTER TABLE flows ALTER COLUMN org_id DROP DEFAULT';
            EXECUTE 'ALTER TABLE flows ALTER COLUMN org_id TYPE integer USING org_id::integer';
          END IF;
        END IF;

        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='delegations' AND column_name='org_id') THEN
          UPDATE delegations SET org_id = def_id WHERE org_id IS NULL;
          SELECT data_type INTO col_type FROM information_schema.columns WHERE table_schema='public' AND table_name='delegations' AND column_name='org_id';
          IF col_type <> 'integer' THEN
            EXECUTE 'ALTER TABLE delegations ALTER COLUMN org_id DROP DEFAULT';
            EXECUTE 'ALTER TABLE delegations ALTER COLUMN org_id TYPE integer USING org_id::integer';
          END IF;
        END IF;

        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='templates' AND column_name='org_id') THEN
          UPDATE templates SET org_id = def_id WHERE org_id IS NULL;
          SELECT data_type INTO col_type FROM information_schema.columns WHERE table_schema='public' AND table_name='templates' AND column_name='org_id';
          IF col_type <> 'integer' THEN
            EXECUTE 'ALTER TABLE templates ALTER COLUMN org_id DROP DEFAULT';
            EXECUTE 'ALTER TABLE templates ALTER COLUMN org_id TYPE integer USING org_id::integer';
          END IF;
        END IF;
      END $$;

      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_users_org') THEN
          ALTER TABLE users ADD CONSTRAINT fk_users_org FOREIGN KEY (org_id) REFERENCES organizations(id) DEFERRABLE INITIALLY DEFERRED;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_templates_org') THEN
          ALTER TABLE templates ADD CONSTRAINT fk_templates_org FOREIGN KEY (org_id) REFERENCES organizations(id) DEFERRABLE INITIALLY DEFERRED;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_delegations_org') THEN
          ALTER TABLE delegations ADD CONSTRAINT fk_delegations_org FOREIGN KEY (org_id) REFERENCES organizations(id) DEFERRABLE INITIALLY DEFERRED;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_flows_org') THEN
          ALTER TABLE flows ADD CONSTRAINT fk_flows_org FOREIGN KEY (org_id) REFERENCES organizations(id) DEFERRABLE INITIALLY DEFERRED;
        END IF;
      END $$;
    `
  },
  {
    // FIX v3.2.1: index compus pentru my-flows multi-tenant (performance)
    id: '010_flows_org_updated_index',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_flows_org_updated ON flows(org_id, updated_at DESC);
    `
  },
  {
    // FIX v3.2.1: notificari — index pentru cleanup automat
    id: '011_notifications_cleanup_index',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_notif_cleanup ON notifications(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_notif_user_created ON notifications(user_email, created_at DESC);
    `
  },
  {
    id: '012_notifications_urgent',
    sql: `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS urgent BOOLEAN NOT NULL DEFAULT FALSE;`
  },
  {
    id: '013_ensure_admin_role',
    sql: `UPDATE users SET role='admin' WHERE email='admin@docflowai.ro' AND role != 'admin';`
  },

  // ── R-01: PDF-uri extrase din JSONB → tabelă dedicată ─────────────────────
  // Motivație: JSONB-ul fluxurilor nu mai conține câmpuri de sute de KB.
  // Queries pe my-flows/admin sunt mult mai rapide; backup-urile DB scad drastic.
  // Markeri _*Present rămân în JSONB pentru queries fără JOIN.
  {
    id: '014_flows_pdfs_storage',
    sql: `
      CREATE TABLE IF NOT EXISTS flows_pdfs (
        flow_id  TEXT NOT NULL,
        key      TEXT NOT NULL CHECK (key IN ('pdfB64','signedPdfB64','originalPdfB64')),
        data     TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (flow_id, key),
        FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_flows_pdfs_flow ON flows_pdfs(flow_id);

      -- Migrare date existente: inserăm PDF-urile din JSONB în tabel separat
      INSERT INTO flows_pdfs (flow_id, key, data, updated_at)
        SELECT id, 'pdfB64', data->>'pdfB64', NOW()
        FROM flows WHERE (data->>'pdfB64') IS NOT NULL AND (data->>'pdfB64') != ''
        ON CONFLICT (flow_id, key) DO NOTHING;

      INSERT INTO flows_pdfs (flow_id, key, data, updated_at)
        SELECT id, 'signedPdfB64', data->>'signedPdfB64', NOW()
        FROM flows WHERE (data->>'signedPdfB64') IS NOT NULL AND (data->>'signedPdfB64') != ''
        ON CONFLICT (flow_id, key) DO NOTHING;

      INSERT INTO flows_pdfs (flow_id, key, data, updated_at)
        SELECT id, 'originalPdfB64', data->>'originalPdfB64', NOW()
        FROM flows WHERE (data->>'originalPdfB64') IS NOT NULL AND (data->>'originalPdfB64') != ''
        ON CONFLICT (flow_id, key) DO NOTHING;

      -- Curățăm JSONB: înlocuim câmpurile PDF cu markeri booleeni de prezență
      UPDATE flows SET data =
        (data - 'pdfB64' - 'signedPdfB64' - 'originalPdfB64')
        || jsonb_build_object(
          '_pdfB64Present',      (data->>'pdfB64')         IS NOT NULL AND (data->>'pdfB64')         != '',
          '_signedPdfB64Present',  (data->>'signedPdfB64')   IS NOT NULL AND (data->>'signedPdfB64')   != '',
          '_originalPdfB64Present',(data->>'originalPdfB64') IS NOT NULL AND (data->>'originalPdfB64') != ''
        )
      WHERE data ? 'pdfB64' OR data ? 'signedPdfB64' OR data ? 'originalPdfB64';
    `
  },

  // ── R-02: Tabelă audit_log dedicată pentru interogabilitate SQL ────────────
  // events[] din JSONB nu dispare — rămâne pentru compatibilitate și audit PDF.
  // audit_log permite interogări eficiente: câte fluxuri refuzate azi? etc.
  {
    id: '015_audit_log',
    sql: `
      CREATE TABLE IF NOT EXISTS audit_log (
        id          BIGSERIAL PRIMARY KEY,
        flow_id     TEXT,
        org_id      INTEGER,
        event_type  TEXT NOT NULL,
        actor_email TEXT,
        payload     JSONB,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_audit_flow    ON audit_log(flow_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_org     ON audit_log(org_id,  created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_type    ON audit_log(event_type, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_actor   ON audit_log(actor_email, created_at DESC);
    `
  },

  // ── F-05: IP address logging în audit_log ─────────────────────────────────
  {
    id: '017_audit_log_ip',
    sql: `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_ip TEXT;
          CREATE INDEX IF NOT EXISTS idx_audit_ip ON audit_log(actor_ip) WHERE actor_ip IS NOT NULL;`
  },

  // ── B-03: Elimină plain_password din DB ───────────────────────────────────
  // Parola temporară se trimite o singură dată prin email la creare/reset,
  // nu se mai stochează în clar în baza de date.
  {
    id: '019_drop_plain_password',
    sql: `ALTER TABLE users DROP COLUMN IF EXISTS plain_password;`
  },

  // ── GWS: Google Workspace provisioning columns ────────────────────────────
  {
    id: '018_gws_provisioning',
    sql: `
      ALTER TABLE users ADD COLUMN IF NOT EXISTS prenume            TEXT NOT NULL DEFAULT '';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS nume_familie       TEXT NOT NULL DEFAULT '';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS personal_email     TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS gws_email          TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS gws_status         TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS gws_provisioned_at TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS gws_error          TEXT;
      CREATE INDEX IF NOT EXISTS idx_users_gws_email ON users(gws_email) WHERE gws_email IS NOT NULL;
    `
  },

  // ── R-06: Email verificare utilizatori noi ─────────────────────────────────
  // Userii existenți primesc email_verified=TRUE (deja activi).
  // Userii noi creați de admin primesc email_verified=FALSE până verifică email-ul.
  {
    id: '016_email_verification',
    sql: `
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified      BOOLEAN    NOT NULL DEFAULT TRUE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token  TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_sent_at TIMESTAMPTZ;
      CREATE INDEX IF NOT EXISTS idx_users_verif_token ON users(verification_token) WHERE verification_token IS NOT NULL;
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
  const { rows: uc } = await pool.query('SELECT COUNT(*) FROM users');
  if (parseInt(uc[0].count) === 0 && process.env.ADMIN_INIT_PASSWORD) {
    const pwd = process.env.ADMIN_INIT_PASSWORD;
    await pool.query(
      "INSERT INTO users (email, password_hash, nume, functie, role) VALUES ($1,$2,$3,$4,'admin') ON CONFLICT DO NOTHING",
      ['admin@docflowai.ro', _hashPasswordLocal(pwd), 'Administrator', 'Administrator sistem']
    );
    console.log('✅ Admin user creat.');
  }

  // Recuperare de urgență: dacă nu există NICIUN admin în sistem,
  // promovează admin@docflowai.ro (fără să forțeze rolul dacă există deja alți admini)
  const { rows: admins } = await pool.query("SELECT id FROM users WHERE role='admin' LIMIT 1");
  if (admins.length === 0) {
    const { rowCount } = await pool.query(
      "UPDATE users SET role='admin' WHERE lower(email)='admin@docflowai.ro'"
    );
    if (rowCount > 0) console.log('✅ Recuperare urgență: admin@docflowai.ro promovat la admin (niciun alt admin în sistem).');
    else console.warn('⚠️  Niciun admin în sistem și admin@docflowai.ro nu există!');
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
  console.error('❌ DB init failed permanent.');
}

// Cache org default cu TTL 5 minute (nu infinit)
let _defaultOrgIdCache = null;
let _defaultOrgIdCachedAt = 0;
const DEFAULT_ORG_CACHE_TTL = 5 * 60 * 1000;

export async function getDefaultOrgId() {
  if (_defaultOrgIdCache && (Date.now() - _defaultOrgIdCachedAt) < DEFAULT_ORG_CACHE_TTL) {
    return _defaultOrgIdCache;
  }
  const r = await pool.query('SELECT id FROM organizations ORDER BY id ASC LIMIT 1');
  _defaultOrgIdCache = r.rows[0]?.id || null;
  _defaultOrgIdCachedAt = Date.now();
  return _defaultOrgIdCache;
}

export function invalidateDefaultOrgCache() {
  _defaultOrgIdCache = null;
  _defaultOrgIdCachedAt = 0;
}

export function requireDb(res) {
  if (!DB_READY) { res.status(503).json({ error: 'db_not_ready', dbLastError: DB_LAST_ERROR }); return true; }
  return false;
}

// ── Câmpurile PDF care se stochează în flows_pdfs, nu în JSONB ──────────────
const _PDF_KEYS = ['pdfB64', 'signedPdfB64', 'originalPdfB64'];

/**
 * R-01: saveFlow — extrage câmpurile PDF din JSONB și le persistă în flows_pdfs.
 * Markerii booleeni _*Present rămân în JSONB pentru queries directe (my-flows etc.)
 */
export async function saveFlow(id, data) {
  const orgId = data?.orgId || data?.org_id || null;
  const cleanData = { ...data };

  // Separă câmpurile PDF de restul datelor
  const pdfWrites = {}; // key → value | null (null = ștergere)
  for (const key of _PDF_KEYS) {
    if (key in cleanData) {
      pdfWrites[key] = cleanData[key] ?? null;
      delete cleanData[key];
      // Actualizează marker-ul de prezență în JSONB
      cleanData[`_${key}Present`] = pdfWrites[key] !== null && pdfWrites[key] !== '';
    }
    // Dacă key nu e în cleanData, marker-ul existent rămâne neschimbat
  }

  // Salvează JSONB fără câmpurile PDF
  await pool.query(
    `INSERT INTO flows (id,data,org_id) VALUES ($1,$2::jsonb,$3)
     ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, org_id=EXCLUDED.org_id, updated_at=NOW()`,
    [id, JSON.stringify(cleanData), orgId]
  );

  // Upsert / delete în flows_pdfs
  for (const [key, val] of Object.entries(pdfWrites)) {
    if (val === null || val === '') {
      await pool.query('DELETE FROM flows_pdfs WHERE flow_id=$1 AND key=$2', [id, key]);
    } else {
      await pool.query(
        `INSERT INTO flows_pdfs (flow_id, key, data, updated_at) VALUES ($1,$2,$3,NOW())
         ON CONFLICT (flow_id, key) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()`,
        [id, key, val]
      );
    }
  }
}

/**
 * R-01: getFlowData — reconstituie câmpurile PDF din flows_pdfs în obiectul flow.
 * Șterge markerii _*Present (nu mai sunt necesari când avem datele reale).
 */
export async function getFlowData(id) {
  const r = await pool.query('SELECT data FROM flows WHERE id=$1', [id]);
  if (!r.rows[0]) return null;
  const data = r.rows[0].data;

  // Reataşează câmpurile PDF din flows_pdfs
  const pdfs = await pool.query('SELECT key, data FROM flows_pdfs WHERE flow_id=$1', [id]);
  for (const row of pdfs.rows) {
    data[row.key] = row.data;
  }
  // Curăță markerii (inutili când avem datele reale)
  for (const key of _PDF_KEYS) delete data[`_${key}Present`];

  return data;
}

/**
 * R-02 / F-05: writeAuditEvent — scrie eveniment în audit_log cu IP opțional.
 * Fire-and-forget: erorile sunt logate, nu propagate.
 */
export async function writeAuditEvent({ flowId, orgId, eventType, actorEmail, actorIp = null, payload = {} }) {
  if (!pool || !DB_READY) return;
  try {
    await pool.query(
      'INSERT INTO audit_log (flow_id, org_id, event_type, actor_email, actor_ip, payload) VALUES ($1,$2,$3,$4,$5,$6)',
      [flowId || null, orgId || null, eventType, actorEmail || null, actorIp || null, JSON.stringify(payload)]
    );
  } catch(e) {
    console.error('writeAuditEvent error:', e.message);
  }
}

/**
 * Construieste un map de useri filtrat pe org_id (anti-leak multi-tenant).
 * Daca orgId e null/0, returneaza toti userii (backward compat pentru admini fara org).
 */
export async function getUserMapForOrg(orgId) {
  let query, params;
  if (orgId && orgId > 0) {
    query = 'SELECT email,functie,compartiment,institutie FROM users WHERE org_id=$1';
    params = [orgId];
  } else {
    query = 'SELECT email,functie,compartiment,institutie FROM users';
    params = [];
  }
  const { rows } = await pool.query(query, params);
  const map = {};
  rows.forEach(u => { map[(u.email || '').toLowerCase()] = u; });
  return map;
}
