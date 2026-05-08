// public/js/formular/clasa8.js
// DocFlowAI — Modul Clasa 8: centralizator angajamente/ordonanțări/plăți per Cod SSI.
//
// Cross-module exports (window):
//   - openClasa8         : apelată din switchListTab când user accesează tab-ul
//   - clasa8Reload       : reload manual (după modificări în alte tab-uri)
//
// Local state: _state (items, totals, filters, loading, debounceTimer, error, initialized)
// Dependențe: window.df.esc (cu fallback inline)
//
// SheetJS este încărcat LAZY la primul click pe Export (CDN cdnjs.cloudflare.com),
// pentru a nu umfla bundle-ul pentru utilizatorii care nu folosesc niciodată exportul.

(function () {
  'use strict';
  const esc = (window.df && window.df.esc)
    ? window.df.esc
    : s => String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  const _state = {
    items: [],
    totals: { angajamente: 0, ordonantari: 0, plati: 0, ramane_din_angajamente: 0 },
    filters: { ssi: '', compartiment: '', q: '' },
    loading: false,
    error: null,
    debounceTimer: null,
    initialized: false,
  };

  function _formatRO(n) {
    if (n === null || n === undefined || n === '') return '—';
    const num = Number(n);
    if (isNaN(num)) return '—';
    return num.toLocaleString('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  async function _fetch() {
    _state.loading = true;
    _state.error = null;
    _renderLoading();
    try {
      const params = new URLSearchParams();
      if (_state.filters.ssi)          params.set('ssi', _state.filters.ssi);
      if (_state.filters.compartiment) params.set('compartiment', _state.filters.compartiment);
      if (_state.filters.q)            params.set('q', _state.filters.q);

      const r = await fetch('/api/clasa8?' + params.toString(), { credentials: 'include' });
      if (r.status === 401) { location.href = '/'; return; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      _state.items  = Array.isArray(j.items) ? j.items : [];
      _state.totals = j.totals || { angajamente: 0, ordonantari: 0, plati: 0, ramane_din_angajamente: 0 };
    } catch(e) {
      _state.error = e.message || 'Eroare la încărcare.';
      _state.items = [];
    } finally {
      _state.loading = false;
      _render();
    }
  }

  function _renderLoading() {
    const tbody = document.getElementById('clasa8-tbody');
    if (!tbody) return;
    tbody.innerHTML =
      '<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--df-text-3);">⏳ Se încarcă…</td></tr>';
    const tfoot = document.getElementById('clasa8-tfoot');
    if (tfoot) tfoot.style.display = 'none';
    const empty = document.getElementById('clasa8-empty');
    if (empty) empty.style.display = 'none';
    const errEl = document.getElementById('clasa8-error');
    if (errEl) errEl.style.display = 'none';
  }

  function _render() {
    const tbody  = document.getElementById('clasa8-tbody');
    const tfoot  = document.getElementById('clasa8-tfoot');
    const empty  = document.getElementById('clasa8-empty');
    const errEl  = document.getElementById('clasa8-error');
    const counter = document.getElementById('clasa8-counter');
    if (!tbody) return;

    if (_state.error) {
      if (errEl) { errEl.textContent = '⚠ ' + _state.error; errEl.style.display = ''; }
      tbody.innerHTML = '';
      if (tfoot)   tfoot.style.display = 'none';
      if (empty)   empty.style.display = 'none';
      if (counter) counter.textContent = '';
      return;
    }
    if (errEl) errEl.style.display = 'none';

    if (_state.items.length === 0) {
      tbody.innerHTML = '';
      if (tfoot)   tfoot.style.display = 'none';
      if (empty)   empty.style.display = '';
      if (counter) counter.textContent = '0 înregistrări';
      return;
    }
    if (empty) empty.style.display = 'none';

    tbody.innerHTML = _state.items.map(it =>
      '<tr>'
      + '<td><strong>' + esc(it.cod_ssi) + '</strong></td>'
      + '<td class="clasa8-num">' + (it.buget === null
          ? '<span style="color:var(--df-text-5);" title="Buget neimportat — funcționalitate Phase 2">—</span>'
          : _formatRO(it.buget)) + '</td>'
      + '<td class="clasa8-num">' + _formatRO(it.angajamente)             + '</td>'
      + '<td class="clasa8-num">' + _formatRO(it.ordonantari)             + '</td>'
      + '<td class="clasa8-num">' + _formatRO(it.plati)                   + '</td>'
      + '<td class="clasa8-num"><strong>' + _formatRO(it.ramane_din_angajamente) + '</strong></td>'
      + '</tr>'
    ).join('');

    if (tfoot) {
      tfoot.style.display = '';
      tfoot.innerHTML =
        '<tr class="clasa8-total-row">'
        + '<td><strong>TOTAL</strong></td>'
        + '<td class="clasa8-num"><span style="color:var(--df-text-5);">—</span></td>'
        + '<td class="clasa8-num"><strong>' + _formatRO(_state.totals.angajamente)            + '</strong></td>'
        + '<td class="clasa8-num"><strong>' + _formatRO(_state.totals.ordonantari)            + '</strong></td>'
        + '<td class="clasa8-num"><strong>' + _formatRO(_state.totals.plati)                  + '</strong></td>'
        + '<td class="clasa8-num"><strong>' + _formatRO(_state.totals.ramane_din_angajamente) + '</strong></td>'
        + '</tr>';
    }

    if (counter) counter.textContent = _state.items.length + ' înregistrări';
  }

  function _onSsiInput(value) {
    _state.filters.ssi = (value || '').trim();
    clearTimeout(_state.debounceTimer);
    _state.debounceTimer = setTimeout(_fetch, 350);
  }

  function _onResetFilters() {
    _state.filters = { ssi: '', compartiment: '', q: '' };
    const ssiInput = document.getElementById('clasa8-filter-ssi');
    if (ssiInput) ssiInput.value = '';
    _fetch();
  }

  // ── Export XLSX (lazy load SheetJS de pe cdnjs) ─────────────────────────────
  const SHEETJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  let _sheetJsLoading = null;

  function _loadSheetJs() {
    if (typeof window.XLSX !== 'undefined') return Promise.resolve();
    if (_sheetJsLoading) return _sheetJsLoading;
    _sheetJsLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SHEETJS_CDN;
      s.async = true;
      s.onload  = () => resolve();
      s.onerror = () => { _sheetJsLoading = null; reject(new Error('SheetJS load failed (CDN inaccesibil?)')); };
      document.head.appendChild(s);
    });
    return _sheetJsLoading;
  }

  async function _exportXLSX() {
    const btn = document.getElementById('clasa8-btn-export');
    const orig = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Pregătire export…'; }
    try {
      await _loadSheetJs();
      if (typeof window.XLSX === 'undefined') throw new Error('XLSX indisponibil după load');

      const aoa = [
        ['Cod SSI', 'Buget (din fișier importat)', 'Angajamente bugetare', 'Ordonanțări', 'Plăți', 'Rămâne din angajamente'],
      ];
      _state.items.forEach(it => {
        aoa.push([
          it.cod_ssi,
          it.buget === null ? '—' : Number(it.buget),
          Number(it.angajamente),
          Number(it.ordonantari),
          Number(it.plati),
          Number(it.ramane_din_angajamente),
        ]);
      });
      aoa.push([]);
      aoa.push([
        'TOTAL', '',
        Number(_state.totals.angajamente),
        Number(_state.totals.ordonantari),
        Number(_state.totals.plati),
        Number(_state.totals.ramane_din_angajamente),
      ]);

      const ws = window.XLSX.utils.aoa_to_sheet(aoa);

      // Format numeric „1.234,56" stil RO pe coloanele B-F (col indices 1-5)
      const range = window.XLSX.utils.decode_range(ws['!ref']);
      for (let R = 1; R <= range.e.r; R++) {
        for (let C = 1; C <= 5; C++) {
          const ref = window.XLSX.utils.encode_cell({ r: R, c: C });
          if (ws[ref] && typeof ws[ref].v === 'number') {
            ws[ref].t = 'n';
            ws[ref].z = '#,##0.00';
          }
        }
      }
      ws['!cols'] = [{ wch: 18 }, { wch: 24 }, { wch: 22 }, { wch: 16 }, { wch: 14 }, { wch: 22 }];

      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, 'Clasa 8');

      const dateStr = new Date().toISOString().slice(0, 10);
      const fileName = 'Clasa8_' + dateStr + '.xlsx';
      window.XLSX.writeFile(wb, fileName);
    } catch(e) {
      alert('Export eșuat: ' + (e.message || e));
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = orig || '<svg class="df-ico"><use href="/icons.svg?v=3.9.444#ico-download"/></svg> Export Excel';
      }
    }
  }

  // ── Init handlere event ─────────────────────────────────────────────────────
  function _bindEvents() {
    if (_state.initialized) return;
    const ssiInput  = document.getElementById('clasa8-filter-ssi');
    const resetBtn  = document.getElementById('clasa8-btn-reset');
    const exportBtn = document.getElementById('clasa8-btn-export');
    if (ssiInput)  ssiInput.addEventListener('input', e => _onSsiInput(e.target.value));
    if (resetBtn)  resetBtn.addEventListener('click', _onResetFilters);
    if (exportBtn) exportBtn.addEventListener('click', _exportXLSX);
    _state.initialized = true;
  }

  // Public API
  function openClasa8() { _bindEvents(); _fetch(); }
  function clasa8Reload() { _fetch(); }

  window.openClasa8   = openClasa8;
  window.clasa8Reload = clasa8Reload;
})();
