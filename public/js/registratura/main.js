// public/js/registratura/main.js — Registratură Faza 1 (read-only UI)
//
// Pagina:
//  - verifică /api/me/can-registratura; dacă can=false → mesaj „modul inactiv"
//  - listează intrari paginat (50/pagină) cu filtre: an, q (obiect/nr), status
//  - permite export CSV cu același filtru
//  - ZERO localStorage/sessionStorage; HTML escape obligatoriu pe orice câmp

(function () {
  'use strict';

  const esc = (window.df && window.df.esc) || function (s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  const $ = (id) => document.getElementById(id);

  const state = { page: 1, limit: 50, total: 0, an: null, q: '', status: '' };

  function statusBadge(st) {
    const map = {
      finalizat:    ['Finalizat',   '#0a7d3e', 'rgba(16,185,129,.14)'],
      in_lucru:     ['În lucru',    '#5c5c5c', 'rgba(148,163,184,.18)'],
      inregistrat:  ['Înregistrat', '#5c5c5c', 'rgba(148,163,184,.18)'],
      refuzat:      ['Refuzat',     '#a3162c', 'rgba(248,113,113,.16)'],
      anulat:       ['Anulat',      '#a3162c', 'rgba(248,113,113,.16)'],
    };
    const [label, color, bg] = map[st] || [st || '—', '#5c5c5c', 'rgba(148,163,184,.18)'];
    return `<span style="display:inline-block;padding:3px 10px;border-radius:999px;font-size:.78rem;font-weight:600;color:${color};background:${bg};">${esc(label)}</span>`;
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '—';
      return d.toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest', dateStyle: 'short', timeStyle: 'short' });
    } catch { return '—'; }
  }

  function populateYears() {
    const sel = $('reg-an');
    if (!sel) return;
    const y = new Date().getFullYear();
    const opts = ['<option value="">Toți</option>'];
    for (let i = 0; i < 3; i++) opts.push(`<option value="${y - i}">${y - i}</option>`);
    sel.innerHTML = opts.join('');
  }

  function buildQuery() {
    const p = new URLSearchParams();
    if (state.an)     p.set('an', state.an);
    if (state.q)      p.set('q', state.q);
    if (state.status) p.set('status', state.status);
    p.set('page',  state.page);
    p.set('limit', state.limit);
    return p.toString();
  }

  async function loadList() {
    const tbody = $('reg-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--df-text-3);">Se încarcă…</td></tr>';
    try {
      const r = await fetch('/api/registratura/intrari?' + buildQuery(), { credentials: 'include' });
      if (!r.ok) throw new Error('http_' + r.status);
      const data = await r.json();
      state.total = Number(data.total || 0);
      renderRows(data.items || []);
      renderPagination();
    } catch (e) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--df-text-3);">Eroare la încărcare.</td></tr>';
    }
  }

  function renderRows(items) {
    const tbody = $('reg-tbody');
    if (!tbody) return;
    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--df-text-3);">Niciun document înregistrat.</td></tr>';
      return;
    }
    const rows = items.map((it) => `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid var(--df-border-2);font-weight:600;">${esc(it.numarFormat)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid var(--df-border-2);">${esc(fmtDate(it.data))}</td>
        <td style="padding:10px 12px;border-bottom:1px solid var(--df-border-2);">${esc(it.obiect || '—')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid var(--df-border-2);">${esc(it.expeditor || '—')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid var(--df-border-2);">${esc(it.compartiment || '—')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid var(--df-border-2);">${statusBadge(it.status)}</td>
      </tr>
    `).join('');
    tbody.innerHTML = rows;
  }

  function renderPagination() {
    const totalPages = Math.max(1, Math.ceil(state.total / state.limit));
    const totalEl = $('reg-total');
    const pageEl = $('reg-page');
    const prev = $('reg-prev');
    const next = $('reg-next');
    if (totalEl) totalEl.textContent = `${state.total} înregistrări`;
    if (pageEl)  pageEl.textContent  = `Pagina ${state.page} / ${totalPages}`;
    if (prev) prev.disabled = state.page <= 1;
    if (next) next.disabled = state.page >= totalPages;
  }

  function wire() {
    const debounce = (window.df && window.df.debounce) || ((fn, ms) => {
      let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
    });

    $('reg-an').addEventListener('change', (e) => { state.an = e.target.value || null; state.page = 1; loadList(); });
    $('reg-status').addEventListener('change', (e) => { state.status = e.target.value || ''; state.page = 1; loadList(); });
    $('reg-q').addEventListener('input', debounce((e) => { state.q = e.target.value.trim(); state.page = 1; loadList(); }, 300));
    $('reg-refresh').addEventListener('click', () => loadList());
    $('reg-prev').addEventListener('click', () => { if (state.page > 1) { state.page--; loadList(); } });
    $('reg-next').addEventListener('click', () => { state.page++; loadList(); });
    $('reg-export').addEventListener('click', () => {
      const p = new URLSearchParams();
      if (state.an) p.set('an', state.an);
      window.location = '/api/registratura/export.csv?' + p.toString();
    });
  }

  async function checkAccess() {
    try {
      const r = await fetch('/api/me/can-registratura', { credentials: 'include' });
      if (!r.ok) return false;
      const j = await r.json();
      return !!(j && j.can);
    } catch { return false; }
  }

  async function init() {
    const can = await checkAccess();
    if (!can) {
      const inactive = $('reg-inactive');
      if (inactive) inactive.style.display = '';
      return;
    }
    const content = $('reg-content');
    if (content) content.style.display = '';
    populateYears();
    wire();
    loadList();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
