/**
 * v3.9.497 (Finding #1 audit Pas 3) — guard că fix-ul de vizibilitate
 * a barei de revizie e prezent în surse. Vizibilitate DOM e testabilă
 * doar manual; aici doar string-match pentru a păzi împotriva eliminării
 * accidentale a fix-ului.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

describe('bara revizie: vizibilitate sincronizată cu tab-ul', () => {
  it('sw() în core.js ascunde bara când tab !== notafd', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/core.js'), 'utf8');
    expect(src).toMatch(/df-revizie-header-bar/);
    expect(src).toMatch(/v3\.9\.497.*Finding #1/);
  });

  it('updateRevizieHeaderBadge în doc.js ascunde bara la early return', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    expect(src).toMatch(/v3\.9\.497.*Finding #1/);
    // Verifică că în blocul if(ft!=='notafd') apare ascunderea barei
    const m = src.match(/if\(ft!=='notafd'\)\s*\{[\s\S]{0,400}\}/);
    expect(m, 'early-return block în updateRevizieHeaderBadge nu a fost găsit').toBeTruthy();
    expect(m[0]).toMatch(/df-revizie-header-bar/);
    expect(m[0]).toMatch(/display='none'/);
  });
});
