// DocFlowAI — încarcă pdf-lib pentru ștampilare PDF la creare flux (multi-CDN fallback).
// Extras din semdoc-initiator.html la Pas 2.11. Expune window._pdfLibLoaded / window._pdfLibFailed.
  // Incarca pdf-lib pentru stampilare PDF la creare flux
  (function() {
    const cdns = [
      "https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js",
      "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js",
      "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js"
    ];
    let idx = 0;
    function tryNext() {
      if (idx >= cdns.length) { window._pdfLibFailed = true; return; }
      const s = document.createElement("script");
      s.src = cdns[idx++];
      s.onerror = tryNext;
      s.onload = () => { window._pdfLibLoaded = true; };
      document.head.appendChild(s);
    }
    tryNext();
  })();
