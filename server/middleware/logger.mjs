/**
 * DocFlowAI — Structured JSON Logger v3.3.4
 *
 * Logger minimal fără dependențe externe — output JSON lines compatibil cu
 * Railway log aggregation, Datadog, Grafana Loki etc.
 *
 * Utilizare:
 *   import { logger } from './middleware/logger.mjs';
 *   logger.info({ flowId, userId }, 'Document semnat');
 *   logger.error({ err: e, requestId }, 'DB error');
 *
 * Configurare via ENV:
 *   LOG_LEVEL=debug|info|warn|error  (default: info)
 *   LOG_PRETTY=1                     (output human-readable în development)
 */

const SERVICE = 'docflowai';
// Citim versiunea direct din package.json — npm_package_version nu e setat de Railway
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const VERSION = (() => {
  try { return _require('../../package.json').version; } catch(e) { return '0.0.0'; }
})();

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL_NAMES = { 10: 'debug', 20: 'info', 30: 'warn', 40: 'error' };

const rawLevel   = (process.env.LOG_LEVEL || 'info').toLowerCase();
const currentLvl = LEVELS[rawLevel] ?? LEVELS.info;
const pretty     = process.env.LOG_PRETTY === '1' || process.env.NODE_ENV === 'development';

const PRETTY_COLORS = {
  debug: '\x1b[36m', // cyan
  info:  '\x1b[32m', // green
  warn:  '\x1b[33m', // yellow
  error: '\x1b[31m', // red
  reset: '\x1b[0m',
};

function serializeError(err) {
  if (!err || typeof err !== 'object') return err;
  return {
    message: err.message,
    type: err.constructor?.name || 'Error',
    code: err.code,
    stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
  };
}

function write(numLevel, ctx, msg) {
  if (numLevel < currentLvl) return;

  const levelName = LEVEL_NAMES[numLevel] || 'info';
  const ts = new Date().toISOString();

  // Normalizare apel: logger.info('mesaj') sau logger.info({ ctx }, 'mesaj')
  let context = {};
  let message = msg;
  if (typeof ctx === 'string') {
    message = ctx;
  } else if (ctx && typeof ctx === 'object') {
    const { err, error, ...rest } = ctx;
    context = rest;
    if (err)   context.err   = serializeError(err);
    if (error) context.error = serializeError(error);
  }

  if (pretty) {
    const col   = PRETTY_COLORS[levelName] || '';
    const reset = PRETTY_COLORS.reset;
    const prefix = `${col}[${levelName.toUpperCase()}]${reset}`;
    const ctxStr = Object.keys(context).length
      ? ' ' + Object.entries(context).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ')
      : '';
    (numLevel >= LEVELS.warn ? console.error : console.log)(
      `${ts} ${prefix} ${message}${ctxStr}`
    );
  } else {
    const entry = {
      time: ts,
      level: levelName,
      msg: message,
      service: SERVICE,
      v: VERSION,
      ...context,
    };
    (numLevel >= LEVELS.warn ? console.error : console.log)(JSON.stringify(entry));
  }
}

export const logger = {
  debug: (ctx, msg) => write(LEVELS.debug, ctx, msg),
  info:  (ctx, msg) => write(LEVELS.info,  ctx, msg),
  warn:  (ctx, msg) => write(LEVELS.warn,  ctx, msg),
  error: (ctx, msg) => write(LEVELS.error, ctx, msg),

  /** Returnează un child logger cu context pre-populat (ex: per-request) */
  child(baseCtx) {
    return {
      debug: (ctx, msg) => write(LEVELS.debug, typeof ctx === 'string' ? { ...baseCtx } : { ...baseCtx, ...ctx }, typeof ctx === 'string' ? ctx : msg),
      info:  (ctx, msg) => write(LEVELS.info,  typeof ctx === 'string' ? { ...baseCtx } : { ...baseCtx, ...ctx }, typeof ctx === 'string' ? ctx : msg),
      warn:  (ctx, msg) => write(LEVELS.warn,  typeof ctx === 'string' ? { ...baseCtx } : { ...baseCtx, ...ctx }, typeof ctx === 'string' ? ctx : msg),
      error: (ctx, msg) => write(LEVELS.error, typeof ctx === 'string' ? { ...baseCtx } : { ...baseCtx, ...ctx }, typeof ctx === 'string' ? ctx : msg),
    };
  },
};

/**
 * requestLogger — Express access log middleware.
 * Logs method, url, status code and response time in ms.
 */
export function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const lvl = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[lvl]({ method: req.method, url: req.originalUrl, status: res.statusCode, ms }, 'request');
  });
  next();
}
