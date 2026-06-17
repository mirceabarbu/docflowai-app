/**
 * server/routes/health.mjs — liveness (/health) + readiness (/readyz).
 *
 * Separarea liveness vs readiness (P0.1):
 *  - /health  → liveness pur: procesul e viu. Întoarce mereu 200 + ok:true,
 *               NU reflectă starea DB. (Comportament neschimbat față de inline-ul vechi.)
 *  - /readyz  → readiness: 200 DOAR dacă DB_READY===true ȘI un `SELECT 1` trece;
 *               altfel 503 cu { error:'db_not_ready', dbLastError }.
 *
 * Factory cu dependențe injectate → testabil fără a porni serverul real
 * (index.mjs e module-with-side-effects: face listen() la import).
 *
 * @param {object} deps
 * @param {string}   deps.version        — APP_VERSION
 * @param {object}   deps.pool           — pg Pool (pentru ping SELECT 1)
 * @param {Function} deps.getReady       — () => DB_READY (live binding)
 * @param {Function} deps.getLastError   — () => DB_LAST_ERROR
 */
import express from 'express';

function errToString(e) {
  if (!e) return null;
  return String(e?.message || e);
}

export function makeHealthRouter({ version, pool, getReady, getLastError } = {}) {
  const router = express.Router();

  router.get('/health', (req, res) => {
    const mem = process.memoryUsage();
    res.json({
      ok: true,
      service: 'DocFlowAI',
      version,
      ts: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      memory: {
        rss: Math.round(mem.rss / 1024 / 1024) + 'MB',
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + 'MB',
      },
    });
  });

  router.get('/readyz', async (req, res) => {
    if (!pool || !getReady?.()) {
      return res.status(503).json({ error: 'db_not_ready', dbLastError: errToString(getLastError?.()) });
    }
    try {
      await pool.query('SELECT 1');
    } catch (e) {
      return res.status(503).json({ error: 'db_not_ready', dbLastError: errToString(e) });
    }
    res.json({ ok: true, dbReady: true, version });
  });

  return router;
}
