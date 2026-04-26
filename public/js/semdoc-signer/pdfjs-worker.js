// DocFlowAI — config worker pentru pdfjs-dist pe semdoc-signer.html.
// Depinde de CDN pdf.js încărcat anterior. Extras la Pas 2.12.

      if (window.pdfjsLib) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      }
