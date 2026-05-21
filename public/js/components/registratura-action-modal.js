/* registratura-action-modal.js — modal acțiuni Registratură Intrări.
 *
 * API:
 *   window.DFRegistraturaActionModal.open({ intrareId, action, onSuccess })
 *
 * action ∈ { 'repartizat', 'clasat', 'solutionat' }
 *
 * Convenții (skill docflowai-ui):
 *   - clase .df-modal-bg, .df-modal, .df-frow, .df-modal-acts, .df-action-btn
 *   - culori prin var(--df-*)
 *   - CSRF prin window.df.getCsrf() + credentials:'include'
 *   - escaping prin window.df.esc()
 *   - aria-modal + Esc close + click backdrop close
 *
 * Dependențe: window.df.esc, window.df.getCsrf (din df-utils.js).
 */
(function () {
  'use strict';

  const esc = (s) => (window.df && window.df.esc ? window.df.esc(s) : String(s == null ? '' : s));
  const csrf = () => (window.df && window.df.getCsrf ? window.df.getCsrf() : '');
  const CACHE_TTL_MS = 5 * 60 * 1000;

  let _rootEl = null;
  let _opts = {};
  let _asignatariCache = null;
  let _asignatariAt = 0;

  function getStr(o, k) { return String((o && o[k]) || '').trim(); }

  async function loadAsignatari(force) {
    const now = Date.now();
    if (!force && _asignatariCache && (now - _asignatariAt) < CACHE_TTL_MS) {
      return _asignatariCache;
    }
    const r = await fetch('/api/registratura/asignatari', { credentials: 'include' });
    if (!r.ok) throw new Error('asignatari_fetch_failed');
    const j = await r.json();
    _asignatariCache = { compartimente: j.compartimente || [], users: j.users || [] };
    _asignatariAt = now;
    return _asignatariCache;
  }

  function buildHtml(action) {
    const titles = {
      repartizat: 'Repartizare intrare',
      clasat:     'Clasare intrare',
      solutionat: 'Soluționare intrare',
    };
    const submitLabels = {
      repartizat: 'Repartizează',
      clasat:     'Clasează',
      solutionat: 'Soluționează',
    };
    const submitVariants = {
      repartizat: 'primary',
      clasat:     'warning',
      solutionat: 'success',
    };
    const title = titles[action] || 'Acțiune';
    const submitLabel = submitLabels[action] || 'Confirmă';
    const submitVariant = submitVariants[action] || 'primary';

    let body = '';
    if (action === 'repartizat') {
      body = `
        <div class="df-frow">
          <label for="df-reg-am-comp" style="display:block;font-size:.75rem;margin-bottom:5px;">Compartiment</label>
          <select id="df-reg-am-comp" style="width:100%;padding:8px;border:1px solid var(--df-border);border-radius:6px;background:var(--df-surface);color:var(--df-text);">
            <option value="">— alege compartiment —</option>
          </select>
        </div>
        <div class="df-frow">
          <label for="df-reg-am-pers" style="display:block;font-size:.75rem;margin-bottom:5px;">Persoană (opțional)</label>
          <select id="df-reg-am-pers" style="width:100%;padding:8px;border:1px solid var(--df-border);border-radius:6px;background:var(--df-surface);color:var(--df-text);">
            <option value="">— oricine din compartiment —</option>
          </select>
        </div>
        <div class="df-frow">
          <label for="df-reg-am-rez" style="display:block;font-size:.75rem;margin-bottom:5px;">Rezoluție (opțional, max 500)</label>
          <textarea id="df-reg-am-rez" rows="3" maxlength="500" style="width:100%;padding:8px;border:1px solid var(--df-border);border-radius:6px;background:var(--df-surface);color:var(--df-text);resize:vertical;"></textarea>
        </div>`;
    } else if (action === 'clasat') {
      body = `
        <div class="df-frow">
          <label for="df-reg-am-mot" style="display:block;font-size:.75rem;margin-bottom:5px;">Motiv clasare <span style="color:var(--df-danger);">*</span></label>
          <textarea id="df-reg-am-mot" rows="4" maxlength="500" minlength="3" required style="width:100%;padding:8px;border:1px solid var(--df-border);border-radius:6px;background:var(--df-surface);color:var(--df-text);resize:vertical;"></textarea>
          <div id="df-reg-am-mot-hint" style="font-size:.7rem;color:var(--df-text-3);margin-top:4px;">Minim 3 caractere, maxim 500.</div>
        </div>`;
    } else if (action === 'solutionat') {
      body = `
        <div class="df-frow">
          <p style="margin:0 0 10px 0;color:var(--df-text-2);">Marchezi această intrare ca soluționată.</p>
          <label for="df-reg-am-rez" style="display:block;font-size:.75rem;margin-bottom:5px;">Rezoluție (opțional, max 500)</label>
          <textarea id="df-reg-am-rez" rows="3" maxlength="500" style="width:100%;padding:8px;border:1px solid var(--df-border);border-radius:6px;background:var(--df-surface);color:var(--df-text);resize:vertical;"></textarea>
        </div>`;
    }

    return `
<div class="df-modal-bg" id="df-reg-am-bg" role="dialog" aria-modal="true" aria-labelledby="df-reg-am-title" style="display:flex;align-items:center;justify-content:center;">
  <div class="df-modal" style="max-width:520px;width:90%;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
      <h3 id="df-reg-am-title" style="margin:0;font-size:1.05rem;">${esc(title)}</h3>
      <button type="button" class="df-modal-close" id="df-reg-am-close" aria-label="Închide" style="background:none;border:0;font-size:1.4rem;line-height:1;cursor:pointer;color:var(--df-text-3);">&times;</button>
    </div>
    <div id="df-reg-am-body">${body}</div>
    <div id="df-reg-am-err" style="display:none;font-size:.8rem;color:var(--df-danger);margin-top:8px;"></div>
    <div class="df-modal-acts" style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
      <button type="button" class="df-action-btn" id="df-reg-am-cancel">Anulează</button>
      <button type="button" class="df-action-btn ${submitVariant}" id="df-reg-am-submit">${esc(submitLabel)}</button>
    </div>
  </div>
</div>`;
  }

  function populateRepartizatSelects(asign) {
    const compSel = _rootEl.querySelector('#df-reg-am-comp');
    const persSel = _rootEl.querySelector('#df-reg-am-pers');
    (asign.compartimente || []).forEach(c => {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      compSel.appendChild(opt);
    });
    // Persoane: re-populare la schimbarea compartimentului.
    compSel.addEventListener('change', () => {
      while (persSel.options.length > 1) persSel.remove(1);
      const sel = compSel.value;
      (asign.users || []).forEach(u => {
        const uComp = String(u.compartiment || '').trim();
        if (sel && uComp !== sel) return;
        const opt = document.createElement('option');
        opt.value = String(u.nume || '');
        opt.textContent = String(u.nume || '');
        persSel.appendChild(opt);
      });
    });
  }

  function setErr(text) {
    const el = _rootEl.querySelector('#df-reg-am-err');
    if (!el) return;
    if (!text) { el.style.display = 'none'; el.textContent = ''; return; }
    el.textContent = text;
    el.style.display = 'block';
  }

  function setSubmitDisabled(yes) {
    const btn = _rootEl.querySelector('#df-reg-am-submit');
    if (btn) btn.disabled = !!yes;
  }

  function buildPayload(action) {
    if (action === 'repartizat') {
      const comp = getStr({ v: _rootEl.querySelector('#df-reg-am-comp').value }, 'v');
      const pers = getStr({ v: _rootEl.querySelector('#df-reg-am-pers').value }, 'v');
      const rez  = getStr({ v: _rootEl.querySelector('#df-reg-am-rez').value }, 'v');
      const where = pers ? (comp ? `${comp} / ${pers}` : pers) : comp;
      if (!where) return { _err: 'Alege un compartiment.' };
      const out = { status: 'repartizat', repartizatLa: where };
      if (rez) out.rezolutie = rez;
      return out;
    }
    if (action === 'clasat') {
      const mot = getStr({ v: _rootEl.querySelector('#df-reg-am-mot').value }, 'v');
      if (mot.length < 3) return { _err: 'Motivul trebuie să aibă minim 3 caractere.' };
      return { status: 'clasat', motivClasare: mot };
    }
    if (action === 'solutionat') {
      const rez = getStr({ v: _rootEl.querySelector('#df-reg-am-rez').value }, 'v');
      const out = { status: 'solutionat' };
      if (rez) out.rezolutie = rez;
      return out;
    }
    return { _err: 'Acțiune necunoscută.' };
  }

  async function submit() {
    const action = _opts.action;
    const id = _opts.intrareId;
    const payload = buildPayload(action);
    if (payload._err) { setErr(payload._err); return; }
    setErr('');
    setSubmitDisabled(true);
    try {
      const r = await fetch(`/api/registratura/intrari/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf() },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = j.error === 'motiv_obligatoriu'
          ? 'Motivul clasării este obligatoriu.'
          : ('Eroare: ' + (j.error || r.status));
        setErr(msg);
        setSubmitDisabled(false);
        return;
      }
      close();
      if (typeof _opts.onSuccess === 'function') _opts.onSuccess();
    } catch (e) {
      setErr('Eroare de rețea.');
      setSubmitDisabled(false);
    }
  }

  function wireListeners(action) {
    _rootEl.querySelector('#df-reg-am-close').addEventListener('click', close);
    _rootEl.querySelector('#df-reg-am-cancel').addEventListener('click', close);
    _rootEl.querySelector('#df-reg-am-submit').addEventListener('click', submit);
    _rootEl.addEventListener('click', (e) => { if (e.target === _rootEl) close(); });

    if (action === 'clasat') {
      const mot = _rootEl.querySelector('#df-reg-am-mot');
      const update = () => setSubmitDisabled(mot.value.trim().length < 3);
      mot.addEventListener('input', update);
      update();
    }
  }

  function focusFirst(action) {
    let sel = '#df-reg-am-mot';
    if (action === 'repartizat') sel = '#df-reg-am-comp';
    else if (action === 'solutionat') sel = '#df-reg-am-rez';
    const el = _rootEl && _rootEl.querySelector(sel);
    if (el) try { el.focus(); } catch (_) {}
  }

  function onKey(e) {
    if (e.key === 'Escape' && _rootEl && _rootEl.style.display !== 'none') close();
  }

  async function open(opts) {
    _opts = opts || {};
    const action = _opts.action;
    if (!['repartizat', 'clasat', 'solutionat'].includes(action)) {
      alert('Acțiune nevalidă: ' + action);
      return;
    }
    // Construiește DOM nou de fiecare dată (conținut diferă pe acțiune).
    if (_rootEl) { try { document.body.removeChild(_rootEl); } catch (_) {} _rootEl = null; }
    const wrap = document.createElement('div');
    wrap.innerHTML = buildHtml(action).trim();
    _rootEl = wrap.firstChild;
    document.body.appendChild(_rootEl);

    wireListeners(action);

    if (action === 'repartizat') {
      try {
        const asign = await loadAsignatari(false);
        populateRepartizatSelects(asign);
      } catch (e) {
        setErr('Nu am putut încărca lista de compartimente/utilizatori.');
      }
    }

    document.addEventListener('keydown', onKey);
    focusFirst(action);
  }

  function close() {
    if (!_rootEl) return;
    document.removeEventListener('keydown', onKey);
    try { document.body.removeChild(_rootEl); } catch (_) {}
    _rootEl = null;
    _opts = {};
  }

  window.DFRegistraturaActionModal = { open, close };
})();
