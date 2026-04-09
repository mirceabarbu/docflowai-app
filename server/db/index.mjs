/**
 * server/db/index.mjs — DocFlowAI v4 Database Layer
 *
 * Exports required by NO-TOUCH zone (cloud-signing, bulk-signing, acroform):
 *   pool, DB_READY, requireDb, saveFlow, getFlowData,
 *   getDefaultOrgId, getUserMapForOrg, writeAuditEvent
 *
 * Backward compat strategy:
 *   - flows table keeps `data JSONB` column for NO-TOUCH JSONB queries
 *   - flows_pdfs table kept for direct PDF key-value queries in NO-TOUCH zone
 *   - saveFlow writes to both relational columns AND data JSONB + flows_pdfs
 *   - getFlowData returns object in v3 format (signers in data.signers, etc.)
 *   - requireDb: dual-mode — 1-arg (res) returns bool, 3-arg is Express middleware
 */

import pg from 'pg';
import config from '../config.mjs';
import { logger } from '../middleware/logger.mjs';
import { runMigrations } from './migrate.mjs';
import { generateId } from '../core/ids.mjs';

const { Pool } = pg;

// ── Pool ─────────────────────────────────────────────────────────────────────

export const pool = config.DATABASE_URL
  ? new Pool({
      connectionString: config.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 20,
      idleTimeoutMillis: 30_000,
    })
  : null;

// ── DB readiness ──────────────────────────────────────────────────────────────

export let DB_READY = false;
export let DB_LAST_ERROR = null;

let _dbReadyResolve;
export const DB_READY_PROMISE = new Promise(resolve => { _dbReadyResolve = resolve; });

/**
 * requireDb — dual-mode:
 *
 *   Old style (1-arg):   if (requireDb(res)) return;
 *   Middleware (3-arg):  router.use(requireDb)
 */
export function requireDb(arg1, arg2, arg3) {
  if (!DB_READY) {
    const body = { error: 'db_not_ready', dbLastError: DB_LAST_ERROR };
    if (typeof arg3 === 'function') {
      // Middleware mode: arg1=req, arg2=res, arg3=next
      arg2.status(503).json(body);
      return;
    }
    // Legacy mode: arg1=res
    arg1.status(503).json(body);
    return true;
  }
  if (typeof arg3 === 'function') {
    // Middleware mode — pass through
    arg3();
    return;
  }
  return false;
}

// ── Core query helpers ────────────────────────────────────────────────────────

export async function query(sql, params) {
  return pool.query(sql, params);
}

export async function getOne(sql, params) {
  const { rows } = await pool.query(sql, params);
  return rows[0] ?? null;
}

