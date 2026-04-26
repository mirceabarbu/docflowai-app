// DocFlowAI — încarcă pdf-lib pentru ștampilare PDF la semnare local-upload (multi-CDN fallback).
// Extras din semdoc-signer.html la Pas 2.12. Expune window._pdfLibLoaded / window._pdfLibFailed.
// NU confunda cu semdoc-initiator/pdf-lib-loader.js — variantă puțin diferită (logging + var vs let).

      // Load pdf-lib with multiple CDN fallbacks
      (function() {
        var cdns = [
          "https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js",
          "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js",
          "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js"
        ];
        var idx = 0;
        function tryNext() {
          if (idx >= cdns.length) {
            window._pdfLibFailed = true;
            console.error("❌ pdf-lib failed to load from all CDNs");
            return;
          }
          var s = document.createElement("script");
          s.src = cdns[idx++];
          s.onload = function() { console.log("✅ pdf-lib loaded from", s.src); window._pdfLibLoaded = true; };
          s.onerror = function() { console.warn("⚠ CDN failed:", s.src); tryNext(); };
          document.head.appendChild(s);
        }
        tryNext();
      })();
