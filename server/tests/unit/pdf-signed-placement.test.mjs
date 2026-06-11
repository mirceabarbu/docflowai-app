// pdf-signed-placement.test.mjs
//
// FIX (v3.9.552) — PDF-uri pre-semnate la upload:
//   - pdfLooksSigned: re-exportată din server/index.mjs, comportament identic.
//   - computeSignerRectsReadOnly: calculează padesRect per semnatar pe ULTIMA
//     pagină, FĂRĂ a modifica PDF-ul (read-only). page e 1-based.

import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import * as PDFLib from 'pdf-lib';
import { pdfLooksSigned, computeSignerRectsReadOnly } from '../../utils/pdf-signed-placement.mjs';

// Builder PDF multi-pagină cu control deplin asupra content stream-ului per pagină.
// pageStreams: array de string-uri (latin1) — câte un content stream per pagină.
// extraCatalog: text injectat în dicționarul Catalog (ex. pentru a face PDF-ul
//   „semnat" prin prezența literalului /ByteRange în bytes).
function buildPdf(pageStreams, extraCatalog = '') {
  const n = pageStreams.length;
  let buf = Buffer.from('%PDF-1.4\n', 'latin1');
  const offsets = [];
  const pushObj = (s) => { offsets.push(buf.length); buf = Buffer.concat([buf, Buffer.from(s, 'latin1')]); };
  const pushRaw = (parts) => {
    offsets.push(buf.length);
    buf = Buffer.concat([buf, ...parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p, 'latin1'))]);
  };

  const pageObjStart = 3;
  const contentObjStart = 3 + n;
  const fontObj = 3 + 2 * n;
  const kids = [];
  for (let i = 0; i < n; i++) kids.push(`${pageObjStart + i} 0 R`);

  pushObj(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R ${extraCatalog} >>\nendobj\n`);
  pushObj(`2 0 obj\n<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${n} >>\nendobj\n`);
  for (let i = 0; i < n; i++) {
    pushObj(`${pageObjStart + i} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${contentObjStart + i} 0 R /Resources << /Font << /F1 ${fontObj} 0 R >> >> >>\nendobj\n`);
  }
  for (let i = 0; i < n; i++) {
    const compressed = zlib.deflateSync(Buffer.from(pageStreams[i], 'latin1'));
    pushRaw([`${contentObjStart + i} 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`, compressed, `\nendstream\nendobj\n`]);
  }
  pushObj(`${fontObj} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);

  const xrefOff = buf.length;
  const total = offsets.length + 1;
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefOff}\n%%EOF\n`;
  buf = Buffer.concat([buf, Buffer.from(xref, 'latin1')]);
  return buf;
}

// Conținut puțin, sus pe pagină → minContentY mare → bottom placement.
const SPARSE = `BT /F1 12 Tf 1 0 0 1 50 800 Tm (titlu) Tj ET\n`;

// Conținut dens de sus până jos (pas 10pt) → fără gap, minContentY mic → forced.
function denseStream() {
  let s = '';
  for (let y = 800; y >= 50; y -= 10) s += `BT /F1 10 Tf 1 0 0 1 50 ${y} Tm (linie) Tj ET\n`;
  return s;
}

const signers = (k) => Array.from({ length: k }, (_, i) => ({ email: `s${i}@t.ro`, order: i + 1 }));

describe('pdfLooksSigned', () => {
  it('true pentru PDF cu /ByteRange în bytes', () => {
    const b64 = buildPdf([SPARSE], '/SigMark /ByteRange').toString('base64');
    expect(pdfLooksSigned(b64)).toBe(true);
  });
  it('false pentru PDF curat (nesemnat)', () => {
    const b64 = buildPdf([SPARSE]).toString('base64');
    expect(pdfLooksSigned(b64)).toBe(false);
  });
  it('false pentru input gol/invalid', () => {
    expect(pdfLooksSigned(null)).toBe(false);
    expect(pdfLooksSigned('')).toBe(false);
  });
  it('acceptă data-URL prefix', () => {
    const b64 = buildPdf([SPARSE], '/SigMark /ByteRange').toString('base64');
    expect(pdfLooksSigned('data:application/pdf;base64,' + b64)).toBe(true);
  });
});

describe('computeSignerRectsReadOnly', () => {
  it('semnatari goi → {signerRects:[], placement:"none"}', async () => {
    const b64 = buildPdf([SPARSE]).toString('base64');
    const r = await computeSignerRectsReadOnly(b64, [], PDFLib);
    expect(r).toEqual({ signerRects: [], placement: 'none' });
  });

  it('un rect per semnatar, page = ultima pagină (1-based)', async () => {
    const b64 = buildPdf([SPARSE, SPARSE, SPARSE]).toString('base64'); // 3 pagini
    const r = await computeSignerRectsReadOnly(b64, signers(2), PDFLib);
    expect(r.signerRects).toHaveLength(2);
    for (const rect of r.signerRects) {
      expect(rect.page).toBe(3); // ultima pagină, 1-based
      expect(rect.h).toBe(65);
      expect(rect.w).toBeGreaterThan(0);
    }
  });

  it('NU modifică PDF-ul (read-only) — input b64 neschimbat', async () => {
    const b64 = buildPdf([SPARSE], '/SigMark /ByteRange').toString('base64');
    const before = b64;
    await computeSignerRectsReadOnly(b64, signers(2), PDFLib);
    expect(b64).toBe(before);
  });

  it('placement "bottom" când conținutul e aerisit (sus pe pagină)', async () => {
    const b64 = buildPdf([SPARSE]).toString('base64');
    const r = await computeSignerRectsReadOnly(b64, signers(1), PDFLib);
    expect(r.placement).toBe('bottom');
    expect(r.signerRects[0].page).toBe(1);
  });

  it('placement "forced" când pagina e plină de sus până jos', async () => {
    const b64 = buildPdf([SPARSE, denseStream()]).toString('base64'); // pag.2 densă
    const r = await computeSignerRectsReadOnly(b64, signers(2), PDFLib);
    expect(r.placement).toBe('forced');
    // Niciodată page 1 — rect-urile stau pe ultima pagină (densă)
    for (const rect of r.signerRects) expect(rect.page).toBe(2);
  });

  it('multi-coloană: 3 semnatari → 3 coloane, x crescător, același y/page', async () => {
    const b64 = buildPdf([SPARSE]).toString('base64');
    const r = await computeSignerRectsReadOnly(b64, signers(3), PDFLib);
    expect(r.signerRects).toHaveLength(3);
    const [a, b, c] = r.signerRects;
    expect(a.x).toBeLessThan(b.x);
    expect(b.x).toBeLessThan(c.x);
    expect(a.y).toBe(b.y);
    expect(b.y).toBe(c.y);
    expect(new Set(r.signerRects.map(s => s.page)).size).toBe(1);
  });

  it('PDFLib lipsă → {signerRects:[], placement:"none"} (non-fatal)', async () => {
    const b64 = buildPdf([SPARSE]).toString('base64');
    const r = await computeSignerRectsReadOnly(b64, signers(1), null);
    expect(r).toEqual({ signerRects: [], placement: 'none' });
  });
});
