/**
 * DocFlowAI — PDF Footer Stamp (v3.4.0)
 *
 * Aplicã un footer discret pe ultima pagina a PDF-ului la crearea fluxului:
 *   - Stânga: data creãrii + date inițiator (nume, funcție, instituție, compartiment)
 *   - Dreapta: flowId + "DocFlowAI"
 *   - Linie separatoare subtilã deasupra
 *
 * NOTE:
 *  - Diacritice românești sunt transliterate (Helvetica nu le suportã nativ)
 *  - Pentru flowType='ancore': useObjectStreams:false pãstreazã structura AcroForm
 *    intactã pentru aplicațiile de semnare calificatã (STSign/Adobe)
 *  - Erori non-fatale: la eșec returneazã pdf-ul original nesimpcat
 *
 * @param {string} pdfB64    — PDF-ul original ca base64 (cu sau fãrã prefix data:...)
 * @param {object} flowData  — Date flux: flowId, createdAt, initName, initFunctie,
 *                             institutie, compartiment, flowType
 * @param {object} PDFLib    — Instanța pdf-lib injectatã din index.mjs
 * @returns {Promise<string>} — PDF modificat ca base64 pur (fãrã prefix)
 */

import { logger } from '../middleware/logger.mjs';

// Transliterare diacritice românești → ASCII (Helvetica standard nu le suportã)
const DIACR_MAP = {
  'ă':'a','â':'a','î':'i','ș':'s','ț':'t',
  'Ă':'A','Â':'A','Î':'I','Ș':'S','Ț':'T',
  'ş':'s','ţ':'t','Ş':'S','Ţ':'T',
};
function ro(t) {
  return String(t || '').split('').map(ch => DIACR_MAP[ch] || ch).join('');
}

export async function stampFooterOnPdf(pdfB64, flowData, PDFLib) {
  if (!pdfB64 || !PDFLib) return pdfB64;
  try {
    const { PDFDocument, rgb, StandardFonts } = PDFLib;

    const clean = pdfB64.includes(',') ? pdfB64.split(',')[1] : pdfB64;
    const pdfDoc = await PDFDocument.load(Buffer.from(clean, 'base64'), { ignoreEncryption: true });

    const fontR    = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const lastPage = pdfDoc.getPages()[pdfDoc.getPageCount() - 1];
    const { width: pW } = lastPage.getSize();

    const MARGIN    = 40;
    const footerY   = 14;
    const FONT_SIZE = 7;

    // ── Construiește textul footer ──────────────────────────────────────────
    const createdDate = flowData.createdAt
      ? new Date(flowData.createdAt).toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest' })
      : new Date().toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest' });

    const parts = [
      flowData.initName      ? ro(flowData.initName)      : null,
      flowData.initFunctie   ? ro(flowData.initFunctie)   : null,
      flowData.institutie    ? ro(flowData.institutie)    : null,
      flowData.compartiment  ? ro(flowData.compartiment)  : null,
    ].filter(Boolean).join(', ');

    const footerLeft  = createdDate + (parts ? '  |  ' + parts : '');
    const footerRight = ro(flowData.flowId || '') + '  |  DocFlowAI';

    // ── Poziționare ─────────────────────────────────────────────────────────
    const rightWidth  = fontR.widthOfTextAtSize(footerRight, FONT_SIZE);
    const rightX      = pW - MARGIN - rightWidth;
    const leftMaxWidth = rightX - MARGIN - 8;

    // ── Desenare ────────────────────────────────────────────────────────────
    lastPage.drawLine({
      start: { x: MARGIN, y: footerY + 10 },
      end:   { x: pW - MARGIN, y: footerY + 10 },
      thickness: 0.4,
      color: rgb(0.75, 0.75, 0.75),
    });
    lastPage.drawText(footerLeft, {
      x: MARGIN, y: footerY, size: FONT_SIZE, font: fontR,
      color: rgb(0.5, 0.5, 0.5), opacity: 0.8, maxWidth: leftMaxWidth,
    });
    lastPage.drawText(footerRight, {
      x: rightX, y: footerY, size: FONT_SIZE, font: fontR,
      color: rgb(0.5, 0.5, 0.5), opacity: 0.8,
    });

    // ancore: useObjectStreams:false pãstreazã structura AcroForm intactã
    const isAncore = flowData.flowType === 'ancore';
    return Buffer.from(await pdfDoc.save({ useObjectStreams: !isAncore })).toString('base64');

  } catch(e) {
    logger.warn({ err: e }, 'stampFooterOnPdf error (non-fatal)');
    return pdfB64;
  }
}
