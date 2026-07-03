/* df-transmit-modal.js — Modal pentru transmiterea internă (repartizare ad-hoc) a
 * documentului finalizat către un utilizator SAU un compartiment, cu rezoluție.
 * Oglindă simplificată a df-email-modal.js; refolosește tokens/design-ul .df-.
 *
 * API:
 *   DFTransmitModal.open(flowId, { docName, onSuccess: () => {...} });
 *
 * CSS-ul e injectat scoped sub .dft-overlay (auto-conținut, fără fișier extern).
 * Fără inline handlers (CSP-safe): totul prin addEventListener.
 */
(function () {
  'use strict';

  const MAX_REZOLUTIE = 2000;

  let _flowId = null;
  let _opts = {};
  let _rootEl = null;
  let _users = [];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function ensureStyle() {
    if (document.getElementById('dft-style')) return;
    const st = document.createElement('style');
    st.id = 'dft-style';
    st.textContent = `
.dft-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:2000;align-items:center;justify-content:center;padding:16px;}
.dft-overlay.dft-open{display:flex;}
.dft-dialog{background:var(--df-surface,#fff);color:var(--df-text,#111);border:1px solid var(--df-border-2,#ccc);border-radius:var(--df-radius-xl,14px);padding:22px 28px;width:100%;max-width:520px;position:relative;max-height:90vh;overflow-y:auto;}
.dft-close{position:absolute;top:12px;right:14px;background:none;border:none;font-size:20px;line-height:1;cursor:pointer;color:var(--df-text-3,#888);}
.dft-title{font-size:18px;font-weight:700;margin:0 24px 4px 0;}
.dft-subtitle{font-size:13px;color:var(--df-text-3,#888);margin-bottom:16px;word-break:break-word;}
.dft-field{margin-bottom:14px;}
.dft-label{display:block;font-size:13px;font-weight:600;margin-bottom:5px;}
.dft-overlay select.dft-select,
.dft-overlay textarea.dft-textarea{width:100%;box-sizing:border-box;padding:9px 11px;font-size:14px;font-family:inherit;background:var(--df-surface-2,#f6f6f8);color:var(--df-text,#111);border:1px solid var(--df-border-2,#ccc);border-radius:var(--df-radius-md,8px);}
.dft-overlay textarea.dft-textarea{resize:vertical;min-height:74px;}
.dft-hint{font-size:12px;color:var(--df-text-3,#888);margin-top:3px;}
.dft-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:18px;}
.dft-btn{padding:9px 18px;font-size:14px;font-weight:600;border-radius:var(--df-radius-md,8px);border:1px solid var(--df-border-2,#ccc);background:var(--df-surface-2,#f0f0f0);color:var(--df-text,#111);cursor:pointer;}
.dft-btn.dft-primary{background:var(--df-accent,#2563eb);border-color:var(--df-accent,#2563eb);color:#fff;}
.dft-btn:disabled{opacity:.6;cursor:default;}
.dft-msg{margin-top:12px;font-size:13px;display:none;}
.dft-msg.dft-ok{display:block;color:var(--df-success,#16a34a);}
.dft-msg.dft-err{display:block;color:var(--df-danger,#dc2626);}
`;
    document.head.appendChild(st);
  }

  function ensureDOM() {
    if (_rootEl) return;
    ensureStyle();
    const wrap = document.createElement('div');
    wrap.className = 'dft-overlay';
    wrap.id = 'dft-overlay';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.innerHTML = `
<div class="dft-dialog">
  <button class="dft-close" type="button" aria-label="Închide">✕</button>
  <div class="dft-title">📨 Transmite în aplicație</div>
  <div class="dft-subtitle" id="dft-docname"></div>

  <div class="dft-field">
    <label class="dft-label" for="dft-type">Tip destinatar</label>
    <select class="dft-select" id="dft-type">
      <option value="user">Utilizator</option>
      <option value="comp">Compartiment</option>
    </select>
  </div>

  <div class="dft-field" id="dft-user-field">
    <label class="dft-label" for="dft-user">Utilizator</label>
    <select class="dft-select" id="dft-user"></select>
  </div>

  <div class="dft-field" id="dft-comp-field" style="display:none;">
    <label class="dft-label" for="dft-comp">Compartiment</label>
    <select class="dft-select" id="dft-comp"></select>
  </div>

  <div class="dft-field">
    <label class="dft-label" for="dft-rezolutie">Rezoluție <span class="dft-hint" style="font-weight:400;">(opțional)</span></label>
    <textarea class="dft-textarea" id="dft-rezolutie" maxlength="${MAX_REZOLUTIE}" placeholder="Ex: Spre luare la cunoștință și conformare."></textarea>
  </div>

  <div class="dft-msg" id="dft-msg"></div>

  <div class="dft-actions">
    <button class="dft-btn" type="button" id="dft-cancel">Anulează</button>
    <button class="dft-btn dft-primary" type="button" id="dft-submit">Transmite</button>
  </div>
</div>`;
    document.body.appendChild(wrap);
    _rootEl = wrap;

    wrap.querySelector('.dft-close').addEventListener('click', close);
    wrap.querySelector('#dft-cancel').addEventListener('click', close);
    wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
    wrap.querySelector('#dft-type').addEventListener('change', onTypeChange);
    wrap.querySelector('#dft-submit').addEventListener('click', submit);
    document.addEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key === 'Escape' && _rootEl && _rootEl.classList.contains('dft-open')) close();
  }

  function onTypeChange() {
    const type = _rootEl.querySelector('#dft-type').value;
    _rootEl.querySelector('#dft-user-field').style.display = type === 'user' ? '' : 'none';
    _rootEl.querySelector('#dft-comp-field').style.display = type === 'comp' ? '' : 'none';
  }

  function setMsg(text, kind) {
    const el = _rootEl.querySelector('#dft-msg');
    el.textContent = text || '';
    el.className = 'dft-msg' + (kind ? ' dft-' + kind : '');
  }

  async function loadUsers() {
    const userSel = _rootEl.querySelector('#dft-user');
    const compSel = _rootEl.querySelector('#dft-comp');
    userSel.innerHTML = '';
    compSel.innerHTML = '';
    try {
      const r = await fetch('/users', { credentials: 'include' });
      _users = r.ok ? await r.json() : [];
    } catch (e) { _users = []; }
    if (!Array.isArray(_users)) _users = [];

    for (const u of _users) {
      if (!u || u.id == null) continue;
      const opt = document.createElement('option');
      opt.value = String(u.id);
      const nume = u.nume || u.name || u.email || ('#' + u.id);
      opt.textContent = u.email ? `${nume} — ${u.email}` : nume;
      userSel.appendChild(opt);
    }

    const comps = [...new Set(_users
      .map(u => (u && u.compartiment != null ? String(u.compartiment).trim() : ''))
      .filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ro'));
    for (const c of comps) {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      compSel.appendChild(opt);
    }
    if (!comps.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '(niciun compartiment)';
      opt.disabled = true;
      compSel.appendChild(opt);
    }
  }

  async function submit() {
    const btn = _rootEl.querySelector('#dft-submit');
    const type = _rootEl.querySelector('#dft-type').value;
    const rezolutie = (_rootEl.querySelector('#dft-rezolutie').value || '').trim();

    let value;
    if (type === 'user') {
      value = Number(_rootEl.querySelector('#dft-user').value);
      if (!Number.isInteger(value) || value <= 0) { setMsg('Selectează un utilizator.', 'err'); return; }
    } else {
      value = (_rootEl.querySelector('#dft-comp').value || '').trim();
      if (!value) { setMsg('Selectează un compartiment.', 'err'); return; }
    }

    const recipient = { type, value };
    if (rezolutie) recipient.rezolutie = rezolutie;

    btn.disabled = true;
    setMsg('Se transmite…', null);
    try {
      const r = await fetch(`/flows/${encodeURIComponent(_flowId)}/transmit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ recipients: [recipient] }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        const n = d.added || 0;
        if (n > 0) setMsg(`✓ Transmis — ${n} destinatar${n > 1 ? 'i' : ''}.`, 'ok');
        else setMsg('Destinatarul era deja repartizat pe acest document.', 'ok');
        if (typeof _opts.onSuccess === 'function') { try { _opts.onSuccess(); } catch (e) {} }
        setTimeout(close, 1200);
      } else {
        setMsg(d.message || d.error || 'Eroare la transmitere.', 'err');
        btn.disabled = false;
      }
    } catch (e) {
      setMsg('Eroare de rețea.', 'err');
      btn.disabled = false;
    }
  }

  function open(flowId, opts) {
    _flowId = flowId;
    _opts = opts || {};
    ensureDOM();
    _rootEl.querySelector('#dft-docname').textContent = _opts.docName || flowId || '';
    _rootEl.querySelector('#dft-type').value = 'user';
    _rootEl.querySelector('#dft-rezolutie').value = '';
    _rootEl.querySelector('#dft-submit').disabled = false;
    setMsg('', null);
    onTypeChange();
    _rootEl.classList.add('dft-open');
    loadUsers();
  }

  function close() {
    if (_rootEl) _rootEl.classList.remove('dft-open');
  }

  window.DFTransmitModal = { open, close };
})();
