// public/js/formular/draft.js
// DocFlowAI — Modul Draft (auto-save localStorage) + Date helpers (BLOC 2.3).
//
// Cross-module exports (apelate din formular.js + HTML onclick):
//   - window.draftSave, window.draftClear, window.draftLoadIfExists
//   - window._draftSchedule, window._draftAttach, window._doRestore
//   - window.onDateTextInput, window.onDatePickerChange, window.initDateDisplayRo
//
// Dependențe: df.parseDMYtoISO, df.isoToDMY (BLOC 0) — înlocuiesc definițiile locale din formular.js

(function() {
  'use strict';
  /* eslint-disable no-unused-vars */
  const parseDMYtoISO = window.df.parseDMYtoISO;
  const isoToDMY      = window.df.isoToDMY;

/* ── AUTO-SAVE DRAFT ─────────────────────────────────────────────────────────
 * Salvează starea fiecărui formular în localStorage la fiecare 2s de inactivitate.
 * La reload: restaurare automată cu banner de confirmare.
 * La resetF: draft șters.
 * NU salvează: fișiere atașate (prea mari), imaginile de captură. ─────────── */

const DRAFT_VER = '2'; // bump dacă schimbi structura draft-ului

function _draftKey(ft){ return 'dfai_draft_v' + DRAFT_VER + '_' + ft; }

// Colectează starea completă a formularului într-un obiect serializabil
function _draftCollect(ft) {
  const form = document.getElementById('form-' + ft);
  if (!form) return null;
  const state = { inputs:{}, checkboxes:{}, rows:{}, ts: new Date().toISOString() };

  // Inputs și textareas cu ID (exclus file inputs și cele fără ID)
  form.querySelectorAll('input[id]:not([type=file]):not([type=hidden]),textarea[id]').forEach(el => {
    if (el.type === 'checkbox') state.checkboxes[el.id] = el.checked;
    else state.inputs[el.id] = el.value;
  });

  // Rânduri dinamice — salvate ca array de obiecte {data-f: value}
  const tbodies = {
    ordnt: ['o-tbody'],
    notafd: ['n-vtbody','n-ptbody','n-ctbody'],
  };
  (tbodies[ft] || []).forEach(tid => {
    const tbody = document.getElementById(tid);
    if (!tbody) return;
    state.rows[tid] = [...tbody.querySelectorAll('tr')].map(tr => {
      const o = {};
      tr.querySelectorAll('input[data-f]').forEach(inp => { o[inp.dataset.f] = inp.value; });
      return o;
    });
  });

  return state;
}

// Restaurează starea din obiectul salvat
function _draftApply(ft, state) {
  if (!state) return;
  const form = document.getElementById('form-' + ft);
  if (!form) return;

  // Inputs
  Object.entries(state.inputs || {}).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el && el.type !== 'file') el.value = val;
  });

  // Checkboxes + re-trigger toggle-uri dependente
  Object.entries(state.checkboxes || {}).forEach(([id, checked]) => {
    const el = document.getElementById(id);
    if (el) el.checked = checked;
  });

  // Re-aplică stările dependente pentru pct 4 și pct 5 (doc fundamentare)
  if (ft === 'notafd') {
    const ckStab = document.getElementById('n-ck-stab');
    const ckRam  = document.getElementById('n-ck-ramane');
    if (ckStab && ckRam) {
      if (ckStab.checked) p4toggle('stab');
      else if (ckRam.checked) p4toggle('ramane');
    }
    p5toggle && p5toggle();
  }

  // Rânduri dinamice
  const addFns = { 'o-tbody': addOR, 'n-vtbody': addNV, 'n-ptbody': addNP, 'n-ctbody': addNC };
  Object.entries(state.rows || {}).forEach(([tid, rows]) => {
    const tbody = document.getElementById(tid);
    if (!tbody || !rows.length) return;
    tbody.innerHTML = '';
    const addFn = addFns[tid];
    rows.forEach(rowData => {
      if (addFn) addFn();
      const tr = tbody.querySelector('tr:last-child');
      if (!tr) return;
      Object.entries(rowData).forEach(([f, v]) => {
        const inp = tr.querySelector(`[data-f="${f}"]`);
        if (inp) inp.value = v;
      });
    });
  });

  // Recalculează totaluri și col 7 după restore
  upTot && upTot();
  // Re-calculează col 7 = col5+col6 pentru fiecare rând NV
  document.querySelectorAll('#n-vtbody tr').forEach(tr => {
    const c5 = parseFloat(tr.querySelector('[data-f="valt_rev_prec"]')?.value) || 0;
    const c6 = parseFloat(tr.querySelector('[data-f="influente"]')?.value) || 0;
    const c7 = tr.querySelector('[data-f="valt_actualiz"]');
    if (c7) c7.value = c5 + c6;
  });
  // Re-calculează col 7=5+6 și col 10=8+9 pentru fiecare rând NC (Secțiunea B)
  document.querySelectorAll('#n-ctbody tr').forEach(tr => {
    const c5 = parseFloat(tr.querySelector('[data-f="sum_rezv_crdt_ang_af_rvz_prc"]')?.value) || 0;
    const c6 = parseFloat(tr.querySelector('[data-f="influente_c6"]')?.value) || 0;
    const c7 = tr.querySelector('[data-f="sum_rezv_crdt_ang_act"]');
    if (c7) c7.value = c5 + c6;
    const c8 = parseFloat(tr.querySelector('[data-f="sum_rezv_crdt_bug_af_rvz_prc"]')?.value) || 0;
    const c9 = parseFloat(tr.querySelector('[data-f="influente_c9"]')?.value) || 0;
    const c10 = tr.querySelector('[data-f="sum_rezv_crdt_bug_act"]');
    if (c10) c10.value = c8 + c9;
  });
  upTot && upTot();
}

