// DocFlowAI — apiFetch shim complet (Variant C) partajat pentru paginile STS.
// Diferă de df-apifetch-shim.js (Variant B) prin:
//   - Retry automat pe 403 csrf_invalid (refresh CSRF via /auth/csrf-token sau /auth/refresh)
//   - Management  (prefetch la deschiderea paginii)
//
// Utilizat de: semdoc-initiator.html (Pas 2.11), semdoc-signer.html (Pas 2.12).
// Trebuie încărcat ÎNAINTE de df-shell.js în <head>.
//
// NU folosi pentru pagini care nu au nevoie de retry CSRF (flow, notifications,
// templates, verifica) — pentru acelea folosește df-apifetch-shim.js (Variant B).
    // apiFetch shim — folosește refresh automat dacă notif-widget e încărcat,
    // SEC-01: token în cookie HttpOnly — credentials: include trimite cookie automat.
    // Fallback tranziție: dacă există token vechi în localStorage (sesiune anterioară upgrade),
    // îl trimitem ca Authorization Bearer până expiră natural.
    window._apiFetch = async function(url, options) {
      if (window.docflow && window.docflow.apiFetch) return window.docflow.apiFetch(url, options);
      const headers = Object.assign({}, (options||{}).headers || {});
      const legacyToken = localStorage.getItem('docflow_token');
      if (legacyToken) headers['Authorization'] = 'Bearer ' + legacyToken;
      const method = (options?.method || 'GET').toUpperCase();
      const isMutation = !['GET','HEAD','OPTIONS'].includes(method);
      function getCsrf() {
        // Preferinta: variabila globala > cookie
        if (window._csrfToken) return window._csrfToken;
        const c = document.cookie.split('; ').find(r => r.startsWith('csrf_token='));
        return c ? c.split('=')[1] : null;
      }
      if (isMutation) { const t = getCsrf(); if (t) headers['x-csrf-token'] = t; }
      let res = await fetch(url, Object.assign({}, options||{}, { headers, credentials: 'include' }));
      if (res.status === 403 && isMutation) {
        let body = {};
        try { body = await res.clone().json(); } catch(e) {}
        if (body?.error === 'csrf_invalid') {
          let freshCsrf = null;
          try {
            const rr = await fetch('/auth/csrf-token', { credentials: 'include' });
            if (rr.ok) { const rd = await rr.json(); freshCsrf = rd.csrfToken || null; }
          } catch(e) {}
          if (!freshCsrf) {
            try {
              const rr = await fetch('/auth/refresh', { method: 'POST', credentials: 'include' });
              if (rr.ok) { const rd = await rr.json(); freshCsrf = rd.csrfToken || null; }
            } catch(e) {}
          }
          if (freshCsrf) { window._csrfToken = freshCsrf; }
          const retryHeaders = Object.assign({}, headers);
          const t2 = getCsrf(); if (t2) retryHeaders['x-csrf-token'] = t2;
          res = await fetch(url, Object.assign({}, options||{}, { headers: retryHeaders, credentials: 'include' }));
        }
      }
      return res;
    };
    // ── CSRF: incarcare token la deschiderea paginii ──────────────────────────
    // Citim token din /auth/csrf-token (sigur, nu depinde de timing cookie)
    // Stocat in window._csrfToken — folosit de toti apiFetch shim-ii
    window._csrfToken = null;
    (async function initCsrf() {
      try {
        const r = await fetch('/auth/csrf-token', { credentials: 'include' });
        if (r.ok) { const d = await r.json(); window._csrfToken = d.csrfToken || null; }
      } catch(e) {}
      // Fallback la cookie daca fetch esueaza
      if (!window._csrfToken) {
        const c = document.cookie.split('; ').find(r => r.startsWith('csrf_token='));
        if (c) window._csrfToken = c.split('=')[1];
      }
    })();

