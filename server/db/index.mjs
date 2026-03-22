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
export const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 20, idleTimeoutMillis: 30000 })
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

  DB_READY = true; DB_LAST_ERROR = null;
  logger.info('DB ready.');
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
 * Construieste un map de useri filtrat pe org_id (anti-leak multi-tenant).
 * Daca orgId e null/0, returneaza toti userii (backward compat pentru admini fara org).
 */
// ARCH-04: Cache per org_id cu TTL 60s.
// getUserMapForOrg e apelat la fiecare GET /flows/:id și GET /my-flows —
// fără cache, face un SELECT pe users la fiecare request.
// Map<orgId|'all', { map, cachedAt }>
const _userMapCache = new Map();
const USER_MAP_CACHE_TTL = 60_000; // 60 secunde

export async function getUserMapForOrg(orgId) {
  const cacheKey = (orgId && orgId > 0) ? String(orgId) : 'all';
  const cached = _userMapCache.get(cacheKey);
  if (cached && (Date.now() - cached.cachedAt) < USER_MAP_CACHE_TTL) {
    return cached.map;
  }

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
