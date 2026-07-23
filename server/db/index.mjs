/**
  {
    id: '033_signing_providers',
    sql: `
      -- Arhitectură corectă: provider per semnatar, nu per organizație
      --
      -- signing_providers_enabled: ce provideri sunt contractați/activi în org
      --   ex: ARRAY['local-upload', 'certsign', 'sts-cloud']
      --
      -- signing_providers_config: configurație per provider (API keys, URLs, secrets)
      --   ex: { "certsign": { "apiKey": "...", "apiUrl": "...", "webhookSecret": "..." },
      --          "sts-cloud": { "apiKey": "...", "apiUrl": "..." } }
      --   NOTĂ: în producție, API keys trebuie criptate (pgcrypto sau vault extern)
      --
      -- preferred_signing_provider pe users: ce provider preferă utilizatorul
      --   pre-selectat în UI semnatar, poate fi overridden la orice semnare

      ALTER TABLE organizations
        ADD COLUMN IF NOT EXISTS signing_providers_enabled TEXT[]  NOT NULL DEFAULT ARRAY['local-upload']::TEXT[],
        ADD COLUMN IF NOT EXISTS signing_providers_config  JSONB   NOT NULL DEFAULT '{}';

      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS preferred_signing_provider TEXT   DEFAULT NULL;

      CREATE INDEX IF NOT EXISTS idx_org_signing_providers
        ON organizations USING GIN (signing_providers_enabled);
    `
  },

  {
    id: '034_signing_trust_tables',
    sql: `
      -- Tabel semnături per semnatar (detalii semnare)
      CREATE TABLE IF NOT EXISTS flow_signatures (
        id              TEXT        PRIMARY KEY,
        flow_id         TEXT        NOT NULL,
        signer_id       TEXT,
        signer_name     TEXT        NOT NULL,
        signer_email    TEXT,
        signer_role     TEXT,
        signing_order   INTEGER,
        status          TEXT        NOT NULL DEFAULT 'pending',
        signed_at       TIMESTAMPTZ,
        signature_method TEXT,
        source_file_name TEXT,
        signed_file_hash TEXT,
        signature_hash  TEXT,
        certificate_id  TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_flow_signatures_flow_id
        ON flow_signatures(flow_id);
      CREATE INDEX IF NOT EXISTS idx_flow_signatures_certificate_id
        ON flow_signatures(certificate_id);

      -- Tabel certificate (metadate X.509 per semnătură)
      CREATE TABLE IF NOT EXISTS signature_certificates (
        id                      TEXT        PRIMARY KEY,
        flow_id                 TEXT        NOT NULL,
        signer_email            TEXT,
        signer_name             TEXT,
        certificate_type        TEXT        DEFAULT 'unknown',
        issuer_name             TEXT,
        issuer_cn               TEXT,
        subject_cn              TEXT,
        subject_serial          TEXT,
        subject_identifier      TEXT,
        serial_number           TEXT,
        valid_from              TIMESTAMPTZ,
        valid_to                TIMESTAMPTZ,
        was_valid_at_signing    BOOLEAN     DEFAULT FALSE,
        revocation_status       TEXT        DEFAULT 'unknown',
        chain_status            TEXT        DEFAULT 'unknown',
        trust_status            TEXT        DEFAULT 'unknown',
        qc_statement_present    BOOLEAN     DEFAULT FALSE,
        key_usage               TEXT,
        signature_algorithm     TEXT,
        digest_algorithm        TEXT,
        timestamp_present       BOOLEAN     DEFAULT FALSE,
        timestamp_time          TIMESTAMPTZ,
        ocsp_url                TEXT,
        raw_json                JSONB,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_signature_certificates_flow_id
        ON signature_certificates(flow_id);

      -- Tabel rapoarte generate (link PDF în Drive sau base64 mic)
      CREATE TABLE IF NOT EXISTS trust_reports (
        id          TEXT        PRIMARY KEY,
        flow_id     TEXT        NOT NULL UNIQUE,
        generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        pdf_url     TEXT,
        pdf_size    INTEGER,
        conclusion  TEXT,
        report_json JSONB
      );
      CREATE INDEX IF NOT EXISTS idx_trust_reports_flow_id
        ON trust_reports(flow_id);
    \`,
  }, * DocFlowAI — DB layer v3.3.4
 * Pool PostgreSQL, migrări schema, helpers saveFlow / getFlowData / getUserMapForOrg.
 * NOTA: plain_password pastrat intentionat pentru workflow admin actual.
 *       Migrarea la securitate fara plain_password se face intr-o versiune viitoare.
 *
 * CHANGES v3.3.4:
 *  PERF-01: Migrare 021 — 3 indexuri JSONB (idx_flows_active, idx_flows_init_org, idx_flows_org_status)
 *  SEC-03:  Migrare 022 — coloana hash_algo pentru tracking versiune PBKDF2
 */

import pg from 'pg';
import crypto from 'crypto';
import util from 'util';

const _pbkdf2 = util.promisify(crypto.pbkdf2);
import { logger } from '../middleware/logger.mjs';

const { Pool } = pg;

export const DATABASE_URL = process.env.DATABASE_URL;
// HANG-FIX (incident 2026-05-20): timeouts ca un query stuck să nu țină
// procesul ostatec. statement_timeout=30s ucide query-urile care depășesc;
// connectionTimeoutMillis=5s ca pool-ul să nu blocheze indefinit pe achiziție.
export const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      // Railway cere SSL (default). Testele pe Postgres local/CI setează DB_DISABLE_SSL=1.
      ssl: process.env.DB_DISABLE_SSL === '1' ? false : { rejectUnauthorized: false },
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      statement_timeout: 30000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000, // primul pachet keepalive după 10s de inactivitate
    })
  : null;

// FIX CRITIC (incident 2026-07-02): fără acest handler, o eroare pe un client inactiv din
// pool (ex. Postgres restartează, conexiune resetată de rețea) escaladează la
// process.on('uncaughtException') și doboară TOT procesul — nu doar acea conexiune.
// pg documentează explicit necesitatea acestui listener pentru erori pe clienți idle.
// Non-fatal: pool-ul reface automat conexiunea la următoarea cerere.
if (pool) {
  pool.on('error', (err) => {
    logger.error({ err }, 'pool: eroare pe client inactiv (non-fatală — conexiunea se reface automat)');
  });
}

export let DB_READY = false;
export let DB_LAST_ERROR = null;

