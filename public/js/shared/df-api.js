/**
 * public/js/shared/df-api.js — SURSA UNICĂ de acces la API din frontend.
 *
 * Consolidează cele CINCI implementări divergente de `apiFetch` care existau
 * în paralel (lot #183, etapa 1/4):
 *   1. public/notif-widget.js            — canonica (refresh la 401, REVOKED_CODES, retry CSRF)
 *   2. public/js/admin/core.js           — CSRF + retry, ZERO tratare de 401
 *   3. public/js/df-apifetch-shim-full.js — identică cu 2
 *   4. public/js/df-apifetch-shim.js     — CSRF simplu, fără retry, fără 401
 *   5. public/js/bulk-signer/bulk-signer.js — redirect la 401, dar FĂRĂ CSRF deloc
 *
 * Divergența nu era cosmetică: canonica ȘTERGE antetul `Authorization`, iar 2/3/4 îl
 * ADĂUGAU din `localStorage.docflow_token`. Convergența se face pe comportamentul
 * canonic — token-ul e în cookie HttpOnly din SEC-01, nimic nu mai scrie `docflow_token`
 * (login.js îl șterge la fiecare autentificare), deci fallback-ul Bearer e cod mort.
 *
 * Script CLASIC (fără `type="module"`), la fel ca restul fișierelor din public/js/ —
 * încărcat prin <script> ÎNAINTEA oricărui consumator. Expune window.DFApi.
 *
 * ⚠️ Acest lot NU migrează niciun call-site: cele ~179 de apeluri `fetch(` din aplicație
 * rămân neatinse. Migrarea lor vine în loturile 2-4, ca fiecare să poată fi dat înapoi separat.
 */
