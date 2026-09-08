// DocFlowAI — apiFetch shim partajat între pagini.
//
// #183: nu mai are implementare proprie. Nucleul trăiește în public/js/shared/df-api.js
// (window.DFApi), care e ÎNCĂRCAT ÎNAINTEA acestui fișier pe fiecare pagină consumatoare.
// Shim-ul rămâne doar ca alias `window._apiFetch`, numele pe care îl folosesc paginile.
//
// Ce s-a schimbat față de varianta anterioară: fallback-ul `Authorization: Bearer` citit
// din `localStorage.docflow_token` a DISPĂRUT. Nimic nu mai scrie cheia aia (login.js o
// șterge la fiecare autentificare, token-ul e în cookie HttpOnly din SEC-01), iar pe
// paginile cu notif-widget shim-ul delega oricum către canonica, care ștergea antetul.
//
// Utilizat de: chat.html, flow.html, notifications.html, registratura.html,
//   semdoc-initiator.html, semdoc-signer.html, setari.html, templates.html.
// Trebuie încărcat ÎNAINTE de df-shell.js în <head>, și DUPĂ shared/df-api.js.

    window._apiFetch = function(url, options) { return window.DFApi.fetch(url, options); };
