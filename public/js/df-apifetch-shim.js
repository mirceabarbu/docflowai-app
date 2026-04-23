// DocFlowAI — apiFetch shim partajat între pagini.
// Folosește refresh automat dacă notif-widget.js e încărcat (window.docflow.apiFetch),
// altfel fallback la fetch standard cu Bearer token din localStorage + CSRF header.
//
// Utilizat de: flow.html, notifications.html, templates.html, semdoc-initiator.html,
//   semdoc-signer.html (migrare progresivă Pas 2.7 → 2.8 → 2.10 → 2.11 → 2.12).
// Trebuie încărcat ÎNAINTE de df-shell.js în <head>.

    // apiFetch shim — folosește refresh automat dacă notif-widget e încărcat,
    // altfel fallback la fetch standard cu Bearer token din localStorage.
    window._apiFetch = async function(url, options) {
      if (window.docflow && window.docflow.apiFetch) return window.docflow.apiFetch(url, options);
      const headers = Object.assign({}, (options||{}).headers || {});
      // Tranziție: dacă există token vechi în localStorage, îl trimitem ca fallback Bearer
      const legacyToken = localStorage.getItem('docflow_token');
      if (legacyToken) headers['Authorization'] = 'Bearer ' + legacyToken;
      // CSRF: citim csrf_token din cookie și îl trimitem ca header pentru mutații
      const method = (options?.method || 'GET').toUpperCase();
      if (!['GET','HEAD','OPTIONS'].includes(method)) {
        const csrfCookie = document.cookie.split('; ').find(r => r.startsWith('csrf_token='));
        if (csrfCookie) headers['x-csrf-token'] = csrfCookie.split('=')[1];
      }
      return fetch(url, Object.assign({}, options||{}, { headers, credentials: 'include' }));
    };