(function () {
  'use strict';

  // Gardă de reintrare: dacă pagina include fișierul de două ori (sau un shim îl
  // încarcă defensiv), nu redefinim nimic și — mai important — nu rulăm initCsrf a doua oară.
  if (window.DFApi) return;

  // SEC-88.3: coduri de eroare pe care sessionGuard (server/middleware/session-guard.mjs)
  // le întoarce cu 401. TOATE înseamnă același lucru: serverul a decis că sesiunea nu mai e
  // validă. NU se încearcă refresh pentru ele — /auth/refresh (auth.mjs) validează DOAR
  // deleted_at și token_version, NU rolul și NU organizația. Un refresh pe `session_org_stale`
  // ar REUȘI și ar emite tăcut un token pentru org-ul NOU, lăsând UI-ul populat cu datele
  // org-ului VECHI — exact scurgerea între instituții pe care prompturile 86-88 au închis-o.
  // Listă SEPARATĂ de cea refreshabilă de mai jos: aici mergem direct la login.
  // (Mutată din notif-widget.js: e o listă de coduri ale SERVERULUI, nu o preocupare
  // a widget-ului de notificări.)
  const REVOKED_CODES = [
    'session_revoked',    // cont dezactivat sau inexistent
    'token_revoked',      // token_version bump-uit (reset parolă / dezactivare / schimbare rol)
    'session_role_stale', // rolul din JWT nu mai corespunde celui din DB
    'session_org_stale',  // organizația din JWT nu mai corespunde celei din DB
  ];

  // Coduri de 401 pentru care are sens un refresh de token (spre deosebire de cele revocate).
  const REFRESHABLE_CODES = ['token_invalid_or_expired', 'unauthorized', 'token_invalid'];

  // ── Cârlige OPȚIONALE ────────────────────────────────────────────────────────
  // `refreshToken` și `redirectLogin` rămân în notif-widget.js — sunt legate de ciclul
  // lui de viață (WebSocket, toast-uri, deduplicarea cererilor de refresh). df-api.js le
  // primește prin cârlige, ceea ce e exact ce permite paginilor FĂRĂ widget
  // (registratura.html, setari.html, bulk-signer.html) să folosească aceeași funcție:
  // fără cârlige, DFApi.fetch se comportă ca shim-ul minimal de azi (CSRF + retry
  // csrf_invalid + răspuns brut la 401); cu ele, capătă comportamentul complet.
  let _refreshHook = null;   // () => Promise<boolean>
  let _redirectHook = null;  // () => void

  function _setRefreshHook(fn) { _refreshHook = (typeof fn === 'function') ? fn : null; }
  function _setRedirectHook(fn) { _redirectHook = (typeof fn === 'function') ? fn : null; }

  // ── CSRF ─────────────────────────────────────────────────────────────────────
  /** Token-ul CSRF curent: window._csrfToken (setat la init pagină) > cookie. */
  function getCsrf() {
    if (window._csrfToken) return window._csrfToken;
    const c = document.cookie.split('; ').find(r => r.startsWith('csrf_token='));
    return c ? c.split('=')[1] : null;
  }

  /**
   * Publică un token CSRF proaspăt. `window._csrfToken` RĂMÂNE contractul global —
   * df-utils.js și admin/admin.js îl citesc direct; nu-l schimba.
   */
  function setCsrf(token) { window._csrfToken = token || null; }

  // ── Implementarea canonică ───────────────────────────────────────────────────
  /**
   * DFApi.fetch — înlocuitor pentru fetch() cu CSRF automat, refresh la 401 și
   * retry pe csrf_invalid. Mutată din notif-widget.js (apiFetch), cu dependențele
   * legate de widget extrase în cârlige.
   */
  async function dfFetch(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    // Autentificarea se face EXCLUSIV prin cookie HttpOnly (SEC-01). Antetul e șters
    // indiferent de forma cheii — un call-site care ar trimite `authorization` cu literă
    // mică ar reintroduce tăcut fallback-ul Bearer pe care lotul ăsta îl închide.
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'authorization') delete headers[k];
    }

    const method = (options?.method || 'GET').toUpperCase();
    const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);

    if (isMutation) { const t = getCsrf(); if (t) headers['x-csrf-token'] = t; }

    let res = await fetch(url, { ...options, headers, credentials: 'include' });

    // ── Refresh reactiv la 401 ────────────────────────────────────────────────
    if (res.status === 401) {
      let body = {};
      try { body = await res.clone().json(); } catch (e) {}
      const err = body?.error || '';
      // SEC-88.3: sesiune revocată de sessionGuard → direct la login, FĂRĂ refresh (ar fi
      // inutil pentru revoked/token_revoked și NOCIV pentru role/org_stale — vezi REVOKED_CODES).
      if (REVOKED_CODES.includes(err)) {
        if (_redirectHook) _redirectHook();
        return res;
      }
      if (_refreshHook) {
        if (REFRESHABLE_CODES.includes(err)) {
          const ok = await _refreshHook();
          if (ok) res = await fetch(url, { ...options, headers, credentials: 'include' });
        }
      } else if (_redirectHook) {
        // Pagină fără mecanism de refresh (bulk-signer.html nu încarcă notif-widget.js):
        // un 401 e definitiv, deci redirect — exact comportamentul pe care îl avea
        // _apiFetch-ul local de acolo, mutat, nu șters.
        _redirectHook();
      }
    }

    // ── Retry la 403 csrf_invalid: token nou, apoi O SINGURĂ reîncercare ──────
    if (res.status === 403 && isMutation) {
      let body = {};
      try { body = await res.clone().json(); } catch (e) {}
      if (body?.error === 'csrf_invalid') {
        let freshCsrf = null;
        // Primul fallback: /auth/csrf-token (fara side effects, simplu si rapid)
        try {
          const rr = await fetch('/auth/csrf-token', { credentials: 'include' });
          if (rr.ok) { const rd = await rr.json(); freshCsrf = rd.csrfToken || null; }
        } catch (e) {}
        // Al doilea fallback: reînnoirea completă a sesiunii, dacă pagina o are (widget).
        if (!freshCsrf && _refreshHook) {
          const ok = await _refreshHook();
          if (ok) freshCsrf = getCsrf(); // refreshToken publică token-ul prin DFApi.setCsrf
        }
        if (freshCsrf) setCsrf(freshCsrf);
        const newHeaders = { ...headers };
        const t2 = getCsrf(); if (t2) newHeaders['x-csrf-token'] = t2;
        res = await fetch(url, { ...options, headers: newHeaders, credentials: 'include' });
      }
    }

    return res;
  }

  // ── API public ───────────────────────────────────────────────────────────────
  window.DFApi = {
    fetch: dfFetch,
    getCsrf: getCsrf,
    setCsrf: setCsrf,
    REVOKED_CODES: REVOKED_CODES,
    _setRefreshHook: _setRefreshHook,
    _setRedirectHook: _setRedirectHook,
  };

  // ── CSRF: incarcare token la deschiderea paginii ──────────────────────────
  // Citim token din /auth/csrf-token (sigur, nu depinde de timing cookie).
  // Stocat in window._csrfToken — folosit de toti consumatorii.
  // Mutat identic din admin/core.js și df-apifetch-shim-full.js (erau două copii);
  // rulează o singură dată datorită gărzii de reintrare de la începutul fișierului.
  window._csrfToken = null;
  (async function initCsrf() {
    try {
      const r = await fetch('/auth/csrf-token', { credentials: 'include' });
      if (r.ok) { const d = await r.json(); window._csrfToken = d.csrfToken || null; }
    } catch (e) {}
    // Fallback la cookie daca fetch esueaza
    if (!window._csrfToken) {
      const c = document.cookie.split('; ').find(r => r.startsWith('csrf_token='));
      if (c) window._csrfToken = c.split('=')[1];
    }
  })();
})();
