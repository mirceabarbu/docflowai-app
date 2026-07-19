# DocFlowAI — 🩹 TRASABILITATE HOTFIX 2: data-attributes + event delegation (v3.9.450)

```
═══════════════════════════════════════════════════════════
⚠️  BRANCH: develop ONLY. NU FACE merge / push / checkout pe main.
═══════════════════════════════════════════════════════════
```

> Hotfix peste v3.9.449. Backend-ul e OK (200 răspuns, modal se deschide,
> arbore se randează). DAR: click pe noduri în arbore NU navighează.
>
> CAUZA: în v3.9.448 am construit HTML dinamic cu `onclick="_trasabOpenNode('df', 'uuid')"`
> folosind concatenare de string-uri JS cu escape `\'`. Combinația de
> string-builder JS + atribut HTML + JS interpretat din atribut a creat
> bug-uri subtile de escape (apostrofii nu mai ajung corect la browser).
>
> SOLUȚIA: rescriu toate render-functions cu **template literals (backticks)**
> + **`data-trasab-type` / `data-trasab-id` attributes** + un singur
> listener delegat pe modal-body. ZERO escape, idiom modern.

```
DocFlowAI v3.9.449 → v3.9.450 (SW v165 → v166)
Branch: develop  ⚠️ EXCLUSIV develop
Subiect: fix(trasabilitate): event delegation + data-attrs (elimin escape hell)

═══════════════════════════════════════════════════════════
PASUL 1 — Înlocuire INTEGRALĂ public/js/formular/trasabilitate.js
═══════════════════════════════════════════════════════════

STRATEGIE: viewuiește mai întâi fișierul ca să confirmi structura,
apoi folosește `create_file` cu path-ul exact și conținutul EXACT de mai jos.
(create_file overwrites if file exists.)

Conținut NOU pentru public/js/formular/trasabilitate.js:

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
    if (modal) modal.style.display = '';
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
    if (modal) modal.style.display = 'none';
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

    const badgesHtml = revizii.map(rv => {
      const isRoot = rv.is_root_df || rv.is_root_df_link;
      const cls = isRoot ? 'trasab-rev-badge trasab-rev-badge-root' : 'trasab-rev-badge';
      const aprobIcon = rv.aprobat ? '✓' : '⏳';
      const tooltip = (rv.titlu||'') + (rv.aprobat ? ' (aprobat)' : ' (în curs)');
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
      // Caută cel mai apropiat strămoș cu data-trasab-type și data-trasab-id
      const node = e.target.closest('[data-trasab-type][data-trasab-id]');
      if (!node) return;
      // Asigură-te că nodul e în interiorul modal-ului (nu în alt loc)
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
      if (modal && modal.style.display !== 'none') closeTrasabilitate();
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

═══════════════════════════════════════════════════════════
PASUL 2 — Adaugă cursor:pointer pe nodurile clickable (CSS, în formular.html)
═══════════════════════════════════════════════════════════

În blocul <style> din modal-ul Trasabilitate (din formular.html), adaugă
o regulă CSS care arată că orice element cu data-trasab-type e clickable:

old_str:
  /* Buton inline 🔗 lângă număr în lista DF/ORD */

new_str:
  /* Cursor pointer pe orice nod clickable din arbore (event delegation v3.9.450) */
  #trasabilitate-modal [data-trasab-type][data-trasab-id] { cursor: pointer; }

  /* Buton inline 🔗 lângă număr în lista DF/ORD */

═══════════════════════════════════════════════════════════
PASUL 3 — Cache busting (3.9.449 → 3.9.450, SW v165 → v166)
═══════════════════════════════════════════════════════════

3.1 — package.json:
  old_str:   "version": "3.9.449",
  new_str:   "version": "3.9.450",

3.2 — public/sw.js:
  old_str: const CACHE_VERSION = 'docflowai-v165';
  new_str: const CACHE_VERSION = 'docflowai-v166';

3.3 — Cache busting în HTML (CRITIC: trasabilitate.js?v= trebuie bumpat
       altfel browserul servește versiunea veche cu bug):

  for f in public/formular.html public/refnec-form.html \
           public/notafd-invest-form.html public/admin.html; do
    sed -i 's/v=3\.9\.448/v=3.9.450/g; s/v=3\.9\.449/v=3.9.450/g' "$f"
  done

  Verifică:
  for f in public/formular.html public/refnec-form.html \
           public/notafd-invest-form.html public/admin.html; do
    OLD=$(grep -oE "v=3\.9\.4[0-9]{2}" "$f" | grep -v "v=3.9.450" | wc -l)
    NEW=$(grep -c "v=3.9.450" "$f")
    echo "$f: 450=$NEW, alte_44X=$OLD"
    [ "$OLD" -eq 0 ] && echo "  ✓ OK" || echo "  ✗ FAIL"
  done

═══════════════════════════════════════════════════════════
VERIFICARE OBLIGATORIE
═══════════════════════════════════════════════════════════

1. Modul JS sintactic OK:
   node --check public/js/formular/trasabilitate.js

2. Inline onclick eliminat din module:
   grep -c "onclick=" public/js/formular/trasabilitate.js
   → 0 (nimic — toate click-urile vin prin data-attrs + delegation)

3. Data attributes prezente:
   grep -cE "data-trasab-type" public/js/formular/trasabilitate.js
   → ≥ 4 (DF badge + ALOP header + ORD curent + ORD arhivat)

4. Event delegation prezent:
   grep -c "_bindDelegation\|delegationBound" public/js/formular/trasabilitate.js
   → ≥ 3

5. Cursor pointer CSS:
   grep -c "data-trasab-type.*cursor:.*pointer" public/formular.html
   → 1

6. Cache bust trasabilitate.js:
   grep "trasabilitate.js?v=" public/formular.html
   → trebuie să arate v=3.9.450 (NU 448 sau 449)

7. npm run check + npm test verde, fără regresii.

═══════════════════════════════════════════════════════════
COMMIT pe develop  ⚠️ NU MAIN!
═══════════════════════════════════════════════════════════
git add public/js/formular/trasabilitate.js \
        public/formular.html \
        public/refnec-form.html \
        public/notafd-invest-form.html \
        public/admin.html \
        public/sw.js \
        package.json

git commit -m "fix(trasabilitate): event delegation + data-attrs (v3.9.450)

Bug runtime descoperit pe staging:
  - API răspunde 200 corect (după v3.9.449 fix cancelled_reason)
  - Modal se deschide cu arborele complet randat
  - DAR: click pe noduri (DF revizii, ALOP card, ORD cards) NU navighează

CAUZA: în v3.9.448 am construit HTML dinamic cu inline onclick:
  '<div onclick=\"_trasabOpenNode(\\\\'df\\\\', \\\\'\${id}\\\\'\)\">'
Combinația de string-builder JS + atribut HTML + escape \\\\' a stricat
parsing-ul onclick-urilor în browser.

SOLUȚIA: rescriu trasabilitate.js cu pattern modern de event delegation:
  - Renunțat complet la inline onclick (0 ocurențe în modul)
  - Folosesc data-trasab-type + data-trasab-id pe fiecare nod clickable
  - UN SINGUR click listener pe modal, atașat la primul openTrasabilitate
    (idempotent prin flag _state.delegationBound)
  - Folosesc template literals (backticks) — fără escape hell
  - Click delegation: e.target.closest('[data-trasab-type][data-trasab-id]')

Beneficii adiționale:
  - Mai performant (un singur listener vs N onclick-uri)
  - Mai testabil (logica de click izolată)
  - Mai ușor de debug (un singur loc unde se procesează evenimentul)

CSS update: adăugat cursor:pointer pe orice nod cu data-trasab-type.

Cache bust necesar: trasabilitate.js?v=3.9.448 → v=3.9.450 (browserul
trebuie să descarce noua versiune; cache-ul vechi serveșe versiunea cu bug)."

git push origin develop  # ⚠️ NU origin main

═══════════════════════════════════════════════════════════
TEST POST-DEPLOY (staging) — 5 click-uri esențiale
═══════════════════════════════════════════════════════════

1. Hard refresh /formular.html (Ctrl+Shift+R) — IMPORTANT pentru a forța
   browser-ul să descarce noul trasabilitate.js?v=3.9.450.

2. Tab DF → click 🔗 inline pe un DF aprobat → modal cu arbore.

3. CLICK PE BADGE REVIZIE (R0, R1...) → modal se închide, formular DF
   pentru revizia respectivă se deschide ✓

4. Re-deschide Trasabilitate → CLICK PE ALOP HEADER → modal închis,
   tab ALOP, panel detaliu ALOP deschis ✓

5. Re-deschide → CLICK PE CARD ORD CURENT → modal închis, tab ORD,
   formular ORD deschis ✓

6. Re-deschide → CLICK PE CICLU ARHIVAT → modal închis, tab ORD,
   formular ORD-ul arhivat deschis ✓

7. ESC funcționează în continuare; click pe overlay funcționează.

8. Console DevTools: ZERO erori la click. Doar log-uri normale de fetch.

STOP dacă:
- Click NU navighează → verifică în Console: tipi
  `document.getElementById('trasabilitate-modal').onclick`
  Ar trebui să fie null (delegation, nu inline). Dacă click pe nod nu
  triggers nimic, verifică:
  `document.querySelectorAll('[data-trasab-type]').length`
  → trebuie să returneze >0 după ce arbore e randat.
- 'switchListTab is not defined' → ordinea defer scripturi greșită;
  list.js trebuie să fie ÎNAINTEA trasabilitate.js (DOCSCRIPT preserve).
- Cache servește vechi → forțează Ctrl+Shift+R sau verifică
  Network → Disable cache.
```
