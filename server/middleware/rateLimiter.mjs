/**
 * DocFlowAI — Rate limiter în memorie (R-03)
 * Fără dependențe externe — Map cu timestamps per IP+path.
 * Curățare automată la 5 minute pentru a preveni memory leak.
 */

const _allStores = []; // Referințe pentru cleanup global

/**
 * Creează un middleware de rate limiting.
 * @param {object} opts
 * @param {number} opts.windowMs  - Fereastra de timp în ms (ex: 60_000 = 1 min)
 * @param {number} opts.max       - Număr maxim de cereri permise în fereastră
 * @param {string} [opts.message] - Mesaj de eroare returntat la 429
 * @param {string} [opts.keyBy]   - 'ip' (default) | 'ip+user' (include email din JWT dacă există)
 */
export function createRateLimiter({ windowMs, max, message, keyBy = 'ip' }) {
  const store = new Map(); // key → [timestamp, ...]
  _allStores.push({ store, windowMs });

  return function rateLimiter(req, res, next) {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    let key = `${ip}:${req.path}`;
    if (keyBy === 'ip+user') {
      try {
        // Încearcă să extragă email-ul din Authorization header (JWT, nu verificat complet)
        const auth = req.get('authorization') || '';
        if (auth.startsWith('Bearer ')) {
          const payload = JSON.parse(Buffer.from(auth.slice(7).split('.')[1], 'base64').toString());
          if (payload?.email) key += `:${payload.email}`;
        }
      } catch(e) { /* ignorat — fallback la IP only */ }
    }

    const now = Date.now();
    const windowStart = now - windowMs;
    const hits = (store.get(key) || []).filter(t => t > windowStart);

    if (hits.length >= max) {
      const oldestHit = hits[0];
      const retryAfterSec = Math.max(1, Math.ceil((oldestHit + windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        error: 'rate_limit_exceeded',
        message: message || 'Prea multe cereri. Încearcă mai târziu.',
        retryAfterSec,
      });
    }

    hits.push(now);
    store.set(key, hits);
    next();
  };
}

// ── Curățare globală la 5 minute ──────────────────────────────────────────
// Elimină intrările expirate din toate store-urile pentru a preveni memory leak
// în cazul multor IP-uri unice (ex: attackers, crawlers).
setInterval(() => {
  const now = Date.now();
  for (const { store, windowMs } of _allStores) {
    const cutoff = now - windowMs;
    for (const [key, hits] of store.entries()) {
      const fresh = hits.filter(t => t > cutoff);
      if (fresh.length === 0) store.delete(key);
      else store.set(key, fresh);
    }
  }
}, 5 * 60 * 1000).unref(); // .unref() — nu blochează graceful shutdown

// ── Pre-built limiters (used by v4 modules) ───────────────────────────────────
export const loginLimiter = createRateLimiter({
  windowMs: 900_000,
  max: 10,
  message: 'Prea multe încercări. Încearcă în 15 minute.',
});

export const apiLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 60,
  message: 'Prea multe cereri. Încearcă în 1 minut.',
});
