// trim-empty-trailing-pages.test.mjs
//
// Test guard pentru v3.9.494 — LibreOffice produce uneori pagini trailing
// goale când conversia DOCX→PDF interpretează layout-ul diferit de Word
// (paginare diferită). Funcția trimEmptyTrailingPages() elimină paginile
// goale finale înainte de stamping pentru a evita „pagina albă între body
// și cartuș".
//
// Repro istoric: PDF DocFlowAI_PT_7E9A5A447E.pdf — DOCX cu Times New Roman
// convertit în PDF de 2 pagini, page 2 fără conținut renderable (LibreOffice
// a inserat un page break inutil).

import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  pageHasRenderableContent,
  trimEmptyTrailingPages,
} from '../../utils/convertToPdf.mjs';

async function makePdf(specs) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const s of specs) {
    const p = doc.addPage([595, 842]); // A4
    if (s === 'text') p.drawText('Hello body', { x: 50, y: 800, size: 12, font });
    else if (s === 'rect') p.drawRectangle({ x: 50, y: 50, width: 100, height: 50, color: rgb(0, 0, 0) });
    // 'empty' — nu desenăm nimic
  }
  return Buffer.from(await doc.save());
}

describe('trimEmptyTrailingPages — v3.9.494', () => {
  it('păstrează singura pagină (nu trim când nu există pagini trailing)', async () => {
    const buf = await makePdf(['text']);
    const out = await trimEmptyTrailingPages(buf);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(1);
  });

  it('elimină 1 pagină trailing goală după body', async () => {
    const buf = await makePdf(['text', 'empty']);
    const out = await trimEmptyTrailingPages(buf);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(1);
  });

  it('elimină multiple pagini trailing goale consecutive', async () => {
    const buf = await makePdf(['text', 'empty', 'empty', 'empty']);
    const out = await trimEmptyTrailingPages(buf);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(1);
  });

  it('NU elimină pagina goală din MIJLOC (doar trailing)', async () => {
    const buf = await makePdf(['text', 'empty', 'text']);
    const out = await trimEmptyTrailingPages(buf);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(3);
  });

  it('păstrează 2 pagini cu conținut text (no trim)', async () => {
    const buf = await makePdf(['text', 'text']);
    const out = await trimEmptyTrailingPages(buf);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(2);
  });

  it('păstrează pagina cu doar formă geometrică (rectangle)', async () => {
    const buf = await makePdf(['text', 'rect']);
    const out = await trimEmptyTrailingPages(buf);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(2);
  });

  it('NU șterge prima pagină chiar dacă e goală (safe-guard)', async () => {
    const buf = await makePdf(['empty']);
    const out = await trimEmptyTrailingPages(buf);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(1);
  });

  it('pageHasRenderableContent: detectează corect text', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage();
    p.drawText('X', { x: 50, y: 50, size: 12, font });
    const buf = Buffer.from(await doc.save());
    const reloaded = await PDFDocument.load(buf);
    expect(pageHasRenderableContent(reloaded.getPage(0))).toBe(true);
  });

  it('pageHasRenderableContent: returnează false pe pagină 100% goală', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const buf = Buffer.from(await doc.save());
    const reloaded = await PDFDocument.load(buf);
    expect(pageHasRenderableContent(reloaded.getPage(0))).toBe(false);
  });
});
