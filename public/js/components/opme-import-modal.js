/* opme-import-modal.js — modal global pentru upload F1129 OPME.
 *
 * API:
 *   window.DFOpmeImportModal.open({ onSuccess: (match_report) => void })
 *
 * Flux:
 *   1) Drag&drop sau click pe „Alege fișier" → validare client (.pdf, ≤5 MB)
 *   2) Preview: nume + dimensiune + buton „Încarcă"
 *   3) XHR POST /api/opme/import cu progres
 *   4) 201 → toast verde + onSuccess(match_report); 409 → toast galben cu
 *      link „Vezi import existent"; 4xx/5xx → toast roșu.
 *
 * Dependențe: window.df.esc, window.df.getCsrf (din df-utils.js).
 */
(function () {
  'use strict';

  const MAX_BYTES = 5 * 1024 * 1024;
  const esc = (s) => (window.df && window.df.esc ? window.df.esc(s) : String(s || ''));
  const csrf = () => (window.df && window.df.getCsrf ? window.df.getCsrf() : '');

  let _rootEl = null;
  let _selectedFile = null;
  let _opts = {};

  function ensureDOM() {
    if (_rootEl) return;
    const html = `
<div class="df-opme-overlay" id="df-opme-overlay" role="dialog" aria-modal="true" aria-labelledby="df-opme-title">
  <div class="df-opme-dialog">
    <button class="df-opme-close" type="button" aria-label="Închide">&times;</button>
    <div class="df-opme-title" id="df-opme-title">
      <svg class="df-ico df-ico-lg"><use href="/icons.svg?v=3.9.469#ico-upload-cloud"/></svg>
      Import OPME — F1129
    </div>
    <div class="df-opme-subtitle">Ordine de plată multiple (formular F1129 generat de Forexebug). Maxim 5&nbsp;MB.</div>

    <div class="df-opme-modal__dropzone" id="df-opme-dropzone" tabindex="0" role="button">
      <svg class="df-ico df-ico-xl df-opme-modal__dz-icon"><use href="/icons.svg?v=3.9.469#ico-upload"/></svg>
      <div class="df-opme-modal__dz-text">
        <strong>Trage fișierul aici</strong> sau
        <button type="button" class="df-opme-modal__dz-btn" id="df-opme-btn-pick">Alege fișier</button>
      </div>
      <div class="df-opme-modal__dz-hint">Doar PDF F1129 · max 5 MB</div>
      <input type="file" id="df-opme-file-input" accept=".pdf,application/pdf" style="display:none">
    </div>

    <div class="df-opme-preview" id="df-opme-preview" style="display:none">
      <div class="df-opme-preview__row">
        <svg class="df-ico"><use href="/icons.svg?v=3.9.469#ico-file-text"/></svg>
        <span class="df-opme-preview__name" id="df-opme-preview-name">—</span>
        <span class="df-opme-preview__size" id="df-opme-preview-size">—</span>
        <button type="button" class="df-opme-preview__remove" id="df-opme-btn-remove" title="Elimină">&times;</button>
      </div>
    </div>

    <div class="df-opme-progress" id="df-opme-progress" style="display:none">
      <div class="df-opme-progress__bar" id="df-opme-progress-bar"></div>
      <div class="df-opme-progress__text" id="df-opme-progress-text">Se încarcă…</div>
    </div>

    <div class="df-opme-msg" id="df-opme-msg" style="display:none"></div>

    <div class="df-modal-footer">
      <button type="button" class="df-action-btn" id="df-opme-btn-cancel">Anulează</button>
      <button type="button" class="df-action-btn primary" id="df-opme-btn-upload" disabled>
        <svg class="df-ico"><use href="/icons.svg?v=3.9.469#ico-upload-cloud"/></svg>
        Încarcă
      </button>
    </div>
  </div>
</div>`;
    const wrap = document.createElement('div');
    wrap.innerHTML = html.trim();
    _rootEl = wrap.firstChild;
    document.body.appendChild(_rootEl);

    const dz = _rootEl.querySelector('#df-opme-dropzone');
    const input = _rootEl.querySelector('#df-opme-file-input');
    const pickBtn = _rootEl.querySelector('#df-opme-btn-pick');

    _rootEl.querySelector('.df-opme-close').addEventListener('click', close);
    _rootEl.addEventListener('click', e => { if (e.target === _rootEl) close(); });
    _rootEl.querySelector('#df-opme-btn-cancel').addEventListener('click', close);
    _rootEl.querySelector('#df-opme-btn-remove').addEventListener('click', removeFile);
    _rootEl.querySelector('#df-opme-btn-upload').addEventListener('click', upload);

    pickBtn.addEventListener('click', (e) => { e.stopPropagation(); input.click(); });
    dz.addEventListener('click', (e) => {
      if (e.target.closest('.df-opme-modal__dz-btn')) return;
      input.click();
    });
    dz.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    input.addEventListener('change', () => { if (input.files && input.files[0]) handleFile(input.files[0]); });

    ['dragenter', 'dragover'].forEach(ev => {
      dz.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); dz.classList.add('is-dragover'); });
    });
    ['dragleave', 'drop'].forEach(ev => {
      dz.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); dz.classList.remove('is-dragover'); });
    });
    dz.addEventListener('drop', e => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && _rootEl && _rootEl.classList.contains('df-opme-open')) close();
    });
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function setMsg(text, type) {
    const el = _rootEl.querySelector('#df-opme-msg');
    if (!text) { el.style.display = 'none'; el.textContent = ''; el.className = 'df-opme-msg'; return; }
    el.textContent = text;
    el.className = 'df-opme-msg df-opme-msg--' + (type || 'info');
    el.style.display = 'block';
  }

  function handleFile(file) {
    setMsg('', null);
    if (!file) return;
    const name = (file.name || '').toLowerCase();
    if (!name.endsWith('.pdf') && file.type && file.type !== 'application/pdf') {
      setMsg('Doar fișiere PDF F1129 sunt acceptate.', 'err');
      return;
    }
    if (file.size > MAX_BYTES) {
      setMsg('Fișierul depășește 5 MB.', 'err');
      return;
    }
    _selectedFile = file;
    _rootEl.querySelector('#df-opme-preview-name').textContent = file.name;
    _rootEl.querySelector('#df-opme-preview-size').textContent = fmtBytes(file.size);
    _rootEl.querySelector('#df-opme-preview').style.display = '';
    _rootEl.querySelector('#df-opme-dropzone').style.display = 'none';
    _rootEl.querySelector('#df-opme-btn-upload').disabled = false;
  }

  function removeFile() {
    _selectedFile = null;
    _rootEl.querySelector('#df-opme-file-input').value = '';
    _rootEl.querySelector('#df-opme-preview').style.display = 'none';
    _rootEl.querySelector('#df-opme-dropzone').style.display = '';
    _rootEl.querySelector('#df-opme-btn-upload').disabled = true;
    setMsg('', null);
  }

  function setProgress(p, text) {
    const bar = _rootEl.querySelector('#df-opme-progress-bar');
    const txt = _rootEl.querySelector('#df-opme-progress-text');
    bar.style.width = Math.max(0, Math.min(100, p)) + '%';
    if (text != null) txt.textContent = text;
  }

  function showProgress(show) {
    _rootEl.querySelector('#df-opme-progress').style.display = show ? '' : 'none';
  }

  function upload() {
    if (!_selectedFile) return;
    const fd = new FormData();
    fd.append('file', _selectedFile);

    setMsg('', null);
    showProgress(true);
    setProgress(5, 'Se încarcă…');
    _rootEl.querySelector('#df-opme-btn-upload').disabled = true;
    _rootEl.querySelector('#df-opme-btn-cancel').disabled = true;

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/opme/import');
    xhr.withCredentials = true;
    xhr.setRequestHeader('X-CSRF-Token', csrf());

    xhr.upload.addEventListener('progress', e => {
      if (e.lengthComputable) {
        const p = 5 + Math.floor((e.loaded / e.total) * 70);
        setProgress(p, `Se încarcă… ${Math.floor((e.loaded / e.total) * 100)}%`);
      }
    });
    xhr.addEventListener('load', () => {
      _rootEl.querySelector('#df-opme-btn-cancel').disabled = false;
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch (_) {}
      if (xhr.status === 201) {
        setProgress(100, 'Gata.');
        const rep = body.match_report || null;
        const summary = rep && rep.summary_text
          ? rep.summary_text
          : `Import reușit: ${body.lines_count || 0} linii.`;
        showToast(summary, 'ok', rep && body.import_id ? {
          label: 'Vezi raport',
          action: () => {
            if (window.DFOpmeReportDrawer && window.DFOpmeReportDrawer.open) {
              window.DFOpmeReportDrawer.open({ importId: body.import_id });
            }
          }
        } : null);
        close();
        if (typeof _opts.onSuccess === 'function') _opts.onSuccess(rep, body.import_id);
        return;
      }
      if (xhr.status === 409) {
        showProgress(false);
        const existing = body.existing_import_id;
        setMsg('Acest fișier a fost deja importat.', 'warn');
        showToast('Fișier deja importat.', 'warn', existing ? {
          label: 'Vezi import existent',
          action: () => {
            if (window.DFOpmeReportDrawer && window.DFOpmeReportDrawer.open) {
              window.DFOpmeReportDrawer.open({ importId: existing });
            }
          }
        } : null);
        _rootEl.querySelector('#df-opme-btn-upload').disabled = false;
        return;
      }
      // Eroare
      showProgress(false);
      const msg = body.message || body.detail || body.error || `Eroare ${xhr.status}`;
      setMsg(msg, 'err');
      showToast(msg, 'err');
      _rootEl.querySelector('#df-opme-btn-upload').disabled = false;
    });
    xhr.addEventListener('error', () => {
      showProgress(false);
      setMsg('Eroare de rețea.', 'err');
      _rootEl.querySelector('#df-opme-btn-upload').disabled = false;
      _rootEl.querySelector('#df-opme-btn-cancel').disabled = false;
    });
    xhr.send(fd);
  }

  function open(opts) {
    _opts = opts || {};
    ensureDOM();
    removeFile();
    _rootEl.classList.add('df-opme-open');
    _rootEl.style.display = 'flex';
  }

  function close() {
    if (!_rootEl) return;
    _rootEl.classList.remove('df-opme-open');
    _rootEl.style.display = 'none';
    _selectedFile = null;
  }

  // ── Toast lightweight (reutilizabil de drawer) ───────────────────────────
  function showToast(text, type, action) {
    let host = document.getElementById('df-opme-toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'df-opme-toast-host';
      host.className = 'df-opme-toast-host';
      document.body.appendChild(host);
    }
    const t = document.createElement('div');
    t.className = 'df-opme-toast df-opme-toast--' + (type || 'info');
    let inner = `<span class="df-opme-toast__msg">${esc(text)}</span>`;
    if (action && action.label) {
      inner += `<button type="button" class="df-opme-toast__btn">${esc(action.label)}</button>`;
    }
    inner += `<button type="button" class="df-opme-toast__close" aria-label="Închide">&times;</button>`;
    t.innerHTML = inner;
    host.appendChild(t);
    const dismiss = () => { try { host.removeChild(t); } catch(_){} };
    t.querySelector('.df-opme-toast__close').addEventListener('click', dismiss);
    if (action && action.action) {
      t.querySelector('.df-opme-toast__btn').addEventListener('click', () => {
        try { action.action(); } catch(_){}
        dismiss();
      });
    }
    setTimeout(dismiss, 8000);
  }

  window.DFOpmeImportModal = { open, close };
  window.DFOpmeToast = { show: showToast };
})();
