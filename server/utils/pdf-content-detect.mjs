/**
 * server/utils/pdf-content-detect.mjs
 *
 * v3.9.496 — extras din server/index.mjs pentru testabilitate unitară +
 * adăugat tracking CTM (cm/q/Q) astfel încât PDF-urile generate prin
 * GDI/Quartz/Chrome (Microsoft Print to PDF, "Save as PDF" macOS, etc.)
 * care folosesc "1 0 0 -1 0 H cm" pentru Y-flip să raporteze poziții
 * de conținut corecte în spațiu pagină.
 *
 * Înainte: pentru un text vizibil sus pe pagină (page-y ≈ 792 pe A4),
 * parser-ul vechi raporta minContentY=50 (Y în spațiu transformat) →
 * fitsAtBottom=false → pagină albă suplimentară pentru cartuș.
 */

import zlib from 'node:zlib';

// PDF transform matrix format: [a, b, c, d, e, f] reprezentând
//   | a b 0 |
//   | c d 0 |
//   | e f 1 |
// `cm`: m_new = m_param × m_current  (concat la stânga; PDF spec 8.4.4)
function mul(m1, m2) {
  return [
    m1[0]*m2[0] + m1[1]*m2[2],
    m1[0]*m2[1] + m1[1]*m2[3],
    m1[2]*m2[0] + m1[3]*m2[2],
    m1[2]*m2[1] + m1[3]*m2[3],
    m1[4]*m2[0] + m1[5]*m2[2] + m2[4],
    m1[4]*m2[1] + m1[5]*m2[3] + m2[5],
  ];
}

// Transformă punctul (x, y) prin CTM și returnează Y-ul în spațiu pagină.
// pageY = b*x + d*y + f
function transformY(ctm, x, y) {
  return ctm[1] * x + ctm[3] * y + ctm[5];
}

/**
 * detectContentYs — întoarce array sortat ascending de Y-uri (în spațiu
 * pagină, după CTM) unde a fost detectat conținut, sau null dacă nu se
 * poate parsa stream-ul.
 *
 * @param {object} page — obiect pdf-lib PDFPage
 * @param {number} ignoreBelow — filtrează Y-uri sub această valoare (default 45,
 *   sub footer-ul DocFlowAI "Pagina X din Y" la y=38)
 * @param {object} PDFLib — modulul pdf-lib (injectat pentru a evita import
 *   circular cu server/index.mjs)
 */
export function detectContentYs(page, ignoreBelow = 45, PDFLib) {
  try {
    const { PDFArray, PDFRawStream } = PDFLib;
    const doc = page.doc;
    const contentsRef = page.node.Contents();
    if (!contentsRef) return null;

    const streams = [];
    if (contentsRef instanceof PDFArray) {
      for (let i = 0; i < contentsRef.size(); i++) {
        const resolved = doc.context.lookup(contentsRef.get(i));
        if (resolved) streams.push(resolved);
      }
    } else {
      const resolved = doc.context.lookup(contentsRef);
      if (resolved) streams.push(resolved);
    }

    const ySet = new Set();
    for (const stream of streams) {
      if (!(stream instanceof PDFRawStream) || !stream.contents) continue;
      let text;
      try {
        const inflated = zlib.inflateSync(Buffer.from(stream.contents));
        text = inflated.toString('latin1');
      } catch {
        try { text = Buffer.from(stream.contents).toString('latin1'); }
        catch { continue; }
      }

      const tokens = text.split(/[\s\n\r]+/);

      // Graphics state stack (q/Q) — fiecare element e o copie a CTM
      const ctmStack = [];
      let ctm = [1, 0, 0, 1, 0, 0];

      // Text state
      let txX = 0, txY = null;
      let leading = 0;

      const capture = (x, y) => {
        const pageY = transformY(ctm, x, y);
        if (pageY >= ignoreBelow) ySet.add(Math.round(pageY * 10) / 10);
      };

      for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];

        if (tok === 'q') {
          ctmStack.push(ctm.slice());
        } else if (tok === 'Q') {
          if (ctmStack.length) ctm = ctmStack.pop();
        } else if (tok === 'cm' && i >= 6) {
          // a b c d e f cm
          const m = [
            parseFloat(tokens[i-6]), parseFloat(tokens[i-5]),
            parseFloat(tokens[i-4]), parseFloat(tokens[i-3]),
            parseFloat(tokens[i-2]), parseFloat(tokens[i-1]),
          ];
          if (m.every(v => !isNaN(v))) ctm = mul(m, ctm);
        } else if (tok === 'BT') {
          txX = 0; txY = 0;
        } else if (tok === 'ET') {
          txY = null;
        } else if (tok === 'Tm' && i >= 6) {
          const e = parseFloat(tokens[i-2]);
          const f = parseFloat(tokens[i-1]);
          if (!isNaN(f)) {
            txX = isNaN(e) ? 0 : e;
            txY = f;
            capture(txX, txY);
          }
        } else if ((tok === 'Td' || tok === 'TD') && i >= 2) {
          const tx = parseFloat(tokens[i-2]);
          const ty = parseFloat(tokens[i-1]);
          if (!isNaN(ty) && txY !== null) {
            if (!isNaN(tx)) txX += tx;
            txY += ty;
            if (tok === 'TD') leading = -ty;
            capture(txX, txY);
          }
        } else if (tok === 'T*') {
          if (txY !== null) { txY -= leading; capture(txX, txY); }
        } else if (tok === 'TL' && i >= 1) {
          const v = parseFloat(tokens[i-1]);
          if (!isNaN(v)) leading = v;
        } else if (tok === 're' && i >= 4) {
          const x = parseFloat(tokens[i-4]);
          const y = parseFloat(tokens[i-3]);
          if (!isNaN(y)) capture(isNaN(x) ? 0 : x, y);
        }
      }
    }
    return ySet.size ? [...ySet].sort((a, b) => a - b) : null;
  } catch (e) {
    return null;
  }
}

/**
 * findLowestUsableGap — caută cea mai JOASĂ bandă goală >= minGapSize
 * într-un array sortat ascending de Y-uri. Preferăm gap-uri jos pe
 * pagină (cartușul stă semantic la sfârșitul documentului).
 */
export function findLowestUsableGap(ys, minGapSize) {
  if (!ys || ys.length < 2) return null;
  for (let i = 0; i < ys.length - 1; i++) {
    const gapSize = ys[i + 1] - ys[i];
    if (gapSize >= minGapSize) {
      return { gapBottom: ys[i], gapTop: ys[i + 1], gapSize };
    }
  }
  return null;
}
