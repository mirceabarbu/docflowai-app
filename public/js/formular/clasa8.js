// public/js/formular/clasa8.js
// DocFlowAI — Modul Clasa 8: centralizator angajamente/ordonanțări/plăți per Cod SSI.
//
// Cross-module exports (window):
//   - openClasa8, clasa8Reload
//   - clasa8CloseImport
//
// Local state: _state (items, totals, filters, loading, debounceTimer, error, initialized)
// Dependențe: window.df.esc (cu fallback inline)
//
// SheetJS este încărcat LAZY la export/import (CDN cdnjs.cloudflare.com).

(function () {
  'use strict';
  const esc = (window.df && window.df.esc)
    ? window.df.esc
    : s => String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  const _pMR = v => {
    if (v === null || v === undefined || v === '') return NaN;
    const s = String(v).trim().replace(/\s/g,'').replace(/\./g,'').replace(',','.');
    return parseFloat(s);
  };

  const _state = {
    items: [],
    totals: { buget: 0, angajamente: 0, ordonantari: 0, plati: 0, ramane_din_buget: 0, ramane_din_angajamente: 0 },
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

  function _numCell(n, opts = {}) {
    if (n === null || n === undefined) {
      return '<td class="clasa8-num"><span style="color:var(--df-text-5);">—</span></td>';
    }
    const isNeg = Number(n) < 0;
    const cls = 'clasa8-num' + (isNeg ? ' is-neg' : '');
    const inner = opts.bold ? '<strong>' + _formatRO(n) + '</strong>' : _formatRO(n);
    return `<td class="${cls}">${inner}</td>`;
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
      _state.totals = j.totals || { buget: 0, angajamente: 0, ordonantari: 0, plati: 0, ramane_din_buget: 0, ramane_din_angajamente: 0 };
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
      '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--df-text-3);">⏳ Se încarcă…</td></tr>';
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

    // Ordine coloane: Cod SSI | BUGET | Angajamente | Rămâne din buget | Ordonanțări | Rămâne din angajamente | Plăți
    tbody.innerHTML = _state.items.map(it =>
      '<tr>'
      + '<td><strong>' + esc(it.cod_ssi) + '</strong></td>'
      + _numCell(it.buget)
      + _numCell(it.angajamente)
      + _numCell(it.ramane_din_buget)
      + _numCell(it.ordonantari)
      + _numCell(it.ramane_din_angajamente)
      + _numCell(it.plati)
      + '</tr>'
    ).join('');

    if (tfoot) {
      tfoot.style.display = '';
      const t = _state.totals;
      tfoot.innerHTML =
        '<tr class="clasa8-total-row">'
        + '<td><strong>TOTAL</strong></td>'
        + _numCell(t.buget,                  { bold: true })
        + _numCell(t.angajamente,            { bold: true })
        + _numCell(t.ramane_din_buget,       { bold: true })
        + _numCell(t.ordonantari,            { bold: true })
        + _numCell(t.ramane_din_angajamente, { bold: true })
        + _numCell(t.plati,                  { bold: true })
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
        ['Cod SSI', 'BUGET', 'Angajamente bugetare', 'Rămâne din buget', 'Ordonanțări', 'Rămâne din angajamente', 'Plăți'],
      ];
      _state.items.forEach(it => {
        aoa.push([
          it.cod_ssi,
          it.buget === null ? '—' : Number(it.buget),
          Number(it.angajamente),
          it.ramane_din_buget === null ? '—' : Number(it.ramane_din_buget),
          Number(it.ordonantari),
          Number(it.ramane_din_angajamente),
          Number(it.plati),
        ]);
      });
      aoa.push([]);
      aoa.push([
        'TOTAL',
        Number(_state.totals.buget),
        Number(_state.totals.angajamente),
        Number(_state.totals.ramane_din_buget),
        Number(_state.totals.ordonantari),
        Number(_state.totals.ramane_din_angajamente),
        Number(_state.totals.plati),
      ]);

      const ws = window.XLSX.utils.aoa_to_sheet(aoa);

      // Format numeric pe coloanele B-G (col indices 1-6)
      const range = window.XLSX.utils.decode_range(ws['!ref']);
      for (let R = 1; R <= range.e.r; R++) {
        for (let C = 1; C <= 6; C++) {
          const ref = window.XLSX.utils.encode_cell({ r: R, c: C });
          if (ws[ref] && typeof ws[ref].v === 'number') {
            ws[ref].t = 'n';
            ws[ref].z = '#,##0.00';
          }
        }
      }
      ws['!cols'] = [{ wch: 18 }, { wch: 18 }, { wch: 22 }, { wch: 18 }, { wch: 16 }, { wch: 22 }, { wch: 14 }];

      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, 'Clasa 8');

      const dateStr = new Date().toISOString().slice(0, 10);
      window.XLSX.writeFile(wb, 'Clasa8_' + dateStr + '.xlsx');
    } catch(e) {
      alert('Export eșuat: ' + (e.message || e));
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = orig || '<svg class="df-ico"><use href="/icons.svg?v=3.9.468#ico-download"/></svg> Export Excel';
      }
    }
  }

  // ── Buget meta ──────────────────────────────────────────────────────────────
  async function _refreshBugetMeta() {
    try {
      const r = await fetch('/api/clasa8/buget/meta', { credentials: 'include' });
      if (!r.ok) return;
      const j = await r.json();
      const metaEl  = document.getElementById('clasa8-buget-meta');
      const emptyEl = document.getElementById('clasa8-buget-empty');
      if (!j.active) {
        if (metaEl)  metaEl.style.display  = 'none';
        if (emptyEl) emptyEl.style.display = '';
        return;
      }
      const a = j.active;
      if (metaEl) {
        metaEl.style.display = 'flex';
        const vEl = document.getElementById('clasa8-buget-version');
        if (vEl) vEl.textContent = 'v' + a.version_no;
        const wEl = document.getElementById('clasa8-buget-when');
        if (wEl) {
          const d = new Date(a.uploaded_at).toLocaleString('ro-RO', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
          wEl.textContent = (a.uploaded_by_nume || '?') + ' · ' + d;
        }
        const sEl = document.getElementById('clasa8-buget-stats');
        if (sEl) {
          const total = Number(a.total_value);
          sEl.textContent = a.row_count + ' coduri · ' + total.toLocaleString('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' lei';
        }
      }
      if (emptyEl) emptyEl.style.display = 'none';
    } catch (_) {}
  }

  // ── Parsing fișier import ───────────────────────────────────────────────────
  function _parseCsv(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return [];
    const first = lines[0];
    const sep = (first.split(';').length >= first.split(',').length) ? ';' : ',';
    const aoa = lines.map(l => l.split(sep));
    // Skip header dacă col2 din primul rând este non-numeric text
    const col2 = (aoa[0][1] || '').trim().replace(/\./g,'').replace(',','.');
    const skipHeader = isNaN(parseFloat(col2)) || col2 === '';
    return skipHeader ? aoa.slice(1) : aoa;
  }

  function _parseXlsx(buffer) {
    const wb = window.XLSX.read(buffer, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    // Skip header dacă col2 din primul rând este non-numeric
    if (!aoa.length) return [];
    const col2 = String(aoa[0][1] || '').trim().replace(/\./g,'').replace(',','.');
    const skipHeader = isNaN(parseFloat(col2)) || col2 === '';
    return skipHeader ? aoa.slice(1) : aoa;
  }

  function _normalizeRows(aoa) {
    const result = [];
    for (const row of aoa) {
      const cod_ssi = String(row[0] || '').trim();
      if (!cod_ssi) continue;
      const rawVal = String(row[1] || '').trim();
      const valoare = _pMR(rawVal);
      if (isNaN(valoare)) continue;
      result.push({ cod_ssi, valoare });
    }
    return result;
  }

  // ── Import modal ────────────────────────────────────────────────────────────
  let _parsedRows = [];

  async function _openImportModal() {
    await _refreshBugetMeta();
    // Populate current version info în modal
    const metaEl = document.getElementById('clasa8-buget-meta');
    const cur = document.getElementById('clasa8-import-current');
    if (cur) {
      cur.innerHTML = metaEl && metaEl.style.display !== 'none'
        ? '<div style="font-size:.83rem;color:var(--df-text-2);">Versiune curentă: ' + esc(document.getElementById('clasa8-buget-version')?.textContent||'') + ' — va fi înlocuită.</div>'
        : '<div style="font-size:.83rem;color:var(--df-text-3);">Niciun buget activ.</div>';
    }
    // Reset state
    _parsedRows = [];
    const fileInput = document.getElementById('clasa8-import-file');
    if (fileInput) fileInput.value = '';
    const preview = document.getElementById('clasa8-import-preview');
    if (preview) { preview.style.display = 'none'; preview.innerHTML = ''; }
    const errEl = document.getElementById('clasa8-import-error');
    if (errEl) errEl.style.display = 'none';
    const doBtn = document.getElementById('clasa8-btn-do-import');
    if (doBtn) doBtn.disabled = true;

    const modal = document.getElementById('clasa8-import-modal');
    if (modal) modal.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function clasa8CloseImport() {
    const modal = document.getElementById('clasa8-import-modal');
    if (modal) modal.classList.remove('open');
    document.body.style.overflow = '';
    const fileInput = document.getElementById('clasa8-import-file');
    if (fileInput) fileInput.value = '';
    const nameEl = document.getElementById('clasa8-import-file-name');
    if (nameEl) { nameEl.textContent = 'Niciun fișier selectat'; nameEl.style.fontStyle = 'italic'; nameEl.style.color = 'var(--df-text-3)'; }
    const preview = document.getElementById('clasa8-import-preview');
    if (preview) { preview.style.display = 'none'; preview.innerHTML = ''; }
    const errEl = document.getElementById('clasa8-import-error');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    const btnDo = document.getElementById('clasa8-btn-do-import');
    if (btnDo) btnDo.disabled = true;
  }
  window.clasa8CloseImport = clasa8CloseImport;

  async function _onImportFileChange(file) {
    const nameEl = document.getElementById('clasa8-import-file-name');
    if (nameEl) {
      if (file) {
        nameEl.textContent = file.name;
        nameEl.style.fontStyle = 'normal';
        nameEl.style.color = 'var(--df-text)';
      } else {
        nameEl.textContent = 'Niciun fișier selectat';
        nameEl.style.fontStyle = 'italic';
        nameEl.style.color = 'var(--df-text-3)';
      }
    }
    if (!file) return;
    const preview = document.getElementById('clasa8-import-preview');
    const errEl   = document.getElementById('clasa8-import-error');
    const doBtn   = document.getElementById('clasa8-btn-do-import');
    if (errEl) errEl.style.display = 'none';
    if (preview) { preview.style.display = 'none'; preview.innerHTML = ''; }
    if (doBtn) doBtn.disabled = true;
    _parsedRows = [];

    try {
      await _loadSheetJs();
      let aoa;
      if (file.name.endsWith('.csv')) {
        const text = await file.text();
        aoa = _parseCsv(text);
      } else {
        const buf = await file.arrayBuffer();
        aoa = _parseXlsx(new Uint8Array(buf));
      }
      _parsedRows = _normalizeRows(aoa);
      if (!_parsedRows.length) throw new Error('Nu s-au găsit rânduri valide (cod_ssi + valoare numerică).');

      const total = _parsedRows.reduce((s, r) => s + r.valoare, 0);
      const previewRows = _parsedRows.slice(0, 10).map(r =>
        `<div style="display:flex;gap:12px;border-bottom:1px solid var(--df-border-2);padding:3px 0">
          <span style="flex:1;font-variant-numeric:tabular-nums">${esc(r.cod_ssi)}</span>
          <span style="min-width:110px;text-align:right;font-variant-numeric:tabular-nums">${r.valoare.toLocaleString('ro-RO',{minimumFractionDigits:2,maximumFractionDigits:2})} lei</span>
        </div>`
      ).join('');

      if (preview) {
        preview.style.display = '';
        preview.innerHTML = `<div style="font-weight:600;margin-bottom:8px">${_parsedRows.length} rânduri · Total: ${total.toLocaleString('ro-RO',{minimumFractionDigits:2,maximumFractionDigits:2})} lei</div>`
          + previewRows
          + (_parsedRows.length > 10 ? `<div style="margin-top:6px;color:var(--df-text-3)">… și încă ${_parsedRows.length - 10} rânduri</div>` : '');
      }
      if (doBtn) doBtn.disabled = false;
    } catch(e) {
      _parsedRows = [];
      if (errEl) { errEl.textContent = '⚠ ' + (e.message || e); errEl.style.display = ''; }
    }
  }

  async function _doImport() {
    if (!_parsedRows.length) return;
    const doBtn = document.getElementById('clasa8-btn-do-import');
    const errEl = document.getElementById('clasa8-import-error');
    if (doBtn) { doBtn.disabled = true; doBtn.textContent = '⏳ Se importă…'; }
    if (errEl) errEl.style.display = 'none';

    const fileInput = document.getElementById('clasa8-import-file');
    const filename  = fileInput?.files?.[0]?.name || null;

    try {
      const r = await fetch('/api/clasa8/buget/import', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.df?.getCsrf?.() || '' },
        body: JSON.stringify({ rows: _parsedRows, filename }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.error || 'HTTP ' + r.status);
      clasa8CloseImport();
      alert('Buget importat ca v' + j.version_no + ' (' + j.count + ' coduri)');
      await _refreshBugetMeta();
      _fetch();
      if (typeof window.loadBugetCodes === 'function') window.loadBugetCodes();
    } catch(e) {
      if (errEl) { errEl.textContent = '⚠ ' + (e.message || e); errEl.style.display = ''; }
    } finally {
      if (doBtn) { doBtn.disabled = false; doBtn.textContent = 'Importă'; }
    }
  }

  async function _clearBuget() {
    if (!confirm('Vrei să ștergi bugetul activ? Versiunile anterioare rămân în istoric.')) return;
    try {
      const r = await fetch('/api/clasa8/buget', {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'X-CSRF-Token': window.df?.getCsrf?.() || '' },
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      clasa8CloseImport();
      await _refreshBugetMeta();
      _fetch();
      if (typeof window.loadBugetCodes === 'function') window.loadBugetCodes();
    } catch(e) {
      alert('Eroare la ștergere: ' + (e.message || e));
    }
  }

  // ── Init handlere event ─────────────────────────────────────────────────────
  function _bindEvents() {
    if (_state.initialized) return;
    const ssiInput  = document.getElementById('clasa8-filter-ssi');
    const resetBtn  = document.getElementById('clasa8-btn-reset');
    const exportBtn = document.getElementById('clasa8-btn-export');
    const importBtn = document.getElementById('clasa8-btn-import');
    const fileInput = document.getElementById('clasa8-import-file');
    const doImport  = document.getElementById('clasa8-btn-do-import');
    const clearBtn  = document.getElementById('clasa8-btn-clear-buget');

    if (ssiInput)  ssiInput.addEventListener('input', e => _onSsiInput(e.target.value));
    if (resetBtn)  resetBtn.addEventListener('click', _onResetFilters);
    if (exportBtn) exportBtn.addEventListener('click', _exportXLSX);
    if (importBtn) importBtn.addEventListener('click', _openImportModal);
    document.getElementById('clasa8-import-file-btn')?.addEventListener('click', () => {
      document.getElementById('clasa8-import-file')?.click();
    });
    if (fileInput) fileInput.addEventListener('change', e => _onImportFileChange(e.target.files?.[0]));
    if (doImport)  doImport.addEventListener('click', _doImport);
    if (clearBtn)  clearBtn.addEventListener('click', _clearBuget);

    // Backdrop click closes modal
    const modalBg = document.getElementById('clasa8-import-modal');
    if (modalBg) modalBg.addEventListener('click', e => { if (e.target === modalBg) clasa8CloseImport(); });

    // ESC closes modal
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        const m = document.getElementById('clasa8-import-modal');
        if (m && m.classList.contains('open')) clasa8CloseImport();
      }
    });

    _state.initialized = true;
  }

  // Public API
  function openClasa8() {
    _bindEvents();
    _refreshBugetMeta();
    _fetch();
  }
  function clasa8Reload() { _fetch(); }

  window.openClasa8   = openClasa8;
  window.clasa8Reload = clasa8Reload;
})();
