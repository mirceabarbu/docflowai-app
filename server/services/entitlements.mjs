/**
 * DocFlowAI — Entitlements resolver (PASUL 2)
 *
 * Rezolvă per-user dacă un modul (refnec, alop, df, ord, clasa8, etc.) e activ,
 * folosind regula "most-specific wins": user > comp > org > catalog.default_enabled.
 *
 * Sursa: module_catalog + module_entitlements (migrațiile 070, 071).
 *
 * Cache in-memory 60s pe cheie `${moduleKey}|${userId}` — invalidat la write din
 * routerul admin (PUT/DELETE). Compartiment-ul utilizatorului e luat din JWT
 * (actor.compartiment) sau, ca fallback, din DB cu cache propriu pe userId.
 */

import { pool as defaultPool } from '../db/index.mjs';
import { logger } from '../middleware/logger.mjs';

const TTL_MS = 60_000;

// Cache rezultat: `${moduleKey}|${userId}` → { value: boolean, exp: ms-epoch }
const cache = new Map();

// Cache compartiment fallback (când nu vine în actor): userId → { value, exp }
const compCache = new Map();

function _now() { return Date.now(); }

function _getFromCache(key) {
  const e = cache.get(key);
  if (!e) return undefined;
  if (e.exp < _now()) { cache.delete(key); return undefined; }
  return e.value;
}

function _setCache(key, value) {
  cache.set(key, { value, exp: _now() + TTL_MS });
}

/**
 * Invalidează cache-ul rezolvat.
 *  - invalidate()                 → golește tot cache-ul
 *  - invalidate({ userId })       → golește doar intrările pentru un user
 */
export function invalidate(opts = {}) {
  const { userId } = opts || {};
  if (userId == null) { cache.clear(); return; }
  const suffix = `|${String(userId)}`;
  for (const k of cache.keys()) {
    if (k.endsWith(suffix)) cache.delete(k);
  }
}

/** Pentru test/debug — golește și cache-ul de compartiment. */
export function invalidateAll() {
  cache.clear();
  compCache.clear();
}

/**
 * Obține compartimentul utilizatorului. Dacă e dat ca parametru (din JWT), îl
 * folosim direct; altfel SELECT din DB cu cache 60s.
 */
async function _resolveCompartiment(pool, userId, compartimentFromActor) {
  if (compartimentFromActor != null && compartimentFromActor !== '') {
    return String(compartimentFromActor);
  }
  if (compartimentFromActor === '') return null; // explicit gol → nu există scope comp
  if (!userId) return null;
  const cKey = `u:${userId}`;
  const c = compCache.get(cKey);
  if (c && c.exp >= _now()) return c.value;
  try {
    const { rows } = await pool.query('SELECT compartiment FROM users WHERE id=$1', [userId]);
    const v = rows[0]?.compartiment || null;
    compCache.set(cKey, { value: v, exp: _now() + TTL_MS });
    return v;
  } catch (e) {
    logger.warn({ err: e, userId }, 'entitlements: lookup compartiment eșuat (fallback null)');
    return null;
  }
}

/**
 * Rezolvă efectiv pentru un user dacă un modul este activ.
 * Regula most-specific wins: user > comp > org > catalog.default_enabled.
 * Modul necunoscut sau inactiv în catalog → false.
 *
 * @param {import('pg').Pool} pool
 * @param {{ moduleKey: string, userId: number|string, compartiment?: string|null, orgId: number|string|null }} ctx
 * @returns {Promise<boolean>}
 */
export async function isModuleEnabled(pool, ctx) {
  pool = pool || defaultPool;
  const moduleKey = String(ctx?.moduleKey || '').trim();
  const userId    = ctx?.userId;
  const orgId     = ctx?.orgId != null ? String(ctx.orgId) : null;
  if (!moduleKey || !userId) return false;

  const cacheKey = `${moduleKey}|${userId}`;
  const cached = _getFromCache(cacheKey);
  if (cached !== undefined) return cached;

  const compartiment = await _resolveCompartiment(pool, userId, ctx?.compartiment);
  const value = await _computeEnabled(pool, { moduleKey, userId, compartiment, orgId });
  _setCache(cacheKey, value);
  return value;
}

async function _computeEnabled(pool, { moduleKey, userId, compartiment, orgId }) {
  let rows = [];
  try {
    const r = await pool.query(
      `SELECT scope_type, enabled FROM module_entitlements
        WHERE module_key = $1
          AND (
            (scope_type = 'user' AND scope_id = $2::text)
            OR (scope_type = 'comp' AND $3::text IS NOT NULL AND scope_id = $3::text)
            OR (scope_type = 'org'  AND $4::text IS NOT NULL AND scope_id = $4::text)
          )`,
      [moduleKey, String(userId), compartiment, orgId]
    );
    rows = r.rows || [];
  } catch (e) {
    logger.warn({ err: e, moduleKey, userId }, 'entitlements: SELECT module_entitlements eșuat');
    rows = [];
  }

  // Most-specific wins în Node (mai stabil decât ORDER BY+LIMIT pe scope_type)
  const byScope = { user: null, comp: null, org: null };
  for (const r of rows) {
    if (r.scope_type in byScope) byScope[r.scope_type] = !!r.enabled;
  }
  if (byScope.user !== null) return byScope.user;
  if (byScope.comp !== null) return byScope.comp;
  if (byScope.org  !== null) return byScope.org;

  // Fallback catalog.default_enabled (cu active=true)
  try {
    const { rows: cat } = await pool.query(
      'SELECT default_enabled FROM module_catalog WHERE module_key=$1 AND active=true',
      [moduleKey]
    );
    if (!cat.length) return false; // modul necunoscut/inactiv = blocat
    return !!cat[0].default_enabled;
  } catch (e) {
    logger.warn({ err: e, moduleKey }, 'entitlements: SELECT module_catalog eșuat');
    return false;
  }
}

