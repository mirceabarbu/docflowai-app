// crud-skip-reconversion.test.mjs
//
// Test guard v3.9.495 — la POST /flows, dacă body.pdfB64 e deja PDF
// (magic bytes %PDF-) și body.originalFileName e ".docx" (frontend-ul
// a convertit înainte de upload), backend-ul NU trebuie să apeleze
// convertToPdf. Re-conversia distrugea alignment-ul justify.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

describe('crud createFlow: skip re-conversion când buffer-ul e deja PDF', () => {
  it('codul în crud.mjs verifică magic bytes %PDF- înainte de convertToPdf', () => {
    const src = readFileSync(
      path.join(REPO, 'server/routes/flows/crud.mjs'), 'utf8'
    );
    expect(src,
      'crud.mjs trebuie să verifice "%PDF-" în primii 5 bytes ai buffer-ului ' +
      'înainte de a apela convertToPdf — altfel re-conversia DOCX-ului deja ' +
      'convertit distruge alignment-ul justify (v3.9.495 fix)'
    ).toMatch(/inputBuf\.subarray\(0,\s*5\)\.toString\('latin1'\)\s*===\s*'%PDF-'/);
  });

  it('skip-ul e gated de isAlreadyPdf și loghează cu "skip re-conversion"', () => {
    const src = readFileSync(
      path.join(REPO, 'server/routes/flows/crud.mjs'), 'utf8'
    );
    expect(src).toMatch(/const isAlreadyPdf\s*=/);
    expect(src).toMatch(/skip re-conversion/);
  });

  it('ramura else păstrează apelul convertToPdf pentru fișiere non-PDF reale', () => {
    const src = readFileSync(
      path.join(REPO, 'server/routes/flows/crud.mjs'), 'utf8'
    );
    // Convertul trebuie să existe în ramura else (nu eliminat complet)
    const blockMatch = src.match(/if \(isAlreadyPdf\)[\s\S]*?\} else \{([\s\S]*?)\n\s{2}\}/);
    expect(blockMatch, 'block if(isAlreadyPdf) ... else { ... } nu a fost găsit').toBeTruthy();
    expect(blockMatch[1]).toMatch(/convertToPdf\(inputBuf,\s*body\.originalFileName\)/);
  });
});
