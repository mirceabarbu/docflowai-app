/**
 * DocFlowAI — Frontend entitlements bootstrap
 *
 * La load fetchează /api/entitlements/me și expune:
 *   - window.df.entitlements       — mapa { module_key: boolean }
 *   - window.df.canUseModule(key)  — getter sincron (false dacă mapa nu e încărcată sau modulul lipsește)
 *   - window.df.entitlementsReady  — Promise care se rezolvă la încărcare
 *
 * Auto-ascundere DOM: elemente cu attr `data-df-module="alop"` (sau orice cheie
 * cunoscută) sunt ascunse cu style.display='none' când entitlement-ul e off.
 * `data-df-module-any="a,b"` ascunde dacă NICIUN modul din listă nu e activ.
 *
 * NU adăuga aici fetch-uri care fac POST/PUT — modulul e read-only pe load.
 */
(function (global) {
  'use strict';

  global.df = global.df || {};

  let _modules = null; // null = încă nu am răspuns; obiect = răspuns primit
  let _resolveReady;
  const ready = new Promise((res) => { _resolveReady = res; });

  function _normalize(mods) {
    const out = {};
    if (mods && typeof mods === 'object') {
      for (const k of Object.keys(mods)) out[k] = !!mods[k];
    }
    return out;
  }

  /** Sincron — returnează boolean. False dacă entitlements nu au fost încă fetchuite. */
  function canUseModule(key) {
    if (!_modules) return false;
    return _modules[key] === true;
  }

  /** Aplică ascundere DOM pe elementele marcate cu data-df-module / data-df-module-any. */
  function applyDom(root) {
    const scope = root || document;
    // Cu UN singur modul: ascunde dacă e off
    scope.querySelectorAll('[data-df-module]').forEach((el) => {
      const key = el.getAttribute('data-df-module');
      if (!key) return;
      if (!canUseModule(key)) el.style.display = 'none';
    });
    // Cu LISTĂ: ascunde doar dacă TOATE sunt off (utile pentru tab-uri umbrella)
    scope.querySelectorAll('[data-df-module-any]').forEach((el) => {
      const list = (el.getAttribute('data-df-module-any') || '')
        .split(',').map((s) => s.trim()).filter(Boolean);
      if (!list.length) return;
      const anyOn = list.some((k) => canUseModule(k));
      if (!anyOn) el.style.display = 'none';
    });
  }

  function _fetchOnce() {
    return fetch('/api/entitlements/me', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : { modules: {} }))
      .catch(() => ({ modules: {} }))
      .then((data) => {
        _modules = _normalize(data && data.modules);
        global.df.entitlements = _modules;
        _resolveReady(_modules);
        // Aplică hide-ul cât mai devreme posibil — și după DOMContentLoaded
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', () => applyDom());
        } else {
          applyDom();
        }
        try {
          document.dispatchEvent(new CustomEvent('df:entitlements-ready', { detail: _modules }));
        } catch (_) {}
        return _modules;
      });
  }

  Object.assign(global.df, {
    canUseModule,
    entitlementsReady: ready,
    /** Forțează re-fetch (după ce superadmin schimbă entitlements din UI). */
    refreshEntitlements: _fetchOnce,
    applyEntitlementsDom: applyDom,
    _entitlementsLoaded: true,
  });

  // Start fetch imediat — nu așteaptă DOMContentLoaded
  _fetchOnce();
})(window);
