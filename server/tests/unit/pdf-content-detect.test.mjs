// pdf-content-detect.test.mjs
//
// Test guard v3.9.496 — detectContentYs trebuie să trateze corect operatorii
// `cm` (concat matrix), `q` (save state), `Q` (restore state) astfel încât
// PDF-urile generate cu Y-flip ("1 0 0 -1 0 H cm" — Microsoft Print to PDF,
// Chrome "Save as PDF", Quartz on macOS) să raporteze poziții de text în
// spațiu pagină, nu în spațiu transformat.
//
// Repro al bugului: text vizibil sus pe pagină (page-y ≈ 792 pe A4) era
// raportat ca y=50 (Y în spațiu Y-flipped) → fitsAtBottom=false → pagină
// albă suplimentară pentru cartuș.

import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import * as PDFLib from 'pdf-lib';
import { detectContentYs, findLowestUsableGap } from '../../utils/pdf-content-detect.mjs';

// Helper: construiește un PDF minimal de o pagină A4 cu un content stream dat.
async function makePdfWithStream(streamText) {
  const compressed = zlib.deflateSync(Buffer.from(streamText, 'latin1'));
  const header = '%PDF-1.4\n';
  const o = [];
  let buf = Buffer.from(header, 'latin1');
  const pushObj = (s) => {
    o.push(buf.length);
    buf = Buffer.concat([buf, Buffer.from(s, 'latin1')]);
  };
  pushObj('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  pushObj('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  pushObj('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n');
  const obj4Header = `4 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`;
  o.push(buf.length);
  buf = Buffer.concat([buf, Buffer.from(obj4Header, 'latin1'), compressed, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
  pushObj('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');
  const xrefOff = buf.length;
  let xref = 'xref\n0 6\n0000000000 65535 f \n';
  for (const off of o) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOff}\n%%EOF\n`;
  buf = Buffer.concat([buf, Buffer.from(xref, 'latin1')]);
  return buf;
}

async function loadPage(pdfBuf) {
  const doc = await PDFLib.PDFDocument.load(pdfBuf, { ignoreEncryption: true });
  return doc.getPage(0);
}

describe('detectContentYs — CTM tracking (v3.9.496)', () => {
  it('PDF cu Y-flip "1 0 0 -1 0 842 cm": Tm la y=50 → page-y=792', async () => {
    const stream = `q
1 0 0 -1 0 842 cm
BT /F1 12 Tf 1 0 0 -1 50 50 Tm (text top) Tj ET
Q
`;
    const pdf = await makePdfWithStream(stream);
    const page = await loadPage(pdf);
    const ys = detectContentYs(page, 45, PDFLib);
    expect(ys, 'detectContentYs nu trebuie să returneze null pentru content stream valid').not.toBeNull();
    expect(ys.length).toBeGreaterThan(0);
    // page-y = b*x + d*y + f = 0*50 + (-1)*50 + 842 = 792
    expect(ys[0]).toBeCloseTo(792, 0);
    expect(ys[0]).toBeGreaterThan(700);
    expect(ys[0]).toBeLessThan(800);
  });

  it('PDF fără Y-flip (CTM identity): Tm la y=792 → page-y=792 (backward compat)', async () => {
    const stream = `BT /F1 12 Tf 1 0 0 1 50 792 Tm (text top) Tj ET
`;
    const pdf = await makePdfWithStream(stream);
    const page = await loadPage(pdf);
    const ys = detectContentYs(page, 45, PDFLib);
    expect(ys).not.toBeNull();
    expect(ys[0]).toBeCloseTo(792, 0);
  });

  it('q/Q: cm într-un sub-bloc nu afectează CTM-ul după Q', async () => {
    const stream = `q
1 0 0 -1 0 842 cm
BT /F1 12 Tf 1 0 0 -1 0 50 Tm (in flipped) Tj ET
Q
BT /F1 12 Tf 1 0 0 1 0 100 Tm (after Q) Tj ET
`;
    const pdf = await makePdfWithStream(stream);
    const page = await loadPage(pdf);
    const ys = detectContentYs(page, 45, PDFLib);
    expect(ys).not.toBeNull();
    // În blocul flip: pageY = -1*50 + 842 = 792
    // După Q: CTM revine la identity, Tm y=100 → pageY = 100
    expect(ys).toContain(792);
    expect(ys).toContain(100);
  });

  it('decizie integrată: PDF cu Y-flip și text sus → fitsAtBottom=true (cartuș 1 row)', async () => {
    const stream = `q
1 0 0 -1 0 842 cm
BT /F1 12 Tf 1 0 0 -1 50 50 Tm (text sus) Tj ET
BT /F1 12 Tf 1 0 0 -1 50 70 Tm (linia 2) Tj ET
Q
`;
    const pdf = await makePdfWithStream(stream);
    const page = await loadPage(pdf);
    const ys = detectContentYs(page, 45, PDFLib);
    const minContentY = ys && ys.length ? ys[0] : null;

    // Same formula as stampFooterOnPdf for 1-row cartuș on A4
    const footerY = 14;
    const cartusTotalH = 78;
    const SAFETY_MARGIN = 25;
    const requiredFreeY = (footerY + 32) + cartusTotalH + SAFETY_MARGIN; // 149
    const fitsAtBottom = (minContentY !== null) && (minContentY >= requiredFreeY);

    expect(fitsAtBottom,
      `cu CTM tracking, content vizibil sus pe pagină trebuie să producă ` +
      `fitsAtBottom=true (minContentY=${minContentY}, requiredFreeY=${requiredFreeY})`
    ).toBe(true);
  });

  it('null pe content stream lipsă (PDF criptat / structură exotică)', async () => {
    const doc = await PDFLib.PDFDocument.create();
    doc.addPage([595, 842]);
    const buf = Buffer.from(await doc.save());
    const reloaded = await PDFLib.PDFDocument.load(buf);
    const result = detectContentYs(reloaded.getPage(0), 45, PDFLib);
    expect(result === null || result.length === 0).toBe(true);
  });
});

describe('findLowestUsableGap (v3.9.496)', () => {
  it('returnează null pe array gol sau < 2 elemente', () => {
    expect(findLowestUsableGap([], 100)).toBeNull();
    expect(findLowestUsableGap([100], 100)).toBeNull();
    expect(findLowestUsableGap(null, 100)).toBeNull();
  });

  it('găsește gap-ul cel mai jos care satisface minGapSize', () => {
    const g = findLowestUsableGap([50, 60, 70, 500, 510], 108);
    expect(g).not.toBeNull();
    expect(g.gapBottom).toBe(70);
    expect(g.gapTop).toBe(500);
    expect(g.gapSize).toBe(430);
  });

  it('returnează null dacă niciun gap nu satisface minGapSize', () => {
    expect(findLowestUsableGap([50, 100, 150, 200], 60)).toBeNull();
  });
});
