/* opme-report-drawer.js — drawer lateral pentru raportul unui import OPME.
 *
 * API:
 *   window.DFOpmeReportDrawer.open({ importId, onRematch })
 *
 * Conținut:
 *   • Antet: nr_document, data_op, plătitor, suma_totala, nr_inregistrari
 *   • 4 carduri stats: matched / ambiguous / unmatched / partial
 *   • Subtab-uri: „Toate" / „Confirmate" / „Probleme"
 *   • Tabel linii: NrOp · CodAng · IndAng · Beneficiar · CIF · Sumă · Status · ALOP
 *   • Footer: buton „Re-rulează matching" (admin/P2)
 *
 * Dependențe: df-utils.js (esc, getCsrf).
 */
(function () {
  'use strict';

  const esc = (s) => (window.df && window.df.esc ? window.df.esc(s) : String(s || ''));
  const csrf = () => (window.df && window.df.getCsrf ? window.df.getCsrf() : '');

  let _rootEl = null;
  let _state = { importId: null, data: null, filter: 'all', onRematch: null, canRematch: false };

  function ensureDOM() {
    if (_rootEl) return;
    const html = `
<div class="df-opme-drawer-overlay" id="df-opme-drawer-overlay" role="dialog" aria-modal="true">
  <aside class="df-opme-drawer" id="df-opme-drawer-panel" aria-labelledby="df-opme-drawer-title">
    <div class="df-opme-drawer__head">
      <div>
        <div class="df-opme-drawer__title" id="df-opme-drawer-title">Raport import OPME</div>
        <div class="df-opme-drawer__sub" id="df-opme-drawer-sub">—</div>
      </div>
      <button type="button" class="df-opme-drawer__close" aria-label="Închide">&times;</button>
    </div>
    <div class="df-opme-drawer__body" id="df-opme-drawer-body">
      <div class="df-opme-drawer__loading">Se încarcă…</div>
    </div>
  </aside>
</div>`;
    const wrap = document.createElement('div');
    wrap.innerHTML = html.trim();
    _rootEl = wrap.firstChild;
    document.body.appendChild(_rootEl);

    _rootEl.querySelector('.df-opme-drawer__close').addEventListener('click', close);
    _rootEl.addEventListener('click', e => { if (e.target === _rootEl) close(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && _rootEl && _rootEl.classList.contains('is-open')) close();
    });
  }

  function fmtRON(v) {
    if (v == null || v === '') return '—';
    const n = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(n)) return '—';
    return new Intl.NumberFormat('ro-RO', { style: 'currency', currency: 'RON' }).format(n);
  }
  function fmtDate(v) {
    if (!v) return '—';
    const s = String(v);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[3]}.${m[2]}.${m[1]}`;
    try { return new Date(v).toLocaleDateString('ro-RO'); } catch (_) { return s; }
  }

  function statusBadge(st) {
    const map = {
      auto:      { label: 'Confirmat', cls: 'ok' },
      manual:    { label: 'Manual',    cls: 'ok' },
      ambiguous: { label: 'Ambigu',    cls: 'warn' },
      unmatched: { label: 'Nepotrivit',cls: 'muted' },
      partial:   { label: 'Parțial',   cls: 'yellow' },
      pending:   { label: 'În așteptare', cls: 'muted' },
    };
    const x = map[st] || { label: st, cls: 'muted' };
    return `<span class="df-opme-status df-opme-status--${x.cls}">${esc(x.label)}</span>`;
  }

  async function _fetchCanOpme() {
    try {
      const r = await fetch('/api/me/can-import-opme', { credentials: 'include' });
      if (!r.ok) return false;
      const j = await r.json();
      return !!j.can;
    } catch { return false; }
  }

  function render() {
    const body = _rootEl.querySelector('#df-opme-drawer-body');
    const sub  = _rootEl.querySelector('#df-opme-drawer-sub');
    if (!_state.data) {
      body.innerHTML = '<div class="df-opme-drawer__loading">Se încarcă…</div>';
      sub.textContent = '—';
      return;
    }
    const { import: h, lines, stats } = _state.data;
    sub.innerHTML = `
      <strong>Nr. ${esc(h.nr_document || '—')}</strong>
       · ${esc(fmtDate(h.data_op))}
       · ${esc(h.den_platitor || '')}
       · ${esc(fmtRON(h.suma_totala))}
       · ${esc(h.nr_inregistrari || 0)} linii`;

    const matched   = stats.auto || 0;
    const ambiguous = stats.ambiguous || 0;
    const unmatched = stats.unmatched || 0;
    const partial   = stats.partial || 0;

    const filter = _state.filter;
    let filtered;
    if (filter === 'ok')        filtered = lines.filter(l => l.match_status === 'auto' || l.match_status === 'manual');
    else if (filter === 'bad')  filtered = lines.filter(l => l.match_status === 'ambiguous' || l.match_status === 'unmatched' || l.match_status === 'partial');
    else                         filtered = lines;

    const canRematch = _state.canRematch || false;

    body.innerHTML = `
      <div class="df-opme-stats">
        <div class="df-opme-stats-card df-opme-stats-card--ok">
          <div class="df-opme-stats-card__n">${matched}</div>
          <div class="df-opme-stats-card__l">Confirmate auto</div>
        </div>
        <div class="df-opme-stats-card df-opme-stats-card--warn">
          <div class="df-opme-stats-card__n">${ambiguous}</div>
          <div class="df-opme-stats-card__l">Ambigue</div>
        </div>
        <div class="df-opme-stats-card df-opme-stats-card--muted">
          <div class="df-opme-stats-card__n">${unmatched}</div>
          <div class="df-opme-stats-card__l">Fără match</div>
        </div>
        <div class="df-opme-stats-card df-opme-stats-card--yellow">
          <div class="df-opme-stats-card__n">${partial}</div>
          <div class="df-opme-stats-card__l">Parțiale</div>
        </div>
      </div>

      <div class="df-subtabs df-opme-drawer__tabs">
        <button type="button" class="df-subtab ${filter==='all'?'active':''}" data-filter="all">Toate <span class="df-subtab-count">${lines.length}</span></button>
        <button type="button" class="df-subtab ${filter==='ok'?'active':''}" data-filter="ok">Confirmate <span class="df-subtab-count">${matched}</span></button>
        <button type="button" class="df-subtab ${filter==='bad'?'active':''}" data-filter="bad">Probleme <span class="df-subtab-count">${ambiguous + unmatched + partial}</span></button>
      </div>

      <div class="df-opme-lines">
        <table class="df-opme-lines__table">
          <thead>
            <tr>
              <th>Nr. OP</th>
              <th>Cod ang.</th>
              <th>Indicator</th>
              <th>Beneficiar</th>
              <th>CIF</th>
              <th class="num">Sumă</th>
              <th>Status</th>
              <th>ALOP</th>
            </tr>
          </thead>
          <tbody>
            ${filtered.length === 0
              ? `<tr><td colspan="8" class="df-opme-lines__empty">Nicio linie de afișat.</td></tr>`
              : filtered.map(l => `
              <tr title="${esc(l.match_notes || '')}">
                <td>${esc(l.nr_op || '—')}</td>
                <td><code>${esc(l.cod_angajament || '—')}</code></td>
                <td>${esc(l.indicator_angajament || '—')}</td>
                <td>${esc(l.den_beneficiar || '—')}</td>
                <td>${esc(l.cif_beneficiar || '—')}</td>
                <td class="num">${esc(fmtRON(l.suma_op))}</td>
                <td>${statusBadge(l.match_status)}</td>
                <td>${l.matched_alop_id
                    ? `<a href="javascript:void(0)" data-alop-id="${esc(l.matched_alop_id)}" class="df-opme-lines__alop-link">${esc(l.alop_titlu || l.df_nr || l.matched_alop_id.slice(0,8))}</a>`
                    : '—'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>

      <div class="df-modal-footer">
        ${canRematch
          ? `<button type="button" class="df-action-btn" id="df-opme-btn-rematch">
              <svg class="df-ico"><use href="/icons.svg?v=3.9.475#ico-rotate-cw"/></svg>
              Re-rulează matching
            </button>
            <a href="/api/opme/imports/${encodeURIComponent(_state.importId)}/export.csv"
               class="df-action-btn" id="df-opme-btn-csv" download>
              <svg class="df-ico"><use href="/icons.svg?v=3.9.475#ico-download"/></svg>
              Export CSV
            </a>` : ''}
        <button type="button" class="df-action-btn primary" id="df-opme-btn-close">Închide</button>
      </div>
    `;

    body.querySelectorAll('.df-subtab').forEach(b => {
      b.addEventListener('click', () => { _state.filter = b.getAttribute('data-filter'); render(); });
    });
    body.querySelectorAll('.df-opme-lines__alop-link').forEach(a => {
      a.addEventListener('click', () => {
        const id = a.getAttribute('data-alop-id');
        close();
        if (typeof window.openAlop === 'function') window.openAlop(id);
      });
    });
    const rb = body.querySelector('#df-opme-btn-rematch');
    if (rb) rb.addEventListener('click', rematch);
    const cb = body.querySelector('#df-opme-btn-close');
    if (cb) cb.addEventListener('click', close);
  }

  async function load(importId) {
    try {
      const [r, canR] = await Promise.all([
        fetch(`/api/opme/imports/${encodeURIComponent(importId)}`, { credentials: 'include' }),
        _fetchCanOpme(),
      ]);
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${r.status}`);
      }
      _state.data = await r.json();
      _state.canRematch = canR;
      render();
    } catch (e) {
      const body = _rootEl.querySelector('#df-opme-drawer-body');
      body.innerHTML = `<div class="df-opme-drawer__error">Eroare: ${esc(e.message)}</div>`;
    }
  }

  async function rematch() {
    if (!_state.importId) return;
    const btn = _rootEl.querySelector('#df-opme-btn-rematch');
    if (btn) { btn.disabled = true; btn.textContent = 'Se re-rulează…'; }
    try {
      const r = await fetch(`/api/opme/imports/${encodeURIComponent(_state.importId)}/rematch`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-CSRF-Token': csrf() },
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      const rep = body.match_report;
      if (window.DFOpmeToast && window.DFOpmeToast.show) {
        window.DFOpmeToast.show(rep.summary_text || 'Matching re-rulat.', 'ok');
      }
      // Reîncarcă datele
      await load(_state.importId);
      if (typeof _state.onRematch === 'function') {
        try { _state.onRematch(rep); } catch(_){}
      }
    } catch (e) {
      if (window.DFOpmeToast && window.DFOpmeToast.show) {
        window.DFOpmeToast.show('Eroare la re-matching: ' + e.message, 'err');
      } else {
        alert('Eroare: ' + e.message);
      }
      if (btn) { btn.disabled = false; btn.textContent = 'Re-rulează matching'; }
    }
  }

  function open(opts) {
    ensureDOM();
    _state.importId = (opts && opts.importId) || null;
    _state.data = null;
    _state.filter = 'all';
    _state.onRematch = (opts && opts.onRematch) || null;
    _rootEl.classList.add('is-open');
    _rootEl.style.display = '';
    if (_state.importId) load(_state.importId);
    else _rootEl.querySelector('#df-opme-drawer-body').innerHTML =
      '<div class="df-opme-drawer__error">Lipsește importId.</div>';
  }

  function close() {
    if (!_rootEl) return;
    _rootEl.classList.remove('is-open');
    _rootEl.style.display = 'none';
    _state = { importId: null, data: null, filter: 'all', onRematch: null, canRematch: false };
  }

  window.DFOpmeReportDrawer = { open, close };
})();
