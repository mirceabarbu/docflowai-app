// DocFlowAI — auth guard pentru semdoc-signer.html (fetch /auth/me + redirect login).
// Trebuie încărcat EARLY — NU avem shell client să facă redirect.
// Extras la Pas 2.12.

    // Auth guard — semnarea strict in-app, cookie HttpOnly obligatoriu
    (function() {
      fetch('/auth/me', { credentials: 'include' })
        .then(r => {
          if (!r.ok) {
            location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
          }
        })
        .catch(() => {
          location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
        });

    })();
