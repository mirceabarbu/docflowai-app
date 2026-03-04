/**
 * DocFlowAI — Rate limiting global in-memory
 * Fereastră glisantă per IP.
 *
 * Reguli:
 *   global   — 120 req/min per IP (toate rutele /api, /flows, /admin, /auth)
 *   heavy    — 10 req/min per IP  (upload PDF, archive)
 *   auth     — 20 req/min per IP  (login, refresh — ca fallback față de login_blocks DB)
 *
 * Notă: in-memory → se resetează la restart și nu e distribuit.
 * OK pentru o singură instanță Railway.
 */

// Structura: Map<key, number[]> — timestamps ale request-urilor în fereastră
const _windows = new Map();

// Curăță intrările expirate la fiecare 5 minute
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of _windows.entries()) {
    // Păstrăm cel mai lung window posibil (60s)
    const fresh = timestamps.filter(t => now - t < 60_000);
    if (fresh.length === 0) _windows.delete(key);
    else _windows.set(key, fresh);
  }
}, 5 * 60_000);

/**
 * Verifică și înregistrează un request.
 * @param {string} key       — cheie unică (ex: `global:1.2.3.4`)
 * @param {number} maxReqs   — număr maxim de request-uri
 * @param {number} windowMs  — fereastra în ms
 * @returns {{ allowed: boolean, remaining: number, retryAfter: number }}
 */
function check(key, maxReqs, windowMs) {
  const now = Date.now();
  const cutoff = now - windowMs;
  let timestamps = _windows.get(key) || [];
  timestamps = timestamps.filter(t => t > cutoff);
  const allowed = timestamps.length < maxReqs;
  if (allowed) {
    timestamps.push(now);
    _windows.set(key, timestamps);
  }
  const remaining = Math.max(0, maxReqs - timestamps.length);
  // Timp până se eliberează un slot (primul timestamp + windowMs - now)
  const retryAfter = allowed ? 0 : Math.ceil((timestamps[0] + windowMs - now) / 1000);
  return { allowed, remaining, retryAfter };
}

function getIp(req) {
  return (req.headers['x-forwarded-for'] || req.ip || 'unknown').toString().split(',')[0].trim();
}

/**
 * Middleware global — 120 req/min per IP
 * Aplicat pe toate rutele API (exclude static)
 */
export function rateLimitGlobal(req, res, next) {
  const ip = getIp(req);
  const { allowed, remaining, retryAfter } = check(`global:${ip}`, 120, 60_000);
  res.setHeader('X-RateLimit-Limit', '120');
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  if (!allowed) {
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'rate_limit_exceeded', message: `Prea multe request-uri. Încearcă din nou în ${retryAfter}s.`, retryAfter });
  }
  next();
}

/**
 * Middleware heavy — 10 req/min per IP
 * Aplicat pe upload PDF și archive
 */
export function rateLimitHeavy(req, res, next) {
  const ip = getIp(req);
  const { allowed, remaining, retryAfter } = check(`heavy:${ip}`, 10, 60_000);
  res.setHeader('X-RateLimit-Limit', '10');
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  if (!allowed) {
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'rate_limit_exceeded', message: `Prea multe upload-uri. Încearcă din nou în ${retryAfter}s.`, retryAfter });
  }
  next();
}

/**
 * Middleware auth — 20 req/min per IP
 * Aplicat pe /auth/login și /auth/refresh ca strat suplimentar
 */
export function rateLimitAuth(req, res, next) {
  const ip = getIp(req);
  const { allowed, remaining, retryAfter } = check(`auth:${ip}`, 20, 60_000);
  if (!allowed) {
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'rate_limit_exceeded', message: `Prea multe încercări de autentificare. Încearcă din nou în ${retryAfter}s.`, retryAfter });
  }
  next();
}
