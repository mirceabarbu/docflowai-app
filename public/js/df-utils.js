// public/js/df-utils.js
// DocFlowAI — utilitare frontend partajate (BLOC 0 din migrare v4 frontend).
// Zero side effects, zero dependențe externe. Toate paginile încarcă acest fișier.
//
// Folosire: window.df.$('myId'), window.df.esc(str), window.df.debounce(fn, 300), etc.
//
// NU adăuga aici:
//   - cod care face fetch (vezi df-apifetch-shim*.js — vor fi unificate în BLOC 4)
//   - cod care manipulează CSRF / auth (idem)
//   - cod specific unei pagini
//
(function(global) {
  'use strict';

  // ── DOM helpers ──────────────────────────────────────────────────────────
  /** Shorthand pentru document.getElementById */
  function $(id) { return document.getElementById(id); }

  /** Shorthand pentru document.querySelector */
  function $q(sel, root) { return (root || document).querySelector(sel); }

  /** Shorthand pentru document.querySelectorAll, returnează Array */
  function $qa(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  // ── String / HTML escape ─────────────────────────────────────────────────
  /** Escape HTML pentru inserare safe în innerHTML. Acceptă null/undefined. */
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Date helpers (Romania format dd.mm.yyyy ↔ ISO yyyy-mm-dd) ────────────
  /** "25.04.2026" → "2026-04-25". Returnează '' pentru input invalid. */
  function parseDMYtoISO(dmy) {
    if (!dmy || typeof dmy !== 'string') return '';
    const m = dmy.trim().match(/^(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{4})$/);
    if (!m) return '';
    const d = m[1].padStart(2, '0');
    const mo = m[2].padStart(2, '0');
    return `${m[3]}-${mo}-${d}`;
  }

  /** "2026-04-25" → "25.04.2026". Returnează '—' pentru input invalid (placeholder UI). */
  function isoToDMY(iso) {
    if (!iso || typeof iso !== 'string') return '—';
    const m = iso.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return '—';
    return `${m[3]}.${m[2]}.${m[1]}`;
  }

  // ── CSRF token (citire pură; NU face refresh — asta rămâne în shim-uri) ──
  /** Returnează CSRF token-ul curent: window._csrfToken (preferat) > cookie. */
  function getCsrf() {
    if (global._csrfToken) return global._csrfToken;
    const c = document.cookie.split('; ').find(r => r.startsWith('csrf_token='));
    return c ? c.split('=')[1] : null;
  }

  // ── Debounce ─────────────────────────────────────────────────────────────
  /** Debounce generic. delay în ms, default 300. */
  function debounce(fn, delay) {
    delay = (typeof delay === 'number') ? delay : 300;
    let t = null;
    return function debounced() {
      const args = arguments;
      const self = this;
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; fn.apply(self, args); }, delay);
    };
  }

  // ── Download blob ca fișier (înlocuiește pattern createObjectURL+a.click) ─
  /** Descarcă un Blob ca fișier. Curăță URL-ul automat după click. */
  function downloadBlob(blob, filename) {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try { document.body.removeChild(a); } catch(_) {}
      try { URL.revokeObjectURL(url); } catch(_) {}
    }, 100);
  }

  // ── Mesaje UI standardizate ──────────────────────────────────────────────
  /**
   * Afișează un mesaj într-un element existent. type: 'ok' | 'err' | '' (neutral).
   * Folosește clase: .df-msg, .df-msg--ok, .df-msg--err. Dacă elementul nu există, no-op.
   */
  function showMsg(elOrId, txt, type) {
    const el = (typeof elOrId === 'string') ? $(elOrId) : elOrId;
    if (!el) return;
    el.textContent = txt || '';
    el.classList.remove('df-msg--ok', 'df-msg--err');
    if (type === 'ok') el.classList.add('df-msg--ok');
    else if (type === 'err') el.classList.add('df-msg--err');
  }

  // ── Export public ────────────────────────────────────────────────────────
  global.df = global.df || {};
  Object.assign(global.df, {
    // DOM
    $, $q, $qa,
    // String
    esc,
    // Date
    parseDMYtoISO, isoToDMY,
    // CSRF (read-only)
    getCsrf,
    // Async
    debounce,
    // Files
    downloadBlob,
    // UI
    showMsg,
    // Marker
    _utilsLoaded: true,
  });
})(window);
