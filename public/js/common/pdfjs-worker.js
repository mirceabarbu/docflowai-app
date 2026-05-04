// DocFlowAI — config worker pentru pdfjs-dist (depinde de CDN pdf.js încărcat anterior).
// Folosit de semdoc-initiator.html și semdoc-signer.html.
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}
