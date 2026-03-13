/**
 * DocFlowAI — Rate limiter PostgreSQL-backed (FIX-06 v3.3.8)
 *
 * ANTERIOR: Map JS in-memory — se reseta la fiecare restart Railway, nu
 *   funcționa corect pe multi-instanță (atacatorul putea distribui cereri).
 *
 * ACUM: Tabelă api_rate_limits (migrare 026) cu upsert atomic:
 *   - Supraviețuiește restart-urilor
 *   - Funcționează corect pe orice număr de instanțe Railway
 *   - Același model sliding-window ca login_blocks (count + first_at + blocked_until)
 *
 * FALLBACK: dacă DB nu e disponibil, se folosește Map in-memory
 *   (graceful degradation — serverul pornește chiar dacă DB e down momentan).
 */

import { logger } from './logger.mjs';

// ── Lazy import pool — evită circular dependency la startup ──────────────
let _pool = null;
async function _getPool() {
  if (_pool) return _pool;
  try {
    const db = await import('../db/index.mjs');
    if (db.pool && db.DB_READY) { _pool = db.pool; return _pool; }
    return null;
  } catch(e) { return null; }
}

// ── Fallback in-memory ────────────────────────────────────────────────────
const _memStore = new Map();
function _memCheck(key, windowMs, max) {
  const now = Date.now();
  const hits = (_memStore.get(key) || []).filter(t => t > now - windowMs);
  if (hits.length >= max) {
    return { blocked: true, retryAfterSec: Math.max(1, Math.ceil((hits[0] + windowMs - now) / 1000)) };
  }
  hits.push(now);
  _memStore.set(key, hits);
  return { blocked: false };
}

// ── PostgreSQL sliding-window cu upsert atomic ────────────────────────────
async function _pgCheck(key, windowMs, max, blockMs) {
  const pool = await _getPool();
  if (!pool) return null;
  const windowSec = Math.ceil(windowMs / 1000);
  const blockSec  = Math.ceil(blockMs  / 1000);
  try {
    const { rows } = await pool.query(`
      INSERT INTO api_rate_limits (key, count, first_at, updated_at)
        VALUES ($1, 1, NOW(), NOW())
      ON CONFLICT (key) DO UPDATE SET
        count = CASE
          WHEN api_rate_limits.first_at < NOW() - ($2 || ' seconds')::INTERVAL THEN 1
          ELSE api_rate_limits.count + 1
        END,
        first_at = CASE
          WHEN api_rate_limits.first_at < NOW() - ($2 || ' seconds')::INTERVAL THEN NOW()
          ELSE api_rate_limits.first_at
        END,
        blocked_until = CASE
          WHEN (CASE
            WHEN api_rate_limits.first_at < NOW() - ($2 || ' seconds')::INTERVAL THEN 1
            ELSE api_rate_limits.count + 1
          END) >= $3
          THEN NOW() + ($4 || ' seconds')::INTERVAL
          ELSE api_rate_limits.blocked_until
        END,
        updated_at = NOW()
      RETURNING count, blocked_until
    `, [key, windowSec, max, blockSec]);

    const row = rows[0];
    if (!row) return { blocked: false };
    if (row.blocked_until && new Date(row.blocked_until) > new Date()) {
      return { blocked: true, retryAfterSec: Math.ceil((new Date(row.blocked_until) - Date.now()) / 1000) };
    }
    return { blocked: false };
  } catch(e) {
    logger.warn({ err: e, key }, 'rateLimiter: eroare DB, fallback in-memory');
    return null;
  }
}

/**
 * createRateLimiter — middleware Express.
 * @param {number}  opts.windowMs   Fereastra sliding (ms)
 * @param {number}  opts.max        Cereri max în fereastră
 * @param {number}  [opts.blockMs]  Durata blocării (default = windowMs)
 * @param {string}  [opts.message]  Mesaj 429
 * @param {string}  [opts.bucket]   Prefix key (ex: 'sign', 'upload')
 */
export function createRateLimiter({ windowMs, max, blockMs, message, bucket = 'api' }) {
  const _blockMs = blockMs ?? windowMs;
  return async function rateLimiter(req, res, next) {
    const ip  = req.ip || req.socket?.remoteAddress || 'unknown';
    const key = `${bucket}:${ip}`;
    let result = await _pgCheck(key, windowMs, max, _blockMs);
    if (result === null) result = _memCheck(key, windowMs, max);
    if (result.blocked) {
      res.setHeader('Retry-After', String(result.retryAfterSec ?? 60));
      return res.status(429).json({
        error: 'rate_limit_exceeded',
        message: message || 'Prea multe cereri. Încearcă mai târziu.',
        retryAfterSec: result.retryAfterSec ?? 60,
      });
    }
    next();
  };
}

// ── Curățare periodică ────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of _memStore.entries()) {
    const fresh = hits.filter(t => t > now - 3_600_000);
    if (!fresh.length) _memStore.delete(key); else _memStore.set(key, fresh);
  }
}, 10 * 60_000).unref();

setInterval(async () => {
  try {
    const pool = await _getPool();
    if (!pool) return;
    const { rowCount } = await pool.query(`
      DELETE FROM api_rate_limits
      WHERE (blocked_until IS NULL OR blocked_until < NOW())
        AND first_at < NOW() - INTERVAL '2 hours'
    `);
    if (rowCount > 0) logger.info({ rowCount }, 'api_rate_limits: intrari expirate sterse');
  } catch(e) { /* non-fatal */ }
}, 30 * 60_000).unref();

