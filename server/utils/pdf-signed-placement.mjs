/**
 * server/utils/pdf-signed-placement.mjs
 *
 * PDF-uri pre-semnate la upload (conțin deja un câmp QES /ByteRange aplicat
 * într-un soft extern ÎNAINTE de upload).
 *
 * Pentru astfel de PDF-uri NU avem voie să rescriem documentul (un re-save
 * pdf-lib ar invalida semnătura existentă). `stampFooterOnPdf` sare intenționat
 * (guard `preventRewriteIfSigned`), deci nu mai returnează `signerRects` →
 * `signer.padesRect` rămâne `undefined` → fallback-ul hardcodat din
 * `cloud-signing.mjs` plasa aparențele iText pe pagina 1, peste conținut.
 *
 * `computeSignerRectsReadOnly` calculează `padesRect` per semnatar FĂRĂ să
 * atingă un singur byte din PDF (read-only), folosind aceeași geometrie de
 * celule ca `stampFooterOnPdf`, dar restrânsă la ultima pagină existentă (nu
 * putem adăuga pagini fără a invalida semnătura).
 */

import { detectContentYs as _detectContentYs, findLowestUsableGap } from './pdf-content-detect.mjs';

/**
 * pdfLooksSigned — euristică pe bytes (latin1) pentru a detecta dacă PDF-ul
 * conține deja o semnătură QES / un câmp /Sig.
 *
 * Mutată din `server/index.mjs` (v3.9.552) pentru a fi refolosită la call-site
 * (crud.mjs / lifecycle.mjs). `server/index.mjs` o importă de aici — comportament
 * identic bit-cu-bit.
 */
export function pdfLooksSigned(pdfB64) {
  try {
    if (!pdfB64) return false;
    const clean = pdfB64.includes(',') ? pdfB64.split(',')[1] : pdfB64;
    const buf = Buffer.from(clean, 'base64');
    const sample = buf.toString('latin1');
    return (
      sample.includes('/ByteRange') ||
      sample.includes('/Contents<') ||
      sample.includes('/Contents <') ||
      sample.includes('/SubFilter/ETSI.CAdES.detached') ||
      sample.includes('/SubFilter /ETSI.CAdES.detached') ||
      sample.includes('/Type/Sig') ||
      sample.includes('/Type /Sig')
    );
  } catch { return false; }
}

/**
 * computeSignerRectsReadOnly — calculează `padesRect` per semnatar pentru un
 * PDF deja semnat, FĂRĂ a modifica PDF-ul.
 *
 * @param {string} pdfB64   — PDF-ul (base64, cu sau fără data-URL prefix)
 * @param {Array}  signers  — lista de semnatari (folosim doar length-ul + ordinea)
 * @param {object} PDFLib   — modulul pdf-lib (injectat — load async la pornire)
 * @param {object} [logger] — logger Pino opțional (pentru warn la forced placement)
 * @returns {Promise<{ signerRects: Array<{page,x,y,w,h}>, placement: 'bottom'|'gap'|'forced'|'none'|'error' }>}
 *   `page` e 1-based, identic cu formatul din `stampFooterOnPdf`.
 *
 * ⚠️ GEOMETRIE SINCRONIZATĂ MANUAL cu `stampFooterOnPdf` din `server/index.mjs`
 *    (sideMargin, colGap, rowGap, cols, cellW, cellH, h=65, SAFETY_MARGIN,
 *    GAP_MARGIN). Orice schimbare a geometriei cartușului acolo TREBUIE
 *    reflectată aici, altfel aparențele iText se desfac față de footer.
 */
