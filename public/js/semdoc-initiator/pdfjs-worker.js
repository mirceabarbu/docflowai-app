// DocFlowAI — config worker pentru pdfjs-dist (depinde de CDN pdf.js încărcat anterior).
// Extras din semdoc-initiator.html la Pas 2.11.
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }
