/* df-email-modal.js — componentă unificată pentru trimiterea documentelor pe email.
   API public: window.openDfEmailModal({ flowId, docName, institutie?, compartiment?, onSuccess? })
   Injectează HTML-ul modalului în body la prima utilizare, gestionează chip-uri
   multi-destinatari, atașamente, și submit spre /flows/:flowId/send-email. */
(function () {
  'use strict';

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const MAX_TOTAL_BYTES = 20 * 1024 * 1024; // 20 MB

  let _state = {
    flowId: null,
    recipients: [],     // [{ email, valid }]
    extraFiles: [],     // File[]
    onSuccess: null,
  };

  // Injectează HTML-ul modalului (o singură dată)
  function ensureModal() {
    if (document.getElementById('dfEmailOverlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'dfEmailOverlay';
    overlay.className = 'df-email-overlay';
    overlay.innerHTML = `
      <div class="df-email-modal" role="dialog" aria-labelledby="dfEmailTitle">
        <button type="button" class="df-email-modal-close" id="dfEmailClose" aria-label="Închide">✕</button>
        <div class="df-email-modal-title" id="dfEmailTitle">
          <svg class="df-ico df-ico-lg" viewBox="0 0 24 24"><use href="/icons.svg?v=__V__#ico-mail"/></svg>
          Trimite document pe email
        </div>
        <div class="df-email-modal-subtitle" id="dfEmailDocLabel"></div>

        <div class="df-email-form">
          <div>
            <label>Destinatari <span class="req">*</span></label>
            <div class="df-email-chips-wrap" id="dfEmailChipsWrap">
              <input type="text" id="dfEmailChipsInput" class="df-email-chips-input"
                placeholder="ex: primar@primarie.ro (Enter, virgulă sau Tab pentru mai mulți)"
                autocomplete="off" spellcheck="false" />
            </div>
            <div class="df-email-hint">Apasă Enter, virgulă sau Tab pentru a adăuga mai multe adrese.</div>
          </div>

          <div>
            <label>Subiect <span class="req">*</span></label>
            <input id="dfEmailSubject" type="text" />
          </div>

          <div>
            <label>Mesaj personalizat <span class="opt">— opțional</span></label>
            <textarea id="dfEmailBody" rows="7"></textarea>
          </div>

          <div>
            <label>📎 Atașamente suplimentare <span class="opt">— opțional, max 20 MB total</span></label>
            <div class="df-email-attach-row">
              <button type="button" class="df-email-attach-btn" id="dfEmailAttachBtn">+ Adaugă fișier</button>
              <span class="df-email-attach-info" id="dfEmailAttachInfo">PDF semnat inclus automat</span>
            </div>
            <input id="dfEmailAttachInput" type="file" multiple accept=".pdf,.docx,.xlsx,.png,.jpg,.jpeg" style="display:none;" />
            <div class="df-email-attach-list" id="dfEmailAttachList"></div>
          </div>

          <div class="df-email-msg" id="dfEmailMsg"></div>
          <button type="button" class="df-email-submit" id="dfEmailSubmit">
            <svg class="df-ico df-ico-sm" viewBox="0 0 24 24"><use href="/icons.svg?v=__V__#ico-send"/></svg>
            Trimite email
          </button>
        </div>
      </div>
    `;
    // Înlocuiește placeholder __V__ cu versiunea curentă
    const v = detectVersion();
    overlay.innerHTML = overlay.innerHTML.replace(/__V__/g, v);
    document.body.appendChild(overlay);

    // Evenimente
    document.getElementById('dfEmailClose').addEventListener('click', closeModal);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && overlay.classList.contains('open')) closeModal();
    });

    // Chips input
    const chipsInput = document.getElementById('dfEmailChipsInput');
    const chipsWrap = document.getElementById('dfEmailChipsWrap');
    chipsWrap.addEventListener('click', e => { if (e.target === chipsWrap) chipsInput.focus(); });
    chipsInput.addEventListener('keydown', handleChipsKeydown);
    chipsInput.addEventListener('paste', handleChipsPaste);
    chipsInput.addEventListener('blur', () => flushChipInput());

    // Attachments
    document.getElementById('dfEmailAttachBtn').addEventListener('click', () => {
      document.getElementById('dfEmailAttachInput').click();
    });
    document.getElementById('dfEmailAttachInput').addEventListener('change', handleAttachChange);

    // Submit
    document.getElementById('dfEmailSubmit').addEventListener('click', doSend);
  }

  function detectVersion() {
    const links = document.querySelectorAll('link[href*="?v="]');
    for (const link of links) {
      const m = link.getAttribute('href').match(/\?v=([\d.]+)/);
      if (m) return m[1];
    }
    return '';
  }

  // === Chips ===
  function handleChipsKeydown(e) {
    const input = e.currentTarget;
    if (e.key === 'Enter' || e.key === 'Tab' || e.key === ',' || e.key === ';') {
      if (input.value.trim()) {
        e.preventDefault();
        flushChipInput();
      }
    } else if (e.key === 'Backspace' && !input.value && _state.recipients.length) {
      _state.recipients.pop();
      renderChips();
    }
  }

  function handleChipsPaste(e) {
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (!text) return;
    if (/[,;\s\n]/.test(text)) {
      e.preventDefault();
      const parts = text.split(/[,;\s\n]+/).map(s => s.trim()).filter(Boolean);
      for (const p of parts) addRecipient(p);
      renderChips();
    }
  }

  function flushChipInput() {
    const input = document.getElementById('dfEmailChipsInput');
    if (!input) return;
    const val = (input.value || '').trim().replace(/[,;]+$/, '');
    if (!val) return;
    addRecipient(val);
    input.value = '';
    renderChips();
  }

  function addRecipient(email) {
    const trimmed = email.trim();
    if (!trimmed) return;
    if (_state.recipients.some(r => r.email.toLowerCase() === trimmed.toLowerCase())) return;
    _state.recipients.push({ email: trimmed, valid: EMAIL_RE.test(trimmed) });
  }

  function removeRecipient(idx) {
    _state.recipients.splice(idx, 1);
    renderChips();
  }
  window._dfRemoveRecipient = removeRecipient;

  function renderChips() {
    const wrap = document.getElementById('dfEmailChipsWrap');
    const input = document.getElementById('dfEmailChipsInput');
    if (!wrap || !input) return;
    wrap.querySelectorAll('.df-email-chip').forEach(c => c.remove());
    _state.recipients.forEach((r, idx) => {
      const chip = document.createElement('span');
      chip.className = 'df-email-chip ' + (r.valid ? 'valid' : 'invalid');
      chip.innerHTML = escapeHtml(r.email) + `<button type="button" class="df-email-chip-x" onclick="window._dfRemoveRecipient(${idx})" aria-label="Șterge">✕</button>`;
      wrap.insertBefore(chip, input);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // === Attachments ===
  function handleAttachChange(e) {
    const input = e.currentTarget;
    const files = Array.from(input.files || []);
    for (const f of files) {
      const totalSize = _state.extraFiles.reduce((s, x) => s + x.size, 0) + f.size;
      if (totalSize > MAX_TOTAL_BYTES) {
        alert(`Depășești limita de 20 MB. „${f.name}" nu a fost adăugat.`);
        continue;
      }
      if (_state.extraFiles.some(x => x.name === f.name && x.size === f.size)) continue;
      _state.extraFiles.push(f);
    }
    input.value = '';
    renderAttachments();
  }

  function renderAttachments() {
    const list = document.getElementById('dfEmailAttachList');
    const info = document.getElementById('dfEmailAttachInfo');
    if (!list || !info) return;
    list.innerHTML = _state.extraFiles.map((f, i) => `
      <div class="df-email-attach-item">
        <span class="df-email-attach-item-icon">📄</span>
        <span class="df-email-attach-item-name">${escapeHtml(f.name)}</span>
        <span class="df-email-attach-item-size">${(f.size / 1024).toFixed(0)} KB</span>
        <button type="button" class="df-email-attach-item-remove" onclick="window._dfRemoveAttach(${i})" aria-label="Șterge">✕</button>
      </div>
    `).join('');
    const totalKB = (_state.extraFiles.reduce((s, x) => s + x.size, 0) / 1024).toFixed(0);
    info.textContent = _state.extraFiles.length
      ? `PDF semnat + ${_state.extraFiles.length} fișier(e) extra (${totalKB} KB)`
      : 'PDF semnat inclus automat';
  }

  function removeAttach(idx) {
    _state.extraFiles.splice(idx, 1);
    renderAttachments();
  }
  window._dfRemoveAttach = removeAttach;

  // === Open / Close ===
  function openModal(opts) {
    ensureModal();
    const { flowId, docName, institutie, compartiment, onSuccess } = opts || {};
    if (!flowId || !docName) { console.error('openDfEmailModal: flowId și docName sunt obligatorii'); return; }

    _state.flowId = flowId;
    _state.recipients = [];
    _state.extraFiles = [];
    _state.onSuccess = (typeof onSuccess === 'function') ? onSuccess : null;

    document.getElementById('dfEmailDocLabel').textContent = docName;
    document.getElementById('dfEmailChipsInput').value = '';
    document.getElementById('dfEmailSubject').value = `Document semnat electronic: ${docName}`;

    const u = JSON.parse(localStorage.getItem('docflow_user') || '{}');
    const senderName = u.nume || u.email || '';
    const today = new Date().toLocaleDateString('ro-RO');
    const functieStr      = u.functie                               ? `\nFuncție: ${u.functie}`                               : '';
    const institutieStr   = (u.institutie   || institutie)          ? `\nInstituție: ${u.institutie   || institutie}`          : '';
    const compartimentStr = (u.compartiment || compartiment)        ? `\nCompartiment: ${u.compartiment || compartiment}`     : '';
    document.getElementById('dfEmailBody').value =
`Stimată/e Doamnă/Domnule,

Vă transmitem atașat documentul „${docName}", în vederea aplicării prevederilor legale.

Cu stimă,
Nume: ${senderName}${functieStr}${institutieStr}${compartimentStr}
Data: ${today}`;

    document.getElementById('dfEmailMsg').textContent = '';
    document.getElementById('dfEmailMsg').className = 'df-email-msg';
    const btn = document.getElementById('dfEmailSubmit');
    btn.disabled = false;
    btn.innerHTML = '<svg class="df-ico df-ico-sm" viewBox="0 0 24 24"><use href="/icons.svg?v=' + detectVersion() + '#ico-send"/></svg>Trimite email';

    renderChips();
    renderAttachments();
    document.getElementById('dfEmailOverlay').classList.add('open');
    setTimeout(() => document.getElementById('dfEmailChipsInput').focus(), 100);
  }

  function closeModal() {
    const overlay = document.getElementById('dfEmailOverlay');
    if (overlay) overlay.classList.remove('open');
    _state.flowId = null;
    _state.recipients = [];
    _state.extraFiles = [];
    _state.onSuccess = null;
  }

  // === Submit ===
  async function doSend() {
    flushChipInput();
    const msg = document.getElementById('dfEmailMsg');
    const btn = document.getElementById('dfEmailSubmit');

    const validRecipients = _state.recipients.filter(r => r.valid).map(r => r.email);
    const invalidCount = _state.recipients.length - validRecipients.length;

    if (!validRecipients.length) {
      msg.className = 'df-email-msg err';
      msg.textContent = 'Adaugă cel puțin un destinatar cu adresă validă.';
      return;
    }
    if (invalidCount > 0) {
      msg.className = 'df-email-msg err';
      msg.textContent = `${invalidCount} adresă(e) invalidă — elimină-le sau corectează înainte de a trimite.`;
      return;
    }
    const subject = (document.getElementById('dfEmailSubject').value || '').trim();
    const bodyText = (document.getElementById('dfEmailBody').value || '').trim();
    if (!subject) {
      msg.className = 'df-email-msg err';
      msg.textContent = 'Subiectul este obligatoriu.';
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span>⏳</span> Se trimite...';
    msg.textContent = '';
    msg.className = 'df-email-msg';

    const extraAttachments = [];
    for (const f of _state.extraFiles) {
      const b64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = e => res(e.target.result);
        r.onerror = rej;
        r.readAsDataURL(f);
      });
      extraAttachments.push({ filename: f.name, dataB64: b64 });
    }

    try {
      const jwt = localStorage.getItem('docflow_token') || localStorage.getItem('jwt') || '';
      const body = {
        to: validRecipients.length === 1 ? validRecipients[0] : validRecipients,
        subject,
        bodyText,
        extraAttachments,
      };
      const r = await fetch(`/flows/${encodeURIComponent(_state.flowId)}/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(jwt ? { 'Authorization': 'Bearer ' + jwt } : {}) },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (r.ok) {
        msg.className = 'df-email-msg ok';
        msg.textContent = validRecipients.length === 1
          ? `✅ Email trimis cu succes către ${validRecipients[0]}`
          : `✅ Email trimis cu succes către ${validRecipients.length} destinatari`;
        btn.innerHTML = '<span>✅</span> Trimis!';
        const cb = _state.onSuccess;
        setTimeout(() => {
          closeModal();
          if (cb) try { cb(); } catch (_) {}
        }, 1500);
      } else {
        msg.className = 'df-email-msg err';
        msg.textContent = `❌ ${d.message || d.error || 'Eroare la trimitere.'}`;
        btn.disabled = false;
        btn.innerHTML = '<svg class="df-ico df-ico-sm" viewBox="0 0 24 24"><use href="/icons.svg?v=' + detectVersion() + '#ico-send"/></svg>Trimite email';
      }
    } catch (e) {
      msg.className = 'df-email-msg err';
      msg.textContent = '❌ Eroare de rețea.';
      btn.disabled = false;
      btn.innerHTML = '<svg class="df-ico df-ico-sm" viewBox="0 0 24 24"><use href="/icons.svg?v=' + detectVersion() + '#ico-send"/></svg>Trimite email';
    }
  }

  // === API public ===
  window.openDfEmailModal = openModal;
})();