export async function computeSignerRectsReadOnly(pdfB64, signers, PDFLib, logger = null) {
  if (!pdfB64 || !PDFLib) return { signerRects: [], placement: 'none' };
  const list = Array.isArray(signers) ? signers : [];
  if (!list.length) return { signerRects: [], placement: 'none' };

  try {
    const { PDFDocument } = PDFLib;
    const clean = pdfB64.includes(',') ? pdfB64.split(',')[1] : pdfB64;
    // NU salvăm NICIODATĂ acest pdfDoc — read-only, ca să nu invalidăm semnătura.
    const pdfDoc = await PDFDocument.load(Buffer.from(clean, 'base64'), { ignoreEncryption: true });

    const pageCount = pdfDoc.getPageCount();
    const lastPage = pdfDoc.getPages()[pageCount - 1];
    const lastPageNum = pageCount; // 1-based — ultima pagină existentă
    const { width, height } = lastPage.getSize();

    // ── Geometrie celule — REPLICĂ FIDELĂ a stampFooterOnPdf ──────────────────
    const sideMargin = 40;
    const colGap = 1;
    const rowGap = 1;
    const footerY = 14;
    const n = list.length;
    let cols = 3;
    if (n === 1) cols = 1;
    else if (n === 2) cols = 2;
    else if (n === 3) cols = 3;
    else if (n === 4) cols = 2;
    else cols = 3;
    const rows = Math.ceil(n / cols);

    const totalWidth = width - (sideMargin * 2) - ((cols - 1) * colGap);
    const cellW = totalWidth / cols;
    const cellH = Math.max(56, Math.min(78,
      (Math.max(120, height * 0.30) - ((rows - 1) * rowGap)) / rows));
    const cartusTotalH = rows * cellH + (rows - 1) * rowGap;

    // ── Detectare conținut pe ultima pagină (CTM-aware, v3.9.496) ─────────────
    const contentYs = _detectContentYs(lastPage, 45, PDFLib);
    const minContentY = contentYs && contentYs.length ? contentYs[0] : null;

    // Try 1: bottom placement (identic cu stampFooterOnPdf) ───────────────────
    const SAFETY_MARGIN = 25;
    const requiredFreeY = (footerY + 32) + cartusTotalH + SAFETY_MARGIN;
    const fitsAtBottom = (minContentY !== null) && (minContentY >= requiredFreeY);

    // Try 2: gap placement mid-page ───────────────────────────────────────────
    const GAP_MARGIN = 15;
    const REQUIRED_GAP = cartusTotalH + 2 * GAP_MARGIN;
    let lowestGap = null;
    if (!fitsAtBottom && contentYs) {
      lowestGap = findLowestUsableGap(contentYs, REQUIRED_GAP);
    }

    let placement, startY;
    if (fitsAtBottom) {
      // Bottom placement clasic: deasupra footer-ului
      placement = 'bottom';
      const blockBottom = footerY + 41;
      const blockTop = blockBottom + rows * cellH + (rows - 1) * rowGap;
      startY = Math.min(height - 40, blockTop) - cellH;
    } else if (lowestGap) {
      // Mid-page placement: banda goală cea mai joasă
      placement = 'gap';
      const blockBottom = lowestGap.gapBottom + GAP_MARGIN;
      const blockTop = blockBottom + rows * cellH + (rows - 1) * rowGap;
      startY = blockTop - cellH;
    } else {
      // Forced: NU putem adăuga pagină (ar invalida semnătura existentă).
      // Plasăm în cea mai liberă bandă disponibilă pe ultima pagină — DEASUPRA
      // celui mai jos conținut detectat, lipit de footer dacă nu avem detecție.
      // NICIODATĂ page 1, NICIODATĂ coordonate care ignoră conținutul.
      placement = 'forced';
      const blockBottom = (minContentY !== null)
        ? Math.max(footerY + 41, minContentY + GAP_MARGIN)
        : footerY + 41;
      const blockTop = blockBottom + rows * cellH + (rows - 1) * rowGap;
      startY = Math.min(height - 40, blockTop) - cellH;
      if (logger) logger.warn(
        { pages: pageCount, minContentY, requiredFreeY, cartusTotalH },
        'computeSignerRectsReadOnly: forced placement (fără bandă liberă pe ultima pagină)');
    }

    const signerRects = [];
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / cols);
      const col = i % cols;
      const x = sideMargin + col * (cellW + colGap);
      const y = startY - row * (cellH + rowGap);
      // h=65: identic cu stampFooterOnPdf (7 linii + padding + chenar)
      signerRects.push({ page: lastPageNum, x, y, w: cellW, h: 65 });
    }
    return { signerRects, placement };
  } catch (e) {
    if (logger) logger.warn({ err: e }, 'computeSignerRectsReadOnly error (non-fatal)');
    return { signerRects: [], placement: 'error' };
  }
}
