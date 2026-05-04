// DocFlowAI — încarcă pdf-lib pentru ștampilare PDF (multi-CDN fallback).
// Folosit de semdoc-initiator.html (creare flux) și semdoc-signer.html (semnare local-upload).
// Expune window._pdfLibLoaded / window._pdfLibFailed.
(function() {
  const cdns = [
    "https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js",
    "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js"
  ];
  let idx = 0;
  function tryNext() {
    if (idx >= cdns.length) {
      window._pdfLibFailed = true;
      console.error("❌ pdf-lib failed to load from all CDNs");
      return;
    }
    const s = document.createElement("script");
    s.src = cdns[idx++];
    s.onload  = () => { console.log("✅ pdf-lib loaded from", s.src); window._pdfLibLoaded = true; };
    s.onerror = () => { console.warn("⚠ CDN failed:", s.src); tryNext(); };
    document.head.appendChild(s);
  }
  tryNext();
})();