export const MIGRATIONS = [
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
  },
  {
    id: '020_force_password_change',
    sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS force_password_change BOOLEAN NOT NULL DEFAULT FALSE;`
  },
  {
    // PERF-01: Indexuri JSONB pentru query-urile cel mai frecvent executate
    id: '021_perf_jsonb_indexes',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_flows_active
        ON flows(updated_at DESC)
        WHERE (data->>'completed') IS DISTINCT FROM 'true'
          AND (data->>'status') NOT IN ('refused','cancelled');

      CREATE INDEX IF NOT EXISTS idx_flows_init_org
        ON flows(org_id, (data->>'initEmail'), updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_flows_org_status
        ON flows(org_id, (data->>'status'), created_at DESC);
    `
  },
  {
    // SEC-03: Coloana hash_algo pentru tracking versiune hash PBKDF2
    // 'pbkdf2_v1' = 100k iterații (legacy)
    // 'pbkdf2_v2' = 600k iterații (OWASP 2025, curent)
    // Detectarea automată se face și din prefixul hash-ului ("v2:"), coloana e informativă
    id: '022_hash_algo_column',
    sql: `
      ALTER TABLE users ADD COLUMN IF NOT EXISTS hash_algo TEXT NOT NULL DEFAULT 'pbkdf2_v1';
      UPDATE users SET hash_algo = 'pbkdf2_v2' WHERE password_hash LIKE 'v2:%';
    `
  },
  {
    // ASYNC-01: Tabel pentru arhivare asincronă — evită timeout Railway pe loturi mari
    id: '023_archive_jobs',
    sql: `
      CREATE TABLE IF NOT EXISTS archive_jobs (
        id         BIGSERIAL PRIMARY KEY,
        org_id     INTEGER,
        flow_ids   JSONB    NOT NULL DEFAULT '[]',
        status     TEXT     NOT NULL DEFAULT 'pending',
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        result     JSONB,
        error      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_archive_jobs_status ON archive_jobs(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_archive_jobs_org    ON archive_jobs(org_id, created_at DESC);
    `
  },
  {
    // ORG-ADMIN-01: Suport rol org_admin — admin limitat la propria instituție
    id: '024_org_admin_role',
    sql: `
      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
      ALTER TABLE users ADD CONSTRAINT users_role_check
        CHECK (role IN ('admin', 'org_admin', 'user'));
    `
  },
  // ── F-06: Documente suport atașate fluxului ─────────────────────────────
  {
    id: '025_flow_attachments',
    sql: `
      CREATE TABLE IF NOT EXISTS flow_attachments (
        id          SERIAL PRIMARY KEY,
        flow_id     TEXT        NOT NULL,
        filename    TEXT        NOT NULL,
        mime_type   TEXT        NOT NULL DEFAULT 'application/octet-stream',
        size_bytes  INTEGER     NOT NULL DEFAULT 0,
        data        BYTEA       NOT NULL,
        drive_file_id   TEXT,
        drive_file_link TEXT,
        uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_flow_att_flow ON flow_attachments(flow_id);
    `
  },
  {
    id: '026_outreach',
    sql: `
      CREATE TABLE IF NOT EXISTS outreach_campaigns (
        id          SERIAL PRIMARY KEY,
        name        TEXT        NOT NULL,
        subject     TEXT        NOT NULL,
        html_body   TEXT        NOT NULL,
        created_by  TEXT        NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS outreach_recipients (
        id          SERIAL PRIMARY KEY,
        campaign_id INTEGER     NOT NULL REFERENCES outreach_campaigns(id) ON DELETE CASCADE,
        email       TEXT        NOT NULL,
        institutie  TEXT        NOT NULL DEFAULT '',
        status      TEXT        NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','sent','opened','error')),
        tracking_id TEXT        NOT NULL DEFAULT md5(random()::text || clock_timestamp()::text),
        sent_at     TIMESTAMPTZ,
        opened_at   TIMESTAMPTZ,
        downloaded_at TIMESTAMPTZ,
        download_count INTEGER NOT NULL DEFAULT 0,
        error_msg   TEXT,
        UNIQUE (campaign_id, email)
      );
      CREATE INDEX IF NOT EXISTS idx_orecip_campaign ON outreach_recipients(campaign_id);
      CREATE INDEX IF NOT EXISTS idx_orecip_status   ON outreach_recipients(status);
      CREATE INDEX IF NOT EXISTS idx_orecip_tracking ON outreach_recipients(tracking_id);
    `
  },
  {
    // SEC-01: Elimină coloana plain_password din tabelul users.
    // Parola în clar nu trebuie stocată niciodată în DB — GDPR + securitate.
    // Codul nu mai scrie în această coloană din v3.3.2; acum o ștergem definitiv.
    // IF EXISTS: sigur pe DB-uri unde coloana a fost deja ștearsă manual.
    id: '027_drop_plain_password',
    sql: `ALTER TABLE users DROP COLUMN IF EXISTS plain_password;`
  },
  {
    // PERF-01: Index pe notifications(flow_id).
    // DELETE/SELECT pe flow_id se apelează la fiecare acțiune din flux (sign, refuse,
    // cancel, delegate) — fără index, PostgreSQL face full table scan pe întreaga tabelă.
    // Notă: CREATE INDEX IF NOT EXISTS (non-CONCURRENT) — funcționează în tranzacție.
    // Pe scala acestei instalări (sute de fluxuri) lock-ul e de ordinul milisecundelor.
    id: '028_index_notifications_flow_id',
    sql: `CREATE INDEX IF NOT EXISTS idx_notif_flow_id ON notifications(flow_id);`
  },
  {
    // CRUD Instituții Outreach — tabel persistent, editabil din UI și prin import
    // Seeded automat la primul boot din primarii-romania.json
    id: '029_outreach_primarii',
    sql: `
      CREATE TABLE IF NOT EXISTS outreach_primarii (
        id          SERIAL PRIMARY KEY,
        institutie  TEXT        NOT NULL,
        email       TEXT        NOT NULL,
        judet       TEXT        NOT NULL DEFAULT '',
        localitate  TEXT        NOT NULL DEFAULT '',
        activ       BOOLEAN     NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(email)
      );
      CREATE INDEX IF NOT EXISTS idx_oprm_judet  ON outreach_primarii(judet);
      CREATE INDEX IF NOT EXISTS idx_oprm_activ  ON outreach_primarii(activ);
    `
  },
  {
    id: '030_outreach_unsubscribe',
    sql: `
      -- SEC-N01: GDPR compliance — dezabonare outreach
      ALTER TABLE outreach_primarii
        ADD COLUMN IF NOT EXISTS unsubscribed       BOOLEAN     NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS unsubscribe_token  TEXT        UNIQUE;
      CREATE INDEX IF NOT EXISTS idx_oprm_unsub_token ON outreach_primarii(unsubscribe_token)
        WHERE unsubscribe_token IS NOT NULL;
    `
  },
  {
    id: '031_token_version',
    sql: `
      -- SEC-04: token_version pentru invalidare JWT la reset parolă.
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 1;
    `
  },
  {
    id: '032_organization_webhooks',
    sql: `
      -- FEAT-N01: webhook generic per organizație (AvanDoc, registratură proprie, etc.)
      ALTER TABLE organizations
        ADD COLUMN IF NOT EXISTS webhook_url     TEXT,
        ADD COLUMN IF NOT EXISTS webhook_secret  TEXT,
        ADD COLUMN IF NOT EXISTS webhook_events  TEXT[]   NOT NULL DEFAULT '{flow.completed}',
        ADD COLUMN IF NOT EXISTS webhook_enabled BOOLEAN  NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();
    `
  },
  {
    id: '035_trust_report_pdf_cache',
    sql: `
      -- BUG-01 fix: adaugă coloana BYTEA pentru cache PDF raport
      -- CREATE TABLE IF NOT EXISTS — producția poate să nu aibă tabela din 034
      CREATE TABLE IF NOT EXISTS trust_reports (
        id           TEXT        PRIMARY KEY,
        flow_id      TEXT        NOT NULL UNIQUE,
        generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        pdf_url      TEXT,
        pdf_size     INTEGER,
        conclusion   TEXT,
        report_json  JSONB,
        report_pdf   BYTEA
      );
      CREATE INDEX IF NOT EXISTS idx_trust_reports_flow_id ON trust_reports(flow_id);
      -- Adaugă coloana dacă tabela exista deja fără ea
      ALTER TABLE trust_reports ADD COLUMN IF NOT EXISTS report_pdf BYTEA;
    `
  },
  {
    id: '036_flows_indexes',
    sql: `
      -- Indexuri JSONB pentru query-uri frecvente — fara impact la scriere, query-uri ~10x mai rapide
      -- status: filtru cel mai comun in admin si listings
      CREATE INDEX IF NOT EXISTS idx_flows_status
        ON flows ((data->>'status'));

      -- orgId: izolare multi-tenant — fiecare query filtreaza per organizatie
      CREATE INDEX IF NOT EXISTS idx_flows_org_id
        ON flows ((data->>'orgId'));

      -- completed: filtru fluxuri finalizate vs active
      CREATE INDEX IF NOT EXISTS idx_flows_completed
        ON flows ((data->>'completed'));

      -- initEmail + orgId combinat: query-ul my-flows (cel mai frecvent)
      CREATE INDEX IF NOT EXISTS idx_flows_init_org
        ON flows ((data->>'initEmail'), (data->>'orgId'));
    `
  },
  {
    id: '037_flows_soft_delete',
    sql: `
      -- Soft delete: flows nu se mai sterg fizic — se marcheaza ca sterse
      -- Permite audit complet si recuperare in caz de accident
      ALTER TABLE flows ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
      ALTER TABLE flows ADD COLUMN IF NOT EXISTS deleted_by TEXT DEFAULT NULL;
      CREATE INDEX IF NOT EXISTS idx_flows_deleted_at ON flows(deleted_at) WHERE deleted_at IS NULL;
    `
  },
  {
    id: '038_users_totp_2fa',
    sql: `
      -- 2FA TOTP pentru conturi privilegiate (admin, org_admin)
      ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret      TEXT    DEFAULT NULL;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled     BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_backup_codes TEXT[]  DEFAULT NULL;
    `
  },
  {
    id: '039_flows_signers_gin_index',
    sql: `
      -- PERF-04: GIN index pe data->'signers' pentru query-ul STS OAuth callback
      -- SELECT ... FROM flows WHERE data->'signers' @> $1::jsonb LIMIT 1
      -- Fără index: sequential scan pe toate fluxurile active. Cu GIN: lookup direct.
      CREATE INDEX IF NOT EXISTS idx_flows_signers_gin
        ON flows USING GIN ((data->'signers'));
    `
  },
  {
    id: '040_outreach_click_tracking',
    sql: `
      -- Tracking click-uri separat de deschideri (pixel) — click-urile sunt metrica reala
      -- clicked_at: momentul primului click pe orice link din email
      -- click_count: numarul total de click-uri (acelasi utilizator poate da click de mai multe ori)
      ALTER TABLE outreach_recipients ADD COLUMN IF NOT EXISTS clicked_at   TIMESTAMPTZ DEFAULT NULL;
      ALTER TABLE outreach_recipients ADD COLUMN IF NOT EXISTS click_count  INTEGER     NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_orecip_clicked ON outreach_recipients(clicked_at) WHERE clicked_at IS NOT NULL;
    `
  },
  {
    id: '041_flows_pdfs_pades_keys',
    sql: `
      -- PAdES: extindem constraint-ul pe flows_pdfs.key pentru a permite chei temporare PAdES
      -- padesPdf_N: PDF-ul cu ByteRange placeholder pentru semnatarul N (stocat temporar la initiate, șters după poll)
      ALTER TABLE flows_pdfs DROP CONSTRAINT IF EXISTS flows_pdfs_key_check;
      ALTER TABLE flows_pdfs ADD CONSTRAINT flows_pdfs_key_check
        CHECK (key IN ('pdfB64','signedPdfB64','originalPdfB64')
               OR key LIKE 'padesPdf_%');
    `
  },
  {
    id: '042_bulk_signing_sessions',
    sql: `
      -- Bulk signing: sesiuni de semnare în masă (un utilizator semnează N documente
      -- printr-un singur flux OAuth + o singură aprobare email/PUSH la STS)
      CREATE TABLE IF NOT EXISTS bulk_signing_sessions (
        id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id        INTEGER      REFERENCES organizations(id) ON DELETE SET NULL,
        signer_email  TEXT         NOT NULL,
        provider_id   TEXT         NOT NULL DEFAULT 'sts-cloud',
        status        TEXT         NOT NULL DEFAULT 'initiated'
                                   CHECK (status IN ('initiated','oauth_pending','signing_pending','completed','error')),
        items         JSONB        NOT NULL DEFAULT '[]',
        sts_provider_data JSONB,
        sts_op_id     TEXT,
        sts_token     TEXT,
        sts_sign_url  TEXT,
        sts_cert_pem  TEXT,
        error_message TEXT,
        created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        expires_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW() + INTERVAL '2 hours',
        completed_at  TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_bulk_sessions_signer
        ON bulk_signing_sessions(signer_email, status);
      CREATE INDEX IF NOT EXISTS idx_bulk_sessions_expires
        ON bulk_signing_sessions(expires_at)
        WHERE status NOT IN ('completed','error');
    `
  },
  {
    id: '043_flows_pdfs_pades_fix',
    sql: `
      -- b233: refacem explicit constraint-ul flows_pdfs.key pentru a include padesPdf_%
      -- Migration 041 a putut rula in medii unde constraint-ul deja exista (DROP IF EXISTS ok
      -- dar ADD CONSTRAINT putea eșua silențios sau nu a inclus padesPdf_% corect).
      ALTER TABLE flows_pdfs DROP CONSTRAINT IF EXISTS flows_pdfs_key_check;
      ALTER TABLE flows_pdfs ADD CONSTRAINT flows_pdfs_key_check
        CHECK (key IN ('pdfB64','signedPdfB64','originalPdfB64')
               OR key LIKE 'padesPdf_%');
    `
  },
  {
    id: '045_cleanup_pades_jsonb',
    sql: `
      -- b233: curățăm cheile _padesPdf_N rămase în JSONB din fluxuri existente
      -- Acestea sunt PDF-uri de ~300KB care blochează app-ul dacă nu sunt șterse la poll
      UPDATE flows SET data = data - '_padesPdf_0' - '_padesPdf_1' - '_padesPdf_2' - '_padesPdf_3'
        - 'padesPdfs'
      WHERE data ? '_padesPdf_0' OR data ? '_padesPdf_1' OR data ? 'padesPdfs';
    `
  },
  {
    id: '044_flows_pdfs_no_constraint',
    sql: `
      -- b233: eliminam COMPLET constraint-ul pe flows_pdfs.key.
      -- Motivul: CHECK constraint cauza INSERT silent-fail pentru cheia 'padesPdf_N'
      -- in unele medii (constraint ADD-uit partial sau cu versiune veche),
      -- ducand la fallback la pdfB64 (fara cartus, fara semnatura vizibila).
      -- flows_pdfs este o tabela interna — nu are sens sa restrictionam cheile.
      ALTER TABLE flows_pdfs DROP CONSTRAINT IF EXISTS flows_pdfs_key_check;
    `
  },
  {
    // FEAT: CIF + compartimente pe organizații
    // cif: Codul de Identificare Fiscală al instituției (completat automat în formulare)
    // compartimente: lista compartimentelor instituției (pentru datalist în formulare + flux nou)
    id: '047_org_cif_compartimente',
    sql: `
      ALTER TABLE organizations
        ADD COLUMN IF NOT EXISTS cif          TEXT    DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS compartimente TEXT[] NOT NULL DEFAULT '{}';
    `
  },
  {
    id: '048_notifications_data_col',
    sql: `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS data JSONB DEFAULT NULL;`
  },
  {
    id: '048_formulare_df',
    sql: `
      CREATE TABLE IF NOT EXISTS formulare_df (
        id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id          INTEGER NOT NULL REFERENCES organizations(id),
        version         INTEGER NOT NULL DEFAULT 1,
        status          TEXT    NOT NULL DEFAULT 'draft',
        created_by      INTEGER NOT NULL REFERENCES users(id),
        assigned_to     INTEGER REFERENCES users(id),
        flow_id         TEXT    DEFAULT NULL,

        cif             TEXT,
        den_inst_pb     TEXT,
        subtitlu_df     TEXT,
        nr_unic_inreg   TEXT,
        revizuirea      TEXT,
        data_revizuirii TEXT,

        compartiment_specialitate   TEXT,
        obiect_fd_reviz_scurt       TEXT,
        obiect_fd_reviz_lung        TEXT,
        ckbx_stab_tin_cont          TEXT,
        ckbx_ramane_suma            TEXT,
        ramane_suma                 TEXT,
        rows_val                    JSONB NOT NULL DEFAULT '[]',
        ckbx_fara_ang_emis_ancrt    TEXT,
        ckbx_cu_ang_emis_ancrt      TEXT,
        ckbx_sting_ang_in_ancrt     TEXT,
        ckbx_fara_plati_ang_in_ancrt TEXT,
        ckbx_cu_plati_ang_in_mmani  TEXT,
        ckbx_ang_leg_emise_ct_an_urm TEXT,
        rows_plati                  JSONB NOT NULL DEFAULT '[]',

        ckbx_secta_inreg_ctrl_ang   TEXT,
        ckbx_fara_inreg_ctrl_ang    TEXT,
        sum_fara_inreg_ctrl_crdbug  TEXT,
        ckbx_interzis_emit_ang      TEXT,
        ckbx_interzis_intrucat      TEXT,
        intrucat                    TEXT,
        rows_ctrl                   JSONB NOT NULL DEFAULT '[]',

        submitted_at  TIMESTAMPTZ,
        completed_at  TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at    TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_formulare_df_org    ON formulare_df(org_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_formulare_df_p1     ON formulare_df(created_by);
      CREATE INDEX IF NOT EXISTS idx_formulare_df_p2     ON formulare_df(assigned_to) WHERE assigned_to IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_formulare_df_status ON formulare_df(org_id, status) WHERE deleted_at IS NULL;
    `
  },
  {
    id: '049_formulare_ord',
    sql: `
      CREATE TABLE IF NOT EXISTS formulare_ord (
        id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id          INTEGER NOT NULL REFERENCES organizations(id),
        version         INTEGER NOT NULL DEFAULT 1,
        status          TEXT    NOT NULL DEFAULT 'draft',
        created_by      INTEGER NOT NULL REFERENCES users(id),
        assigned_to     INTEGER REFERENCES users(id),
        df_id           UUID    REFERENCES formulare_df(id),
        flow_id         TEXT    DEFAULT NULL,

        cif             TEXT,
        den_inst_pb     TEXT,
        nr_ordonant_pl  TEXT,
        data_ordont_pl  TEXT,

        nr_unic_inreg           TEXT,
        beneficiar              TEXT,
        documente_justificative TEXT,
        iban_beneficiar         TEXT,
        cif_beneficiar          TEXT,
        banca_beneficiar        TEXT,
        inf_pv_plata            TEXT,
        inf_pv_plata1           TEXT,

        rows JSONB NOT NULL DEFAULT '[]',

        submitted_at  TIMESTAMPTZ,
        completed_at  TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at    TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_formulare_ord_org    ON formulare_ord(org_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_formulare_ord_p1     ON formulare_ord(created_by);
      CREATE INDEX IF NOT EXISTS idx_formulare_ord_p2     ON formulare_ord(assigned_to) WHERE assigned_to IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_formulare_ord_status ON formulare_ord(org_id, status) WHERE deleted_at IS NULL;
    `
  },
  {
    id: '050_formulare_capturi',
    sql: `
      CREATE TABLE IF NOT EXISTS formulare_capturi (
        id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
        form_type   TEXT    NOT NULL,
        form_id     UUID    NOT NULL,
        uploaded_by INTEGER NOT NULL REFERENCES users(id),
        filename    TEXT,
        mimetype    TEXT,
        size_bytes  INTEGER,
        data        BYTEA   NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_formulare_capturi_form ON formulare_capturi(form_type, form_id);
    `
  },
  {
    id: '051_beneficiari',
    sql: `
      CREATE TABLE IF NOT EXISTS beneficiari (
        id        SERIAL PRIMARY KEY,
        org_id    INTEGER REFERENCES organizations(id),
        denumire  TEXT NOT NULL,
        cif       VARCHAR(20),
        iban      VARCHAR(34),
        banca     TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_beneficiari_org ON beneficiari(org_id);
    `
  },
  {
    id: '052_formulare_ord_compartiment',
    sql: `
      ALTER TABLE formulare_ord
        ADD COLUMN IF NOT EXISTS compartiment_specialitate TEXT;
    `
  },
  {
    id: '053_formulare_motiv_returnare',
    sql: `
      ALTER TABLE formulare_df  ADD COLUMN IF NOT EXISTS motiv_returnare TEXT;
      ALTER TABLE formulare_ord ADD COLUMN IF NOT EXISTS motiv_returnare TEXT;
    `
  },
  {
    id: '054_alop_sabloane_schema',
    sql: `
      DO $do$ DECLARE has_old boolean;
      BEGIN
        -- Sigur dacă tabela nu există încă (creată ulterior de runMigrationsV4)
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema='public' AND table_name='alop_sabloane'
        ) THEN RETURN; END IF;

        -- Adaugă coloanele noi (no-op dacă există deja)
        ALTER TABLE alop_sabloane
          ADD COLUMN IF NOT EXISTS df_semnatari_sablon   JSONB DEFAULT '[]',
          ADD COLUMN IF NOT EXISTS ord_semnatari_sablon  JSONB DEFAULT '[]',
          ADD COLUMN IF NOT EXISTS lichidare_sablon      JSONB DEFAULT '{}';

        -- Verifică dacă există coloanele vechi
        SELECT EXISTS(
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='alop_sabloane'
            AND column_name='signatari_angajare'
        ) INTO has_old;

        IF has_old THEN
          EXECUTE $u$
            UPDATE alop_sabloane
            SET df_semnatari_sablon  = COALESCE(signatari_angajare, '[]'::jsonb),
                ord_semnatari_sablon = COALESCE(signatari_ordonantare, '[]'::jsonb),
                lichidare_sablon     = COALESCE(
                  CASE WHEN signatari_lichidare IS NOT NULL
                       AND jsonb_array_length(signatari_lichidare) > 0
                  THEN signatari_lichidare->0 ELSE '{}'::jsonb END, '{}'::jsonb)
            WHERE df_semnatari_sablon = '[]'::jsonb
          $u$;
          ALTER TABLE alop_sabloane
            DROP COLUMN IF EXISTS signatari_angajare,
            DROP COLUMN IF EXISTS signatari_lichidare,
            DROP COLUMN IF EXISTS signatari_ordonantare,
            DROP COLUMN IF EXISTS signatari_plata;
        END IF;

        -- Setează defaults cu structura de roluri conform OMF 1140/2025
        ALTER TABLE alop_sabloane
          ALTER COLUMN df_semnatari_sablon SET DEFAULT '[{"order":1,"role":"initiator","user_id":null,"name":""},{"order":2,"role":"sef_compartiment","user_id":null,"name":"","same_as_initiator":false},{"order":3,"role":"responsabil_cab","user_id":null,"name":""},{"order":4,"role":"sef_cab","user_id":null,"name":""},{"order":5,"role":"director_economic","user_id":null,"name":""},{"order":6,"role":"ordonator_credite","user_id":null,"name":""}]',
          ALTER COLUMN ord_semnatari_sablon SET DEFAULT '[{"order":1,"role":"initiator","user_id":null,"name":""},{"order":2,"role":"responsabil_cab","user_id":null,"name":""},{"order":3,"role":"cfp_propriu","user_id":null,"name":""},{"order":4,"role":"ordonator_credite","user_id":null,"name":""}]';

      END $do$;
    `
  },
  {
    id: '055_alop_instances_semnatari',
    sql: `
      DO $g$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.tables
          WHERE table_schema='public' AND table_name='alop_instances'
        ) THEN RETURN; END IF;
        ALTER TABLE alop_instances
          ADD COLUMN IF NOT EXISTS df_semnatari  JSONB DEFAULT '[]',
          ADD COLUMN IF NOT EXISTS ord_semnatari JSONB DEFAULT '[]',
          ADD COLUMN IF NOT EXISTS lichidare_confirmed_by INTEGER;
        BEGIN
          ALTER TABLE alop_instances
            ADD CONSTRAINT alop_lichidare_confirmed_by_fk
            FOREIGN KEY (lichidare_confirmed_by) REFERENCES users(id);
        EXCEPTION WHEN duplicate_object THEN NULL;
        END;
      END $g$;
    `
  },
  {
    id: '056_formulare_df_revizuiri',
    sql: `
      ALTER TABLE formulare_df
        ADD COLUMN IF NOT EXISTS revizie_nr    INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS parent_df_id  UUID REFERENCES formulare_df(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS este_revizie  BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS revizie_motiv TEXT,
        ADD COLUMN IF NOT EXISTS revizie_at    TIMESTAMPTZ;

      CREATE INDEX IF NOT EXISTS idx_formulare_df_parent
        ON formulare_df(parent_df_id)
        WHERE parent_df_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_formulare_df_nr_unic
        ON formulare_df(nr_unic_inreg, org_id)
        WHERE nr_unic_inreg IS NOT NULL;

      UPDATE formulare_df
        SET revizie_nr = 0, este_revizie = FALSE
        WHERE revizie_nr IS NULL;
    `
  },
  {
    id: '057_formulare_df_revizie_an_urmator',
    sql: `
      ALTER TABLE formulare_df
        ADD COLUMN IF NOT EXISTS este_revizie_an_urmator BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS total_val_prec          NUMERIC(15,2);
    `
  },
  {
    id: '058_formulare_ord_img2',
    sql: `
      ALTER TABLE formulare_ord
        ADD COLUMN IF NOT EXISTS img2 TEXT;
    `
  },
  {
    id: '059_alop_lichidare_documente',
    sql: `
      DO $g$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.tables
          WHERE table_schema='public' AND table_name='alop_instances'
        ) THEN RETURN; END IF;
        ALTER TABLE alop_instances
          ADD COLUMN IF NOT EXISTS lichidare_nr_factura   TEXT,
          ADD COLUMN IF NOT EXISTS lichidare_data_factura DATE,
          ADD COLUMN IF NOT EXISTS lichidare_nr_pv        TEXT;
      END $g$;
    `
  },
  {
    id: '060_alop_plata_documente',
    sql: `
      DO $g$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.tables
          WHERE table_schema='public' AND table_name='alop_instances'
        ) THEN RETURN; END IF;
        ALTER TABLE alop_instances
          ADD COLUMN IF NOT EXISTS plata_nr_ordin      TEXT,
          ADD COLUMN IF NOT EXISTS plata_data          DATE,
          ADD COLUMN IF NOT EXISTS plata_suma_efectiva NUMERIC(15,2),
          ADD COLUMN IF NOT EXISTS plata_observatii    TEXT;
      END $g$;
    `
  },
  {
    id: '061_alop_lichidare_data_pv',
    sql: `
      DO $g$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.tables
          WHERE table_schema='public' AND table_name='alop_instances'
        ) THEN RETURN; END IF;
        ALTER TABLE alop_instances
          ADD COLUMN IF NOT EXISTS lichidare_data_pv DATE;
      END $g$;
    `
  },
  {
    id: '062_alop_multi_ord',
    sql: `
      DO $g$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.tables
          WHERE table_schema='public' AND table_name='alop_instances'
        ) THEN RETURN; END IF;
        CREATE TABLE IF NOT EXISTS alop_ord_cicluri (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          alop_id UUID NOT NULL REFERENCES alop_instances(id),
          org_id INTEGER NOT NULL,
          ciclu_nr INTEGER NOT NULL DEFAULT 1,
          ord_id UUID REFERENCES formulare_ord(id),
          ord_flow_id TEXT,
          lichidare_confirmed_by INTEGER REFERENCES users(id),
          lichidare_confirmed_at TIMESTAMPTZ,
          lichidare_nr_factura TEXT,
          lichidare_data_factura DATE,
          lichidare_nr_pv TEXT,
          lichidare_data_pv DATE,
          lichidare_notes TEXT,
          plata_confirmed_by INTEGER REFERENCES users(id),
          plata_confirmed_at TIMESTAMPTZ,
          plata_nr_ordin TEXT,
          plata_data DATE,
          plata_suma_efectiva NUMERIC(15,2),
          plata_observatii TEXT,
          status TEXT NOT NULL DEFAULT 'lichidare',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_alop_ord_cicluri_alop
          ON alop_ord_cicluri(alop_id);
        ALTER TABLE alop_instances
          ADD COLUMN IF NOT EXISTS suma_totala_platita NUMERIC(15,2) DEFAULT 0,
          ADD COLUMN IF NOT EXISTS ciclu_curent INTEGER DEFAULT 1;
      END $g$;
    `
  },
  {
    id: '063_user_leave_delegate',
    sql: `
      DO $g$ BEGIN
        ALTER TABLE users
          ADD COLUMN IF NOT EXISTS leave_start DATE,
          ADD COLUMN IF NOT EXISTS leave_end DATE,
          ADD COLUMN IF NOT EXISTS delegate_user_id INTEGER,
          ADD COLUMN IF NOT EXISTS leave_reason TEXT;

        BEGIN
          ALTER TABLE users
            ADD CONSTRAINT users_delegate_fk
            FOREIGN KEY (delegate_user_id) REFERENCES users(id) ON DELETE SET NULL;
        EXCEPTION WHEN duplicate_object THEN NULL;
        END;

        BEGIN
          ALTER TABLE users
            ADD CONSTRAINT users_leave_dates_chk
            CHECK (leave_end IS NULL OR leave_start IS NULL OR leave_end >= leave_start);
        EXCEPTION WHEN duplicate_object THEN NULL;
        END;

        BEGIN
          ALTER TABLE users
            ADD CONSTRAINT users_no_self_delegate_chk
            CHECK (delegate_user_id IS NULL OR delegate_user_id != id);
        EXCEPTION WHEN duplicate_object THEN NULL;
        END;

        CREATE INDEX IF NOT EXISTS idx_users_leave_active
          ON users(leave_start, leave_end)
          WHERE leave_start IS NOT NULL;
      END $g$;
    `
  },
  {
    id: '064_delegation_functie',
    sql: `
      ALTER TABLE delegations
        ADD COLUMN IF NOT EXISTS reason       TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS functie_from TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS functie_to   TEXT NOT NULL DEFAULT '';
    `
  },
  {
    id: '065_formulare_df_ckbx_oblig_tert',
    sql: `
      ALTER TABLE formulare_df
        ADD COLUMN IF NOT EXISTS ckbx_oblig_tert TEXT;
    `
  },
  {
    id: '066_updated_by_tracking',
    sql: `
      ALTER TABLE formulare_df
        ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES users(id);
      ALTER TABLE formulare_ord
        ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES users(id);
      CREATE INDEX IF NOT EXISTS idx_formulare_df_updated_by ON formulare_df(updated_by);
      CREATE INDEX IF NOT EXISTS idx_formulare_ord_updated_by ON formulare_ord(updated_by);
      DO $g$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.tables
          WHERE table_schema='public' AND table_name='alop_instances'
        ) THEN RETURN; END IF;
        ALTER TABLE alop_instances
          ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES users(id);
        CREATE INDEX IF NOT EXISTS idx_alop_instances_updated_by ON alop_instances(updated_by);
      END $g$;
    `
  },
  {
    id: '067_soft_delete_users_orgs',
    sql: `
      DO $g$ BEGIN
        -- ── Users: soft-delete + partial unique pe email activ ─────
        ALTER TABLE users
          ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

        -- Eliminăm constrântul UNIQUE original pe email (auto-numit)
        -- ca să-l înlocuim cu unul partial care permite reutilizare
        -- emailului după soft-delete.
        DECLARE
          c text;
        BEGIN
          SELECT conname INTO c
            FROM pg_constraint
           WHERE conrelid = 'users'::regclass
             AND contype  = 'u'
             AND pg_get_constraintdef(oid) ILIKE '%(email)%';
          IF c IS NOT NULL THEN
            EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', c);
          END IF;
        END;

        -- Index unic parțial: doar pe useri activi (deleted_at IS NULL)
        CREATE UNIQUE INDEX IF NOT EXISTS users_email_active_uniq
          ON users (lower(email))
          WHERE deleted_at IS NULL;

        -- Index pentru filtrare rapidă în liste
        CREATE INDEX IF NOT EXISTS idx_users_deleted_at
          ON users(deleted_at)
          WHERE deleted_at IS NOT NULL;

        -- ── Organizations: soft-delete ─────────────────────────────
        ALTER TABLE organizations
          ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

        CREATE INDEX IF NOT EXISTS idx_organizations_deleted_at
          ON organizations(deleted_at)
          WHERE deleted_at IS NOT NULL;
      END $g$;
    `
  },
  {
    id: '068_formular_attachments',
    sql: `
      DO $g$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.tables
          WHERE table_schema='public' AND table_name='formulare_oficiale'
        ) THEN RETURN; END IF;
        CREATE TABLE IF NOT EXISTS formular_attachments (
          id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
          formular_id   UUID        NOT NULL REFERENCES formulare_oficiale(id) ON DELETE CASCADE,
          category      TEXT        NOT NULL CHECK (category IN ('caiet_sarcini','estimare_valoare','altele')),
          uploaded_by   INTEGER     NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
          filename      TEXT        NOT NULL,
          mime_type     TEXT        NOT NULL DEFAULT 'application/octet-stream',
          size_bytes    INTEGER     NOT NULL DEFAULT 0,
          data          BYTEA       NOT NULL,
          notes         TEXT,
          uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          deleted_at    TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS idx_formular_att_formular
          ON formular_attachments(formular_id, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_formular_att_category
          ON formular_attachments(formular_id, category, deleted_at);
      END $g$;
    `
  },
  {
    id: '069_clasa8_buget',
    sql: `
      CREATE TABLE IF NOT EXISTS clasa8_buget_versions (
        id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id          INTEGER     NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        version_no      INTEGER     NOT NULL,
        uploaded_by     INTEGER     REFERENCES users(id) ON DELETE SET NULL,
        uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        source_filename TEXT,
        row_count       INTEGER     NOT NULL DEFAULT 0,
        total_value     NUMERIC(18,2) NOT NULL DEFAULT 0,
        UNIQUE (org_id, version_no)
      );
      CREATE INDEX IF NOT EXISTS idx_clasa8_buget_versions_org_latest
        ON clasa8_buget_versions(org_id, version_no DESC);

      CREATE TABLE IF NOT EXISTS clasa8_buget (
        id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        version_id  UUID        NOT NULL REFERENCES clasa8_buget_versions(id) ON DELETE CASCADE,
        org_id      INTEGER     NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        cod_ssi     TEXT        NOT NULL,
        valoare     NUMERIC(18,2) NOT NULL DEFAULT 0,
        UNIQUE (org_id, cod_ssi)
      );
      CREATE INDEX IF NOT EXISTS idx_clasa8_buget_org    ON clasa8_buget(org_id);
      CREATE INDEX IF NOT EXISTS idx_clasa8_buget_codssi ON clasa8_buget(org_id, cod_ssi);
    `
  },
  {
    id: '070_module_catalog',
    sql: `
      CREATE TABLE IF NOT EXISTS module_catalog (
        module_key      TEXT PRIMARY KEY,
        display_name    TEXT NOT NULL,
        description     TEXT,
        category        TEXT,
        default_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        active          BOOLEAN NOT NULL DEFAULT TRUE,
        display_order   INTEGER NOT NULL DEFAULT 100,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      INSERT INTO module_catalog (module_key, display_name, category, default_enabled, display_order)
      VALUES
        ('refnec',         'Referat de necesitate',           'documente',  TRUE, 10),
        ('nf-invest',      'Notă de fundamentare investiții', 'documente',  TRUE, 20),
        ('alop',           'ALOP (umbrella)',                 'alop',       TRUE, 30),
        ('df',             'Document de fundamentare',        'alop',       TRUE, 40),
        ('ord',            'Ordonanțare de plată',            'alop',       TRUE, 50),
        ('clasa8',         'Clasa 8',                         'verificari', TRUE, 60),
        ('verif-furnizor', 'Verificare furnizor',             'verificari', TRUE, 70)
      ON CONFLICT (module_key) DO NOTHING;
    `
  },
  {
    id: '071_module_entitlements',
    sql: `
      CREATE TABLE IF NOT EXISTS module_entitlements (
        id          BIGSERIAL PRIMARY KEY,
        module_key  TEXT NOT NULL REFERENCES module_catalog(module_key) ON DELETE CASCADE,
        scope_type  TEXT NOT NULL CHECK (scope_type IN ('org','comp','user')),
        scope_id    TEXT NOT NULL,
        enabled     BOOLEAN NOT NULL,
        set_by      INTEGER NOT NULL REFERENCES users(id),
        set_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        notes       TEXT,
        UNIQUE (module_key, scope_type, scope_id)
      );
      CREATE INDEX IF NOT EXISTS idx_module_entitlements_lookup
        ON module_entitlements (scope_type, scope_id, module_key);
    `
  },
  {
    id: '072_opme_imports',
    sql: `
      CREATE TABLE IF NOT EXISTS opme_imports (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id          INTEGER NOT NULL REFERENCES organizations(id),
        uploaded_by     INTEGER NOT NULL REFERENCES users(id),
        file_hash       TEXT NOT NULL,
        file_name       TEXT,
        nr_document     TEXT,
        data_op         DATE,
        an_r            INTEGER,
        luna_r          INTEGER,
        cif_platitor    TEXT,
        den_platitor    TEXT,
        adresa_platitor TEXT,
        nr_inregistrari INTEGER,
        suma_totala     NUMERIC(15,2),
        universal_code  TEXT,
        raw_meta        JSONB NOT NULL DEFAULT '{}',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      DO $$ BEGIN
        ALTER TABLE opme_imports
          ADD CONSTRAINT opme_imports_org_hash_key UNIQUE (org_id, file_hash);
      EXCEPTION
        WHEN duplicate_table THEN NULL;
        WHEN duplicate_object THEN NULL;
      END $$;

      CREATE TABLE IF NOT EXISTS opme_lines (
        id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        opme_import_id        UUID NOT NULL REFERENCES opme_imports(id) ON DELETE CASCADE,
        org_id                INTEGER NOT NULL REFERENCES organizations(id),
        row_index             INTEGER NOT NULL,
        nr_op                 TEXT,
        iban_platitor         TEXT,
        den_trezorerie        TEXT,
        cod_program           TEXT,
        cod_angajament        TEXT,
        indicator_angajament  TEXT,
        den_beneficiar        TEXT,
        cif_beneficiar        TEXT,
        iban_beneficiar       TEXT,
        den_banca_trez        TEXT,
        suma_op               NUMERIC(15,2) NOT NULL,
        nr_evid_platii        TEXT,
        explicatii            TEXT,
        matched_alop_id       UUID,
        matched_ciclu_id      UUID,
        matched_at            TIMESTAMPTZ,
        match_status          TEXT NOT NULL DEFAULT 'pending',
        match_notes           TEXT,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT opme_lines_match_status_chk
          CHECK (match_status IN ('pending','auto','manual','unmatched','ambiguous','partial'))
      );

      CREATE INDEX IF NOT EXISTS idx_opme_imports_org
        ON opme_imports(org_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_opme_lines_import
        ON opme_lines(opme_import_id);
      CREATE INDEX IF NOT EXISTS idx_opme_lines_match
        ON opme_lines(org_id, match_status);
      CREATE INDEX IF NOT EXISTS idx_opme_lines_triplet
        ON opme_lines(org_id, cod_angajament, indicator_angajament, cif_beneficiar)
        WHERE match_status IN ('pending','unmatched');
      CREATE INDEX IF NOT EXISTS idx_opme_lines_matched_ciclu
        ON opme_lines(matched_ciclu_id) WHERE matched_ciclu_id IS NOT NULL;
    `
  },
  {
    // Pachet B: distinge confirmările de plată manuale vs cele auto din OPME.
    // alop_instances primește CHECK constraint (sursa "live"); alop_ord_cicluri
    // arhivează valoarea ulterior, fără CHECK (acceptă orice valoare istorică).
    id: '073_alop_plata_source',
    sql: `
      DO $g$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.tables
          WHERE table_schema='public' AND table_name='alop_instances'
        ) THEN RETURN; END IF;

        ALTER TABLE alop_instances
          ADD COLUMN IF NOT EXISTS plata_source TEXT DEFAULT 'manual';

        BEGIN
          ALTER TABLE alop_instances
            ADD CONSTRAINT alop_instances_plata_source_chk
            CHECK (plata_source IN ('manual','opme_auto'));
        EXCEPTION
          WHEN duplicate_object THEN NULL;
        END;
      END $g$;

      DO $g$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.tables
          WHERE table_schema='public' AND table_name='alop_ord_cicluri'
        ) THEN RETURN; END IF;

        ALTER TABLE alop_ord_cicluri
          ADD COLUMN IF NOT EXISTS plata_source TEXT;
      END $g$;
    `
  },
  {
    id: '074_registratura',
    sql: `
      -- Registratură Faza 1: serii de numerotare + intrări registru.
      -- Faza 1 folosește DOAR registru='general', directie='iesire'.
      -- Schema permite extindere (petitii/544/intrare) fără migrare nouă.

      CREATE TABLE IF NOT EXISTS registru_serii (
        org_id     INTEGER     NOT NULL REFERENCES organizations(id),
        registru   TEXT        NOT NULL DEFAULT 'general',
        an         INTEGER     NOT NULL,
        pattern    TEXT        NOT NULL DEFAULT '{nr}/{dd}.{mm}.{yyyy}',
        contor     INTEGER     NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (org_id, registru, an)
      );

      CREATE TABLE IF NOT EXISTS registru_intrari (
        id           BIGSERIAL   PRIMARY KEY,
        org_id       INTEGER     NOT NULL REFERENCES organizations(id),
        registru     TEXT        NOT NULL DEFAULT 'general',
        an           INTEGER     NOT NULL,
        numar        INTEGER     NOT NULL,
        numar_format TEXT        NOT NULL,
        data_inreg   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        directie     TEXT        NOT NULL DEFAULT 'iesire'
                                 CHECK (directie IN ('iesire','intrare','intern')),
        sursa_tip    TEXT        NOT NULL DEFAULT 'flow',
        sursa_id     TEXT        NOT NULL,
        flow_id      TEXT,
        obiect       TEXT        NOT NULL DEFAULT '',
        expeditor    TEXT        NOT NULL DEFAULT '',
        destinatar   TEXT        NOT NULL DEFAULT '',
        compartiment TEXT,
        created_by   INTEGER     REFERENCES users(id),
        meta         JSONB       NOT NULL DEFAULT '{}',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Idempotență: o sursă = o singură poziție per registru per org.
      CREATE UNIQUE INDEX IF NOT EXISTS uq_registru_sursa
        ON registru_intrari (org_id, registru, sursa_tip, sursa_id);
      CREATE INDEX IF NOT EXISTS idx_registru_org_an
        ON registru_intrari (org_id, registru, an, numar DESC);
      CREATE INDEX IF NOT EXISTS idx_registru_flow
        ON registru_intrari (flow_id) WHERE flow_id IS NOT NULL;

      INSERT INTO module_catalog
        (module_key, display_name, category, default_enabled, display_order)
      VALUES
        ('registratura', 'Registratură', 'documente', TRUE, 80)
      ON CONFLICT (module_key) DO NOTHING;
    `
  },
  {
    id: '075_registratura_faza2',
    sql: `
      -- Faza 2: coloane lifecycle/intrate pe registru_intrari + atașamente.
      -- Documentele emise (Faza 1) au aceste coloane NULL — comportament neschimbat.

      ALTER TABLE registru_intrari
        ADD COLUMN IF NOT EXISTS status            TEXT,
        ADD COLUMN IF NOT EXISTS mod_primire       TEXT,
        ADD COLUMN IF NOT EXISTS nr_doc_expeditor  TEXT,
        ADD COLUMN IF NOT EXISTS data_doc_expeditor DATE,
        ADD COLUMN IF NOT EXISTS termen_zile       INTEGER,
        ADD COLUMN IF NOT EXISTS termen_at         DATE,
        ADD COLUMN IF NOT EXISTS repartizat_la     TEXT,
        ADD COLUMN IF NOT EXISTS repartizat_at     TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS solutionat_at     TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS clasat_at         TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS raspuns_flow_id   TEXT;

      DO $g$ BEGIN
        ALTER TABLE registru_intrari
          ADD CONSTRAINT registru_status_chk
          CHECK (status IS NULL OR status IN
            ('inregistrat','repartizat','in_lucru','solutionat','clasat'));
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $g$;

      CREATE INDEX IF NOT EXISTS idx_registru_intrari_dir
        ON registru_intrari (org_id, directie, an, numar DESC);
      CREATE INDEX IF NOT EXISTS idx_registru_raspuns
        ON registru_intrari (raspuns_flow_id) WHERE raspuns_flow_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS registru_atasamente (
        id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        intrare_id  BIGINT      NOT NULL REFERENCES registru_intrari(id) ON DELETE CASCADE,
        org_id      INTEGER     NOT NULL REFERENCES organizations(id),
        filename    TEXT        NOT NULL,
        mime_type   TEXT        NOT NULL DEFAULT 'application/pdf',
        size_bytes  INTEGER     NOT NULL DEFAULT 0,
        data        BYTEA       NOT NULL,
        uploaded_by INTEGER     REFERENCES users(id),
        uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at  TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_registru_atas_intrare
        ON registru_atasamente (intrare_id, deleted_at);
    `
  },
  {
    id: '076_registratura_format',
    sql: `
      -- Numărul de înregistrare se afișează doar ca număr zero-pad 5 cifre
      -- ({nr5}); data e coloană separată. Seriile existente cu pattern-ul
      -- vechi sunt migrate; default-ul coloanei devine {nr5} pentru serii noi.
      ALTER TABLE registru_serii ALTER COLUMN pattern SET DEFAULT '{nr5}';
      UPDATE registru_serii
         SET pattern = '{nr5}'
       WHERE pattern = '{nr}/{dd}.{mm}.{yyyy}';
    `
  },
  {
    id: '077_registratura_serie_comuna',
    sql: `
      -- Numerotare continuă comună pentru ieșiri + intrări GENERALE.
      -- Intrările generale (registru='intrare') trec pe registru='general'
      -- și se renumerotează continuând după max(numar) existent pe org/an,
      -- ca să nu colizioneze cu numerele deja alocate ieșirilor.
      -- Petiții/544 NU se ating (serii proprii).
      WITH base AS (
        SELECT org_id, an, COALESCE(MAX(numar), 0) AS maxn
          FROM registru_intrari
         WHERE registru = 'general'
         GROUP BY org_id, an
      ),
      ren AS (
        SELECT i.id,
               COALESCE(b.maxn, 0)
                 + ROW_NUMBER() OVER (PARTITION BY i.org_id, i.an
                                      ORDER BY i.numar, i.id) AS newnum
          FROM registru_intrari i
          LEFT JOIN base b ON b.org_id = i.org_id AND b.an = i.an
         WHERE i.registru = 'intrare'
      )
      UPDATE registru_intrari t
         SET registru     = 'general',
             numar        = r.newnum,
             numar_format = lpad(r.newnum::text, 5, '0')
        FROM ren r
       WHERE t.id = r.id;

      -- Re-seed contorul seriei 'general' la max(numar) pe org/an
      INSERT INTO registru_serii (org_id, registru, an, contor)
        SELECT org_id, 'general', an, MAX(numar)
          FROM registru_intrari
         WHERE registru = 'general'
         GROUP BY org_id, an
      ON CONFLICT (org_id, registru, an)
        DO UPDATE SET contor = GREATEST(registru_serii.contor, EXCLUDED.contor),
                      updated_at = NOW();

      -- Seria 'intrare' nu mai e folosită
      DELETE FROM registru_serii WHERE registru = 'intrare';
    `
  },
  {
    id: '078_registratura_motiv_rezolutie',
    sql: `
      -- BLOC Registratură UX: justificări pentru clasare + rezoluție pe repartizare/soluționare.
      ALTER TABLE registru_intrari
        ADD COLUMN IF NOT EXISTS motiv_clasare TEXT,
        ADD COLUMN IF NOT EXISTS rezolutie     TEXT;
    `
  },
  {
    id: '079_formulare_capturi_slot',
    sql: `
      -- v3.9.499: extindere formulare_capturi cu slot pentru a permite multiple
      -- capturi per formular (ord captura 1 + captura 2). DF folosește doar slot=1.
      ALTER TABLE formulare_capturi
        ADD COLUMN IF NOT EXISTS slot SMALLINT NOT NULL DEFAULT 1;

      -- Drop indexul vechi non-unique pe (form_type, form_id) ca să facem unique pe triplet
      DROP INDEX IF EXISTS idx_formulare_capturi_form;
      CREATE INDEX IF NOT EXISTS idx_formulare_capturi_form
        ON formulare_capturi(form_type, form_id);

      -- Constraint unic pe triplet pentru a permite upsert per slot
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_formulare_capturi_form_slot
        ON formulare_capturi(form_type, form_id, slot);

      -- Backfill din formulare_ord.img2 → formulare_capturi(slot=2)
      -- Numai rândurile cu img2 valid (data URL format). Idempotent prin ON CONFLICT.
      INSERT INTO formulare_capturi (form_type, form_id, uploaded_by, filename, mimetype, size_bytes, data, slot)
      SELECT
        'ord',
        fo.id,
        fo.created_by,
        'captura2_backfill.png',
        COALESCE(substring(fo.img2 from '^data:([^;]+);'), 'image/png'),
        CASE
          WHEN fo.img2 ~ '^data:image\\/[a-z]+;base64,'
          THEN length(decode(split_part(fo.img2, ',', 2), 'base64'))
          ELSE 0
        END,
        CASE
          WHEN fo.img2 ~ '^data:image\\/[a-z]+;base64,'
          THEN decode(split_part(fo.img2, ',', 2), 'base64')
          ELSE NULL
        END,
        2
      FROM formulare_ord fo
      WHERE fo.img2 IS NOT NULL
        AND fo.img2 ~ '^data:image\\/[a-z]+;base64,'
        AND length(fo.img2) > 100
      ON CONFLICT (form_type, form_id, slot) DO NOTHING;

      -- Marchează img2 ca deprecated în comentariu (col rămâne pentru fallback citire)
      COMMENT ON COLUMN formulare_ord.img2 IS 'DEPRECATED v3.9.499 — datele migrate la formulare_capturi(slot=2). Coloană păstrată pentru fallback citire ord-uri vechi.';
    `
  },
  {
    id: '080_formulare_atasamente',
    sql: `
      -- v3.9.500: atașamente pentru DF/ORD (Compartiment specialitate → "Atașează fișiere").
      -- Înainte: atașamentele trăiau doar în memoria clientului (o-adata JSON) și se foloseau
      -- exclusiv pentru generarea PDF-ului. Nu erau persistate în DB → pierdute la reload sau
      -- viewer diferit. Pattern simetric cu formulare_capturi (BYTEA + endpoint dedicat).
      CREATE TABLE IF NOT EXISTS formulare_atasamente (
        id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        form_type   TEXT        NOT NULL CHECK (form_type IN ('df','ord')),
        form_id     UUID        NOT NULL,
        uploaded_by INTEGER     NOT NULL REFERENCES users(id),
        filename    TEXT        NOT NULL,
        mime_type   TEXT        NOT NULL DEFAULT 'application/octet-stream',
        size_bytes  INTEGER     NOT NULL DEFAULT 0,
        data        BYTEA       NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at  TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_formulare_atasamente_form
        ON formulare_atasamente(form_type, form_id) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_formulare_atasamente_uploader
        ON formulare_atasamente(uploaded_by);
    `
  }
  ,{
    id: '081_formulare_atasamente_slot',
    sql: `
      -- v3.9.501: slot column pentru multiple seturi atașamente per formular
      ALTER TABLE formulare_atasamente
        ADD COLUMN IF NOT EXISTS slot SMALLINT NOT NULL DEFAULT 1;

      DROP INDEX IF EXISTS idx_formulare_atasamente_form;
      CREATE INDEX IF NOT EXISTS idx_formulare_atasamente_form
        ON formulare_atasamente(form_type, form_id, slot) WHERE deleted_at IS NULL;
    `
  }
  ,{
    id: '082_formulare_ord_df_id_idx',
    sql: `
      -- v3.9.517: index pentru self-heal ALOP — query lookup ORD orfan WHERE fo.df_id=$1
      CREATE INDEX IF NOT EXISTS idx_formulare_ord_df_id
        ON formulare_ord(df_id) WHERE deleted_at IS NULL AND df_id IS NOT NULL;
    `
  }
  ,{
    id: '083_formulare_audit',
    sql: `
      -- v3.9.539: trail de audit per formular DF/ORD (timeline + export CSV/PDF)
      CREATE TABLE IF NOT EXISTS formulare_audit (
        id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id      INTEGER NOT NULL REFERENCES organizations(id),
        form_type   TEXT    NOT NULL,   -- 'df' | 'ord'
        form_id     UUID    NOT NULL,
        actor_id    INTEGER REFERENCES users(id),
        actor_email TEXT,
        event_type  TEXT    NOT NULL,
        from_status TEXT,
        to_status   TEXT,
        meta        JSONB   NOT NULL DEFAULT '{}',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_formulare_audit_form ON formulare_audit(form_type, form_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_formulare_audit_org  ON formulare_audit(org_id, created_at DESC);
    `
  }
  ,{
    id: '084_formulare_source_alop',
    sql: `
      -- v3.9.554: proveniență persistentă DF/ORD → ALOP. Legarea inițială (link-df/link-ord)
      -- depinde exclusiv de frontend și poate eșua silențios (409/403/CSRF/rețea) — cu
      -- source_alop_id persistat la creare, aprobarea fluxului poate re-lega automat ALOP-ul
      -- (self-heal în server/services/alop-link.mjs). Backfill istoric nu e necesar.
      ALTER TABLE formulare_df  ADD COLUMN IF NOT EXISTS source_alop_id UUID NULL;
      ALTER TABLE formulare_ord ADD COLUMN IF NOT EXISTS source_alop_id UUID NULL;
      CREATE INDEX IF NOT EXISTS idx_formulare_df_source_alop
        ON formulare_df(source_alop_id) WHERE source_alop_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_formulare_ord_source_alop
        ON formulare_ord(source_alop_id) WHERE source_alop_id IS NOT NULL;
    `
  },
  {
    // v3.9.558 (FEATURE buget multi-anual): ancorare an absolut pe DF.
    // `rows_plati` are benzi RELATIVE (ancrt/np1/np2/np3/ani_precedenti/ani_ulter).
    // `an_referinta` stochează anul absolut căruia îi aparține `plati_estim_ancrt`;
    // np1 → an_referinta+1, ... ani_ulter → > an_referinta+3. NULL = legacy / nedeclarat
    // (DF create înainte de această migrare) — NU se backfillează automat. Decizia owner:
    // pentru NULL plafonul rămâne mono-an pe `ancrt` (block hard 422, identic FIX B).
    id: '085_formulare_df_an_referinta',
    sql: `
      ALTER TABLE formulare_df ADD COLUMN IF NOT EXISTS an_referinta INTEGER NULL;
    `
  },
  {
    // v3.9.558 (FEATURE buget multi-anual): an de exercițiu pe ciclurile arhivate.
    // Pentru cumul corect PER an de exercițiu (o ordonanțare făcută în 2026 consumă
    // bugetul 2026, nu pe cel din 2027), ciclul arhivat marchează explicit anul plății.
    // Populat la arhivare din anul `plata_data` (fallback derivat la calcul pentru
    // ciclurile istorice fără valoare). Tabela e creată inline (062) dar GARDATĂ pe
    // fresh boot (alop_instances vine din V4) → ALTER-ul TREBUIE gardat la fel (vezi 073).
    id: '086_alop_ord_cicluri_an_exercitiu',
    sql: `
      -- depinde de alop_instances (tabela-părinte V4): acest token forțează deferral-ul
      -- în migrateForTests (V4_ONLY regex) ca ALTER-ul să ruleze DUPĂ ce 062 creează
      -- alop_ord_cicluri pe DB fresh — fără el guard-ul ar sări tăcut și coloana ar lipsi.
      DO $g$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.tables
          WHERE table_schema='public' AND table_name='alop_ord_cicluri'
        ) THEN RETURN; END IF;
        ALTER TABLE alop_ord_cicluri
          ADD COLUMN IF NOT EXISTS an_exercitiu INTEGER;
      END $g$;
    `
  },
  {
    // SecB DF (v3.9.585): a doua sumă CFP — „credite bugetare" (sum_fara_inreg_ctrl_crd_bug).
    // Era câmp-fantomă (colectat de frontend, fără coloană/whitelist → pierdut la reload).
    // formulare_df e tabelă inline (mig. 048) → există garantat, fără guard V4.
    id: '087_formulare_df_sum_crd_bug',
    sql: `
      ALTER TABLE formulare_df ADD COLUMN IF NOT EXISTS sum_fara_inreg_ctrl_crd_bug TEXT;
    `
  },
  {
    // Transmitere internă (repartizare) a documentului finalizat către un utilizator
    // SAU un compartiment care nu a fost neapărat semnatar. Sursa de adevăr a accesului
    // „destinatar" pe flux. CHECK garantează EXACT o țintă (user XOR compartiment).
    id: '088_flow_recipients',
    sql: `
      CREATE TABLE IF NOT EXISTS flow_recipients (
        id                     BIGSERIAL   PRIMARY KEY,
        flow_id                TEXT        NOT NULL REFERENCES flows(id),
        org_id                 INTEGER     REFERENCES organizations(id),
        recipient_user_id      INTEGER     REFERENCES users(id),
        recipient_compartiment TEXT,
        rezolutie              TEXT,
        source                 TEXT        NOT NULL DEFAULT 'auto',
        transmitted_by         INTEGER     REFERENCES users(id),
        transmitted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        acknowledged_at        TIMESTAMPTZ,
        CONSTRAINT flow_recipients_target_chk
          CHECK ( (recipient_user_id IS NOT NULL)::int + (NULLIF(TRIM(recipient_compartiment),'') IS NOT NULL)::int = 1 )
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_flow_recipient_user
        ON flow_recipients(flow_id, recipient_user_id) WHERE recipient_user_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_flow_recipient_comp
        ON flow_recipients(flow_id, TRIM(recipient_compartiment)) WHERE NULLIF(TRIM(recipient_compartiment),'') IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_flow_recipient_user ON flow_recipients(recipient_user_id, acknowledged_at);
      CREATE INDEX IF NOT EXISTS idx_flow_recipient_comp ON flow_recipients(TRIM(recipient_compartiment)) WHERE NULLIF(TRIM(recipient_compartiment),'') IS NOT NULL;
    `
  },
  {
    // Confirmare „luare la cunoștință" PER-PERSOANĂ pe repartizare (flow_recipients, mig. 088).
    // O repartizare către compartiment are un singur rând în flow_recipients, dar fiecare
    // membru trebuie să confirme individual — de aceea confirmarea trăiește într-un tabel
    // separat, cheiat pe (flow_id, user_id), nu pe id-ul rândului din flow_recipients.
    id: '089_flow_recipient_acks',
    sql: `
      CREATE TABLE IF NOT EXISTS flow_recipient_acks (
        flow_id         TEXT        NOT NULL REFERENCES flows(id),
        user_id         INTEGER     NOT NULL REFERENCES users(id),
        acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (flow_id, user_id)
      );
    `
  },
  {
    // FIX CRIT (2026-07-02): /my-flows a dat statement timeout (57014, seq scan) în ciuda
    // faptului că AMBELE ramuri ale OR-ului (data->>'initEmail' și data->'signers' @> ...)
    // au deja index (idx_flows_init_email din mig. ~038, idx_flows_signers_gin din mig.
    // 039_flows_signers_gin_index). NU lipsea niciun index — re-declararea idx_flows_signers_gin
    // ar fi fost no-op (CREATE INDEX IF NOT EXISTS pe un nume deja existent nu-l recreează).
    // Cauza cea mai probabilă: date de test acumulate în masă în această sesiune fără ANALYZE
    // ulterior — statistici învechite → planner subestimează selectivitatea predicatelor
    // JSONB și alege seq scan în loc de BitmapOr pe indexurile existente. ANALYZE e sigur în
    // tranzacție (spre deosebire de VACUUM). idx_flows_org_created e index nou, complementar
    // lui idx_flows_org_updated — susține ORDER BY created_at DESC filtrat pe org_id, folosit
    // de /my-flows și alte listinguri.
    id: '090_flows_analyze_and_org_created_idx',
    sql: `
      ANALYZE flows;
      CREATE INDEX IF NOT EXISTS idx_flows_org_created
        ON flows(org_id, created_at DESC);
    `
  },
  {
    id: '091_flow_recipients_backfill_auto_initiator',
    sql: `
      UPDATE flow_recipients fr
         SET transmitted_by = u.id
        FROM flows f
        JOIN users u ON lower(u.email) = lower(f.data->>'initEmail')
       WHERE fr.flow_id = f.id
         AND fr.source = 'auto'
         AND fr.transmitted_by IS NULL
         AND f.data->>'initEmail' IS NOT NULL;
    `
  },
  {
    id: '092_org_cab_compartiment',
    sql: `
      ALTER TABLE organizations ADD COLUMN IF NOT EXISTS cab_compartiment TEXT;
    `
  },
  {
    // v3.9.679 (#95): poartă de stări ALOP în Postgres — FAZA 1 (OBSERVARE).
    // Trei obiecte: CHECK pe status, tabelă audit append-only, trigger de audit AFTER UPDATE.
    //
    // GARDĂ V4: alop_instances vine din V4 (014_alop.sql) care rulează DUPĂ inline. ALTER-ul +
    // trigger-ul pe alop_instances sunt gardate (fresh prod boot: guard sare, ZERO crash — vezi
    // incidentul 2026-04-19). Tokenul `alop_instances` din SQL forțează deferral-ul în
    // migrateForTests (V4_ONLY regex) ca migrarea să se re-ruleze DUPĂ ce 014_alop.sql creează
    // tabela pe DB fresh de test → constraint+trigger CHIAR se creează în teste.
    //
    // Tipuri (verificate în migrații, NU presupuse): alop_instances.id = UUID; org_id = INTEGER;
    // updated_by → users.id = INTEGER (SERIAL). alop_status_log NU are FK spre alop_instances —
    // auditul TREBUIE să supraviețuiască ștergerii ALOP-ului.
    //
    // DUBLĂ ÎNREGISTRARE (împreună cu 094): o violare produce DOUĂ rânduri în alop_status_log —
    // unul de la audit (violation=FALSE, AFTER) și unul de la guard (violation=TRUE, BEFORE).
    // Intenționat și util; NU se deduplică (ar cere comunicare între triggere).
    id: '093_alop_state_gate',
    sql: `
      CREATE TABLE IF NOT EXISTS alop_status_log (
        id           BIGSERIAL PRIMARY KEY,
        alop_id      UUID        NOT NULL,
        org_id       INTEGER,
        from_status  TEXT,
        to_status    TEXT        NOT NULL,
        changed_by   INTEGER,
        violation    BOOLEAN     NOT NULL DEFAULT FALSE,
        changed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_alop_status_log_alop ON alop_status_log(alop_id, changed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_alop_status_log_viol ON alop_status_log(violation) WHERE violation = TRUE;

      CREATE OR REPLACE FUNCTION alop_status_audit() RETURNS TRIGGER AS $fn$
      BEGIN
        IF NEW.status IS DISTINCT FROM OLD.status THEN
          INSERT INTO alop_status_log (alop_id, org_id, from_status, to_status, changed_by)
          VALUES (NEW.id, NEW.org_id, OLD.status, NEW.status, NEW.updated_by);
        END IF;
        RETURN NEW;
      END $fn$ LANGUAGE plpgsql;

      DO $g$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.tables
          WHERE table_schema='public' AND table_name='alop_instances'
        ) THEN RETURN; END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alop_status_valid') THEN
          ALTER TABLE alop_instances ADD CONSTRAINT alop_status_valid
            CHECK (status IN ('draft','angajare','lichidare','ordonantare','plata','completed','cancelled'));
        END IF;

        DROP TRIGGER IF EXISTS trg_alop_status_audit ON alop_instances;
        CREATE TRIGGER trg_alop_status_audit
          AFTER UPDATE ON alop_instances
          FOR EACH ROW EXECUTE FUNCTION alop_status_audit();
      END $g$;
    `
  },
  {
    // v3.9.679 (#95): poartă de stări ALOP — FAZA 1 trigger de validare, MOD OBSERVARE.
    // ⛔ NU BLOCHEAZĂ NIMIC: la tranziție invalidă → RAISE WARNING + INSERT violation=TRUE, apoi
    // RETURN NEW (permite ORICE). Flipul spre RAISE EXCEPTION/RETURN NULL e o migrare SEPARATĂ,
    // ABIA după 7 zile cu zero violări pe producție (vezi secțiunea ⏳ din CLAUDE.md).
    // Matricea = docs/audits/ALOP-STATE-MATRIX.md (codul e specificația). NU o „corecta":
    // completed→lichidare (noua-lichidare), draft→lichidare (salt) și angajare→plata (repair) sunt CORECTE.
    // Gardat V4 + token `alop_instances` la fel ca 093. INSERT-ul folosește alop_status_log (creat de 093).
    id: '094_alop_state_guard',
    sql: `
      CREATE OR REPLACE FUNCTION alop_status_guard() RETURNS TRIGGER AS $fn$
      DECLARE
        allowed TEXT[];
      BEGIN
        IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
          RETURN NEW;
        END IF;

        allowed := CASE OLD.status
          WHEN 'draft'       THEN ARRAY['angajare','lichidare','cancelled']
          WHEN 'angajare'    THEN ARRAY['lichidare','plata','cancelled']
          WHEN 'lichidare'   THEN ARRAY['ordonantare','cancelled']
          WHEN 'ordonantare' THEN ARRAY['plata','cancelled']
          WHEN 'plata'       THEN ARRAY['completed','cancelled']
          WHEN 'completed'   THEN ARRAY['lichidare']
          WHEN 'cancelled'   THEN ARRAY[]::TEXT[]
          ELSE ARRAY[]::TEXT[]
        END;

        IF NOT (NEW.status = ANY(allowed)) THEN
          RAISE WARNING 'ALOP transition violation: % -> % (alop_id=%)', OLD.status, NEW.status, NEW.id;
          INSERT INTO alop_status_log (alop_id, org_id, from_status, to_status, changed_by, violation)
          VALUES (NEW.id, NEW.org_id, OLD.status, NEW.status, NEW.updated_by, TRUE);
        END IF;

        RETURN NEW;
      END $fn$ LANGUAGE plpgsql;

      DO $g$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.tables
          WHERE table_schema='public' AND table_name='alop_instances'
        ) THEN RETURN; END IF;

        DROP TRIGGER IF EXISTS trg_alop_status_guard ON alop_instances;
        CREATE TRIGGER trg_alop_status_guard
          BEFORE UPDATE ON alop_instances
          FOR EACH ROW EXECUTE FUNCTION alop_status_guard();
      END $g$;
    `
  },
  {
    // v3.9.681 (#97): prevenire DF duplicat din context ALOP (incident 13.07.2026 — dublu-click
    // pe „Completează DF" ⇒ două formulare_df goale, revizie_nr=0, același source_alop_id; ALOP
    // legat la cel gol). Migrarea face DOUĂ lucruri, în ordine: (2a) curăță duplicatele existente,
    // (2b) creează indexul unic parțial ca poartă durabilă. ⛔ ORDINEA E OBLIGATORIE — indexul nu
    // se poate crea cât timp există duplicate. formulare_df: id UUID, source_alop_id UUID,
    // revizie_nr INTEGER, flow_id TEXT, status TEXT — verificate, nu presupuse.
    //
    // ⛔ NU șterge NICIODATĂ un DF cu flow_id (e pe flux de semnare). Un grup cu ≥2 DF-uri pe
    // flux = caz intratabil: NEATINS + WARNING (rezolvare manuală). Mai bine indexul lipsește
    // decât să ștergem un document semnat. 2b e înfășurat în EXCEPTION → boot-ul supraviețuiește
    // dacă indexul nu se poate crea (evită un 19-aprilie: 503 db_not_ready pe tot).
    id: '095_df_dedup_and_unique',
    sql: `
      -- 2a. CURĂȚARE — soft-delete duplicatele goale (NICIODATĂ DELETE, NICIODATĂ un DF pe flux).
      DO $dedup$
      DECLARE
        r RECORD;
      BEGIN
        -- Cazul intratabil: grup (source_alop_id, revizie_nr) cu ≥2 DF-uri active AMBELE pe flux.
        -- NU-l atinge — doar avertizează. Indexul 2b va eșua controlat pe el (prins de EXCEPTION).
        FOR r IN
          SELECT source_alop_id, revizie_nr
          FROM formulare_df
          WHERE source_alop_id IS NOT NULL AND deleted_at IS NULL AND flow_id IS NOT NULL
          GROUP BY source_alop_id, revizie_nr
          HAVING COUNT(*) > 1
        LOOP
          RAISE WARNING '095_df_dedup: grup ALOP % rev % cu >=2 DF-uri pe flux — NEATINS (rezolvare manuala).',
            r.source_alop_id, r.revizie_nr;
        END LOOP;

        -- Curățare grupuri dedup-abile: >1 rând activ ȘI cel mult UN rând cu flow_id.
        -- Păstrează UNUL (flow_id > status avansat > cel mai vechi), soft-delete restul.
        WITH grupuri_sigure AS (
          SELECT source_alop_id, revizie_nr
          FROM formulare_df
          WHERE source_alop_id IS NOT NULL AND deleted_at IS NULL
          GROUP BY source_alop_id, revizie_nr
          HAVING COUNT(*) > 1
             AND COUNT(*) FILTER (WHERE flow_id IS NOT NULL) <= 1
        ),
        ranked AS (
          SELECT fd.id,
            ROW_NUMBER() OVER (
              PARTITION BY fd.source_alop_id, fd.revizie_nr
              ORDER BY
                (fd.flow_id IS NOT NULL) DESC,          -- 1. pe flux = sacru (rank keeper)
                CASE fd.status                          -- 2. statusul cel mai avansat
                  WHEN 'aprobat'       THEN 6
                  WHEN 'transmis_flux' THEN 5
                  WHEN 'completed'     THEN 4
                  WHEN 'pending_p2'    THEN 3
                  WHEN 'returnat'      THEN 2
                  WHEN 'draft'         THEN 1
                  ELSE 0
                END DESC,
                fd.created_at ASC                       -- 3. cel mai vechi (primul legat la ALOP)
            ) AS rn
          FROM formulare_df fd
          JOIN grupuri_sigure g
            ON g.source_alop_id = fd.source_alop_id AND g.revizie_nr = fd.revizie_nr
          WHERE fd.deleted_at IS NULL
        )
        UPDATE formulare_df fd
           SET deleted_at = NOW()
          FROM ranked r2
         WHERE fd.id = r2.id
           AND r2.rn > 1
           AND fd.flow_id IS NULL;                      -- dublă siguranță: nicicând un DF pe flux
      END $dedup$;

      -- 2b. INDEX UNIC PARȚIAL — poarta durabilă. Înfășurat în EXCEPTION: dacă rămân duplicate
      -- (cazul intratabil), RAISE WARNING și boot-ul continuă. Un index lipsă e o problemă;
      -- o aplicație care nu pornește e un incident.
      DO $idx$
      BEGIN
        CREATE UNIQUE INDEX IF NOT EXISTS df_source_alop_revizie_uniq
          ON formulare_df (source_alop_id, revizie_nr)
          WHERE source_alop_id IS NOT NULL AND deleted_at IS NULL;
      EXCEPTION WHEN unique_violation THEN
        RAISE WARNING '095_df_dedup: indexul unic df_source_alop_revizie_uniq NU s-a putut crea (duplicate ramase, probabil grup cu >=2 pe flux). Boot continua.';
      END $idx$;
    `
  },
  {
    // Coduri de angajament CANONICE cu MAJUSCULE — repară potrivirea OPME (opme-matcher.mjs,
    // egalitate strictă case-sensitive). LANȚ REAL: matcher-ul citește ORD `rows`
    // (opme-matcher.mjs:127), iar codurile ajung acolo prin prefill DF→ORD din DF `rows_ctrl`
    // (list.js:180). Deci backfill pe AMBELE: sursa (formulare_df.rows_ctrl) ȘI câmpul efectiv
    // potrivit (formulare_ord.rows).
    // Ridică la majuscule DOAR cod_angajament + indicator_angajament, pe rândurile care au deja
    // cheia (NU adaugă chei pe rândurile goale — `e ? 'cheia'`). Restul câmpurilor (program,
    // cod_SSI, sume, receptii) neatinse.
    // ⚠️ WITH ORDINALITY + ORDER BY ord OBLIGATORII: jsonb_agg fără ordonare poate reordona
    // rândurile, iar ordinea are semnificație contabilă.
    // Selectivă (WHERE EXISTS) + idempotentă (UPPER e idempotent → a doua rulare = no-op).
    // 📌 Owner a acceptat explicit că modifică date din DF/ORD deja semnate; PDF-ul semnat cu
    // QES rămâne înghețat în semnătură (poate diverge vizual de UI). Decizie asumată.
    id: '096_uppercase_angajament_codes',
    sql: `
      UPDATE formulare_df fd
         SET rows_ctrl = (
           SELECT jsonb_agg(
             CASE WHEN jsonb_typeof(elem) = 'object' THEN
                  CASE WHEN elem ? 'cod_angajament'
                       THEN elem || jsonb_build_object('cod_angajament',
                              UPPER(TRIM(COALESCE(elem->>'cod_angajament', ''))))
                       ELSE elem END
                  ||
                  CASE WHEN elem ? 'indicator_angajament'
                       THEN jsonb_build_object('indicator_angajament',
                              UPPER(TRIM(COALESCE(elem->>'indicator_angajament', ''))))
                       ELSE '{}'::jsonb END
             ELSE elem END
             ORDER BY ord
           )
           FROM jsonb_array_elements(fd.rows_ctrl) WITH ORDINALITY AS t(elem, ord)
         )
       WHERE jsonb_typeof(fd.rows_ctrl) = 'array'
         AND jsonb_array_length(fd.rows_ctrl) > 0
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(fd.rows_ctrl) e
            WHERE (e ? 'cod_angajament'
                   AND e->>'cod_angajament' IS DISTINCT FROM UPPER(TRIM(COALESCE(e->>'cod_angajament',''))))
               OR (e ? 'indicator_angajament'
                   AND e->>'indicator_angajament' IS DISTINCT FROM UPPER(TRIM(COALESCE(e->>'indicator_angajament',''))))
         );

      -- ORD rows — campul pe care OPME il potriveste efectiv. Aceeasi logica, aceleasi garantii.
      UPDATE formulare_ord fo
         SET rows = (
           SELECT jsonb_agg(
             CASE WHEN jsonb_typeof(elem) = 'object' THEN
                  CASE WHEN elem ? 'cod_angajament'
                       THEN elem || jsonb_build_object('cod_angajament',
                              UPPER(TRIM(COALESCE(elem->>'cod_angajament', ''))))
                       ELSE elem END
                  ||
                  CASE WHEN elem ? 'indicator_angajament'
                       THEN jsonb_build_object('indicator_angajament',
                              UPPER(TRIM(COALESCE(elem->>'indicator_angajament', ''))))
                       ELSE '{}'::jsonb END
             ELSE elem END
             ORDER BY ord
           )
           FROM jsonb_array_elements(fo.rows) WITH ORDINALITY AS t(elem, ord)
         )
       WHERE jsonb_typeof(fo.rows) = 'array'
         AND jsonb_array_length(fo.rows) > 0
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(fo.rows) e
            WHERE (e ? 'cod_angajament'
                   AND e->>'cod_angajament' IS DISTINCT FROM UPPER(TRIM(COALESCE(e->>'cod_angajament',''))))
               OR (e ? 'indicator_angajament'
                   AND e->>'indicator_angajament' IS DISTINCT FROM UPPER(TRIM(COALESCE(e->>'indicator_angajament',''))))
         );
    `
  },
  {
    id: '097_reconcile_organizations_columns',
    sql: `
      -- SEC/PROVISION: bootstrap-ul inline creează organizations cu 3 coloane; V4 001 are 18.
      -- Pe o bază unde tabela există deja din bootstrap, CREATE TABLE IF NOT EXISTS din V4 e sărit,
      -- deci coloanele lipsesc pe fresh-provision. Aliniem la V4. ADD-ONLY, idempotent, fără DROP.
      -- Tipuri și defaults COPIATE EXACT din server/db/migrations/001_organizations.sql.
      ALTER TABLE organizations ADD COLUMN IF NOT EXISTS slug                      TEXT;
      ALTER TABLE organizations ADD COLUMN IF NOT EXISTS cif                       TEXT;
      ALTER TABLE organizations ADD COLUMN IF NOT EXISTS status                    TEXT        NOT NULL DEFAULT 'active';
      ALTER TABLE organizations ADD COLUMN IF NOT EXISTS plan                      TEXT        NOT NULL DEFAULT 'starter';
      ALTER TABLE organizations ADD COLUMN IF NOT EXISTS signing_providers_enabled TEXT[]      NOT NULL DEFAULT ARRAY['local-upload'];
      ALTER TABLE organizations ADD COLUMN IF NOT EXISTS signing_providers_config  JSONB       NOT NULL DEFAULT '{}';
      ALTER TABLE organizations ADD COLUMN IF NOT EXISTS settings                  JSONB       NOT NULL DEFAULT '{}';
      ALTER TABLE organizations ADD COLUMN IF NOT EXISTS branding                  JSONB       NOT NULL DEFAULT '{}';
      ALTER TABLE organizations ADD COLUMN IF NOT EXISTS compartimente             TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[];
      ALTER TABLE organizations ADD COLUMN IF NOT EXISTS webhook_url               TEXT;
      ALTER TABLE organizations ADD COLUMN IF NOT EXISTS webhook_secret            TEXT;
      ALTER TABLE organizations ADD COLUMN IF NOT EXISTS webhook_events            TEXT[]      NOT NULL DEFAULT '{flow.completed}';
      ALTER TABLE organizations ADD COLUMN IF NOT EXISTS webhook_enabled           BOOLEAN     NOT NULL DEFAULT FALSE;
      ALTER TABLE organizations ADD COLUMN IF NOT EXISTS updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW();

      -- slug UNIQUE NOT NULL în V4 — dar pe date existente slug poate fi NULL. NU forțăm NOT NULL aici
      -- (ar pica pe rânduri existente). Populăm slug lipsă din numele org-ului, apoi indexul unic.
      -- Slug-ul derivat include id ca să fie garantat unic (nu există convenție de slug în cod —
      -- createOrg primește slug de la apelant; vezi server/db/queries/organizations.mjs).
      UPDATE organizations
         SET slug = lower(regexp_replace(COALESCE(name,'org'), '[^a-zA-Z0-9]+', '-', 'g')) || '-' || id
       WHERE slug IS NULL OR slug = '';

      CREATE UNIQUE INDEX IF NOT EXISTS idx_org_slug_uniq ON organizations(slug) WHERE slug IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_org_status ON organizations(status);
      CREATE INDEX IF NOT EXISTS idx_org_signing_providers ON organizations USING GIN (signing_providers_enabled);
    `
  },
  {
    id: '098_module_facturi',
    sql: `
      INSERT INTO module_catalog
        (module_key, display_name, category, default_enabled, display_order)
      VALUES
        ('facturi', 'Facturi (centralizator lichidări)', 'alop', TRUE, 65)
      ON CONFLICT (module_key) DO NOTHING;
    `
  },
  {
    id: '099_lichidare_valoare_factura',
    sql: `
      DO $g$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.tables
          WHERE table_schema='public' AND table_name='alop_instances'
        ) THEN RETURN; END IF;
        ALTER TABLE alop_instances ADD COLUMN IF NOT EXISTS lichidare_valoare_factura NUMERIC(18,2);
      END $g$;
      DO $g$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.tables
          WHERE table_schema='public' AND table_name='alop_ord_cicluri'
        ) THEN RETURN; END IF;
        ALTER TABLE alop_ord_cicluri ADD COLUMN IF NOT EXISTS lichidare_valoare_factura NUMERIC(18,2);
      END $g$;
    `
  },
  {
    // Chat Etapa 1 — mesagerie. FK doar spre users/organizations (create INLINE mai sus)
    // → fresh-safe, fără gardă IF EXISTS (nu e clasa de mină a tabelelor V4-only).
    id: '100_chat',
    sql: `
      CREATE TABLE IF NOT EXISTS conversations (
        id          BIGSERIAL   PRIMARY KEY,
        org_id      INTEGER     REFERENCES organizations(id) ON DELETE CASCADE,
        kind        TEXT        NOT NULL DEFAULT 'internal'
                                CHECK (kind IN ('internal','platform_support')),
        is_group    BOOLEAN     NOT NULL DEFAULT FALSE,
        title       TEXT,
        created_by  INTEGER     NOT NULL REFERENCES users(id),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS conversation_participants (
        id            BIGSERIAL   PRIMARY KEY,
        conv_id       BIGINT      NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        user_id       INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role          TEXT        NOT NULL DEFAULT 'member',
        last_read_at  TIMESTAMPTZ,
        left_at       TIMESTAMPTZ,
        joined_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (conv_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_conv_part_active
        ON conversation_participants (user_id) WHERE left_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_conv_part_conv
        ON conversation_participants (conv_id);

      CREATE TABLE IF NOT EXISTS messages (
        id          BIGSERIAL   PRIMARY KEY,
        conv_id     BIGINT      NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        from_user   INTEGER     NOT NULL REFERENCES users(id),
        body        TEXT        NOT NULL,
        deleted_at  TIMESTAMPTZ,
        meta        JSONB       NOT NULL DEFAULT '{}'::jsonb,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conv
        ON messages (conv_id, created_at);
    `
  },
  {
    id: '101_module_chat',
    sql: `
      INSERT INTO module_catalog
        (module_key, display_name, category, default_enabled, display_order)
      VALUES
        ('chat', 'Chat (mesagerie internă)', 'comunicare', TRUE, 80)
      ON CONFLICT (module_key) DO NOTHING;
    `
  },
  {
    // v3.9.739 (#TMPL-ORG): un șablon shared nu poate rămâne fără org.
    // Un rând `shared=TRUE AND org_id IS NULL` e invizibil în GET /api/templates
    // pentru toți în afară de proprietar (rând-fantomă dacă proprietarul e șters).
    // ORDINEA CONTEAZĂ: vindecă rândurile ÎNAINTE de ADD CONSTRAINT, altfel
    // migrația eșuează la boot pe orice bază cu date murdare.
    // (ID 102 — nu 100/101, ocupate de migrațiile de chat.)
    id: '102_templates_org_invariant',
    sql: `
      DO $g$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.tables
          WHERE table_schema='public' AND table_name='templates'
        ) THEN RETURN; END IF;

        -- 1) Vindecare: derivă org_id din proprietarul activ, acolo unde lipsește.
        UPDATE templates t
           SET org_id = u.org_id
          FROM users u
         WHERE lower(u.email) = lower(t.user_email)
           AND u.deleted_at IS NULL
           AND u.org_id IS NOT NULL
           AND t.org_id IS NULL;

        -- 2) Rândurile rămase fără org derivabil: le facem PRIVATE, NU le ștergem.
        --    Rămân vizibile proprietarului (ramura user_email din GET) și devin
        --    conforme cu invariantul. ⛔ Nicio ștergere de date într-o migrație.
        UPDATE templates
           SET shared = FALSE
         WHERE shared = TRUE AND org_id IS NULL;

        -- 3) Invariantul, abia acum.
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'templates_shared_needs_org') THEN
          ALTER TABLE templates ADD CONSTRAINT templates_shared_needs_org
            CHECK (NOT (shared AND org_id IS NULL));
        END IF;
      END $g$;
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
    // SEC-01: pre-check înainte de DROP plain_password.
    // IMPORTANT: verificăm existența coloanei via information_schema, NU direct cu SELECT pe users.
    // Un SELECT pe o coloană inexistentă abortează întreaga tranzacție PG — bug în b62.
    if (migration.id === '027_drop_plain_password') {
      try {
        const { rows: colExists } = await client.query(
          `SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name   = 'users'
             AND column_name  = 'plain_password'`
        );
        if (colExists.length > 0) {
          const { rows: pwCheck } = await client.query(
            `SELECT COUNT(*) AS cnt FROM users WHERE plain_password IS NOT NULL AND plain_password != ''`
          );
          const cnt = parseInt(pwCheck[0]?.cnt || '0');
          if (cnt > 0) {
            logger.warn({ count: cnt }, 'SEC-01: plain_password — există useri cu parolă în clar. Coloana va fi ștearsă acum.');
          } else {
            logger.info('SEC-01: plain_password — coloana goală. DROP sigur.');
          }
        } else {
          logger.info('SEC-01: plain_password — coloana nu mai există (attempt anterior). ALTER IF EXISTS va fi no-op.');
        }
      } catch(e) { logger.warn({ err: e }, 'SEC-01: pre-check eșuat (non-fatal)'); }
    }
    logger.info(`Migrare: ${migration.id}...`);
    await client.query(migration.sql);
    await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
    logger.info({ migrationId: migration.id }, 'Migrare aplicata cu succes.');
    ranCount++;
  }
  if (ranCount === 0) logger.info('Schema DB la zi (0 migrari noi).');
  else logger.info({ count: ranCount }, 'Migrari aplicate.');
}

async function _hashPasswordLocal(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await _pbkdf2(password, salt, 100000, 64, 'sha256')).toString('hex');
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
      ['admin@docflowai.ro', await _hashPasswordLocal(pwd), 'Administrator', 'Administrator sistem']
    );
    logger.info('Admin user creat.');
  }

  // Recuperare de urgență: dacă nu există NICIUN admin în sistem,
  // promovează admin@docflowai.ro (fără să forțeze rolul dacă există deja alți admini)
  const { rows: admins } = await pool.query("SELECT id FROM users WHERE role='admin' LIMIT 1");
  if (admins.length === 0) {
    const { rowCount } = await pool.query(
      "UPDATE users SET role='admin' WHERE lower(email)='admin@docflowai.ro'"
    );
    if (rowCount > 0) logger.warn('Recuperare urgenta: admin@docflowai.ro promovat la admin (niciun alt admin in sistem).');
    else logger.error('Niciun admin in sistem si admin@docflowai.ro nu exista!');
  }

  // NU marcăm DB_READY=true aici. Readiness se declară DOAR după ce rulează și
  // migrările file-based V4 (runMigrationsV4) — vezi callback-ul de boot din index.mjs.
  // Altfel o migrare .sql picată ar lăsa appul să servească pe o schemă ne-migrată
  // (incident 2026-04-19). Inline migrations au reușit aici → schema inline e OK.
  DB_LAST_ERROR = null;
  logger.info('Inline migrations applied (DB_READY pending V4 migrations).');
}

export function markDbReady() { DB_READY = true; DB_LAST_ERROR = null; }

// Închide gate-ul de readiness: o migrare (inline sau V4) a picat ⇒ appul NU mai
// servește rute DB ca „ready" (requireDb → 503, /readyz → 503).
export function markDbFailed(err) {
  DB_READY = false;
  DB_LAST_ERROR = err ? String(err?.message || err) : 'db_not_ready';
}

// Folosit DOAR de harness-ul de teste (server/tests/helpers/db-real.mjs).
// Aplică schema completă pe pool-ul curent (idempotent), apoi marchează DB_READY=true.
//
// Context: DocFlowAI are DOUĂ sisteme de migrări (inline în acest fișier + file-based V4
// în migrations/*.sql). În producție inline rulează ÎNTÂI, apoi V4 — și V4 001-013 (tabele
// core: organizations/users/flows...) sunt deja marcate applied istoric, deci nu se re-rulează.
// Pe un DB FRESH (cum e cel de test) cele două sisteme intră în conflict pe tabelele comune:
// V4 001_organizations presupune organizations.slug, dar inline creează organizations FĂRĂ slug
// (CREATE IF NOT EXISTS → no-op) → V4 eșuează pe index(slug). De aceea NU rulăm migrate.mjs.
//
// Strategie (reproduce schema de producție = cea inline):
//   1. Inline, dar PRE-marcăm "applied" migrările inline care referă tabele V4-only
//      (alop_instances/alop_sabloane/formulare_oficiale) ca să fie sărite — altfel
//      068_formular_attachments (FK formulare_oficiale) eșuează, iar 054-066 (alop) s-ar
//      auto-skip prin guard lăsând coloane lipsă (ex. alop_instances.updated_by).
//   2. Aplicăm DOAR fișierele V4 care creează tabele V4-only (014_alop, 015_formulare_oficiale);
//      acestea referă doar organizations/users (create de inline) → sigure pe DB fresh.
//   3. Ștergem din schema_migrations migrările deferred și le re-rulăm: acum tabelele V4 există
//      și SQL-ul idempotent reușește (adaugă coloanele, creează formular_attachments etc.).
export async function migrateForTests() {
  if (!pool) throw new Error('migrateForTests: DATABASE_URL/TEST_DATABASE_URL lipsește');

  const V4_ONLY = /alop_instances|alop_sabloane|formulare_oficiale/i;
  const deferredIds = MIGRATIONS.filter(m => V4_ONLY.test(m.sql)).map(m => m.id);

  // 1. Inline (fără cele deferred — pre-marcate ca applied ca runMigrations să le sară).
  {
    const client = await pool.connect();
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      if (deferredIds.length) {
        await client.query(
          `INSERT INTO schema_migrations (id) SELECT unnest($1::text[]) ON CONFLICT (id) DO NOTHING`,
          [deferredIds]
        );
      }
      await runMigrations(client);
    } finally { client.release(); }
  }

  // 2. Aplică DOAR fișierele V4 care creează tabele V4-only (idempotent: doar dacă lipsesc).
  {
    const { readFile } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const migDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
    const v4only = [
      ['alop_instances', '014_alop.sql'],
      ['formulare_oficiale', '015_formulare_oficiale.sql'],
    ];
    const client = await pool.connect();
    try {
      for (const [marker, file] of v4only) {
        const { rows } = await client.query(
          `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
          [marker]
        );
        if (rows.length) continue;
        await client.query(await readFile(join(migDir, file), 'utf8'));
      }
    } finally { client.release(); }
  }

  // 3. Re-aplică migrările inline deferred (acum tabelele V4 există). SQL idempotent.
  if (deferredIds.length) {
    const client = await pool.connect();
    try {
      await client.query(`DELETE FROM schema_migrations WHERE id = ANY($1::text[])`, [deferredIds]);
      await runMigrations(client);
    } finally { client.release(); }
  }

  markDbReady();
}

