/**
 * v3.9.503 — guard că header-ul ALOP detail afișează valoarea estimată
 * + valoarea DF actual (când DF există cu valoare > 0).
 *
 * Test string-match pentru a păzi împotriva eliminării accidentale.
 * Render efectiv DOM nu e testabil aici (renderAlopDetail e funcție DOM).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

describe('ALOP detail header — valoare estimată + DF actual (v3.9.503)', () => {
  it('comentariul v3.9.503 e prezent în renderAlopDetail', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/alop.js'), 'utf8');
    expect(src).toMatch(/v3\.9\.503/);
  });

  it('header-ul include atât valoarea estimată cât și DF actual', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/alop.js'), 'utf8');
    // Localizează blocul IIFE care construiește valoarea în header
    const m = src.match(/v3\.9\.503[\s\S]{0,2000}?return\s*''[\s\S]{0,800}/);
    expect(m, 'bloc IIFE v3.9.503 nu a fost găsit').toBeTruthy();
    const block = m[0];
    expect(block).toMatch(/valoare_totala/);
    expect(block).toMatch(/df_valoare/);
    expect(block).toMatch(/estimat/);
    expect(block).toMatch(/DF actual/);
  });

  it('guard logic: hasEst și hasDf bazat pe parseFloat + df_id', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/alop.js'), 'utf8');
    expect(src).toMatch(/_hasEst\s*=\s*_vEst\s*>\s*0/);
    expect(src).toMatch(/_hasDf\s*=\s*_vDf\s*>\s*0\s*&&\s*!!a\.df_id/);
  });
});
