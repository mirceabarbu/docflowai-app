'use strict';

// ── State ────────────────────────────────────────────────────────────────────
let _allFlows    = [];
let _selected    = new Set();
let _sessionId   = null;
let _pollInterval = null;
let _pollCount   = 0;
const POLL_MAX   = 60;  // 3 minute × 3s

// ── Helpers ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function showAlert(msg, type = 'err') {
  const el = $('alertBox');
  el.className = `alert alert-${type}`;
  el.textContent = msg;
  el.style.display = 'block';
}
function hideAlert() { $('alertBox').style.display = 'none'; }

async function _apiFetch(url, opts = {}) {
  const r = await fetch(url, { credentials: 'include', ...opts });
  // SEC-88.3: bulk-signer.html nu încarcă notif-widget.js, deci nu beneficiază de handler-ul
  // global. URL canonic de login în toată aplicația: /login (NU /login.html). Plus ?next=,
  // ca utilizatorul să se întoarcă exact aici după reautentificare.
  if (r.status === 401) {
    try { localStorage.removeItem('docflow_user'); } catch (_) {}
    location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
    throw new Error('401');
  }
  return r;
}

// ── Init ─────────────────────────────────────────────────────────────────────
(async function init() {
  const params = new URLSearchParams(location.search);
  const stsPending = params.get('sts_pending');
  const stsError   = params.get('sts_error');
  _sessionId       = params.get('session');

  if (stsError) {
    $('phase-init').style.display  = 'block';
    $('loadingBox').style.display  = 'none';
    showAlert('❌ Eroare STS: ' + decodeURIComponent(stsError));
    loadFlows();
    return;
  }

  if (stsPending && _sessionId) {
    showPhaseWait();
    startPoll();
    return;
  }

  // Dacă avem sessionId dar nu pending — verificam statusul
  if (_sessionId) {
    try {
      const r = await _apiFetch(`/bulk-signing/${_sessionId}/status`);
      const j = await r.json();
      if (j.status === 'completed' || j.status === 'error') {
        showPhaseDone(j);
        return;
      }
    } catch(e) {}
  }

  loadFlows();
})();

// ── Încarcă fluxurile pending ────────────────────────────────────────────────
async function loadFlows() {
  $('phase-init').style.display = 'block';
  $('loadingBox').style.display = 'block';
  $('flowsCard').style.display  = 'none';
  $('emptyBox').style.display   = 'none';
  try {
    const r = await _apiFetch('/api/my-pending-flows');
    const j = await r.json();
    _allFlows = j.flows || [];

    $('loadingBox').style.display = 'none';

    if (!_allFlows.length) {
      $('emptyBox').style.display = 'block';
      return;
    }

    $('flowsCard').style.display   = 'block';
    $('providerBox').style.display = 'block';
    $('countLabel').textContent    = `${_allFlows.length} document${_allFlows.length !== 1 ? 'e' : ''} disponibil${_allFlows.length !== 1 ? 'e' : ''}`;
    renderFlows();
    renderProviderInfo();
  } catch(e) {
    $('loadingBox').style.display = 'none';
    showAlert('Eroare la încărcarea fluxurilor: ' + e.message);
  }
}

function renderFlows() {
  const el = $('flowsList');
  el.innerHTML = _allFlows.map(f => {
    const dt = new Date(f.createdAt).toLocaleString('ro-RO', {
      day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit'
    });
    const isUrgent = f.urgent;
    return `
      <div class="item" id="item_${esc(f.flowId)}">
        <input type="checkbox" id="chk_${esc(f.flowId)}"
          style="width:18px;height:18px;cursor:pointer;accent-color:var(--purple);flex-shrink:0"
          onchange="toggleFlow('${esc(f.flowId)}')"
          ${_selected.has(f.flowId) ? 'checked' : ''}>
        <div class="item-icon">${f.flowType === 'ancore' ? '⚓' : '📋'}</div>
        <div style="flex:1;min-width:0">
          <div class="item-name">${esc(f.docName)}${isUrgent ? ' <span style="color:#ff8888;font-size:.7rem;font-weight:700;background:rgba(255,40,40,.15);border:1px solid rgba(255,40,40,.4);padding:1px 7px;border-radius:20px;vertical-align:middle;margin-left:6px">🚨 URGENT</span>' : ''}</div>
          <div class="item-sub">Creat: ${dt} &nbsp;·&nbsp; ID: <span style="font-family:monospace">${esc(f.flowId)}</span></div>
        </div>
        <span class="item-status status-pending">⏳ De semnat</span>
      </div>`;
  }).join('');
  updateSelCount();
}

function toggleFlow(flowId) {
  if (_selected.has(flowId)) _selected.delete(flowId);
  else _selected.add(flowId);
  updateSelCount();
}

let _allChecked = false;
function toggleSelectAll() {
  _allChecked = !_allChecked;
  _allFlows.forEach(f => {
    _allChecked ? _selected.add(f.flowId) : _selected.delete(f.flowId);
    const chk = $(`chk_${f.flowId}`);
    if (chk) chk.checked = _allChecked;
  });
  updateSelCount();
}

