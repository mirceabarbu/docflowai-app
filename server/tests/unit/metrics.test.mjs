/**
 * DocFlowAI — Unit tests: middleware/metrics.mjs
 *
 * Testează colectorul de metrics fără dependențe externe.
 * Zero side-effects — fiecare test resetează starea.
 *
 * Acoperire:
 *   ✓ incCounter — incrementare, labels, persistență
 *   ✓ setGauge   — setare, suprascrierea valorii
 *   ✓ renderMetrics — format Prometheus text valid
 *   ✓ resetMetrics  — stare curată după reset
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { incCounter, setGauge, renderMetrics, resetMetrics } from '../../middleware/metrics.mjs';

// Reset complet înainte de fiecare test
beforeEach(() => resetMetrics());

// ── incCounter ────────────────────────────────────────────────────────────────

describe('incCounter', () => {
  it('incrementează un contor simplu (fără labels)', () => {
    incCounter('test_counter_total');
    incCounter('test_counter_total');
    const output = renderMetrics();
    expect(output).toContain('test_counter_total 2');
  });

  it('tratează labels diferite ca serii separate', () => {
    incCounter('http_req', { method: 'GET',  status_class: '2xx' });
    incCounter('http_req', { method: 'GET',  status_class: '2xx' });
    incCounter('http_req', { method: 'POST', status_class: '4xx' });

    const output = renderMetrics();
    expect(output).toMatch(/http_req\{[^}]*method="GET"[^}]*\} 2/);
    expect(output).toMatch(/http_req\{[^}]*method="POST"[^}]*\} 1/);
  });

  it('contoare diferite coexistă independent', () => {
    incCounter('counter_a');
    incCounter('counter_b');
    incCounter('counter_b');

    const output = renderMetrics();
    expect(output).toContain('counter_a 1');
    expect(output).toContain('counter_b 2');
  });
});

// ── setGauge ──────────────────────────────────────────────────────────────────

describe('setGauge', () => {
  it('setează și suprascrie un gauge', () => {
    setGauge('ws_clients', 5);
    setGauge('ws_clients', 12);  // suprascrie

    const output = renderMetrics();
    expect(output).toContain('ws_clients 12');
    expect(output).not.toContain('ws_clients 5');
  });

  it('gauge-urile cu labels diferite coexistă', () => {
    setGauge('active_flows', 10, { org_id: '1' });
    setGauge('active_flows', 25, { org_id: '2' });

    const output = renderMetrics();
    expect(output).toMatch(/active_flows\{[^}]*org_id="1"[^}]*\} 10/);
    expect(output).toMatch(/active_flows\{[^}]*org_id="2"[^}]*\} 25/);
  });
});

// ── renderMetrics ─────────────────────────────────────────────────────────────

describe('renderMetrics', () => {
  it('include întotdeauna metricele de process (heap, rss, uptime)', () => {
    const output = renderMetrics();
    expect(output).toContain('process_heap_used_bytes');
    expect(output).toContain('process_rss_bytes');
    expect(output).toContain('process_uptime_seconds');
  });

  it('include header # TYPE pentru fiecare metric', () => {
    incCounter('my_events_total');
    setGauge('my_gauge');

    const output = renderMetrics();
    expect(output).toContain('# TYPE my_events_total counter');
    expect(output).toContain('# TYPE my_gauge gauge');
  });

  it('returnează string non-gol chiar fără date custom', () => {
    const output = renderMetrics();
    expect(output.trim().length).toBeGreaterThan(0);
    expect(output.endsWith('\n')).toBe(true);
  });
});

// ── resetMetrics ──────────────────────────────────────────────────────────────

describe('resetMetrics', () => {
  it('șterge toți contoarele și gauge-urile custom', () => {
    incCounter('temp_counter');
    setGauge('temp_gauge', 99);

    resetMetrics();
    const output = renderMetrics();

    expect(output).not.toContain('temp_counter');
    expect(output).not.toContain('temp_gauge');
    // Dar process metrics rămân
    expect(output).toContain('process_heap_used_bytes');
  });
});
