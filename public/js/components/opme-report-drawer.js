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
  let _state = { importId: null, data: null, filter: 'all', onRematch: null, canRematch: false, canAccept: false };

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
    // #209: dreptul de a accepta o potrivire vine EXCLUSIV de la server (`can_accept`).
    const canAccept = _state.canAccept === true;
    const ACCEPTABLE = { unmatched: 1, partial: 1, ambiguous: 1 };

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
              ${canAccept ? '<th></th>' : ''}
            </tr>
          </thead>
          <tbody>
            ${filtered.length === 0
              ? `<tr><td colspan="${canAccept ? 9 : 8}" class="df-opme-lines__empty">Nicio linie de afișat.</td></tr>`
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
                ${canAccept ? `<td>${(ACCEPTABLE[l.match_status] && !l.matched_ciclu_id)
                    ? `<button type="button" class="df-action-btn sm df-opme-accept-btn" data-line-id="${esc(l.id)}" title="Acceptă potrivirea (responsabil CAB)">Acceptă potrivirea</button>`
                    : ''}</td>` : ''}
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
    body.querySelectorAll('.df-opme-accept-btn').forEach(b => {
      b.addEventListener('click', () => {
        const id = b.getAttribute('data-line-id');
        const line = (lines || []).find(x => String(x.id) === String(id));
        if (line) openAcceptDialog(line);
      });
    });
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
      _state.canAccept = _state.data && _state.data.can_accept === true;
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
      // Rezultat parțial: grupuri picate → toast galben + lista motivelor.
      const errCount = rep && (rep.error_count || (rep.errors && rep.errors.length)) || 0;
      if (window.DFOpmeToast && window.DFOpmeToast.show) {
        const msg = errCount
          ? `${rep.summary_text || 'Matching re-rulat.'} — ${errCount} grup(uri) cu eroare (linii rămase în așteptare).`
          : (rep.summary_text || 'Matching re-rulat.');
        window.DFOpmeToast.show(msg, errCount ? 'warn' : 'ok');
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

  // ── #209 — dialog „Acceptă potrivirea" (responsabil CAB) ───────────────────
  let _acceptEl = null;
  function ensureAcceptDOM() {
    if (_acceptEl) return;
    const w = document.createElement('div');
    w.className = 'df-modal-bg';
    w.id = 'df-opme-accept-modal';
    w.innerHTML = `
      <div class="df-modal" style="max-width:560px" role="dialog" aria-modal="true" aria-labelledby="df-opme-accept-title">
        <h3 id="df-opme-accept-title">Acceptă potrivirea OP-ului</h3>
        <div id="df-opme-accept-line" style="font-size:.82rem;color:var(--df-text-2);margin-bottom:12px"></div>
        <div class="df-frow">
          <label for="df-opme-accept-alop">Dosar ALOP</label>
          <select id="df-opme-accept-alop"></select>
        </div>
        <div class="df-frow">
          <label for="df-opme-accept-motiv">Motiv (obligatoriu, minim 10 caractere)</label>
          <textarea id="df-opme-accept-motiv" rows="3" placeholder="Ex: verificat extrasul de cont — IBAN secundar al aceluiași furnizor"></textarea>
        </div>
        <div style="font-size:.78rem;color:#f59e0b;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.25);border-radius:8px;padding:8px 10px;margin-top:6px">
          ⚠️ Acceptarea confirmă că plata a fost verificată în extrasul de cont. Linia devine potrivire manuală,
          iar dosarul se confirmă automat dacă suma tuturor OP-urilor legate acoperă valoarea ordonanțării.
        </div>
        <div id="df-opme-accept-err" style="display:none;font-size:.8rem;color:#ef4444;margin-top:8px"></div>
        <div class="df-modal-acts">
          <button type="button" class="df-action-btn" id="df-opme-accept-cancel">Renunță</button>
          <button type="button" class="df-action-btn primary" id="df-opme-accept-ok">Acceptă potrivirea</button>
        </div>
      </div>`;
    document.body.appendChild(w);
    _acceptEl = w;
    w.addEventListener('click', e => { if (e.target === w) closeAcceptDialog(); });
    w.querySelector('#df-opme-accept-cancel').addEventListener('click', closeAcceptDialog);
  }
  function closeAcceptDialog() {
    if (_acceptEl) _acceptEl.classList.remove('open');
  }
  async function openAcceptDialog(line) {
    ensureAcceptDOM();
    const el = _acceptEl;
    el.querySelector('#df-opme-accept-line').innerHTML =
      `<strong>OP ${esc(line.nr_op || '—')}</strong> · ${esc(fmtRON(line.suma_op))} · ${esc(line.den_beneficiar || '')} (CIF ${esc(line.cif_beneficiar || '—')})`
      + (line.match_notes ? `<div style="font-size:.74rem;color:var(--df-text-3);margin-top:4px">Motivul respingerii automate: ${esc(line.match_notes)}</div>` : '');
    const sel = el.querySelector('#df-opme-accept-alop');
    sel.innerHTML = '<option value="">Se încarcă dosarele…</option>';
    el.querySelector('#df-opme-accept-motiv').value = '';
    const err = el.querySelector('#df-opme-accept-err');
    err.style.display = 'none'; err.textContent = '';
    el.classList.add('open');

    // Dosarele în faza de plată (+ cel deja legat, DOAR dacă e în plată sau confirmat în ciclul
    // curent — calea de corectare #209). #213: înainte se oferea indiferent de fază, iar o plată
    // dintr-un ciclu închis ajungea pe ciclul curent (incident RATBV). Aceeași regulă ca poarta
    // rutei (opme.mjs, pasul 3c); serverul rămâne poarta.
    const opts = [];
    const seen = new Set();
    const preLegat = !!line.matched_alop_id && !line.matched_ciclu_id
      && ['plata', 'completed'].includes(line.alop_status);
    if (preLegat) {
      opts.push({ id: line.matched_alop_id, label: `${line.alop_titlu || line.df_nr || line.matched_alop_id.slice(0, 8)} (legat de matcher)` });
      seen.add(line.matched_alop_id);
    }
    try {
      const r = await fetch('/api/alop?status=plata&limit=100', { credentials: 'include' });
      if (r.ok) {
        const j = await r.json();
        for (const a of (j.alop || [])) {
          if (seen.has(a.id)) continue;
          seen.add(a.id);
          opts.push({ id: a.id, label: `${a.titlu || a.df_nr || a.id.slice(0, 8)}${a.df_nr ? ' · DF ' + a.df_nr : ''}` });
        }
      }
    } catch (_) { /* lista rămâne cu dosarul pre-legat, dacă există */ }
    sel.innerHTML = '<option value="">— alege dosarul —</option>'
      + opts.map(o => `<option value="${esc(o.id)}">${esc(o.label)}</option>`).join('');
    if (preLegat) sel.value = line.matched_alop_id;

    const ok = el.querySelector('#df-opme-accept-ok');
    ok.onclick = async () => {
      const alopId = sel.value;
      const motiv = el.querySelector('#df-opme-accept-motiv').value.trim();
      if (!alopId) { err.textContent = 'Selectați dosarul ALOP.'; err.style.display = ''; return; }
      if (motiv.length < 10) { err.textContent = 'Motivul e obligatoriu (minim 10 caractere).'; err.style.display = ''; return; }
      ok.disabled = true;
      try {
        const r = await fetch(`/api/opme/lines/${encodeURIComponent(line.id)}/accept`, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
          body: JSON.stringify({ alopId, motiv }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.message || j.error || `HTTP ${r.status}`);
        closeAcceptDialog();
        const toast = (m, k) => (window.DFOpmeToast && window.DFOpmeToast.show) ? window.DFOpmeToast.show(m, k) : alert(m);
        const d = j.details || {};
        const f = v => fmtRON(v);
        if (j.result === 'matched') {
          toast(`Dosar închis: plata confirmată automat cu ${f(d.actual)} (${d.line_count} OP-uri).`, 'ok');
        } else if (j.result === 'partial') {
          toast(`Linia a fost acceptată. Dosarul rămâne PARȚIAL: ${f(d.actual)} din ${f(d.expected)}.`, 'warn');
        } else if (j.result === 'overpay') {
          toast(`Linia a fost acceptată, dar suma OP-urilor (${f(d.actual)}) depășește ordonanțarea (${f(d.expected)}). Verificați liniile legate.`, 'warn');
        } else if (j.result === 'already_confirmed') {
          toast('Linia a fost acceptată, dar dosarul are DEJA o plată confirmată — reluați confirmarea plății din ecranul dosarului („Reia confirmarea plății"), apoi matcher-ul va reagrega OP-urile.', 'warn');
          if (typeof window.openAlop === 'function' && confirm('Deschideți dosarul acum pentru a relua confirmarea plății?')) {
            close(); window.openAlop(alopId); return;
          }
        } else {
          toast(`Linia a fost acceptată (${j.result}).`, 'ok');
        }
        await load(_state.importId);
        if (typeof _state.onRematch === 'function') { try { _state.onRematch(null); } catch (_) {} }
      } catch (e) {
        err.textContent = 'Eroare: ' + e.message; err.style.display = '';
      } finally { ok.disabled = false; }
    };
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
    _state = { importId: null, data: null, filter: 'all', onRematch: null, canRematch: false, canAccept: false };
  }

  window.DFOpmeReportDrawer = { open, close };
})();
