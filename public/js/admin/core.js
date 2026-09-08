    // SEC-01: apiFetch shim — cookie HttpOnly trimis automat cu credentials: include.
    // #183: implementarea (CSRF + retry csrf_invalid + initCsrf) s-a mutat în
    // public/js/shared/df-api.js, încărcat de admin.html ÎNAINTEA acestui fișier.
    // Fallback-ul `Authorization: Bearer` din localStorage.docflow_token a fost eliminat —
    // nimic nu mai scrie cheia aia, iar canonica din notif-widget îl ștergea oricum.
    window._apiFetch = function(url, options) { return window.DFApi.fetch(url, options); };
