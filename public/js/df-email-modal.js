/* df-email-modal.js — Modal unificat pentru trimiterea documentelor semnate pe email.
 * Folosit din semdoc-initiator.html și flow.html (înlocuiește cod duplicat).
 *
 * API:
 *   DFEmailModal.open(flowId, {
 *     docName, institutie, compartiment,
 *     onSuccess: () => { ... },
 *   });
 *
 * Chip-uri multi-destinatari: Enter, virgulă, Tab, paste cu separatori,
 * backspace pe empty input pentru ștergere ultim chip.
 * Max 20 destinatari, max 20 MB atașamente totale.
 */
(function () {
  'use strict';

  const MAX_RECIPIENTS = 20;
  const MAX_ATTACH_BYTES = 20 * 1024 * 1024;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  let _flowId = null;
  let _opts = {};
  let _recipients = [];
  let _attachments = [];
  let _rootEl = null;
  let _acResults = [];
  let _acActive = -1;
  let _acTimer = null;

  function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  function ensureDOM() {
    if (_rootEl) return;
    const html = `
<div class="dfem-overlay" id="dfem-overlay" role="dialog" aria-modal="true" aria-labelledby="dfem-title">
  <div class="dfem-dialog">
    <button class="dfem-close" type="button" aria-label="Închide">✕</button>
    <div class="dfem-title" id="dfem-title">
      <svg class="df-ico df-ico-lg" viewBox="0 0 24 24"><use href="/icons.svg?v=3.9.284#ico-mail"/></svg>
      Trimite document pe email
    </div>
    <div class="dfem-subtitle" id="dfem-docname"></div>

    <div class="dfem-form">
      <div class="dfem-field">
        <label class="dfem-label" for="dfem-to-input">
          Destinatari<span class="dfem-req">*</span>
          <span class="dfem-hint">— Enter, virgulă sau Tab pentru a adăuga</span>
        </label>
        <div class="dfem-chip-wrap" id="dfem-chip-wrap">
          <input class="dfem-chip-input" id="dfem-to-input" type="text" placeholder="ex: primar@primarie.ro" autocomplete="off" />
        </div>
        <div class="dfem-ac-dropdown" id="dfem-ac-dropdown" style="display:none;"></div>
      </div>

      <div class="dfem-field">
        <label class="dfem-label" for="dfem-subject">Subiect<span class="dfem-req">*</span></label>
        <input class="dfem-input" id="dfem-subject" type="text" />
      </div>

      <div class="dfem-field">
        <label class="dfem-label" for="dfem-body">
          Mesaj personalizat<span class="dfem-hint">— opțional</span>
        </label>
        <textarea class="dfem-textarea" id="dfem-body" rows="7"></textarea>
      </div>

      <div class="dfem-field">
        <label class="dfem-label">
          <svg class="df-ico df-ico-sm" viewBox="0 0 24 24"><use href="/icons.svg?v=3.9.284#ico-paperclip"/></svg>
          Atașamente suplimentare<span class="dfem-hint">— opțional, max 20 MB total</span>
        </label>
        <div class="dfem-attach-row">
          <button type="button" class="dfem-attach-btn" id="dfem-attach-btn">+ Adaugă fișier</button>
          <span class="dfem-attach-info" id="dfem-attach-info">PDF semnat inclus automat</span>
        </div>
        <input type="file" id="dfem-attach-input" multiple accept=".pdf,.docx,.xlsx,.png,.jpg,.jpeg" style="display:none;" />
        <div class="dfem-attach-list" id="dfem-attach-list"></div>
      </div>

      <div class="dfem-msg" id="dfem-msg"></div>

      <button class="dfem-submit" id="dfem-submit" type="button">
        <svg viewBox="0 0 24 24"><use href="/icons.svg?v=3.9.284#ico-send"/></svg>
        <span>Trimite email</span>
      </button>
    </div>
  </div>
</div>`;
    const wrap = document.createElement('div');
    wrap.innerHTML = html.trim();
    _rootEl = wrap.firstChild;
    document.body.appendChild(_rootEl);

    _rootEl.querySelector('.dfem-close').addEventListener('click', close);
    _rootEl.addEventListener('click', e => { if (e.target === _rootEl) close(); });

    const input = _rootEl.querySelector('#dfem-to-input');
    input.addEventListener('keydown', onInputKeydown);
    input.addEventListener('paste', onInputPaste);
    input.addEventListener('input', onInputChange);
    input.addEventListener('blur', () => { setTimeout(() => closeAcDropdown(), 150); tryAddFromInput(); });
    _rootEl.querySelector('#dfem-chip-wrap').addEventListener('click', () => input.focus());

    _rootEl.querySelector('#dfem-attach-btn').addEventListener('click', () => _rootEl.querySelector('#dfem-attach-input').click());
    _rootEl.querySelector('#dfem-attach-input').addEventListener('change', onAttachChange);

    _rootEl.querySelector('#dfem-submit').addEventListener('click', onSubmit);

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && _rootEl && _rootEl.classList.contains('dfem-open')) close();
    });
  }

  function renderChips() {
    const wrap = _rootEl.querySelector('#dfem-chip-wrap');
    const input = _rootEl.querySelector('#dfem-to-input');
    wrap.querySelectorAll('.dfem-chip').forEach(c => c.remove());
    _recipients.forEach((r, idx) => {
      const chip = document.createElement('span');
      chip.className = 'dfem-chip' + (r.valid ? '' : ' dfem-chip-invalid');
      chip.title = r.valid ? r.email : r.email + ' — adresă invalidă';
      chip.innerHTML = `<span class="dfem-chip-text">${esc(r.email)}</span><button type="button" class="dfem-chip-remove" aria-label="Șterge">×</button>`;
      chip.querySelector('.dfem-chip-remove').addEventListener('click', () => {
        _recipients.splice(idx, 1);
        renderChips();
      });
      wrap.insertBefore(chip, input);
    });
  }

  function addRecipient(email) {
    const e = (email || '').trim().replace(/^[<,;\s]+|[>,;\s]+$/g, '');
    if (!e) return false;
    if (_recipients.length >= MAX_RECIPIENTS) return false;
    if (_recipients.some(r => r.email.toLowerCase() === e.toLowerCase())) return false;
    _recipients.push({ email: e, valid: EMAIL_RE.test(e) });
    return true;
  }

  function tryAddFromInput() {
    const input = _rootEl.querySelector('#dfem-to-input');
    const v = input.value.trim();
    if (!v) return;
    const parts = v.split(/[,;\s]+/).filter(Boolean);
    let added = false;
    for (const p of parts) if (addRecipient(p)) added = true;
    if (added) { input.value = ''; renderChips(); }
  }

  function onInputKeydown(e) {
    const input = e.target;
    if (_acResults.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); _acActive = Math.min(_acActive + 1, _acResults.length - 1); renderAcDropdown(); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); _acActive = Math.max(_acActive - 1, -1); renderAcDropdown(); return; }
      if (e.key === 'Enter' && _acActive >= 0) { e.preventDefault(); selectAcResult(_acResults[_acActive]); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeAcDropdown(); return; }
    }
    if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
      if (input.value.trim()) {
        e.preventDefault();
        closeAcDropdown();
        tryAddFromInput();
      }
      return;
    }
    if (e.key === 'Backspace' && !input.value && _recipients.length) {
      _recipients.pop();
      renderChips();
    }
  }

  function onInputPaste(e) {
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (!text) return;
    if (/[,;\s]/.test(text)) {
      e.preventDefault();
      const parts = text.split(/[,;\s\n]+/).filter(Boolean);
      let added = false;
      for (const p of parts) if (addRecipient(p)) added = true;
      if (added) renderChips();
    }
  }

  function onInputChange(e) {
    const q = (e.target.value || '').trim();
    clearTimeout(_acTimer);
    if (q.length < 2) { closeAcDropdown(); return; }
    _acTimer = setTimeout(() => fetchAcResults(q), 220);
  }

  async function fetchAcResults(q) {
    try {
      const r = await fetch(`/admin/outreach/search?q=${encodeURIComponent(q)}`, { credentials: 'include' });
      if (!r.ok) return;
      const d = await r.json();
      _acResults = d.results || [];
      _acActive = -1;
      renderAcDropdown();
    } catch (_) { /* non-fatal */ }
  }

  function renderAcDropdown() {
    const drop = _rootEl.querySelector('#dfem-ac-dropdown');
    if (!drop) return;
    if (!_acResults.length) { drop.style.display = 'none'; return; }
    drop.innerHTML = _acResults.map((item, i) => {
      const cls = 'dfem-ac-item' + (i === _acActive ? ' dfem-ac-item-active' : '');
      return `<div class="${cls}" data-idx="${i}">
        <span class="dfem-ac-name">${esc(item.institutie)}</span>
        <span class="dfem-ac-email">${esc(item.email)}</span>
        ${item.localitate ? `<span class="dfem-ac-loc">${esc(item.localitate)}${item.judet ? ', ' + esc(item.judet) : ''}</span>` : ''}
      </div>`;
    }).join('');
    drop.querySelectorAll('.dfem-ac-item').forEach(el => {
      el.addEventListener('mousedown', ev => { ev.preventDefault(); selectAcResult(_acResults[parseInt(el.dataset.idx, 10)]); });
    });
    drop.style.display = 'block';
  }

  function selectAcResult(item) {
    if (!item) return;
    addRecipient(item.email);
    renderChips();
    _rootEl.querySelector('#dfem-to-input').value = '';
    closeAcDropdown();
  }

  function closeAcDropdown() {
    _acResults = [];
    _acActive = -1;
    const drop = _rootEl && _rootEl.querySelector('#dfem-ac-dropdown');
    if (drop) drop.style.display = 'none';
  }

  function onAttachChange(e) {
    const files = Array.from(e.target.files || []);
    for (const f of files) {
      const total = _attachments.reduce((s, x) => s + x.size, 0) + f.size;
      if (total > MAX_ATTACH_BYTES) { alert(`Depășești limita de 20 MB. "${f.name}" nu a fost adăugat.`); continue; }
      if (_attachments.some(x => x.name === f.name && x.size === f.size)) continue;
      _attachments.push(f);
    }
    e.target.value = '';
    renderAttachments();
  }

  function renderAttachments() {
    const list = _rootEl.querySelector('#dfem-attach-list');
    const info = _rootEl.querySelector('#dfem-attach-info');
    list.innerHTML = _attachments.map((f, i) => `
      <div class="dfem-attach-item">
        <span class="dfem-attach-item-name">📄 ${esc(f.name)}</span>
        <span class="dfem-attach-item-size">${(f.size/1024).toFixed(0)} KB</span>
        <button type="button" class="dfem-attach-item-remove" data-idx="${i}">✕</button>
      </div>`).join('');
    list.querySelectorAll('.dfem-attach-item-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        _attachments.splice(parseInt(btn.dataset.idx, 10), 1);
        renderAttachments();
      });
    });
    const kb = (_attachments.reduce((s, x) => s + x.size, 0) / 1024).toFixed(0);
    info.textContent = _attachments.length
      ? `PDF semnat + ${_attachments.length} fișier(e) extra (${kb} KB)`
      : 'PDF semnat inclus automat';
  }

  function setMsg(text, kind) {
    const el = _rootEl.querySelector('#dfem-msg');
    el.textContent = text || '';
    el.className = 'dfem-msg' + (kind === 'err' ? ' dfem-msg-err' : kind === 'ok' ? ' dfem-msg-ok' : '');
  }

  async function onSubmit() {
    tryAddFromInput();
    const valid = _recipients.filter(r => r.valid).map(r => r.email);
    const invalid = _recipients.filter(r => !r.valid).map(r => r.email);

    if (invalid.length) { setMsg(`Adrese invalide: ${invalid.join(', ')}`, 'err'); return; }
    if (!valid.length) { setMsg('Adaugă cel puțin un destinatar.', 'err'); return; }

    const subject = (_rootEl.querySelector('#dfem-subject').value || '').trim();
    const bodyText = (_rootEl.querySelector('#dfem-body').value || '').trim();
    if (!subject) { setMsg('Subiectul este obligatoriu.', 'err'); return; }

    const btn = _rootEl.querySelector('#dfem-submit');
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Se trimite…';
    setMsg('');

    const extraAttachments = [];
    for (const f of _attachments) {
      const b64 = await new Promise((res, rej) => {
        const r = new FileReader(); r.onload = e => res(e.target.result); r.onerror = rej; r.readAsDataURL(f);
      });
      extraAttachments.push({ filename: f.name, dataB64: b64 });
    }

    try {
      const jwt = localStorage.getItem('docflow_token') || localStorage.getItem('jwt') || '';
      const r = await fetch(`/flows/${encodeURIComponent(_flowId)}/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(jwt ? { 'Authorization': 'Bearer ' + jwt } : {}) },
        credentials: 'include',
        body: JSON.stringify({ to: valid, subject, bodyText, extraAttachments }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        const n = d.sent || valid.length;
        setMsg(`✓ Email trimis cu succes către ${n} destinatar${n > 1 ? 'i' : ''}.`, 'ok');
        btn.querySelector('span').textContent = 'Trimis!';
        setTimeout(() => { close(); if (typeof _opts.onSuccess === 'function') _opts.onSuccess(); }, 1500);
      } else {
        setMsg(d.message || d.error || 'Eroare la trimitere.', 'err');
        btn.disabled = false; btn.querySelector('span').textContent = 'Trimite email';
      }
    } catch (e) {
      setMsg('Eroare de rețea.', 'err');
      btn.disabled = false; btn.querySelector('span').textContent = 'Trimite email';
    }
  }

  async function open(flowId, opts) {
    ensureDOM();
    _flowId = flowId;
    _opts = opts || {};
    _recipients = [];
    _attachments = [];

    let docName = _opts.docName;
    let institutie = _opts.institutie;
    let compartiment = _opts.compartiment;

    if (!docName) {
      try {
        const jwt = localStorage.getItem('docflow_token') || localStorage.getItem('jwt') || '';
        const r = await fetch(`/flows/${encodeURIComponent(flowId)}`, {
          headers: jwt ? { 'Authorization': 'Bearer ' + jwt } : {},
          credentials: 'include',
        });
        const j = await r.json();
        const f = j.data || j || {};
        docName = f.docName || flowId;
        institutie = institutie || f.institutie;
        compartiment = compartiment || f.compartiment;
      } catch (_) { docName = flowId; }
    }

    const u = JSON.parse(localStorage.getItem('docflow_user') || '{}');
    const senderName = u.nume || u.email || '';
    const today = new Date().toLocaleDateString('ro-RO');
    const functieStr = u.functie ? `\nFuncție: ${u.functie}` : '';
    const institutieStr = (u.institutie || institutie) ? `\nInstituție: ${u.institutie || institutie}` : '';
    const compartimentStr = (u.compartiment || compartiment) ? `\nCompartiment: ${u.compartiment || compartiment}` : '';

    _rootEl.querySelector('#dfem-docname').textContent = docName;
    _rootEl.querySelector('#dfem-subject').value = `Document semnat electronic: ${docName}`;
    _rootEl.querySelector('#dfem-body').value =
`Stimată/e Doamnă/Domnule,

Vă transmitem atașat documentul „${docName}", în vederea aplicării prevederilor legale.

Cu stimă,
Nume: ${senderName}${functieStr}${institutieStr}${compartimentStr}
Data: ${today}`;
    _rootEl.querySelector('#dfem-to-input').value = '';
    setMsg('');
    const btn = _rootEl.querySelector('#dfem-submit');
    btn.disabled = false; btn.querySelector('span').textContent = 'Trimite email';

    renderChips();
    renderAttachments();
    _rootEl.classList.add('dfem-open');
    setTimeout(() => {
      const inner = _rootEl.querySelector('.dfem-inner');
      if (inner) inner.scrollTop = 0;
      _rootEl.querySelector('#dfem-to-input').focus();
    }, 100);
  }

  function close() {
    if (!_rootEl) return;
    _rootEl.classList.remove('dfem-open');
    closeAcDropdown();
    _flowId = null;
    _opts = {};
  }

  window.DFEmailModal = { open, close };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureDOM);
  } else {
    ensureDOM();
  }
})();