export async function getMany(sql, params) {
  const { rows } = await pool.query(sql, params);
  return rows;
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

// ── PDF field constants (v3 compat) ───────────────────────────────────────────

const _PDF_KEYS = ['pdfB64', 'signedPdfB64', 'originalPdfB64'];

// ── saveFlow ──────────────────────────────────────────────────────────────────

/**
 * saveFlow(flowId, flowData, orgId?)
 *
 * Accepts flowData in v3 JSONB format. Writes to:
 *   1. flows table — relational columns + data JSONB (for NO-TOUCH compat)
 *   2. flows_pdfs  — PDF key-value store (for NO-TOUCH direct queries)
 *   3. flow_signers — relational signer rows (from flowData.signers)
 *
 * orgId is optional — falls back to flowData.orgId || flowData.org_id.
 */
export async function saveFlow(flowId, flowData, orgId) {
  if (!flowData || typeof flowData !== 'object') return;

  const resolvedOrgId = orgId ?? flowData.orgId ?? flowData.org_id ?? null;
  const cleanData = { ...flowData };

  // ── Extract PDF fields → flows_pdfs ──────────────────────────────────────
  const pdfWrites = {};
  for (const key of _PDF_KEYS) {
    if (key in cleanData) {
      pdfWrites[key] = cleanData[key] ?? null;
      delete cleanData[key];
      cleanData[`_${key}Present`] = pdfWrites[key] !== null && pdfWrites[key] !== '';
    }
  }

  // ── Map v3 fields → relational columns ────────────────────────────────────
  const docName      = cleanData.docName      || cleanData.doc_name      || '';
  const docType      = cleanData.docType      || cleanData.doc_type      || 'tabel';
  const status       = cleanData.status       || 'draft';
  const currentStep  = cleanData.currentStep  ?? cleanData.current_step  ?? 0;
  const initEmail    = cleanData.initEmail    || cleanData.initiator_email || '';
  const initName     = cleanData.initName     || cleanData.initiator_name  || '';
  const title        = cleanData.title        || docName;

  // ── Upsert flows row ───────────────────────────────────────────────────────
  await pool.query(
    `INSERT INTO flows
       (id, org_id, initiator_email, initiator_name, title,
        doc_name, doc_type, status, current_step, data, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET
       org_id          = EXCLUDED.org_id,
       initiator_email = EXCLUDED.initiator_email,
       initiator_name  = EXCLUDED.initiator_name,
       title           = EXCLUDED.title,
       doc_name        = EXCLUDED.doc_name,
       doc_type        = EXCLUDED.doc_type,
       status          = EXCLUDED.status,
       current_step    = EXCLUDED.current_step,
       data            = EXCLUDED.data,
       updated_at      = NOW()`,
    [
      flowId,
      resolvedOrgId,
      initEmail,
      initName,
      title,
      docName,
      docType,
      status,
      currentStep,
      JSON.stringify(cleanData),
    ]
  );

  // ── flows_pdfs upsert/delete ───────────────────────────────────────────────
  for (const [key, val] of Object.entries(pdfWrites)) {
    if (val === null || val === '') {
      await pool.query(
        'DELETE FROM flows_pdfs WHERE flow_id=$1 AND key=$2',
        [flowId, key]
      );
    } else {
      await pool.query(
        `INSERT INTO flows_pdfs (flow_id, key, data, updated_at) VALUES ($1, $2, $3, NOW())
         ON CONFLICT (flow_id, key) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()`,
        [flowId, key, val]
      );
    }
  }

  // ── flow_signers upsert (from flowData.signers array) ─────────────────────
  const signers = Array.isArray(cleanData.signers) ? cleanData.signers : null;
  if (signers) {
    for (let i = 0; i < signers.length; i++) {
      const s = signers[i];
      if (!s?.email) continue;

      // Build meta (everything not mapped to a column)
      const { email, name, role, functie, status: sStatus,
              token, tokenExpires, signedAt, method, order: sOrder,
              ...rest } = s;

      const signerId = s.id || generateId();

      await pool.query(
        `INSERT INTO flow_signers
           (id, flow_id, step_order, email, name, role, function,
            status, token, token_expires, signing_method, signed_at, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           step_order    = EXCLUDED.step_order,
           email         = EXCLUDED.email,
           name          = EXCLUDED.name,
           role          = EXCLUDED.role,
           function      = EXCLUDED.function,
           status        = EXCLUDED.status,
           token         = EXCLUDED.token,
           token_expires = EXCLUDED.token_expires,
           signing_method = EXCLUDED.signing_method,
           signed_at     = EXCLUDED.signed_at,
           meta          = EXCLUDED.meta`,
        [
          signerId,
          flowId,
          sOrder ?? i,
          email || '',
          name  || '',
          role  || null,
          functie || null,
          sStatus || 'pending',
          token   || null,
          tokenExpires ? new Date(tokenExpires) : null,
          method  || null,
          signedAt ? new Date(signedAt) : null,
          JSON.stringify(rest),
        ]
      );
    }
  }
}

// ── getFlowData ───────────────────────────────────────────────────────────────

/**
 * getFlowData(flowId) — returns flow in v3 JSONB format for backward compat.
 *
 * Reads: flows JOIN flows_pdfs (for PDF data).
 * Returns object with fields signers[], pdfB64, signedPdfB64, etc.
 */
export async function getFlowData(flowId) {
  const r = await pool.query(
    `SELECT
       f.data,
       f.doc_name    AS "docName",
       f.doc_type    AS "docType",
       f.status,
       f.current_step AS "currentStep",
       f.initiator_email AS "initEmail",
       f.initiator_name  AS "initName",
       f.org_id,
       f.created_at,
       f.updated_at,
       fp_pdf.data   AS "pdfB64",
       fp_spdf.data  AS "signedPdfB64",
       fp_opdf.data  AS "originalPdfB64"
     FROM flows f
     LEFT JOIN flows_pdfs fp_pdf  ON fp_pdf.flow_id  = f.id AND fp_pdf.key  = 'pdfB64'
     LEFT JOIN flows_pdfs fp_spdf ON fp_spdf.flow_id = f.id AND fp_spdf.key = 'signedPdfB64'
     LEFT JOIN flows_pdfs fp_opdf ON fp_opdf.flow_id = f.id AND fp_opdf.key = 'originalPdfB64'
     WHERE f.id = $1 AND f.deleted_at IS NULL`,
    [flowId]
  );

  if (!r.rows[0]) return null;

  const row = r.rows[0];
  // Start from the JSONB data blob (contains signers and all v3 fields)
  const data = row.data || {};

  // Override with relational columns (source of truth)
  if (row.docName)      data.docName      = row.docName;
  if (row.docType)      data.docType      = row.docType;
  if (row.status)       data.status       = row.status;
  if (row.currentStep !== undefined) data.currentStep = row.currentStep;
  if (row.initEmail)    data.initEmail    = row.initEmail;
  if (row.initName)     data.initName     = row.initName;
  if (row.org_id)       data.orgId        = row.org_id;
  data.id                                 = flowId;

  // Reattach PDFs
  if (row.pdfB64)         data.pdfB64         = row.pdfB64;
  if (row.signedPdfB64)   data.signedPdfB64   = row.signedPdfB64;
  if (row.originalPdfB64) data.originalPdfB64 = row.originalPdfB64;

  // Clean presence markers
  for (const key of _PDF_KEYS) delete data[`_${key}Present`];

  return data;
}

// ── getDefaultOrgId ───────────────────────────────────────────────────────────

let _defaultOrgIdCache = null;
let _defaultOrgIdCachedAt = 0;
const DEFAULT_ORG_CACHE_TTL = 5 * 60 * 1000;

export async function getDefaultOrgId() {
  if (_defaultOrgIdCache && (Date.now() - _defaultOrgIdCachedAt) < DEFAULT_ORG_CACHE_TTL) {
    return _defaultOrgIdCache;
  }
  const r = await pool.query(
    "SELECT id FROM organizations WHERE status='active' ORDER BY id ASC LIMIT 1"
  );
  _defaultOrgIdCache = r.rows[0]?.id ?? null;
  _defaultOrgIdCachedAt = Date.now();
  return _defaultOrgIdCache;
}

export function invalidateDefaultOrgCache() {
  _defaultOrgIdCache = null;
  _defaultOrgIdCachedAt = 0;
}

// ── getUserMapForOrg ──────────────────────────────────────────────────────────

const _userMapCache = new Map();
const USER_MAP_CACHE_TTL = 60_000;

/**
 * Returns a plain object map { email → user } for the given org.
 * Includes v3 compat fields: functie, compartiment, institutie.
 */
export async function getUserMapForOrg(orgId) {
  const cacheKey = (orgId && orgId > 0) ? String(orgId) : 'all';
  const cached = _userMapCache.get(cacheKey);
  if (cached && (Date.now() - cached.cachedAt) < USER_MAP_CACHE_TTL) {
    return cached.map;
  }

  const { rows } = orgId && orgId > 0
    ? await pool.query(
        `SELECT id, email, name, role,
                functie, compartiment, institutie,
                preferred_signing_provider
         FROM users WHERE org_id=$1 AND status='active'`,
        [orgId]
      )
    : await pool.query(
        `SELECT id, email, name, role,
                functie, compartiment, institutie,
                preferred_signing_provider
         FROM users WHERE status='active'`
      );

  const map = {};
  for (const u of rows) {
    map[(u.email || '').toLowerCase()] = u;
  }

  _userMapCache.set(cacheKey, { map, cachedAt: Date.now() });
  return map;
}

export function invalidateOrgUserCache(orgId) {
  if (orgId && orgId > 0) {
    _userMapCache.delete(String(orgId));
  } else {
    _userMapCache.clear();
  }
}

// ── writeAuditEvent ───────────────────────────────────────────────────────────

/**
 * writeAuditEvent — fire-and-forget. Writes to both audit_log (v3) and audit_events (v4).
 * Never throws.
 */
export async function writeAuditEvent({
  flowId, orgId, eventType, actorEmail, actorIp = null, payload = {},
}) {
  if (!pool || !DB_READY) return;
  try {
    await pool.query(
      `INSERT INTO audit_log
         (flow_id, org_id, event_type, actor_email, actor_ip, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        flowId   || null,
        orgId    || null,
        eventType,
        actorEmail || null,
        actorIp  || null,
        JSON.stringify(payload),
      ]
    );
  } catch (e) {
    logger.error({ err: e }, 'writeAuditEvent error');
  }
}

// ── DB initialisation ─────────────────────────────────────────────────────────

async function _initDbOnce() {
  if (!pool) throw new Error('DATABASE_URL is not configured');
  await pool.query('SELECT 1'); // connectivity check
  await runMigrations(pool);

  // Bootstrap: create default org if none exists
  const { rows: orgs } = await pool.query(
    "SELECT id FROM organizations LIMIT 1"
  );
  if (orgs.length === 0) {
    await pool.query(
      `INSERT INTO organizations (name, slug, status)
       VALUES ('Default Organization', 'default', 'active')
       ON CONFLICT DO NOTHING`
    );
  }

  // Bootstrap: create admin user if none exists and ADMIN_INIT_PASSWORD is set
  if (process.env.ADMIN_INIT_PASSWORD) {
    const { rows: uc } = await pool.query('SELECT COUNT(*) AS cnt FROM users');
    if (parseInt(uc[0].cnt) === 0) {
      const { hashPassword } = await import('../middleware/auth.mjs');
      const hash = await hashPassword(process.env.ADMIN_INIT_PASSWORD);
      const { rows: orgRows } = await pool.query(
        "SELECT id FROM organizations ORDER BY id LIMIT 1"
      );
      const defaultOrgId = orgRows[0]?.id;
      if (defaultOrgId) {
        await pool.query(
          `INSERT INTO users (org_id, email, password_hash, name, role)
           VALUES ($1, 'admin@docflowai.ro', $2, 'Administrator', 'admin')
           ON CONFLICT DO NOTHING`,
          [defaultOrgId, hash]
        );
        logger.info('Admin user created.');
      }
    }
  }

  DB_READY = true;
  DB_LAST_ERROR = null;
  _dbReadyResolve();
  logger.info('DB ready.');
}

export async function initDbWithRetry() {
  const delays = [1000, 2000, 4000, 8000, 15000];
  for (let i = 0; i < delays.length; i++) {
    try {
      logger.info({ attempt: i + 1, total: delays.length }, 'DB init attempt...');
      await _initDbOnce();
      return;
    } catch (e) {
      DB_READY = false;
      DB_LAST_ERROR = String(e?.message || e);
      logger.error({ err: e }, 'DB init failed');
      if (i < delays.length - 1) {
        await new Promise(r => setTimeout(r, delays[i]));
      }
    }
  }
  logger.error('DB init failed permanently.');
}
