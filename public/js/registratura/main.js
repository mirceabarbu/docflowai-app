// public/js/registratura/main.js — Registratură UI (Faza 1 + Faza 2)
//
//   Faza 1 (Ieșiri): listă paginată + export CSV — comportament neschimbat.
//   Faza 2 (Intrări): listă + modal înregistrare + acțiuni status + atașament
//                     + legare flux răspuns.
//
//   ZERO localStorage/sessionStorage (subtab activ persistă prin df-subtabs.js).
//   esc() obligatoriu pe tot ce ajunge în DOM.

(function () {
  'use strict';

  const esc = (window.df && window.df.esc) || function (s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  const $ = (id) => document.getElementById(id);
  const debounce = (window.df && window.df.debounce) || ((fn, ms) => {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  });

  function _csrfHdr() {
    const t = (window.df && window.df.getCsrf) ? window.df.getCsrf() : null;
    return t ? { 'x-csrf-token': t } : {};
  }

  // ───── helpers comune ─────────────────────────────────────────────────────

  function statusBadge(st) {
    const map = {
      finalizat:    ['Finalizat',   '#0a7d3e', 'rgba(16,185,129,.14)'],
      solutionat:   ['Soluționat',  '#0a7d3e', 'rgba(16,185,129,.14)'],
      in_lucru:     ['În lucru',    '#5c5c5c', 'rgba(148,163,184,.18)'],
      inregistrat:  ['Înregistrat', '#5c5c5c', 'rgba(148,163,184,.18)'],
      repartizat:   ['Repartizat',  '#b25800', 'rgba(251,146,60,.16)'],
      refuzat:      ['Refuzat',     '#a3162c', 'rgba(248,113,113,.16)'],
      anulat:       ['Anulat',      '#a3162c', 'rgba(248,113,113,.16)'],
      clasat:       ['Clasat',      '#5c5c5c', 'rgba(148,163,184,.18)'],
    };
    const [label, color, bg] = map[st] || [st || '—', '#5c5c5c', 'rgba(148,163,184,.18)'];
    return `<span style="display:inline-block;padding:3px 10px;border-radius:999px;font-size:.78rem;font-weight:600;color:${color};background:${bg};">${esc(label)}</span>`;
  }

  function fmtDate(iso, opts) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '—';
      return d.toLocaleString('ro-RO', Object.assign({ timeZone: 'Europe/Bucharest', dateStyle: 'short', timeStyle: 'short' }, opts || {}));
    } catch { return '—'; }
  }

  function fmtDateOnly(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '—';
      return d.toLocaleDateString('ro-RO', { timeZone: 'Europe/Bucharest' });
    } catch { return '—'; }
  }

  function populateYears(selId) {
    const sel = $(selId);
    if (!sel) return;
    const y = new Date().getFullYear();
    const opts = ['<option value="">Toți</option>'];
    for (let i = 0; i < 3; i++) opts.push(`<option value="${y - i}">${y - i}</option>`);
    sel.innerHTML = opts.join('');
  }

  // ───── IEȘIRI (Faza 1) ────────────────────────────────────────────────────

  const stateOut = { page: 1, limit: 50, total: 0, an: null, q: '', status: '' };

  function buildQueryOut() {
    const p = new URLSearchParams();
    if (stateOut.an)     p.set('an', stateOut.an);
    if (stateOut.q)      p.set('q', stateOut.q);
    if (stateOut.status) p.set('status', stateOut.status);
    p.set('directie', 'iesire');
    p.set('page',  stateOut.page);
    p.set('limit', stateOut.limit);
    return p.toString();
  }

  async function loadOut() {
    const tbody = $('reg-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="padding:24px;text-align:center;color:var(--df-text-3);">Se încarcă…</td></tr>';
    try {
      const r = await fetch('/api/registratura/intrari?' + buildQueryOut(), { credentials: 'include' });
      if (!r.ok) throw new Error('http_' + r.status);
      const data = await r.json();
      stateOut.total = Number(data.total || 0);
      renderOut(data.items || []);
      renderPagOut();
    } catch (e) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="padding:24px;text-align:center;color:var(--df-text-3);">Eroare la încărcare.</td></tr>';
    }
  }

  function fluxCell(it) {
    if (!it.flowId) return '<span style="color:var(--df-text-4);">—</span>';
    return `<a href="/flow.html?id=${encodeURIComponent(it.flowId)}" target="_blank" rel="noopener" class="df-action-btn" style="font-size:.78rem;padding:4px 8px;text-decoration:none;">🔗 flux</a>`;
  }

  function renderOut(items) {
    const tbody = $('reg-tbody');
    if (!tbody) return;
    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="padding:24px;text-align:center;color:var(--df-text-3);">Niciun document înregistrat.</td></tr>';
      return;
    }
    tbody.innerHTML = items.map((it) => `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid var(--df-border-2);font-weight:600;">${esc(String(it.numar).padStart(5, '0'))}</td>
        <td style="padding:10px 12px;border-bottom:1px solid var(--df-border-2);">${esc(fmtDate(it.data))}</td>
        <td style="padding:10px 12px;border-bottom:1px solid var(--df-border-2);">${esc(it.obiect || '—')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid var(--df-border-2);">${esc(it.expeditor || '—')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid var(--df-border-2);">${esc(it.compartiment || '—')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid var(--df-border-2);">${statusBadge(it.status)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid var(--df-border-2);">${fluxCell(it)}</td>
      </tr>
    `).join('');
  }

  function renderPagOut() {
    const totalPages = Math.max(1, Math.ceil(stateOut.total / stateOut.limit));
    const totalEl = $('reg-total');
    const pageEl = $('reg-page');
    const prev = $('reg-prev');
    const next = $('reg-next');
    if (totalEl) totalEl.textContent = `${stateOut.total} înregistrări`;
    if (pageEl)  pageEl.textContent  = `Pagina ${stateOut.page} / ${totalPages}`;
    if (prev) prev.disabled = stateOut.page <= 1;
    if (next) next.disabled = stateOut.page >= totalPages;
  }

  function wireOut() {
    $('reg-an').addEventListener('change', (e) => { stateOut.an = e.target.value || null; stateOut.page = 1; loadOut(); });
    $('reg-status').addEventListener('change', (e) => { stateOut.status = e.target.value || ''; stateOut.page = 1; loadOut(); });
    $('reg-q').addEventListener('input', debounce((e) => { stateOut.q = e.target.value.trim(); stateOut.page = 1; loadOut(); }, 300));
    $('reg-refresh').addEventListener('click', () => loadOut());
    $('reg-prev').addEventListener('click', () => { if (stateOut.page > 1) { stateOut.page--; loadOut(); } });
    $('reg-next').addEventListener('click', () => { stateOut.page++; loadOut(); });
    $('reg-export').addEventListener('click', () => {
      const p = new URLSearchParams();
      p.set('directie', 'iesire');
      if (stateOut.an) p.set('an', stateOut.an);
      window.location = '/api/registratura/export.csv?' + p.toString();
    });
  }

  // ───── INTRĂRI (Faza 2) ───────────────────────────────────────────────────

  const stateIn = { page: 1, limit: 50, total: 0, an: null, registru: '', q: '', status: '' };

  function buildQueryIn() {
    const p = new URLSearchParams();
    p.set('directie', 'intrare');
    if (stateIn.an)       p.set('an', stateIn.an);
    if (stateIn.registru) p.set('registru', stateIn.registru);
    if (stateIn.q)        p.set('q', stateIn.q);
    if (stateIn.status)   p.set('status', stateIn.status);
    p.set('page',  stateIn.page);
    p.set('limit', stateIn.limit);
    return p.toString();
  }

  async function loadIn() {
    const tbody = $('regin-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="padding:24px;text-align:center;color:var(--df-text-3);">Se încarcă…</td></tr>';
    try {
      const r = await fetch('/api/registratura/intrari?' + buildQueryIn(), { credentials: 'include' });
      if (!r.ok) throw new Error('http_' + r.status);
      const data = await r.json();
      stateIn.total = Number(data.total || 0);
      renderIn(data.items || []);
      renderPagIn();
    } catch (e) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="padding:24px;text-align:center;color:var(--df-text-3);">Eroare la încărcare.</td></tr>';
    }
  }

  const REGISTRU_LBL = { general: 'Intrări', intrare: 'Intrări', petitii: 'Petiții', '544': '544/2001' };

  function termenCell(it) {
    if (!it.termenAt) return '<span style="color:var(--df-text-4);">—</span>';
    const due = new Date(it.termenAt);
    const now = new Date();
    const closed = it.status === 'solutionat' || it.status === 'clasat';
    const overdue = !closed && due.getTime() < now.getTime();
    const label = fmtDateOnly(it.termenAt);
    if (overdue) return `<span style="color:#a3162c;font-weight:600;">${esc(label)} (depășit)</span>`;
    return esc(label);
  }

  function actionsCell(it) {
    const next = (() => {
      if (it.statusRaw === 'inregistrat') return [['repartizat', 'Repartizează'], ['clasat', 'Clasează']];
      if (it.statusRaw === 'repartizat')  return [['in_lucru', 'În lucru'], ['clasat', 'Clasează']];
      if (it.statusRaw === 'in_lucru')    return [['solutionat', 'Soluționează'], ['clasat', 'Clasează']];
      // statusRaw lipsă (NULL în DB) → considerăm inregistrat
      if (!it.statusRaw) return [['repartizat', 'Repartizează'], ['clasat', 'Clasează']];
      return [];
    })();
    const btns = next.map(([s, l]) =>
      `<button class="df-action-btn" type="button" data-act="status" data-id="${it.id}" data-next="${s}" style="font-size:.78rem;padding:4px 8px;">${esc(l)}</button>`
    ).join('');
    const att = `<button class="df-action-btn" type="button" data-act="atas" data-id="${it.id}" style="font-size:.78rem;padding:4px 8px;">📎</button>`;
    const link = it.raspunsFlowId
      ? `<a href="/flow.html?id=${encodeURIComponent(it.raspunsFlowId)}" target="_blank" rel="noopener" class="df-action-btn" style="font-size:.78rem;padding:4px 8px;text-decoration:none;">🔗 răspuns</a>`
      : `<button class="df-action-btn" type="button" data-act="link" data-id="${it.id}" style="font-size:.78rem;padding:4px 8px;">🔗</button>`;
    return `<div style="display:flex;gap:4px;flex-wrap:wrap;">${btns}${att}${link}</div>`;
  }

  function renderIn(items) {
    const tbody = $('regin-tbody');
    if (!tbody) return;
    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="padding:24px;text-align:center;color:var(--df-text-3);">Niciun document intrat înregistrat.</td></tr>';
      return;
    }
    tbody.innerHTML = items.map((it) => `
      <tr data-id="${it.id}">
        <td style="padding:10px 12px;border-bottom:1px solid var(--df-border-2);font-weight:600;">${esc(String(it.numar).padStart(5, '0'))}</td>
        <td style="padding:10px 12px;border-bottom:1px solid var(--df-border-2);">${esc(fmtDate(it.data))}</td>
        <td style="padding:10px 12px;border-bottom:1px solid var(--df-border-2);">${esc(REGISTRU_LBL[it.registru] || it.registru || '—')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid var(--df-border-2);">${esc(it.obiect || '—')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid var(--df-border-2);">${esc(it.expeditor || '—')}</td>
        <td style="padding:10px 12px;border-bottom:1px solid var(--df-border-2);">${termenCell(it)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid var(--df-border-2);">
          ${statusBadge(it.status)}
          ${it.repartizatLa ? `<div style="font-size:.72rem;color:var(--df-text-3);margin-top:4px;">→ ${esc(String(it.repartizatLa).slice(0, 60))}</div>` : ''}
          ${it.motivClasare ? `<div title="${esc(it.motivClasare)}" style="font-size:.72rem;color:var(--df-text-3);margin-top:4px;font-style:italic;">motiv: ${esc(String(it.motivClasare).slice(0, 40))}${it.motivClasare.length > 40 ? '…' : ''}</div>` : ''}
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid var(--df-border-2);">${actionsCell(it)}</td>
      </tr>
    `).join('');
  }

  function renderPagIn() {
    const totalPages = Math.max(1, Math.ceil(stateIn.total / stateIn.limit));
    const totalEl = $('regin-total');
    const pageEl = $('regin-page');
    const prev = $('regin-prev');
    const next = $('regin-next');
    if (totalEl) totalEl.textContent = `${stateIn.total} înregistrări`;
    if (pageEl)  pageEl.textContent  = `Pagina ${stateIn.page} / ${totalPages}`;
    if (prev) prev.disabled = stateIn.page <= 1;
    if (next) next.disabled = stateIn.page >= totalPages;
  }

  // ───── Acțiuni rând (status / atașament / link) ───────────────────────────

  async function doStatus(id, next) {
    // BLOC Registratură UX: pentru tranziții cu input → modal dedicat.
    if (next === 'repartizat' || next === 'clasat' || next === 'solutionat') {
      if (!window.DFRegistraturaActionModal) {
        alert('Componentă modal indisponibilă. Reîncarcă pagina.');
        return;
      }
      window.DFRegistraturaActionModal.open({
        intrareId: id,
        action: next,
        onSuccess: () => loadIn(),
      });
      return;
    }
    // Restul tranzițiilor (ex. in_lucru) — fără confirmare modală.
    try {
      const r = await fetch(`/api/registratura/intrari/${id}/status`, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, _csrfHdr()),
        credentials: 'include',
        body: JSON.stringify({ status: next }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        alert('Eroare: ' + (j.error || r.status));
        return;
      }
      loadIn();
    } catch (e) { alert('Eroare rețea.'); }
  }

  async function doLink(id) {
    const flowId = prompt('ID-ul fluxului-răspuns (din /flow.html?id=…):', '');
    if (!flowId) return;
    try {
      const r = await fetch(`/api/registratura/intrari/${id}/leaga-raspuns`, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, _csrfHdr()),
        credentials: 'include',
        body: JSON.stringify({ flowId: flowId.trim() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { alert('Eroare: ' + (j.error || r.status)); return; }
      loadIn();
    } catch (e) { alert('Eroare rețea.'); }
  }

  function pickPdf() {
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'application/pdf';
      inp.onchange = () => resolve(inp.files && inp.files[0] || null);
      inp.click();
    });
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function doAttach(id) {
    const file = await pickPdf();
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { alert('Fișierul depășește 15 MB.'); return; }
    try {
      const dataUrl = await fileToBase64(file);
      const r = await fetch(`/api/registratura/intrari/${id}/atasament`, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, _csrfHdr()),
        credentials: 'include',
        body: JSON.stringify({ filename: file.name, mimeType: file.type || 'application/pdf', fileB64: dataUrl }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { alert('Eroare: ' + (j.error || r.status)); return; }
      alert('Atașament încărcat.');
    } catch (e) { alert('Eroare la upload.'); }
  }

  function wireIn() {
    $('regin-an').addEventListener('change', (e) => { stateIn.an = e.target.value || null; stateIn.page = 1; loadIn(); });
    $('regin-registru').addEventListener('change', (e) => { stateIn.registru = e.target.value || ''; stateIn.page = 1; loadIn(); });
    $('regin-status').addEventListener('change', (e) => { stateIn.status = e.target.value || ''; stateIn.page = 1; loadIn(); });
    $('regin-q').addEventListener('input', debounce((e) => { stateIn.q = e.target.value.trim(); stateIn.page = 1; loadIn(); }, 300));
    $('regin-refresh').addEventListener('click', () => loadIn());
    $('regin-prev').addEventListener('click', () => { if (stateIn.page > 1) { stateIn.page--; loadIn(); } });
    $('regin-next').addEventListener('click', () => { stateIn.page++; loadIn(); });
    $('regin-new').addEventListener('click', openModal);

    $('regin-tbody').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      if (act === 'status') doStatus(id, btn.dataset.next);
      else if (act === 'link') doLink(id);
      else if (act === 'atas') doAttach(id);
    });
  }

  // ───── Modal înregistrare intrare ─────────────────────────────────────────

  let _meCache = null;
  async function fetchMe() {
    if (_meCache) return _meCache;
    try {
      const r = await fetch('/auth/me', { credentials: 'same-origin' });
      if (!r.ok) return null;
      _meCache = await r.json();
      return _meCache;
    } catch { return null; }
  }

  function resetFilePick() {
    const fIn = $('regin-f-file'); if (fIn) fIn.value = '';
    const fBox = $('regin-f-file-name'); if (fBox) fBox.style.display = 'none';
    const fLbl = $('regin-f-file-label'); if (fLbl) fLbl.textContent = '—';
  }

  async function openModal() {
    ['regin-f-obiect','regin-f-expeditor','regin-f-comp','regin-f-nrdoc','regin-f-datadoc'].forEach((id) => { const el = $(id); if (el) el.value = ''; });
    const reg = $('regin-f-registru'); if (reg) reg.value = 'intrare';
    const mod = $('regin-f-mod'); if (mod) mod.value = '';
    resetFilePick();
    const msg = $('regin-modal-msg'); if (msg) { msg.style.display = 'none'; msg.textContent = ''; }
    $('regin-modal').style.display = 'flex';
    // Prefill compartiment din profil (rămâne editabil; server-side garantat oricum).
    try {
      const me = await fetchMe();
      const compEl = $('regin-f-comp');
      if (me && me.compartiment && compEl && !compEl.value) compEl.value = me.compartiment;
    } catch {}
  }
  function closeModal() { $('regin-modal').style.display = 'none'; resetFilePick(); }

  function fileFromInput(id) {
    const inp = $(id);
    if (!inp || !inp.files || !inp.files.length) return null;
    return inp.files[0];
  }

  async function saveModal() {
    const obiect = $('regin-f-obiect').value.trim();
    const msg = $('regin-modal-msg');
    if (!obiect) {
      if (msg) { msg.textContent = 'Obiectul este obligatoriu.'; msg.className = 'df-msg df-msg--err'; msg.style.display = ''; }
      return;
    }
    const file = fileFromInput('regin-f-file');
    if (file && file.size > 15 * 1024 * 1024) {
      if (msg) { msg.textContent = 'Fișierul depășește 15 MB.'; msg.className = 'df-msg df-msg--err'; msg.style.display = ''; }
      return;
    }
    const _dataIso = (window.df && window.df.parseDMYtoISO)
      ? window.df.parseDMYtoISO(($('regin-f-datadoc')?.value || '').trim())
      : '';
    const body = {
      registru: $('regin-f-registru').value,
      obiect,
      expeditor: $('regin-f-expeditor').value.trim(),
      compartiment: $('regin-f-comp').value.trim() || null,
      modPrimire: $('regin-f-mod').value || null,
      nrDocExpeditor: $('regin-f-nrdoc').value.trim() || null,
      dataDocExpeditor: _dataIso || null,
    };
    try {
      const r = await fetch('/api/registratura/intrari', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, _csrfHdr()),
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (msg) { msg.textContent = 'Eroare: ' + (j.error || r.status); msg.className = 'df-msg df-msg--err'; msg.style.display = ''; }
        return;
      }
      // Upload atașament dacă a fost ales fișier și avem id.
      if (file && j && j.id) {
        try {
          const dataUrl = await fileToBase64(file);
          const ru = await fetch(`/api/registratura/intrari/${j.id}/atasament`, {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, _csrfHdr()),
            credentials: 'same-origin',
            body: JSON.stringify({ filename: file.name, mimeType: file.type || 'application/pdf', fileB64: dataUrl }),
          });
          if (!ru.ok) {
            const ju = await ru.json().catch(() => ({}));
            if (msg) { msg.textContent = 'Document înregistrat, dar atașamentul a eșuat: ' + (ju.error || ru.status); msg.className = 'df-msg df-msg--err'; msg.style.display = ''; }
            loadIn();
            return;
          }
        } catch {
          if (msg) { msg.textContent = 'Document înregistrat, dar atașamentul a eșuat la upload.'; msg.className = 'df-msg df-msg--err'; msg.style.display = ''; }
          loadIn();
          return;
        }
      }
      closeModal();
      loadIn();
    } catch (e) {
      if (msg) { msg.textContent = 'Eroare de rețea.'; msg.className = 'df-msg df-msg--err'; msg.style.display = ''; }
    }
  }

  function wireModal() {
    $('regin-modal-cancel').addEventListener('click', closeModal);
    $('regin-modal-save').addEventListener('click', saveModal);
    $('regin-modal').addEventListener('click', (e) => { if (e.target.id === 'regin-modal') closeModal(); });

    const fIn  = $('regin-f-file');
    const fBtn = $('regin-f-file-btn');
    const fBox = $('regin-f-file-name');
    const fLbl = $('regin-f-file-label');
    const fClr = $('regin-f-file-clear');
    if (fIn && fBtn && fBox && fLbl && fClr) {
      fBtn.addEventListener('click', () => fIn.click());
      fIn.addEventListener('change', () => {
        const msg = $('regin-modal-msg');
        const f = fIn.files && fIn.files[0];
        if (!f) { fBox.style.display = 'none'; return; }
        if (f.type !== 'application/pdf' && !/\.pdf$/i.test(f.name)) {
          if (msg) { msg.textContent = 'Doar fișiere PDF sunt acceptate.'; msg.className = 'df-msg df-msg--err'; msg.style.display = ''; }
          fIn.value = ''; fBox.style.display = 'none'; return;
        }
        if (f.size > 15 * 1024 * 1024) {
          if (msg) { msg.textContent = 'Fișierul depășește 15 MB.'; msg.className = 'df-msg df-msg--err'; msg.style.display = ''; }
          fIn.value = ''; fBox.style.display = 'none'; return;
        }
        fLbl.textContent = f.name;
        fBox.style.display = 'flex';
      });
      fClr.addEventListener('click', () => { fIn.value = ''; fBox.style.display = 'none'; fLbl.textContent = '—'; });
    }
  }

  // ───── Init ───────────────────────────────────────────────────────────────

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
    populateYears('reg-an');
    populateYears('regin-an');
    wireOut();
    wireIn();
    wireModal();
    loadOut();
    loadIn();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
