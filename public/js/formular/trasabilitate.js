// public/js/formular/trasabilitate.js (rewrite v3.9.450)
// DocFlowAI — Modul Trasabilitate: modal cu arbore DF↔ALOP↔ORD.
//
// REWRITE v3.9.450:
//   - Renunțat la inline onclick-uri în HTML generat dinamic (cauza bug
//     de escape din v3.9.448 — click-urile pe noduri nu navigau)
//   - Folosesc template literals (backticks) pentru tot HTML-ul
//   - Atașez UN SINGUR click listener pe modal — event delegation prin
//     data-trasab-type / data-trasab-id atribute
//
// Cross-module exports (window):
//   - openTrasabilitate(type, id), closeTrasabilitate()
//
// Dependențe:
//   - switchListTab(type), openDocFromList(type, id), openAlop(id)
//   - window.df.esc (cu fallback inline)

(function () {
  'use strict';
  const esc = (window.df && window.df.esc)
    ? window.df.esc
    : s => String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  const _state = {
    currentType: null,
    currentId: null,
    data: null,
    loading: false,
    error: null,
    delegationBound: false,
  };

  function _formatRO(n) {
    if (n === null || n === undefined || n === '') return '—';
    const num = Number(n);
    if (isNaN(num)) return '—';
    return num.toLocaleString('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function _formatDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleDateString('ro-RO', { day: '2-digit', month: '2-digit', year: 'numeric' });
    } catch { return iso; }
  }

  function _statusBadgeAlop(status) {
    const map = {
      'draft':       '<span class="trasab-status trasab-status-draft">📝 Draft</span>',
      'in_progress': '<span class="trasab-status trasab-status-progress">🔄 În curs</span>',
      'completed':   '<span class="trasab-status trasab-status-done">✓ Completat</span>',
      'cancelled':   '<span class="trasab-status trasab-status-cancel">🚫 Anulat</span>',
    };
    return map[status] || `<span class="trasab-status">${esc(status||'?')}</span>`;
  }

  // ── Modal control ───────────────────────────────────────────────────────────
  async function openTrasabilitate(type, id) {
    if (type !== 'df' && type !== 'ord') {
      console.warn('openTrasabilitate: type invalid', type);
      return;
    }
    _state.currentType = type;
    _state.currentId = id;
    _state.loading = true;
    _state.error = null;
    _state.data = null;

    const modal = document.getElementById('trasabilitate-modal');
    if (modal) modal.classList.add('is-open');
    document.body.style.overflow = 'hidden';

    _bindDelegation();
    _showLoading();

    try {
      const r = await fetch(`/api/trasabilitate/${type}/${encodeURIComponent(id)}`,
                            { credentials: 'include' });
      if (r.status === 401) { closeTrasabilitate(); location.href = '/'; return; }
      if (r.status === 404) { _showError('Document negăsit (poate a fost șters între timp).'); return; }
      if (!r.ok)            throw new Error('HTTP ' + r.status);
      const data = await r.json();
      _state.data = data;
      _render();
    } catch(e) {
      _showError('Eroare la încărcarea trasabilității: ' + (e.message || e));
    } finally {
      _state.loading = false;
    }
  }

  function closeTrasabilitate() {
    const modal = document.getElementById('trasabilitate-modal');
    if (modal) modal.classList.remove('is-open');
    document.body.style.overflow = '';
    _state.data = null;
  }

  // ── Render — loading / error ────────────────────────────────────────────────
  function _showLoading() {
    const loading = document.getElementById('trasabilitate-loading');
    const errEl   = document.getElementById('trasabilitate-error');
    const content = document.getElementById('trasabilitate-content');
    if (loading) loading.style.display = '';
    if (errEl)   errEl.style.display = 'none';
    if (content) content.style.display = 'none';
  }

  function _showError(msg) {
    const loading = document.getElementById('trasabilitate-loading');
    const errEl   = document.getElementById('trasabilitate-error');
    const content = document.getElementById('trasabilitate-content');
    if (loading) loading.style.display = 'none';
    if (errEl)   { errEl.textContent = '⚠ ' + msg; errEl.style.display = ''; }
    if (content) content.style.display = 'none';
  }

  // ── Render principal ────────────────────────────────────────────────────────
  function _render() {
    const data = _state.data;
    if (!data) return;

    const loading = document.getElementById('trasabilitate-loading');
    const errEl   = document.getElementById('trasabilitate-error');
    const content = document.getElementById('trasabilitate-content');
    if (loading) loading.style.display = 'none';
    if (errEl)   errEl.style.display = 'none';
    if (!content) return;
    content.style.display = '';

    let html = '';

    if (data.df_revizii && data.df_revizii.length) {
      html += _renderDFCard(data.df_revizii);
      if (data.alopuri && data.alopuri.length) html += _renderConnector();
    }

    if (data.alopuri && data.alopuri.length) {
      data.alopuri.forEach((alop, i) => {
        if (i > 0) html += _renderConnector();
        html += _renderAlopCard(alop);
      });
    } else if (data.df_revizii && data.df_revizii.length) {
      html += '<div class="trasab-empty">Nicio ALOP creată încă pentru acest DF.</div>';
    } else {
      html += '<div class="trasab-empty">Niciun document asociat găsit. Probabil ORD-ul nu are df_id setat (date legacy).</div>';
    }

    content.innerHTML = html;
  }

  // ── Render — card DF cu badges revizii ──────────────────────────────────────
  function _renderDFCard(revizii) {
    const last = revizii[revizii.length - 1];
    const titlu = last.titlu || '(fără subtitlu)';
    const valoare = last.valoare !== undefined && last.valoare !== null ? Number(last.valoare) : 0;
    const valoareLabel = valoare > 0
      ? `<div class="trasab-card-meta">Valoare angajament: <strong>${_formatRO(valoare)} lei</strong></div>`
      : '';

    const badgesHtml = revizii.map(rv => {
      const isRoot = rv.is_root_df || rv.is_root_df_link;
      const cls = isRoot ? 'trasab-rev-badge trasab-rev-badge-root' : 'trasab-rev-badge';
      const aprobIcon = rv.aprobat ? '✓' : '⏳';
      const valTxt = rv.valoare > 0 ? ` · ${_formatRO(rv.valoare)} lei` : '';
      const tooltip = (rv.titlu||'') + (rv.aprobat ? ' (aprobat)' : ' (în curs)') + valTxt;
      return `<button type="button" class="${cls}"
                data-trasab-type="df" data-trasab-id="${esc(rv.id)}"
                title="${esc(tooltip)}">R${rv.revizie_nr} ${aprobIcon}${isRoot ? ' <span class="trasab-here">●</span>' : ''}</button>`;
    }).join('');

    return `<div class="trasab-card trasab-card-df">
      <div class="trasab-card-icon">📄</div>
      <div class="trasab-card-body">
        <div class="trasab-card-kicker">DOCUMENT DE FUNDAMENTARE</div>
        <div class="trasab-card-title">${esc(last.nr_unic_inreg || '—')}</div>
        <div class="trasab-card-subtitle">${esc(titlu)}</div>
        ${valoareLabel}
        <div class="trasab-card-badges-row">
          <span class="trasab-card-badges-label">Revizii:</span> ${badgesHtml}
        </div>
      </div>
    </div>`;
  }

  // ── Render — connector SVG vertical ─────────────────────────────────────────
  function _renderConnector() {
    return `<div class="trasab-connector">
      <svg width="40" height="32" viewBox="0 0 40 32" xmlns="http://www.w3.org/2000/svg">
        <line x1="20" y1="0" x2="20" y2="32"
              stroke="rgba(124,58,237,0.4)" stroke-width="2" stroke-dasharray="4 3"/>
        <polygon points="16,24 24,24 20,32" fill="rgba(124,58,237,0.6)"/>
      </svg>
    </div>`;
  }

  // ── Render — card ALOP cu copii ─────────────────────────────────────────────
  function _renderAlopCard(alop) {
    const titlu = alop.titlu || '(fără titlu)';
    const valTotal = alop.valoare_totala !== null ? _formatRO(alop.valoare_totala) : '—';
    const platit   = alop.suma_totala_platita !== null ? _formatRO(alop.suma_totala_platita) : '0,00';

    const metaParts = [
      _statusBadgeAlop(alop.status),
      `Valoare: <strong>${valTotal} lei</strong>`,
      `Plătit: <strong>${platit} lei</strong>`,
    ];
    if (alop.ciclu_curent && alop.ciclu_curent > 1) {
      metaParts.push(`Ciclu curent: <strong>${alop.ciclu_curent}</strong>`);
    }

    let copiHtml = '';
    if (alop.cicluri_arhivate && alop.cicluri_arhivate.length) {
      alop.cicluri_arhivate.forEach(c => { copiHtml += _renderArchivedCicluCard(c); });
    }
    if (alop.ord_curent) {
      copiHtml += _renderCurrentOrdCard(alop.ord_curent, alop.ciclu_curent || 1);
    }
    if (!copiHtml) {
      copiHtml = '<div class="trasab-empty-inline">Niciun ORD generat încă (ALOP în stadiu Angajare).</div>';
    }

    return `<div class="trasab-card trasab-card-alop">
      <div class="trasab-card-header" data-trasab-type="alop" data-trasab-id="${esc(alop.id)}">
        <div class="trasab-card-icon">🏛</div>
        <div class="trasab-card-body">
          <div class="trasab-card-kicker">ALOP</div>
          <div class="trasab-card-title">${esc(titlu)}</div>
          <div class="trasab-card-meta">${metaParts.join(' · ')}</div>
        </div>
        <div class="trasab-card-arrow">▶</div>
      </div>
      <div class="trasab-card-children">${copiHtml}</div>
    </div>`;
  }

  // ── Render — card ORD curent ────────────────────────────────────────────────
  function _renderCurrentOrdCard(ord, cicluNr) {
    const nr = ord.nr_unic_inreg || '(fără număr)';
    const titlu = ord.titlu || '(beneficiar nedefinit)';
    const isRoot = !!ord.is_root_ord;
    const aprobLabel = ord.aprobat ? '✓ Aprobat'
                     : (ord.status === 'completed' ? '⏳ În așteptare semnături'
                     : '📝 Draft');

    const lichidat = ord.lichidare_confirmed_at
      ? `<div class="trasab-step trasab-step-done">✓ Lichidat ${_formatDate(ord.lichidare_confirmed_at)}${ord.lichidare_nr_factura ? ' · F-' + esc(ord.lichidare_nr_factura) : ''}${ord.lichidare_nr_pv ? ' · PV ' + esc(ord.lichidare_nr_pv) : ''}</div>`
      : '<div class="trasab-step trasab-step-pending">⏳ Lichidare în curs</div>';

    const platit = ord.plata_confirmed_at
      ? `<div class="trasab-step trasab-step-done">✓ Plătit ${_formatDate(ord.plata_confirmed_at)}${ord.plata_nr_ordin ? ' · OP-' + esc(ord.plata_nr_ordin) : ''}${ord.plata_suma_efectiva !== null ? ' · <strong>' + _formatRO(ord.plata_suma_efectiva) + ' lei</strong>' : ''}</div>`
      : '<div class="trasab-step trasab-step-pending">⏳ Plata în curs</div>';

    const cls = `trasab-card-ord trasab-card-ord-curent${isRoot ? ' trasab-card-root' : ''}`;

    return `<div class="${cls}" data-trasab-type="ord" data-trasab-id="${esc(ord.id)}">
      <div class="trasab-card-ord-header">
        <span class="trasab-card-ord-kicker">📦 Ciclu ${cicluNr} (curent)</span>
        ${isRoot ? '<span class="trasab-here-badge">● TU EȘTI AICI</span>' : ''}
      </div>
      <div class="trasab-card-ord-title">
        ORD: ${esc(nr)} <span class="trasab-card-ord-aprob">· ${aprobLabel}</span>
      </div>
      <div class="trasab-card-ord-subtitle">${esc(titlu)}</div>
      ${lichidat}
      ${platit}
    </div>`;
  }

  // ── Render — card ORD arhivat ───────────────────────────────────────────────
  function _renderArchivedCicluCard(ciclu) {
    const nr = ciclu.ord_nr_unic_inreg || '(fără număr)';
    const titlu = ciclu.ord_titlu || '(beneficiar nedefinit)';
    const isRoot = !!ciclu.is_root_ord;
    const aprobLabel = ciclu.ord_aprobat ? '✓ Aprobat' : '📝 ' + esc(ciclu.ord_status || '?');

    const lichidat = ciclu.lichidare_confirmed_at
      ? `<div class="trasab-step trasab-step-done">✓ Lichidat ${_formatDate(ciclu.lichidare_confirmed_at)}${ciclu.lichidare_nr_factura ? ' · F-' + esc(ciclu.lichidare_nr_factura) : ''}${ciclu.lichidare_nr_pv ? ' · PV ' + esc(ciclu.lichidare_nr_pv) : ''}</div>`
      : '';

    const platit = ciclu.plata_confirmed_at
      ? `<div class="trasab-step trasab-step-done">✓ Plătit ${_formatDate(ciclu.plata_confirmed_at)}${ciclu.plata_nr_ordin ? ' · OP-' + esc(ciclu.plata_nr_ordin) : ''}${ciclu.plata_suma_efectiva !== null ? ' · <strong>' + _formatRO(ciclu.plata_suma_efectiva) + ' lei</strong>' : ''}</div>`
      : '';

    const cls = `trasab-card-ord trasab-card-ord-archived${isRoot ? ' trasab-card-root' : ''}`;

    return `<div class="${cls}" data-trasab-type="ord" data-trasab-id="${esc(ciclu.ord_id)}">
      <div class="trasab-card-ord-header">
        <span class="trasab-card-ord-kicker">📦 Ciclu ${ciclu.ciclu_nr} (arhivat)</span>
        ${isRoot ? '<span class="trasab-here-badge">● TU EȘTI AICI</span>' : ''}
      </div>
      <div class="trasab-card-ord-title">
        ORD: ${esc(nr)} <span class="trasab-card-ord-aprob">· ${aprobLabel}</span>
      </div>
      <div class="trasab-card-ord-subtitle">${esc(titlu)}</div>
      ${lichidat}
      ${platit}
    </div>`;
  }

  // ── Click delegation pe modal — un SINGUR listener, idiom modern ────────────
  function _bindDelegation() {
    if (_state.delegationBound) return;
    const modal = document.getElementById('trasabilitate-modal');
    if (!modal) return;

    modal.addEventListener('click', e => {
      const node = e.target.closest('[data-trasab-type][data-trasab-id]');
      if (!node) return;
      if (!modal.contains(node)) return;

      const type = node.dataset.trasabType;
      const id   = node.dataset.trasabId;
      if (!type || !id) return;

      e.stopPropagation();
      _navigateToNode(type, id);
    });

    _state.delegationBound = true;
  }

  // ── Click pe nod: închide modal + deschide documentul ───────────────────────
  function _navigateToNode(type, id) {
    closeTrasabilitate();
    setTimeout(() => {
      try {
        if (type === 'alop') {
          if (typeof switchListTab === 'function') switchListTab('alop');
          if (typeof openAlop === 'function') openAlop(id);
        } else if (type === 'df' || type === 'ord') {
          if (typeof switchListTab === 'function') switchListTab(type);
          if (typeof openDocFromList === 'function') openDocFromList(type, id);
        }
      } catch(e) {
        console.error('trasab navigate error:', e);
      }
    }, 50);
  }

  // ── ESC pentru închidere ────────────────────────────────────────────────────
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const modal = document.getElementById('trasabilitate-modal');
      if (modal && modal.classList.contains('is-open')) closeTrasabilitate();
    }
  });

  // ── Click pe overlay pentru închidere ───────────────────────────────────────
  document.addEventListener('click', e => {
    const modal = document.getElementById('trasabilitate-modal');
    if (modal && e.target === modal) closeTrasabilitate();
  });

  // Public API
  window.openTrasabilitate  = openTrasabilitate;
  window.closeTrasabilitate = closeTrasabilitate;
})();
