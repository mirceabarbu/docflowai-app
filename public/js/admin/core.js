    // SEC-01: apiFetch shim — cookie HttpOnly trimis automat cu credentials: include
    // Nu mai citim token din localStorage
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

