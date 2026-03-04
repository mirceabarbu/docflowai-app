/**
 * DocFlowAI — Rate limiting DB-backed
 *
 * Două niveluri:
 *  - global:  120 req / min / IP   (toate endpoint-urile API)
 *  - strict:  20 req / min / IP    (sign, refuse, upload, regenerate-token)
 *  - download: 10 req / min / IP   (pdf, signed-pdf)
 *  - admin:   60 req / min / IP    (admin panel)
 *
 * Stochează în tabelul rate_limits (creat de migration 010).
 * Funcționează corect pe Railway cu mai multe instanțe.
 */

let _pool = null;
export function injectRateLimitPool(pool) { _pool = pool; }

const BUCKETS = {
  global:   { window: 60, max: 120 },
  strict:   { window: 60, max: 20  },
  download: { window: 60, max: 10  },
  admin:    { window: 60, max: 60  },
};

function getClientIp(req) {
  const forwarded = req.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

async function checkRateLimit(ip, bucket) {
  if (!_pool) return { allowed: true };
  const { window: windowSec, max } = BUCKETS[bucket] || BUCKETS.global;
  const key = `${ip}:${bucket}`;
  try {
    const { rows } = await _pool.query(
      `INSERT INTO rate_limits (key, bucket, count, window_start)
       VALUES ($1, $2, 1, NOW())
       ON CONFLICT (key, bucket) DO UPDATE SET
         count = CASE
           WHEN rate_limits.window_start < NOW() - ($3 || ' seconds')::INTERVAL
           THEN 1
           ELSE rate_limits.count + 1
         END,
         window_start = CASE
           WHEN rate_limits.window_start < NOW() - ($3 || ' seconds')::INTERVAL
           THEN NOW()
           ELSE rate_limits.window_start
         END
       RETURNING count, window_start`,
      [key, bucket, windowSec]
    );
    const { count, window_start } = rows[0];
    if (count > max) {
      const resetAt = new Date(new Date(window_start).getTime() + windowSec * 1000);
      const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
      return { allowed: false, count, max, retryAfter };
    }
    return { allowed: true, count, max };
  } catch(e) {
    // DB error → fail open (nu blocăm traficul legitim)
    console.error('rateLimit DB error:', e.message);
    return { allowed: true };
  }
}

function makeMiddleware(bucket) {
  return async (req, res, next) => {
    const ip = getClientIp(req);
    const result = await checkRateLimit(ip, bucket);
    res.setHeader('X-RateLimit-Limit', result.max || BUCKETS[bucket].max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, (result.max || BUCKETS[bucket].max) - (result.count || 0)));
    if (!result.allowed) {
      res.setHeader('Retry-After', result.retryAfter || 60);
      return res.status(429).json({
        error: 'rate_limit_exceeded',
        message: `Prea multe cereri. Încearcă din nou în ${result.retryAfter || 60} secunde.`,
        retryAfter: result.retryAfter || 60,
      });
    }
    next();
  };
}

// Cleanup periodic — șterge intrări mai vechi de 5 minute
let _cleanupTimer = null;
export function startRateLimitCleanup() {
  if (_cleanupTimer) return;
  _cleanupTimer = setInterval(async () => {
    if (!_pool) return;
    try {
      await _pool.query(
        "DELETE FROM rate_limits WHERE window_start < NOW() - INTERVAL '5 minutes'"
      );
    } catch(e) {}
  }, 5 * 60 * 1000);
}

export const globalRateLimit   = makeMiddleware('global');
export const strictRateLimit   = makeMiddleware('strict');
export const downloadRateLimit = makeMiddleware('download');
export const adminRateLimit    = makeMiddleware('admin');
