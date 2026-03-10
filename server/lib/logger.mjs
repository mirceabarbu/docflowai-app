function log(level, message, meta = {}) {
  const line = {
    ts: new Date().toISOString(),
    level,
    message,
    ...meta,
  };
  try { console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](JSON.stringify(line)); }
  catch { console.log(`[${line.ts}] [${level}] ${message}`, meta); }
}
export const logger = {
  info: (message, meta) => log('info', message, meta),
  warn: (message, meta) => log('warn', message, meta),
  error: (message, meta) => log('error', message, meta),
};