export async function initDbWithRetry() {
  const delays = [1000, 2000, 4000, 8000, 15000];
  for (let i = 0; i < delays.length; i++) {
    try {
      logger.info({ attempt: i+1, total: delays.length }, 'DB init attempt...');
      await initDbOnce();
      return;
    } catch(e) {
      DB_READY = false; DB_LAST_ERROR = String(e?.message || e);
      logger.error({ err: e }, 'DB init failed');
      await new Promise(r => setTimeout(r, delays[i]));
    }
  }
  logger.error('DB init failed permanent. Exiting.');
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
  // ARCH-03: un singur JOIN în loc de 2 query-uri separate — reduce latența DB la jumătate
  const r = await pool.query(`
    SELECT f.data,
           fp_pdf.data  AS "pdfB64",
           fp_spdf.data AS "signedPdfB64",
           fp_opdf.data AS "originalPdfB64"
    FROM flows f
    LEFT JOIN flows_pdfs fp_pdf  ON fp_pdf.flow_id  = f.id AND fp_pdf.key  = 'pdfB64'
    LEFT JOIN flows_pdfs fp_spdf ON fp_spdf.flow_id = f.id AND fp_spdf.key = 'signedPdfB64'
    LEFT JOIN flows_pdfs fp_opdf ON fp_opdf.flow_id = f.id AND fp_opdf.key = 'originalPdfB64'
    WHERE f.id = $1 AND f.deleted_at IS NULL
  `, [id]);
  if (!r.rows[0]) return null;
  const data = r.rows[0].data;

  // Reataşează câmpurile PDF din JOIN (null dacă nu există)
  if (r.rows[0].pdfB64)         data.pdfB64         = r.rows[0].pdfB64;
  if (r.rows[0].signedPdfB64)   data.signedPdfB64   = r.rows[0].signedPdfB64;
  if (r.rows[0].originalPdfB64) data.originalPdfB64 = r.rows[0].originalPdfB64;

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
    logger.error({ err: e }, 'writeAuditEvent error');
  }
}