// Salvează în localStorage cu gestionare erori quota
function draftSave(ft) {
  try {
    const state = _draftCollect(ft);
    if (!state) return;
    localStorage.setItem(_draftKey(ft), JSON.stringify(state));
    _draftShowBadge(ft, '💾 salvat ' + new Date().toLocaleTimeString('ro-RO', {hour:'2-digit',minute:'2-digit'}));
  } catch(e) {
    // localStorage plin sau indisponibil — ignorăm silențios
    if (e.name === 'QuotaExceededError') _draftShowBadge(ft, '⚠ storage plin');
  }
}

function draftClear(ft) {
  try { localStorage.removeItem(_draftKey(ft)); } catch {}
  _draftHideBadge(ft);
}

function _draftShowBadge(ft, txt) {
  // Actualizează badge-ul vizibil din back-bar (tab-urile sunt ascunse)
  const vis = document.getElementById('form-save-badge');
  if (vis) { vis.textContent = txt; vis.style.display = ''; }
  // Și cel din tabs-wrap (ascuns, backup)
  const el = document.getElementById('db-' + ft);
  if (el) { el.textContent = txt; el.classList.add('show'); }
}
function _draftHideBadge(ft) {
  const vis = document.getElementById('form-save-badge');
  if (vis) vis.textContent = '';
  const el = document.getElementById('db-' + ft);
  if (el) { el.textContent = ''; el.classList.remove('show'); }
}

// Încarc draft la pornire cu banner de confirmare
function draftLoadIfExists(ft) {
  try {
    const raw = localStorage.getItem(_draftKey(ft));
    if (!raw) return;
    const state = JSON.parse(raw);
    if (!state || !state.ts) return;

    const age = Math.round((Date.now() - new Date(state.ts)) / 60000);
    const ageStr = age < 1 ? 'acum câteva secunde' : age < 60 ? `acum ${age} min` : `acum ${Math.round(age/60)}h`;

    // Banner de restore
    const bar = document.getElementById('sBar');
    bar.className = 'status info';
    bar.innerHTML = `📋 Draft găsit (${ageStr}). &nbsp;
      <button onclick="_doRestore('${ft}')" style="padding:2px 10px;border-radius:6px;border:1px solid rgba(108,79,240,.4);background:rgba(108,79,240,.12);color:#b0a0ff;cursor:pointer;font-size:.82rem">Restaurează</button>
      <button onclick="draftClear('${ft}');clrS()" style="margin-left:6px;padding:2px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.1);background:none;color:var(--df-text-3);cursor:pointer;font-size:.82rem">Ignoră</button>`;

    // Stocăm starea pentru butonul de restore
    window._pendingDraft = window._pendingDraft || {};
    window._pendingDraft[ft] = state;
  } catch {}
}