/**
 * Batch: returnează mapa { module_key: boolean } pentru toate modulele active
 * din catalog, pentru un user dat. Folosește o singură interogare (LEFT JOIN)
 * ca să evite N+1. Cache-ul individual e populat și pentru fiecare cheie.
 *
 * @param {import('pg').Pool} pool
 * @param {{ userId: number|string, compartiment?: string|null, orgId: number|string|null }} ctx
 * @returns {Promise<Record<string, boolean>>}
 */
export async function getAllModulesForUser(pool, ctx) {
  pool = pool || defaultPool;
  const userId = ctx?.userId;
  const orgId  = ctx?.orgId != null ? String(ctx.orgId) : null;
  if (!userId) return {};

  const compartiment = await _resolveCompartiment(pool, userId, ctx?.compartiment);

  let modules = [];
  try {
    const { rows } = await pool.query(`
      SELECT
        mc.module_key,
        mc.default_enabled,
        (SELECT enabled FROM module_entitlements
          WHERE module_key=mc.module_key AND scope_type='user' AND scope_id=$1::text LIMIT 1) AS user_e,
        (SELECT enabled FROM module_entitlements
          WHERE module_key=mc.module_key AND scope_type='comp' AND $2::text IS NOT NULL AND scope_id=$2::text LIMIT 1) AS comp_e,
        (SELECT enabled FROM module_entitlements
          WHERE module_key=mc.module_key AND scope_type='org'  AND $3::text IS NOT NULL AND scope_id=$3::text LIMIT 1) AS org_e
      FROM module_catalog mc
      WHERE mc.active = true
      ORDER BY mc.display_order ASC
    `, [String(userId), compartiment, orgId]);
    modules = rows;
  } catch (e) {
    logger.warn({ err: e, userId }, 'entitlements: getAllModulesForUser eșuat');
    return {};
  }

  const out = {};
  for (const m of modules) {
    let v;
    if (m.user_e !== null && m.user_e !== undefined) v = !!m.user_e;
    else if (m.comp_e !== null && m.comp_e !== undefined) v = !!m.comp_e;
    else if (m.org_e  !== null && m.org_e  !== undefined) v = !!m.org_e;
    else v = !!m.default_enabled;
    out[m.module_key] = v;
    _setCache(`${m.module_key}|${userId}`, v);
  }
  return out;
}

/**
 * Diagnostic pentru UI admin — returnează valoarea efectivă plus „lanțul" de override.
 * Util pentru endpoint-ul /api/admin/entitlements/resolve.
 *
 * @returns {Promise<{ effective: boolean, source: 'user'|'comp'|'org'|'catalog'|'none', chain: { user: boolean|null, comp: boolean|null, org: boolean|null, default: boolean|null } }>}
 */
export async function resolveDetailed(pool, ctx) {
  pool = pool || defaultPool;
  const moduleKey = String(ctx?.moduleKey || '').trim();
  const userId    = ctx?.userId;
  const orgId     = ctx?.orgId != null ? String(ctx.orgId) : null;
  if (!moduleKey || !userId) {
    return { effective: false, source: 'none', chain: { user: null, comp: null, org: null, default: null } };
  }
  const compartiment = await _resolveCompartiment(pool, userId, ctx?.compartiment);

  let rows = [];
  try {
    const r = await pool.query(
      `SELECT scope_type, enabled FROM module_entitlements
        WHERE module_key = $1
          AND (
            (scope_type = 'user' AND scope_id = $2::text)
            OR (scope_type = 'comp' AND $3::text IS NOT NULL AND scope_id = $3::text)
            OR (scope_type = 'org'  AND $4::text IS NOT NULL AND scope_id = $4::text)
          )`,
      [moduleKey, String(userId), compartiment, orgId]
    );
    rows = r.rows || [];
  } catch (_) { rows = []; }

  const chain = { user: null, comp: null, org: null, default: null };
  for (const r of rows) {
    if (r.scope_type === 'user') chain.user = !!r.enabled;
    else if (r.scope_type === 'comp') chain.comp = !!r.enabled;
    else if (r.scope_type === 'org')  chain.org  = !!r.enabled;
  }

  let defaultEnabled = null;
  try {
    const { rows: cat } = await pool.query(
      'SELECT default_enabled FROM module_catalog WHERE module_key=$1 AND active=true',
      [moduleKey]
    );
    if (cat.length) defaultEnabled = !!cat[0].default_enabled;
  } catch (_) {}
  chain.default = defaultEnabled;

  let effective = false, source = 'none';
  if (chain.user !== null) { effective = chain.user; source = 'user'; }
  else if (chain.comp !== null) { effective = chain.comp; source = 'comp'; }
  else if (chain.org  !== null) { effective = chain.org;  source = 'org';  }
  else if (chain.default !== null) { effective = chain.default; source = 'catalog'; }

  return { effective, source, chain };
}
