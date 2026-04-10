/**
 * public/js/modules/initiator/flow-list.js — Flow listing for DocFlowAI v4
 */

import { api }   from '../../core/api.js';
import { auth }  from '../../core/auth.js';
import { toast } from '../../core/toast.js';
import { modal } from '../../core/modal.js';
import { renderTable, renderPagination } from '../../core/tables.js';
import { $, esc, formatDate, statusBadge } from '../../core/dom.js';

auth.requireLogin();

let currentPage  = 1;
const PAGE_LIMIT = 15;

export async function loadFlows({ status, search } = {}) {
  const container = $('#flows-table');
  if (!container) return;

  const params = {
    page:   currentPage,
    limit:  PAGE_LIMIT,
    status: status || $('#filter-status')?.value || undefined,
    search: search || $('#search-input')?.value?.trim() || undefined,
  };
  // Remove falsy params
  Object.keys(params).forEach(k => !params[k] && delete params[k]);

  container.innerHTML = '<div class="loading-overlay"><div class="spinner"></div></div>';

  try {
    const data  = await api.get('/api/flows', params);
    const flows = data.flows ?? data.items ?? [];
    const total = data.total ?? flows.length;

    renderTable(container, {
      columns: [
        { key: 'doc_name', label: 'Document', render: (v, r) =>
            `<a href="/flow.html?id=${esc(r.id)}" class="font-medium">${esc(v || r.title || r.id)}</a>` },
        { key: 'initiator_name', label: 'Inițiator', render: (v, r) => esc(v || r.initiator_email || '—') },
        { key: 'status',  label: 'Status',   render: v => statusBadge(v) },
        { key: 'created_at', label: 'Data',  render: v => formatDate(v) },
      ],
      rows: flows,
      actions: [
        {
          label: 'Vizualizare',
          class: 'btn-ghost',
          onClick: r => location.href = `/flow.html?id=${r.id}`,
        },
        {
          label: 'Anulare',
          class: 'btn-danger',
          onClick: r => cancelFlow(r),
        },
      ],
      emptyMessage: 'Niciun flux găsit. Creați primul flux apăsând butonul de mai sus.',
    });

    renderPagination($('#flows-pagination'), {
      total, page: currentPage, limit: PAGE_LIMIT,
      onPageChange: p => { currentPage = p; loadFlows(); },
    });
  } catch (err) {
    if (err.status !== 401) {
      container.innerHTML = `<div class="table-empty">Eroare la încărcare: ${esc(err.message)}</div>`;
      toast.error('Nu s-au putut încărca fluxurile.');
    }
  }
}

async function cancelFlow(flow) {
  if (['completed', 'refused', 'cancelled'].includes(flow.status)) {
    toast.warning('Fluxul nu mai poate fi anulat.');
    return;
  }
  const ok = await modal.confirm(
    `Anulați fluxul "${flow.doc_name || flow.title || flow.id}"?\nAcțiunea nu poate fi anulată.`,
    { title: 'Confirmare anulare', okText: 'Anulează fluxul' }
  );
  if (!ok) return;

  try {
    await api.delete(`/api/flows/${flow.id}`);
    toast.success('Fluxul a fost anulat.');
    loadFlows();
  } catch (err) {
    toast.error(err.message || 'Eroare la anulare.');
  }
}

// ── Wire filters ──────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  let searchTimer;

  $('#search-input')?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { currentPage = 1; loadFlows(); }, 350);
  });

  $('#filter-status')?.addEventListener('change', () => {
    currentPage = 1; loadFlows();
  });

  // Expose for flow-create.js to trigger reload after creation
  window.flowListReload = () => { currentPage = 1; loadFlows(); };

  loadFlows();
});
