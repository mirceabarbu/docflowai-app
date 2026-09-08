// DocFlowAI — apiFetch shim complet (Variant C) partajat pentru paginile STS.
//
// #183: diferența istorică față de df-apifetch-shim.js (Variant B) — retry pe 403
// csrf_invalid + prefetch de token CSRF la deschiderea paginii — a DISPĂRUT: ambele
// comportamente trăiesc acum în public/js/shared/df-api.js (window.DFApi), pentru toate
// paginile. Cele două shim-uri sunt de acum identice; rămân separate doar ca să nu
// atingem, în lotul ăsta, cele 13 pagini care le referă pe nume.
//
// Fallback-ul `Authorization: Bearer` din `localStorage.docflow_token` a fost eliminat —
// vezi comentariul din df-apifetch-shim.js.
//
// Utilizat de: semdoc-initiator.html (Pas 2.11), semdoc-signer.html (Pas 2.12).
// Trebuie încărcat ÎNAINTE de df-shell.js în <head>, și DUPĂ shared/df-api.js.

    window._apiFetch = function(url, options) { return window.DFApi.fetch(url, options); };