function _doRestore(ft) {
  const state = window._pendingDraft?.[ft];
  if (!state) return;
  // Golim rândurile implicite adăugate la init înainte de restore
  ['o-tbody','n-vtbody','n-ptbody','n-ctbody'].forEach(tid => {
    const el = document.getElementById(tid);
    if (el) el.innerHTML = '';
  });
  _draftApply(ft, state);
  delete window._pendingDraft[ft];
  clrS();
  _draftShowBadge(ft, '✅ draft restaurat');
  setTimeout(() => _draftHideBadge(ft), 4000);
}

// Debounce auto-save — 2s după ultima tastă
const _draftTimers = {};
function _draftSchedule(ft) {
  if(ST.docAprobat?.[ft])return;
  clearTimeout(_draftTimers[ft]);
  _draftTimers[ft] = setTimeout(() => draftSave(ft), 2000);
}

// Atașează listeners la toate input-urile din fiecare formular
function _draftAttach(ft) {
  const form = document.getElementById('form-' + ft);
  if (!form) return;
  form.addEventListener('input', () => { _draftSchedule(ft); _scheduleAutoSaveDb(ft); });
  form.addEventListener('change', () => { _draftSchedule(ft); _scheduleAutoSaveDb(ft); });
}

// Init — rulat după ce formularele sunt gata
(function initDraft(){
  ['ordnt','notafd'].forEach(ft => {
    _draftAttach(ft);
    draftLoadIfExists(ft);
  });
})();

// ── Date helpers zz.ll.aaaa <-> YYYY-MM-DD (consistent cu admin.js) ──
function onDateTextInput(el, hiddenId) {
  let v = el.value.replace(/[^0-9.]/g,'');
  const digits = v.replace(/\./g,'');
  if (digits.length > 2 && !v.includes('.')) v = digits.slice(0,2) + '.' + digits.slice(2);
  if (digits.length > 4) {
    const parts = v.split('.');
    if (parts.length >= 2 && parts[1].length > 2) {
      v = parts[0] + '.' + parts[1].slice(0,2) + '.' + parts[1].slice(2) + (parts[2]||'');
    }
  }
  v = v.slice(0,10);
  el.value = v;
  const iso = parseDMYtoISO(v);
  const hidden = document.getElementById(hiddenId);
  if (hidden) { hidden.value = iso || ''; if (iso) hidden.dispatchEvent(new Event('change')); }
  el.style.borderColor = v.length === 10 ? (iso ? 'rgba(45,212,191,.5)' : 'rgba(255,80,80,.5)') : '';
}
function onDatePickerChange(pickerEl, displayId) {
  const iso = pickerEl.value;
  if (iso) { const disp = document.getElementById(displayId); if (disp) { disp.value = isoToDMY(iso); disp.style.borderColor = 'rgba(45,212,191,.5)'; } }
}

// Afișare vizuală dd.mm.yyyy peste input[type=date] (valoarea internă rămâne YYYY-MM-DD)
function initDateDisplayRo(){
  document.querySelectorAll('input[type="date"]').forEach(input=>{
    if(input.dataset.roDate)return;
    input.dataset.roDate='1';
    const wrapper=document.createElement('div');
    wrapper.style.cssText='position:relative;display:inline-block;width:100%';
    input.parentNode.insertBefore(wrapper,input);
    wrapper.appendChild(input);
    const display=document.createElement('span');
    display.style.cssText='position:absolute;left:10px;top:50%;transform:translateY(-50%);pointer-events:none;font-size:inherit;color:inherit;background:transparent;z-index:1';
    wrapper.appendChild(display);
    const update=()=>{
      if(input.value){const[y,m,d]=input.value.split('-');display.textContent=`${d}.${m}.${y}`;input.style.color='transparent';}
      else{display.textContent='';input.style.color='';}
    };
    input.addEventListener('change',update);
    input.addEventListener('input',update);
    update();
  });
}
document.addEventListener('DOMContentLoaded',initDateDisplayRo);

  // ── Exports cross-module ─────────────────────────────────────────────────
  window.draftSave          = draftSave;
  window.draftClear         = draftClear;
  window.draftLoadIfExists  = draftLoadIfExists;
  window._draftSchedule     = _draftSchedule;
  window._draftAttach       = _draftAttach;
  window._doRestore         = _doRestore;
  window.onDateTextInput    = onDateTextInput;
  window.onDatePickerChange = onDatePickerChange;
  window.initDateDisplayRo  = initDateDisplayRo;

  window.df = window.df || {};
  window.df._formularDraftLoaded = true;
})();