/**
 * Map de useri (email → {functie, compartiment, institutie}), STRICT pe org.
 *
 * SEC-101 (TENANT-01): fail-CLOSED. Fără org ⇒ hartă GOALĂ, nu întreaga tabelă `users`.
 * Vechiul fallback („backward compat pentru admini fără org") returna toți utilizatorii din
 * toate organizațiile și îi cacheța 60s sub cheia 'all'.
 *
 * SEC-101 (email-reuse): `deleted_at IS NULL`. Migrația 067 a înlocuit UNIQUE(email) cu un index
 * parțial pe utilizatorii activi ⇒ un email poate exista de mai multe ori în tabelă. Fără filtru,
 * harta putea prelua rândul utilizatorului ȘTERS.
 */
// ARCH-04: Cache per org_id cu TTL 60s.
// getUserMapForOrg e apelat la fiecare GET /flows/:id și GET /my-flows —
// fără cache, face un SELECT pe users la fiecare request.
// Map<orgId, { map, cachedAt }>  (cheia 'all' a fost eliminată la SEC-101)
const _userMapCache = new Map();
const USER_MAP_CACHE_TTL = 60_000; // 60 secunde

export async function getUserMapForOrg(orgId) {
  const oid = Number(orgId);
  if (!oid || oid <= 0) {
    logger.warn('getUserMapForOrg fără org_id — hartă goală (fail-closed, SEC-101)');
    return {};                                  // NU se cachează: e o condiție de eroare, nu o valoare
  }

  const cacheKey = String(oid);
  const cached = _userMapCache.get(cacheKey);
  if (cached && (Date.now() - cached.cachedAt) < USER_MAP_CACHE_TTL) return cached.map;

  const { rows } = await pool.query(
    `SELECT email, functie, compartiment, institutie
       FROM users
      WHERE org_id = $1
        AND deleted_at IS NULL`,
    [oid]
  );
  const map = {};
  rows.forEach(u => { map[(u.email || '').toLowerCase()] = u; });
  _userMapCache.set(cacheKey, { map, cachedAt: Date.now() });
  return map;
}

/**
 * Invalidează cache-ul pentru o organizație specifică.
 * Apelat după orice modificare de user (POST/PUT/DELETE /admin/users).
 * Dacă orgId e null, invalidează tot cache-ul (fallback sigur).
 */
export function invalidateOrgUserCache(orgId) {
  if (orgId && orgId > 0) {
    _userMapCache.delete(String(orgId));
  } else {
    _userMapCache.clear();
  }
}

// ── Query helpers for v4 modules ──────────────────────────────────────────────
export async function query(sql, params) {
  return pool.query(sql, params);
}

export async function getOne(sql, params) {
  const result = await pool.query(sql, params);
  return result.rows[0] || null;
}

export async function getMany(sql, params) {
  const result = await pool.query(sql, params);
  return result.rows;
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
