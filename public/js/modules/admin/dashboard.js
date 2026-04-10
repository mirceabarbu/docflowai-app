/**
 * public/js/modules/admin/dashboard.js — Admin dashboard for DocFlowAI v4
 */

import { api }   from '../../core/api.js';
import { auth }  from '../../core/auth.js';
import { toast } from '../../core/toast.js';
import { $, esc, formatDate, statusBadge } from '../../core/dom.js';

auth.requireAdmin();

// ── Chart.js lazy loader ─────────────────────────────────────────────────────

async function loadChartJs() {
  if (window.Chart) return window.Chart;
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js';
    s.onload  = () => resolve(window.Chart);
    s.onerror = () => reject(new Error('Chart.js failed to load'));
    document.head.appendChild(s);
  });
}

// ── Dashboard loader ─────────────────────────────────────────────────────────

async function loadDashboard() {
  try {
    const [summary, timeline] = await Promise.all([
      api.get('/api/analytics/summary'),
      api.get('/api/analytics/flows', { days: 30 }),
    ]);

    // KPI cards
    _setText('#kpi-flows-total',     summary.flows?.total ?? 0);
    _setText('#kpi-flows-completed', summary.flows?.completed ?? 0);
    _setText('#kpi-flows-refused',   summary.flows?.refused ?? 0);
    _setText('#kpi-avg-time',
      summary.avg_completion_hours != null
        ? `${summary.avg_completion_hours}h`
        : '—'
    );

    // Users KPI
    _setText('#kpi-users-total',  summary.users?.total ?? 0);
    _setText('#kpi-users-active', summary.users?.active ?? 0);

    // Forms KPI
    _setText('#kpi-forms-total',
      summary.forms?.total_instances ?? 0
    );

    // Timeline chart
    const chartCanvas = $('#flows-chart');
    if (chartCanvas && timeline?.timeline?.length) {
      await renderFlowsChart(chartCanvas, timeline.timeline);
    }

    // Recent flows table
    await loadRecentFlows();

  } catch (err) {
    if (err.status !== 401) toast.error('Nu s-a putut încărca dashboard-ul.');
  }
}

async function loadRecentFlows() {
  try {
    const data = await api.get('/api/flows', { limit: 10, page: 1 });
    const flows = data?.flows ?? data?.items ?? [];
    renderRecentFlowsTable(flows);
  } catch {
    // non-fatal
  }
}

function renderRecentFlowsTable(flows) {
  const tbody = $('#recent-flows-body');
  if (!tbody) return;

  if (!flows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="table-empty">Niciun flux recent.</td></tr>';
    return;
  }

  tbody.innerHTML = flows.map(f => `
    <tr>
      <td>${esc(f.doc_name || f.title || f.id)}</td>
      <td>${esc(f.initiator_name || f.initiator_email || '—')}</td>
      <td>${statusBadge(f.status)}</td>
      <td>${formatDate(f.created_at)}</td>
      <td>
        <a href="/flow.html?id=${esc(f.id)}" class="btn btn-sm btn-ghost">Vizualizare</a>
      </td>
    </tr>
  `).join('');
}

async function renderFlowsChart(canvas, timeline) {
  try {
    const Chart = await loadChartJs();
    const labels    = timeline.map(d => d.date);
    const created   = timeline.map(d => d.created   ?? d.flows_created   ?? 0);
    const completed = timeline.map(d => d.completed  ?? d.flows_completed ?? 0);

    if (canvas._chart) canvas._chart.destroy();

    canvas._chart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label:           'Inițiate',
            data:            created,
            backgroundColor: 'rgba(37,99,235,0.7)',
            borderRadius:    4,
          },
          {
            label:           'Finalizate',
            data:            completed,
            backgroundColor: 'rgba(22,163,74,0.7)',
            borderRadius:    4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'top' },
        },
        scales: {
          x: { grid: { display: false } },
          y: { beginAtZero: true, ticks: { stepSize: 1 } },
        },
      },
    });
  } catch {
    // Chart.js unavailable (offline) — skip silently
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _setText(sel, val) {
  const el = $(sel);
  if (el) el.textContent = val;
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', loadDashboard);