function updateSelCount() {
  const n = _selected.size;
  $('selCount').textContent = n ? `${n} document${n !== 1 ? 'e' : ''} selectat${n !== 1 ? 'e' : ''}` : '';
  const btn = $('btnSign');
  btn.disabled = n === 0 || _isBulkUnavailable();
  btn.textContent = n > 0
    ? `✍️ Semnează ${n} document${n !== 1 ? 'e' : ''}`
    : '✍️ Semnează documentele selectate';
}

function renderProviderInfo() {
  // Verificăm dacă oricare dintre fluxurile selectate are provider local
  const hasCloud = _allFlows.some(f => !f.signingProvider || f.signingProvider === 'sts-cloud'
    || f.signingProvider?.includes('cloud') || f.signingProvider?.includes('sts'));
  $('providerInfo').innerHTML =
    '🏛️ <strong>STS Cloud QES</strong> — un singur redirect OAuth, o singură aprobare pe email/PUSH, toate documentele semnate automat.';
  $('localUploadWarning').style.display = 'none';
}

function _isBulkUnavailable() {
  return false; // STS e disponibil — verificarea detaliată se face la submit
}

// ── Inițiere bulk ─────────────────────────────────────────────────────────────
async function initiateBulk() {
  if (_selected.size === 0) return;
  hideAlert();
  const btn = $('btnSign');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Se pregătesc documentele…';

  try {
    // Colectam flowId + signerToken pentru fluxurile selectate
    const flowRequests = _allFlows
      .filter(f => _selected.has(f.flowId))
      .map(f => ({ flowId: f.flowId, signerToken: f.signerToken }));

    const r = await _apiFetch('/bulk-signing/initiate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ flows: flowRequests, providerId: 'sts-cloud' }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.message || j.error || `Eroare ${r.status}`);

    _sessionId = j.sessionId;
    // Redirect la STS OAuth
    window.location.href = j.signingUrl;

  } catch(e) {
    btn.disabled = false;
    btn.textContent = `✍️ Semnează documentele selectate`;
    showAlert('❌ ' + e.message);
  }
}

// ── Polling ───────────────────────────────────────────────────────────────────
function showPhaseWait() {
  $('phase-init').style.display  = 'none';
  $('phase-done').style.display  = 'none';
  $('phase-wait').style.display  = 'block';
}

function startPoll() {
  if (_pollInterval) return;
  _pollCount = 0;
  _pollInterval = setInterval(doPoll, 3000);
}

async function doPoll() {
  _pollCount++;
  const bar = $('pollBar');
  if (bar) bar.style.width = Math.min(100, (_pollCount / POLL_MAX) * 100) + '%';

  if (_pollCount >= POLL_MAX) {
    clearInterval(_pollInterval); _pollInterval = null;
    $('pollStatus').textContent = '⏱ Timp expirat. Încearcă din nou.';
    setTimeout(() => { $('phase-wait').style.display = 'none'; $('phase-init').style.display = 'block'; loadFlows(); }, 2000);
    return;
  }

  try {
    const r = await _apiFetch(`/bulk-signing/${_sessionId}/poll`);
    const j = await r.json();
    const st = $('pollStatus');

    if (j.status === 'waiting') {
      if (st) st.textContent = `⏳ Așteptăm aprobarea ta în aplicația STS… (${_pollCount}/${POLL_MAX})`;
      return;
    }
    if (j.status === 'completed' || (j.signed !== undefined && j.errors !== undefined)) {
      clearInterval(_pollInterval); _pollInterval = null;
      showPhaseDone(j);
      return;
    }
    if (j.status === 'error') {
      clearInterval(_pollInterval); _pollInterval = null;
      if (st) st.textContent = '❌ ' + (j.message || 'Eroare la semnare');
      setTimeout(() => { $('phase-wait').style.display = 'none'; $('phase-init').style.display = 'block'; showAlert('❌ ' + (j.message||'Eroare la semnare')); loadFlows(); }, 2500);
    }
  } catch(e) {
    // eroare de rețea — continuăm polling-ul
  }
}

function cancelPoll() {
  if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null; }
  $('phase-wait').style.display  = 'none';
  $('phase-init').style.display  = 'block';
  loadFlows();
}

// ── Faza Done ────────────────────────────────────────────────────────────────
function showPhaseDone(j) {
  $('phase-wait').style.display  = 'none';
  $('phase-init').style.display  = 'none';
  $('phase-done').style.display  = 'block';

  // v3.9.507: render initial cu datele primite de la backend
  _renderDoneState(j);

  // v3.9.507: dacă există items cu status='error', verificăm statusul real al
  // flow-urilor — bulk-signing.mjs poate clasifica greșit ca eroare items
  // deja semnate. Vezi context comentariu funcție _reverifyErrorItems.
  if (Array.isArray(j.items) && j.items.some(i => i.status === 'error')) {
    _reverifyErrorItems(j);
  }
}

