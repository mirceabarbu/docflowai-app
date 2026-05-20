# DocFlowAI — 🏛️ CLASA 8 (PASUL 2: Frontend UI + Export XLSX) v3.9.444

> **PASUL 2 din 2** — UI sub-tab nou între ORD și Verificare furnizor.
> **Pre-requisite:** PASUL 1 (v3.9.443) deployat și verificat pe staging cu cele 7 curl-uri.
> NU rula acest prompt dacă endpoint-ul `/api/clasa8` nu răspunde corect pe staging.

```
DocFlowAI v3.9.443 → v3.9.444 (SW v159 → v160)
Branch: develop
Subiect: feat(clasa8): UI sub-tab Clasa 8 + export XLSX (PASUL 2 din 2)

═══════════════════════════════════════════════════════════
CONTEXT
═══════════════════════════════════════════════════════════

Endpoint-ul GET /api/clasa8 e gata din v3.9.443. Acum adăugăm UI:
  - Sub-tab nou "🏛️ Clasa 8" între ORD și Verificare furnizor
  - Secțiunea #clasa8-section cu filter bar + tabel + footer TOTAL
  - Live search pe Cod SSI debounced 350ms (fără buton submit)
  - Export XLSX prin SheetJS lazy-loaded de pe cdnjs (la primul click)
  - Modul JS nou: public/js/formular/clasa8.js (pattern IIFE, defer)

DECIZII UX (luate împreună):
  - Live search 350ms debounce (fără buton "Filtrează" explicit)
  - Export XLSX cu SheetJS 0.18.5 lazy-loaded de pe cdnjs (NU adăugăm dependency npm)
  - Coloana "Rămâne din angajamente" (= angajamente − plăți) afișată la dreapta
  - Empty state cu mesaj prietenos
  - Footer TOTAL cu sume pe coloane numerice

ICON ales pentru sub-tab: ico-landmark (semantic pentru "instituție publică /
clasa contabilă"). Icoanele deja folosite: clipboard, edit-pencil, bar-chart,
file-text, shield. Landmark e liber și fits perfectly tematica.

═══════════════════════════════════════════════════════════
ZONĂ NO-TOUCH
═══════════════════════════════════════════════════════════
- server/signing/providers/STSCloudProvider.mjs
- server/routes/flows/cloud-signing.mjs
- server/routes/flows/bulk-signing.mjs
- server/signing/pades.mjs
- server/signing/java-pades-client.mjs
- server/middleware/auth.mjs (dual-mode, NU strica fix-ul din v3.9.442)
- server/services/clasa8.mjs și server/routes/clasa8.mjs (din PASUL 1, NU modifica)
- TOATE fișierele de signing și PAdES

═══════════════════════════════════════════════════════════
PASUL 2.1 — Modul JS nou: public/js/formular/clasa8.js (FIȘIER NOU)
═══════════════════════════════════════════════════════════

Creează public/js/formular/clasa8.js cu următorul conținut EXACT:

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

═══════════════════════════════════════════════════════════
PASUL 2.2 — formular.html: buton sub-tab + secțiune + script tag
═══════════════════════════════════════════════════════════

2.2.1 — Adaugă butonul Clasa 8 în bara de sub-tab-uri (între ORD și Verify):

old_str:
  <button class="df-subtab"        id="ltab-ord"    onclick="switchListTab('ord')"><svg class="df-ico"><use href="/icons.svg?v=3.9.442#ico-file-text"/></svg> Ordonanțare de Plată</button>
  <button class="df-subtab"        id="ltab-verify" onclick="switchListTab('verify')"><svg class="df-ico"><use href="/icons.svg?v=3.9.442#ico-shield"/></svg> Verificare furnizor</button>

new_str:
  <button class="df-subtab"        id="ltab-ord"    onclick="switchListTab('ord')"><svg class="df-ico"><use href="/icons.svg?v=3.9.444#ico-file-text"/></svg> Ordonanțare de Plată</button>
  <button class="df-subtab"        id="ltab-clasa8" onclick="switchListTab('clasa8')"><svg class="df-ico"><use href="/icons.svg?v=3.9.444#ico-landmark"/></svg> Clasa 8</button>
  <button class="df-subtab"        id="ltab-verify" onclick="switchListTab('verify')"><svg class="df-ico"><use href="/icons.svg?v=3.9.444#ico-shield"/></svg> Verificare furnizor</button>

NOTĂ: Verifică cu grep numărul actual de versiune în formular.html înainte
să rulezi str_replace — dacă găsești v=3.9.443 în loc de v=3.9.442 (caz în
care PASUL 1 a bumpat și HTML-urile, contrar planului), adaptează old_str
corespunzător. Comandă verificare:
  grep -n 'ltab-ord\|ltab-verify' public/formular.html | head -3

2.2.2 — Adaugă secțiunea #clasa8-section ÎNAINTE de #verify-section.

Locația: înainte de linia care conține `<div id="verify-section"`.

old_str:
<div id="verify-section" style="display:none;">

new_str:
<div id="clasa8-section" style="display:none;">

  <div class="df-info-banner" style="margin-bottom:18px;">
    🏛️ <strong>Centralizator Clasa 8</strong> — agregare per <strong>Cod SSI</strong> a angajamentelor bugetare (din DF Sec.B finalizate),
    ordonanțărilor (din ORD finalizate) și plăților (din ALOP cicluri finalizate, alocate proporțional pe rând).
    Coloana <em>BUGET</em> e rezervată pentru import din fișier extern (funcționalitate Phase 2).
  </div>

  <!-- ── Filter bar ────────────────────────────────────────────────────────── -->
  <div style="display:flex;gap:12px;align-items:center;margin-bottom:14px;flex-wrap:wrap;">
    <div style="flex:1;min-width:260px;max-width:420px;">
      <label style="font-size:.77rem;color:var(--df-text-3);display:block;margin-bottom:4px;">
        🔎 Filtrare după Cod SSI (live, debounce 350 ms)
      </label>
      <input id="clasa8-filter-ssi" type="text" autocomplete="off"
             placeholder="ex: 01A510 sau 020001..."
             style="width:100%;padding:9px 12px;background:rgba(255,255,255,.06);border:1px solid var(--df-border-2);border-radius:8px;color:var(--df-text);font-size:.9rem;box-sizing:border-box;font-family:monospace;">
    </div>
    <button id="clasa8-btn-reset" type="button" class="df-action-btn sm" title="Curăță toate filtrele">
      <svg class="df-ic"><use href="/icons.svg?v=3.9.444#ico-refresh"/></svg> Reset
    </button>
    <span id="clasa8-counter" style="margin-left:auto;font-size:.83rem;color:var(--df-text-3);">— înregistrări</span>
    <button id="clasa8-btn-export" type="button" class="df-action-btn primary">
      <svg class="df-ico"><use href="/icons.svg?v=3.9.444#ico-download"/></svg> Export Excel
    </button>
  </div>

  <!-- ── Mesaj eroare ─────────────────────────────────────────────────────── -->
  <div id="clasa8-error" style="display:none;background:rgba(239,68,68,.12);color:#fca5a5;border:1px solid rgba(239,68,68,.3);border-radius:8px;padding:10px 14px;font-size:.9rem;margin-bottom:12px;"></div>

  <!-- ── Empty state ──────────────────────────────────────────────────────── -->
  <div id="clasa8-empty" style="display:none;padding:32px 20px;text-align:center;background:var(--df-surface);border:1px dashed var(--df-border-2);border-radius:12px;">
    <div style="font-size:2.4rem;margin-bottom:10px;">🪺</div>
    <div style="font-weight:700;color:var(--df-text-2);margin-bottom:6px;">Niciun cod SSI găsit</div>
    <div style="color:var(--df-text-3);font-size:.88rem;line-height:1.6;">
      Posibile cauze: nu există DF cu Sec.B completată și status finalizat,
      ORD-uri finalizate, sau plăți confirmate.<br>
      Verifică tab-urile <strong>DF</strong>, <strong>ORD</strong> și <strong>ALOP</strong> pentru documente cu status <em>Finalizat</em>.
    </div>
  </div>

  <!-- ── Tabel centralizator ──────────────────────────────────────────────── -->
  <div style="overflow-x:auto;background:var(--df-surface);border:1px solid var(--df-border-2);border-radius:12px;">
    <table id="clasa8-table" style="width:100%;border-collapse:collapse;font-size:.88rem;">
      <thead>
        <tr style="background:rgba(255,255,255,.04);border-bottom:2px solid var(--df-border-2);">
          <th style="text-align:left;padding:12px 14px;font-weight:700;color:var(--df-text-2);min-width:140px;">Cod SSI<br><span style="font-weight:400;font-size:.74rem;color:var(--df-text-5);">(din DF/ORD)</span></th>
          <th style="text-align:right;padding:12px 14px;font-weight:700;color:var(--df-text-2);">BUGET<br><span style="font-weight:400;font-size:.74rem;color:var(--df-text-5);">(din fișier importat)</span></th>
          <th style="text-align:right;padding:12px 14px;font-weight:700;color:var(--df-text-2);">Angajamente bugetare<br><span style="font-weight:400;font-size:.74rem;color:var(--df-text-5);">(number #.###,##)</span></th>
          <th style="text-align:right;padding:12px 14px;font-weight:700;color:var(--df-text-2);">Ordonanțări<br><span style="font-weight:400;font-size:.74rem;color:var(--df-text-5);">(number #.###,##)</span></th>
          <th style="text-align:right;padding:12px 14px;font-weight:700;color:var(--df-text-2);">Plăți<br><span style="font-weight:400;font-size:.74rem;color:var(--df-text-5);">(number #.###,##)</span></th>
          <th style="text-align:right;padding:12px 14px;font-weight:700;color:var(--df-text-2);">Rămâne din<br>angajamente</th>
        </tr>
      </thead>
      <tbody id="clasa8-tbody"></tbody>
      <tfoot id="clasa8-tfoot" style="display:none;"></tfoot>
    </table>
  </div>

  <style>
    #clasa8-table .clasa8-num { text-align:right; padding:10px 14px; font-variant-numeric: tabular-nums; font-family: 'SF Mono', Menlo, Consolas, monospace; }
    #clasa8-table tbody tr { border-top:1px solid var(--df-border-2); }
    #clasa8-table tbody tr:hover { background: rgba(124,58,237,.06); }
    #clasa8-table tbody td { padding:10px 14px; }
    #clasa8-table .clasa8-total-row { background: rgba(124,58,237,.10); border-top:2px solid var(--df-border-2); }
    #clasa8-table .clasa8-total-row td { padding:12px 14px; }
  </style>

</div><!-- /clasa8-section -->

<div id="verify-section" style="display:none;">

2.2.3 — Adaugă referința la modulul JS în lista de scripturi:

old_str:
<script src="/js/formular/list.js?v=3.9.442" defer></script>

new_str:
<script src="/js/formular/clasa8.js?v=3.9.444" defer></script>
<script src="/js/formular/list.js?v=3.9.442" defer></script>

NOTĂ: Aceeași observație ca la 2.2.1 — verifică versiunea curentă cu
  grep -n "list.js\?v=" public/formular.html
înainte de str_replace. Adaptează old_str dacă e v=3.9.443 sau alta.

═══════════════════════════════════════════════════════════
PASUL 2.3 — list.js: extinde switchListTab pentru 'clasa8'
═══════════════════════════════════════════════════════════

În public/js/formular/list.js, înlocuiește FUNCȚIA INTREAGĂ switchListTab.

old_str:
function switchListTab(type){
  _lstState.type=type;_lstState.page=1;
  // Curăță contextul ALOP la navigare manuală din/spre alt tab decât DF/ORD
  if(type!=='df'&&type!=='ord'){window._alopContext=null;sessionStorage.removeItem('_alopContext');}
  document.getElementById('ltab-df').classList.toggle('active',type==='df');
  document.getElementById('ltab-ord').classList.toggle('active',type==='ord');
  document.getElementById('ltab-alop').classList.toggle('active',type==='alop');
  const ltabV=document.getElementById('ltab-verify');
  if(ltabV)ltabV.classList.toggle('active',type==='verify');
  const ltabRfn=document.getElementById('ltab-rfn');
  if(ltabRfn)ltabRfn.classList.toggle('active',type==='rfn');
  const ltabNfi=document.getElementById('ltab-nfi');
  if(ltabNfi)ltabNfi.classList.toggle('active',type==='nfi');
  // Bannere informative pentru DF/ORD
  const bannerDf=document.getElementById('lst-banner-df');
  const bannerOrd=document.getElementById('lst-banner-ord');
  if(bannerDf)bannerDf.style.display=type==='df'?'':'none';
  if(bannerOrd)bannerOrd.style.display=type==='ord'?'':'none';
  // Secțiuni ALOP / Verify / Formulare Oficiale
  const lstWrap=document.querySelector('#section-list .lst-wrap');
  const alopSection=document.getElementById('alop-section');
  const verifySection=document.getElementById('verify-section');
  const rfnSection=document.getElementById('rfn-section');
  const nfiSection=document.getElementById('nfi-section');
  if(type==='alop'){
    if(lstWrap)lstWrap.style.display='none';
    if(alopSection)alopSection.style.display='';
    if(verifySection)verifySection.style.display='none';
    if(rfnSection)rfnSection.style.display='none';
    if(nfiSection)nfiSection.style.display='none';
    const _foL=document.getElementById('foList');if(_foL)_foL.style.display='none';
    loadAlop();loadAlopStats();
    // Re-fetch detaliu dacă era deschis — statusul poate fi schimbat după semnare
    const _detailP=document.getElementById('alop-detail-panel');
    if(_detailP&&_detailP.style.display!=='none'&&window._currentAlopId){
      openAlop(window._currentAlopId);
    }
  }else if(type==='verify'){
    if(lstWrap)lstWrap.style.display='none';
    if(alopSection)alopSection.style.display='none';
    if(verifySection)verifySection.style.display='';
    if(rfnSection)rfnSection.style.display='none';
    if(nfiSection)nfiSection.style.display='none';
    const _foL=document.getElementById('foList');if(_foL)_foL.style.display='none';
  }else if(type==='rfn'){
    if(lstWrap)lstWrap.style.display='none';
    if(alopSection)alopSection.style.display='none';
    if(verifySection)verifySection.style.display='none';
    if(rfnSection)rfnSection.style.display='';
    if(nfiSection)nfiSection.style.display='none';
    const _foL=document.getElementById('foList');if(_foL)_foL.style.display='none';
  }else if(type==='nfi'){
    if(lstWrap)lstWrap.style.display='none';
    if(alopSection)alopSection.style.display='none';
    if(verifySection)verifySection.style.display='none';
    if(rfnSection)rfnSection.style.display='none';
    if(nfiSection)nfiSection.style.display='';
    const _foL=document.getElementById('foList');if(_foL)_foL.style.display='none';
  }else{
    if(lstWrap)lstWrap.style.display='';
    if(alopSection)alopSection.style.display='none';
    if(verifySection)verifySection.style.display='none';
    if(rfnSection)rfnSection.style.display='none';
    if(nfiSection)nfiSection.style.display='none';
    const _foL=document.getElementById('foList');if(_foL)_foL.style.display='none';
    loadList();
  }
}

new_str:
function switchListTab(type){
  _lstState.type=type;_lstState.page=1;
  // Curăță contextul ALOP la navigare manuală din/spre alt tab decât DF/ORD
  if(type!=='df'&&type!=='ord'){window._alopContext=null;sessionStorage.removeItem('_alopContext');}
  document.getElementById('ltab-df').classList.toggle('active',type==='df');
  document.getElementById('ltab-ord').classList.toggle('active',type==='ord');
  document.getElementById('ltab-alop').classList.toggle('active',type==='alop');
  const ltabV=document.getElementById('ltab-verify');
  if(ltabV)ltabV.classList.toggle('active',type==='verify');
  const ltabRfn=document.getElementById('ltab-rfn');
  if(ltabRfn)ltabRfn.classList.toggle('active',type==='rfn');
  const ltabNfi=document.getElementById('ltab-nfi');
  if(ltabNfi)ltabNfi.classList.toggle('active',type==='nfi');
  const ltabClasa8=document.getElementById('ltab-clasa8');
  if(ltabClasa8)ltabClasa8.classList.toggle('active',type==='clasa8');
  // Bannere informative pentru DF/ORD
  const bannerDf=document.getElementById('lst-banner-df');
  const bannerOrd=document.getElementById('lst-banner-ord');
  if(bannerDf)bannerDf.style.display=type==='df'?'':'none';
  if(bannerOrd)bannerOrd.style.display=type==='ord'?'':'none';
  // Secțiuni ALOP / Verify / Clasa 8 / Formulare Oficiale
  const lstWrap=document.querySelector('#section-list .lst-wrap');
  const alopSection=document.getElementById('alop-section');
  const verifySection=document.getElementById('verify-section');
  const rfnSection=document.getElementById('rfn-section');
  const nfiSection=document.getElementById('nfi-section');
  const clasa8Section=document.getElementById('clasa8-section');
  if(type==='alop'){
    if(lstWrap)lstWrap.style.display='none';
    if(alopSection)alopSection.style.display='';
    if(verifySection)verifySection.style.display='none';
    if(rfnSection)rfnSection.style.display='none';
    if(nfiSection)nfiSection.style.display='none';
    if(clasa8Section)clasa8Section.style.display='none';
    const _foL=document.getElementById('foList');if(_foL)_foL.style.display='none';
    loadAlop();loadAlopStats();
    // Re-fetch detaliu dacă era deschis — statusul poate fi schimbat după semnare
    const _detailP=document.getElementById('alop-detail-panel');
    if(_detailP&&_detailP.style.display!=='none'&&window._currentAlopId){
      openAlop(window._currentAlopId);
    }
  }else if(type==='verify'){
    if(lstWrap)lstWrap.style.display='none';
    if(alopSection)alopSection.style.display='none';
    if(verifySection)verifySection.style.display='';
    if(rfnSection)rfnSection.style.display='none';
    if(nfiSection)nfiSection.style.display='none';
    if(clasa8Section)clasa8Section.style.display='none';
    const _foL=document.getElementById('foList');if(_foL)_foL.style.display='none';
  }else if(type==='clasa8'){
    if(lstWrap)lstWrap.style.display='none';
    if(alopSection)alopSection.style.display='none';
    if(verifySection)verifySection.style.display='none';
    if(rfnSection)rfnSection.style.display='none';
    if(nfiSection)nfiSection.style.display='none';
    if(clasa8Section)clasa8Section.style.display='';
    const _foL=document.getElementById('foList');if(_foL)_foL.style.display='none';
    if(typeof openClasa8==='function')openClasa8();
  }else if(type==='rfn'){
    if(lstWrap)lstWrap.style.display='none';
    if(alopSection)alopSection.style.display='none';
    if(verifySection)verifySection.style.display='none';
    if(rfnSection)rfnSection.style.display='';
    if(nfiSection)nfiSection.style.display='none';
    if(clasa8Section)clasa8Section.style.display='none';
    const _foL=document.getElementById('foList');if(_foL)_foL.style.display='none';
  }else if(type==='nfi'){
    if(lstWrap)lstWrap.style.display='none';
    if(alopSection)alopSection.style.display='none';
    if(verifySection)verifySection.style.display='none';
    if(rfnSection)rfnSection.style.display='none';
    if(nfiSection)nfiSection.style.display='';
    if(clasa8Section)clasa8Section.style.display='none';
    const _foL=document.getElementById('foList');if(_foL)_foL.style.display='none';
  }else{
    if(lstWrap)lstWrap.style.display='';
    if(alopSection)alopSection.style.display='none';
    if(verifySection)verifySection.style.display='none';
    if(rfnSection)rfnSection.style.display='none';
    if(nfiSection)nfiSection.style.display='none';
    if(clasa8Section)clasa8Section.style.display='none';
    const _foL=document.getElementById('foList');if(_foL)_foL.style.display='none';
    loadList();
  }
}

═══════════════════════════════════════════════════════════
PASUL 2.4 — Cache busting (3.9.443 → 3.9.444, SW v159 → v160, HTML 3.9.442 → 3.9.444)
═══════════════════════════════════════════════════════════

4.1 — package.json:
  old_str:   "version": "3.9.443",
  new_str:   "version": "3.9.444",

4.2 — public/sw.js:
  old_str: const CACHE_VERSION = 'docflowai-v159';
  new_str: const CACHE_VERSION = 'docflowai-v160';

4.3 — Cache busting în HTML (curățare totală 3.9.4XX → 3.9.444):

PRIMUL pas — verifică versiunea curentă în HTML-uri (e probabil v=3.9.442):
  grep -oE "v=3\.9\.4[0-9][0-9]" public/formular.html | sort -u
  → ar trebui să vezi v=3.9.442 (și acum v=3.9.444 din modificările tale)

Apoi sed regex care prinde ORICE v=3.9.4XX (dar NU 3.9.444 nou-introdus):
  sed -i -E 's/v=3\.9\.44[0-3]/v=3.9.444/g' public/formular.html
  sed -i -E 's/v=3\.9\.40[0-9]/v=3.9.444/g' public/formular.html
  sed -i -E 's/v=3\.9\.4[12][0-9]/v=3.9.444/g' public/formular.html
  sed -i -E 's/v=3\.9\.43[0-9]/v=3.9.444/g' public/formular.html

Repetă pentru celelalte 3:
  sed -i -E 's/v=3\.9\.44[0-3]/v=3.9.444/g' public/refnec-form.html
  sed -i -E 's/v=3\.9\.40[0-9]/v=3.9.444/g' public/refnec-form.html
  sed -i -E 's/v=3\.9\.4[12][0-9]/v=3.9.444/g' public/refnec-form.html
  sed -i -E 's/v=3\.9\.43[0-9]/v=3.9.444/g' public/refnec-form.html

  sed -i -E 's/v=3\.9\.44[0-3]/v=3.9.444/g' public/notafd-invest-form.html
  sed -i -E 's/v=3\.9\.40[0-9]/v=3.9.444/g' public/notafd-invest-form.html
  sed -i -E 's/v=3\.9\.4[12][0-9]/v=3.9.444/g' public/notafd-invest-form.html
  sed -i -E 's/v=3\.9\.43[0-9]/v=3.9.444/g' public/notafd-invest-form.html

  sed -i -E 's/v=3\.9\.44[0-3]/v=3.9.444/g' public/admin.html
  sed -i -E 's/v=3\.9\.40[0-9]/v=3.9.444/g' public/admin.html
  sed -i -E 's/v=3\.9\.4[12][0-9]/v=3.9.444/g' public/admin.html
  sed -i -E 's/v=3\.9\.43[0-9]/v=3.9.444/g' public/admin.html

Verificare după sed (toate cele 4 HTML-uri):
  for f in public/formular.html public/refnec-form.html public/notafd-invest-form.html public/admin.html; do
    echo "=== $f ===";
    echo "  v=3.9.444 ocurențe: $(grep -c "v=3.9.444" "$f")";
    echo "  alte v=3.9.4XX:    $(grep -oE "v=3\\.9\\.4[0-9]{2}" "$f" | grep -v "v=3.9.444" | sort -u)";
  done

═══════════════════════════════════════════════════════════
VERIFICARE OBLIGATORIE
═══════════════════════════════════════════════════════════

1. Modul JS sintactic OK:
   node --check public/js/formular/clasa8.js

2. Sub-tab există în formular.html:
   grep -c 'id="ltab-clasa8"' public/formular.html
   → 1

3. Secțiunea există în formular.html:
   grep -c 'id="clasa8-section"' public/formular.html
   → 1

4. Tabelul are toate elementele:
   grep -cE 'id="(clasa8-tbody|clasa8-tfoot|clasa8-empty|clasa8-error|clasa8-counter|clasa8-filter-ssi|clasa8-btn-reset|clasa8-btn-export)"' public/formular.html
   → 8

5. Script tag pentru clasa8.js prezent:
   grep -c 'js/formular/clasa8.js' public/formular.html
   → 1

6. switchListTab gestionează 'clasa8':
   grep -c "type==='clasa8'" public/js/formular/list.js
   → ≥ 2 (toggle activator + branch dedicată)

7. Toate ramurile switchListTab ascund clasa8Section:
   grep -c "clasa8Section" public/js/formular/list.js
   → ≥ 7 (1 declarație + 6 setări `style.display='none'` în ramurile non-clasa8 + 1 setare `''` în ramura clasa8)

8. openClasa8 apelat în branch-ul clasa8:
   grep -c "openClasa8" public/js/formular/list.js
   → ≥ 1

9. Cache busting curat în toate cele 4 HTML-uri:
   for f in public/formular.html public/refnec-form.html public/notafd-invest-form.html public/admin.html; do
     OLD=$(grep -oE "v=3\\.9\\.4[0-9]{2}" "$f" | grep -v "v=3.9.444" | wc -l)
     [ "$OLD" -eq 0 ] && echo "OK $f" || echo "FAIL $f (still has stale: $OLD)"
   done
   → 4 OK

10. SheetJS NU este preincărcat (lazy load only):
    grep -c "sheetjs\|xlsx.full.min.js" public/formular.html
    → 0

11. Sintaxă globală:
    node --check public/sw.js
    npm run check

12. TESTE:
    npm test verde, fără regresii (suite-ul nu testează UI, deci ar trebui să rămână 370/370)

═══════════════════════════════════════════════════════════
COMMIT pe develop
═══════════════════════════════════════════════════════════
git add public/js/formular/clasa8.js \
        public/js/formular/list.js \
        public/formular.html \
        public/refnec-form.html \
        public/notafd-invest-form.html \
        public/admin.html \
        public/sw.js \
        package.json

git commit -m "feat(clasa8): UI sub-tab Clasa 8 + export XLSX (v3.9.444)

PASUL 2 din 2 — UI complet pentru centralizatorul Clasa 8.

Sub-tab nou plasat între Ordonanțare de Plată și Verificare furnizor:
  - Buton 'Clasa 8' cu icon ico-landmark
  - Secțiune #clasa8-section cu filter bar + tabel + footer TOTAL
  - Modul JS lazy-loaded prin <script defer> (clasa8.js)

UX:
  - Live search debounced 350ms pe Cod SSI prefix (fără buton submit)
  - Buton Reset filtre cu icon ico-refresh
  - Counter live cu numărul de înregistrări
  - Empty state cu mesaj prietenos pentru cazul fără date
  - Mesaj de eroare distinct pentru probleme API/rețea
  - Tabel cu rânduri hoverable + footer TOTAL evidențiat
  - Coloana 'Rămâne din angajamente' (= angajamente − plăți) ca informație suplimentară
  - Format numeric RO 1.234,56 cu tabular-nums + monospace

Export XLSX:
  - Lazy-loaded SheetJS 0.18.5 de pe cdnjs.cloudflare.com (consistent cu pdf.js)
  - NU adăugăm dependency npm — încărcat prin <script> dinamic la primul click
  - Format celule numerice '#,##0.00' cu width-uri optimizate
  - Nume fișier: Clasa8_YYYY-MM-DD.xlsx
  - Include rândul TOTAL la final

switchListTab extins:
  - Activator nou pentru ltab-clasa8
  - Branch dedicat type==='clasa8' care apelează openClasa8()
  - Toate celelalte branch-uri ascund explicit clasa8Section (consistență)

Cache busting:
  - package.json: 3.9.443 → 3.9.444
  - sw.js: v159 → v160
  - 4 HTML-uri (formular/refnec-form/notafd-invest-form/admin): TOATE referințele
    v=3.9.4XX vechi (407, 442, 443, etc.) consolidate la v=3.9.444"

git push origin develop

═══════════════════════════════════════════════════════════
TEST POST-DEPLOY (staging) — checklist UI manual
═══════════════════════════════════════════════════════════

1. Hard refresh /formular.html (Ctrl+Shift+R) → bara de sub-tab-uri trebuie
   să aibă 7 butoane în ordinea: RN | NFI | ALOP | DF | ORD | Clasa 8 | Verify

2. Click 'Clasa 8' → secțiunea apare:
   - Banner informativ albastru sus
   - Input filtru Cod SSI (cu placeholder)
   - Buton Reset + counter + buton Export Excel
   - Tabel cu 6 coloane

3. Live search:
   - Tastează '01A' (sau alt prefix din datele tale) → după ~350ms se reîncarcă
   - Counter se actualizează corespunzător
   - DevTools → Network: o singură cerere /api/clasa8?ssi=01A

4. Reset:
   - Click pe buton Reset → input se golește, tabelul se reîncarcă cu toate

5. Test empty state:
   - Tastează ceva ce nu există (ex: 'ZZZ999')
   - După 350ms vezi mesajul cu 🪺 'Niciun cod SSI găsit'

6. Test export XLSX:
   - Click Export Excel
   - Buton devine '⏳ Pregătire export…'
   - DevTools → Network: vezi load pentru xlsx.full.min.js de pe cdnjs (~900KB)
   - Se descarcă Clasa8_YYYY-MM-DD.xlsx
   - Deschide în Excel/LibreOffice → verifică:
     * Header pe rândul 1 (cu denumiri lungi cum sunt în UI)
     * Date cu format numeric '1.234,56'
     * Rând gol înainte de TOTAL
     * TOTAL evidențiat la final cu sume corecte

7. Test al doilea export:
   - Click iar Export Excel
   - DevTools → Network: NU mai face cerere CDN (XLSX e cached după primul load)

8. Test navigare:
   - Click 'DF' → tabelul DF se afișează, Clasa 8 se ascunde
   - Click 'ORD' → tabelul ORD, Clasa 8 ascuns
   - Click 'ALOP' → tab ALOP, Clasa 8 ascuns
   - Click 'Verify' → tab verify, Clasa 8 ascuns
   - Click 'Clasa 8' din nou → datele rămân populate (state păstrat în _state)

9. Test responsive:
   - Resize window la <800px → tabelul are scroll orizontal
   - Filter bar wraps elegant

10. Test corectitudine vs PASUL 1:
    - Notează 1-2 cod_ssi cu valorile lor → click Export
    - Sumele din XLSX trebuie să corespundă cu UI și cu /api/clasa8 raw

STOP dacă:
- Click pe sub-tab nu schimbă vizualul → verifică switchListTab pentru 'clasa8'
- Tabelul rămâne gol, dar /api/clasa8 returnează items → verifică render() și DOM IDs
- Export descarcă fișier corupt → posibil problema cu SheetJS load (verifică Network)
- Filter live search nu se declanșează → verifică addEventListener pe 'clasa8-filter-ssi'
- Hover pe rânduri nu funcționează → posibil CSS scope problem cu <style> în secțiune
- Cache busting incomplet → utilizatorii vor vedea UI vechi după deploy; rulează din
  nou sed-urile din 4.3 și verifică cu grep -oE
```
