/**
 * DocFlowAI — Lightweight Metrics v3.3.5
 *
 * Colector in-memory zero dependențe externe — output Prometheus text format.
 * Compatibil cu Railway Metrics, Grafana Cloud (Prometheus scrape), Datadog.
 *
 * API:
 *   incCounter(name, labels?)     — incrementează un contor
 *   setGauge(name, value, labels?) — setează o valoare de tip gauge
 *   renderMetrics()               — returnează string Prometheus text format
 *   resetMetrics()                — resetează toate contoarele (util pentru teste)
 *
 * Utilizare în routes:
 *   import { incCounter } from '../middleware/metrics.mjs';
 *   incCounter('auth_attempts_total', { result: 'success' });
 */

// Map<metricName, Map<labelString, number>>
const _counters = new Map();
const _gauges   = new Map();

/**
 * Serializează un obiect de labels în string Prometheus.
 * Ordinea e stabilă (sortată) pentru chei consistente în Map.
 */
function _labelsKey(labels) {
  if (!labels || !Object.keys(labels).length) return '';
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`)
    .join(',');
}

/**
 * Incrementează un contor cu 1.
 * @param {string} name   - Nume metric Prometheus (ex: http_requests_total)
 * @param {Object} labels - Labels opționale (ex: { method: 'GET', status: '200' })
 */
export function incCounter(name, labels = {}) {
  if (!_counters.has(name)) _counters.set(name, new Map());
  const key = _labelsKey(labels);
  const map = _counters.get(name);
  map.set(key, (map.get(key) || 0) + 1);
}

/**
 * Setează valoarea unui gauge.
 * @param {string} name   - Nume metric
 * @param {number} value  - Valoare
 * @param {Object} labels - Labels opționale
 */
export function setGauge(name, value, labels = {}) {
  if (!_gauges.has(name)) _gauges.set(name, new Map());
  const key = _labelsKey(labels);
  _gauges.get(name).set(key, { value, labels });
}

/**
 * Returnează toate metricele în format Prometheus text (exposition format).
 * Inclus automat: process_heap_used_bytes, process_rss_bytes, process_uptime_seconds.
 * @returns {string}
 */
export function renderMetrics() {
  const lines = [];

  // Counters
  for (const [name, labelMap] of _counters) {
    lines.push(`# TYPE ${name} counter`);
    for (const [labelKey, val] of labelMap) {
      lines.push(labelKey ? `${name}{${labelKey}} ${val}` : `${name} ${val}`);
    }
  }

  // Gauges
  for (const [name, labelMap] of _gauges) {
    lines.push(`# TYPE ${name} gauge`);
    for (const [labelKey, entry] of labelMap) {
      lines.push(labelKey ? `${name}{${labelKey}} ${entry.value}` : `${name} ${entry.value}`);
    }
  }

  // Process-level metrics (întotdeauna incluse)
  const mem = process.memoryUsage();
  lines.push('# TYPE process_heap_used_bytes gauge');
  lines.push(`process_heap_used_bytes ${mem.heapUsed}`);
  lines.push('# TYPE process_rss_bytes gauge');
  lines.push(`process_rss_bytes ${mem.rss}`);
  lines.push('# TYPE process_uptime_seconds gauge');
  lines.push(`process_uptime_seconds ${process.uptime().toFixed(2)}`);

  return lines.join('\n') + '\n';
}

/**
 * Resetează toate datele de metrics (util pentru teste).
 */
export function resetMetrics() {
  _counters.clear();
  _gauges.clear();
}
