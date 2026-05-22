// stamp-cartus-placement.test.mjs
//
// Test guard: pentru un PDF de o pagină A4 cu body dens până aproape de footer
// (caz raportat — raspuns_adresa_22_04.docx, minContentY=167), cartușul de 2
// semnatari TREBUIE plasat pe pagina existentă, NU pe pagină nouă.
//
// Repro istoric: SAFETY_MARGIN=60 → needsNewPage=true (pagină albă suplimentară).
// Cu SAFETY_MARGIN=25 → fitsAtBottom=true → cartuș pe pagina existentă.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

describe('stampFooterOnPdf: placement cartuș pentru PDF-uri dense', () => {
  it('SAFETY_MARGIN trebuie ≤ 30 pentru a permite plasare pe pagină existentă când minContentY≥150', () => {
    const src = readFileSync(path.join(REPO, 'server/index.mjs'), 'utf8');
    const m = src.match(/const SAFETY_MARGIN\s*=\s*(\d+)/);
    expect(m, 'SAFETY_MARGIN definition not found in server/index.mjs').toBeTruthy();
    const safetyMargin = parseInt(m[1], 10);
    expect(safetyMargin, 'SAFETY_MARGIN > 30 va cauza pagină albă suplimentară pe PDF-uri Office dense — vezi raspuns_adresa_22_04.docx repro').toBeLessThanOrEqual(30);
  });

  it('formula requiredFreeY pentru 2 semnatari cu PDF dens (minContentY=167) → fitsAtBottom=true', () => {
    const footerY = 14;
    const cartusTotalH = 78; // 1 row × cellHCheck=78 pentru pH=842
    const SAFETY_MARGIN = 25; // valoarea așteptată după fix
    const requiredFreeY = (footerY + 32) + cartusTotalH + SAFETY_MARGIN;
    const minContentY = 167; // raspuns_adresa_22_04.docx
    const fitsAtBottom = (minContentY >= requiredFreeY);
    expect(fitsAtBottom, `cu SAFETY_MARGIN=${SAFETY_MARGIN}, requiredFreeY=${requiredFreeY}, minContentY=${minContentY} → ar trebui să fits`).toBe(true);
  });
});
