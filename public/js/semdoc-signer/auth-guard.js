// DocFlowAI — auth guard pentru semdoc-signer.html (fetch /auth/me + redirect login).
// Trebuie încărcat EARLY — NU avem shell client să facă redirect.
// Extras la Pas 2.12.
// #189: RAMANE deliberat pe fetch brut — se incarca la linia 14 din semdoc-signer.html,
// inaintea lui df-api.js (17); mutarea lui dupa ar intarzia redirectul, iar DFApi fara
// carlige n-ar aduce nimic aici (GET fara CSRF, fara nevoie de refresh). NU-l migra.

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
