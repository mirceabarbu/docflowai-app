/**
 * v3.9.498 (Issue R-A) — guard că validarea img2 e prezentă în populateOrd.
 * Test string-match pentru a păzi împotriva eliminării accidentale.
 * Comportament vizual al broken-icon-ului e testabil doar manual pe staging.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

describe('populateOrd: defensive img2 validation', () => {
  it('verifică prefix "data:image/" înainte de showImg', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    expect(src).toMatch(/v3\.9\.498.*Issue R-A/);
    // Validarea trebuie să folosească regex pe prefixul data URL
    expect(src).toMatch(/data:image\\\/\(png\|jpe\?g\|webp\|gif\|bmp\)/);
    // _img2Valid trebuie să fie folosit ca guard pentru showImg
    const m = src.match(/_img2Valid\s*=[\s\S]{0,300}showImg\('o-cimg2'/);
    expect(m, 'blocul _img2Valid → showImg lipsește').toBeTruthy();
  });

  it('când invalid, loghează warning cu preview', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    expect(src).toMatch(/console\.warn\([^)]*v3\.9\.498[^)]*img2/);
  });
});
