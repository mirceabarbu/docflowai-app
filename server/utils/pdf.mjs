/**
 * DocFlowAI — PDF utilities
 * stampFooterOnPdf — adaugă footer cu metadate la ultimul pagina al PDF-ului
 */

// PDFLib e injectat din index.mjs (e opțional la runtime)
let _PDFLib = null;
export function injectPDFLib(lib) { _PDFLib = lib; }

export async function stampFooterOnPdf(pdfB64, flowData) {
  if (!pdfB64 || !_PDFLib) return pdfB64;
  try {
    const { PDFDocument, rgb, StandardFonts } = _PDFLib;
    const diacr = {
      'ă':'a','â':'a','î':'i','ș':'s','ț':'t',
      'Ă':'A','Â':'A','Î':'I','Ș':'S','Ț':'T',
      'ş':'s','ţ':'t','Ş':'S','Ţ':'T'
    };
    function ro(t) { return String(t || '').split('').map(ch => diacr[ch] || ch).join(''); }

    const clean = pdfB64.includes(',') ? pdfB64.split(',')[1] : pdfB64;
    const pdfDoc = await PDFDocument.load(Buffer.from(clean, 'base64'), { ignoreEncryption: true });
    const fontR = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const lastPage = pdfDoc.getPages()[pdfDoc.getPageCount() - 1];
    const { width: pW } = lastPage.getSize();

    const MARGIN = 40, footerY = 14;
    const createdDate = flowData.createdAt
      ? new Date(flowData.createdAt).toLocaleString('ro-RO')
      : new Date().toLocaleString('ro-RO');

    const parts = [
      ro(flowData.initName || ''),
      flowData.initFunctie ? ro(flowData.initFunctie) : null,
      flowData.institutie ? ro(flowData.institutie) : null,
      flowData.compartiment ? ro(flowData.compartiment) : null,
    ].filter(Boolean).join(', ');

    const footerLeft = createdDate + (parts ? '  |  ' + parts : '');
    const footerRight = ro(flowData.flowId || '');

    lastPage.drawLine({
      start: { x: MARGIN, y: footerY + 10 },
      end: { x: pW - MARGIN, y: footerY + 10 },
      thickness: 0.4, color: rgb(0.75, 0.75, 0.75),
    });
    lastPage.drawText(footerLeft, {
      x: MARGIN, y: footerY, size: 7, font: fontR,
      color: rgb(0.5, 0.5, 0.5), opacity: 0.8,
      maxWidth: pW - MARGIN * 2 - (footerRight.length * 4.5) - 16,
    });
    if (footerRight) {
      lastPage.drawText(footerRight, {
        x: pW - MARGIN - (footerRight.length * 4.5), y: footerY,
        size: 7, font: fontR, color: rgb(0.5, 0.5, 0.5), opacity: 0.8,
      });
    }
    return Buffer.from(await pdfDoc.save()).toString('base64');
  } catch(e) {
    console.warn('stampFooterOnPdf error:', e.message);
    return pdfB64;
  }
}