// v3.9.507: render state extras din showPhaseDone — folosit și la re-render
// după re-verificare automată items cu status='error'.
function _renderDoneState(j) {
  const signed = j.signed || 0;
  const errors = j.errors || 0;
  const total  = j.total  || j.flowCount || (signed + errors);
  const allOk  = errors === 0;

  $('doneIcon').textContent  = allOk ? '✅' : (signed > 0 ? '⚠️' : '❌');
  $('doneTitle').textContent = allOk
    ? 'Semnare finalizată cu succes!'
    : signed > 0
      ? 'Semnare parțial finalizată'
      : 'Semnare eșuată';
  $('doneMsg').textContent = allOk
    ? `Toate cele ${total} documente au fost semnate cu succes cu semnătură electronică calificată QES.`
    : `${signed} din ${total} documente semnate. ${errors > 0 ? errors + ' erori.' : ''}`;

  $('doneStats').innerHTML = `
    <div class="stat"><div class="stat-n ok">${signed}</div><div class="stat-l">Semnate</div></div>
    ${errors > 0 ? `<div class="stat"><div class="stat-n bad">${errors}</div><div class="stat-l">Erori</div></div>` : ''}
    <div class="stat"><div class="stat-n">${total}</div><div class="stat-l">Total</div></div>
  `;

  if (Array.isArray(j.items) && j.items.length) {
    $('doneItems').innerHTML = `
      <div class="card">
        ${j.items.map(i => `
          <div class="item">
            <div class="item-icon">${i.status === 'signed' ? '✅' : '❌'}</div>
            <div style="flex:1;min-width:0">
              <div class="item-name">${esc(i.docName || i.flowId)}</div>
              ${i.error && i.status !== 'signed' ? `<div class="item-sub" style="color:#ffaaaa">${esc(i.error)}</div>` : ''}
              ${i._verifiedAfterError ? `<div class="item-sub" style="color:#8ac4ff">🔄 Verificat ulterior — semnătura QES validă</div>` : ''}
            </div>
            <span class="item-status ${i.status === 'signed' ? 'status-signed' : 'status-error'}">
              ${i.status === 'signed' ? '✅ Semnat' : '❌ Eroare'}
            </span>
            ${i.status === 'signed'
              ? `<a href="/flow.html?flow=${encodeURIComponent(i.flowId)}"
                   style="font-size:.8rem;color:var(--sub);text-decoration:none;
                     padding:5px 10px;border:1px solid var(--stroke);border-radius:7px;
                     white-space:nowrap;margin-left:6px">
                   🔍 Vezi
                 </a>`
              : ''}
          </div>`).join('')}
      </div>`;
  }
}

// v3.9.507: re-verificare automată a items cu status='error'. Bulk-signing
// poate raporta greșit ca eroare items care au semnătură QES validă
// (cauză suspectă: retry loop în pipeline-ul backend care iterează peste
// items deja procesate; placeholder șters după prima rulare → next iteration
// vede placeholder lipsă și aruncă eroare deși semnătura s-a făcut).
// Fix: verificăm pentru fiecare item de eroare statusul REAL al flow-ului
// prin GET /flows/:flowId. Dacă flow.completed === true sau toți signers
// sunt status='signed', reclasificăm item ca semnat (cu badge "verificat").
async function _reverifyErrorItems(j) {
  // Spinner mic în UI
  const msgEl = document.getElementById('doneMsg');
  const originalMsg = msgEl ? msgEl.textContent : '';
  if (msgEl) {
    msgEl.innerHTML = `${esc(originalMsg)} <span style="display:inline-block;margin-left:10px;color:#8ac4ff;font-size:.9em">🔄 Verificăm statusul real...</span>`;
  }

  const errorItems = j.items.filter(i => i.status === 'error');
  const checks = errorItems.map(async (item) => {
    try {
      const r = await fetch(`/flows/${encodeURIComponent(item.flowId)}`, { credentials: 'include' });
      if (!r.ok) return { item, isActuallySigned: false };
      const flowData = await r.json();
      // Criteriu: flow.completed === true SAU toți signers cu status='signed'
      const completed = flowData.completed === true || flowData.status === 'completed';
      const allSignersSigned = Array.isArray(flowData.signers) && flowData.signers.length > 0
        && flowData.signers.every(s => s.status === 'signed');
      const isActuallySigned = completed || allSignersSigned;
      return { item, isActuallySigned };
    } catch(_) {
      return { item, isActuallySigned: false };
    }
  });

  const results = await Promise.allSettled(checks);

  // Reclasificăm items pe baza rezultatelor
  let reclassified = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.isActuallySigned) {
      const it = r.value.item;
      // Marchez în obiectul original din j.items (find by reference flowId)
      const target = j.items.find(x => x.flowId === it.flowId);
      if (target) {
        target.status = 'signed';
        target._verifiedAfterError = true;
        reclassified++;
      }
    }
  }

  if (reclassified > 0) {
    // Update count-uri
    j.signed = (j.signed || 0) + reclassified;
    j.errors = Math.max(0, (j.errors || 0) - reclassified);
    // Re-render complet
    _renderDoneState(j);
  } else {
    // Niciuna nu s-a confirmat — restaurăm mesajul fără spinner
    if (msgEl) msgEl.textContent = originalMsg;
  }
}
