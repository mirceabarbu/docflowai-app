/**
 * #135 — cardul ALOP nu mai poate afișa simultan aceeași revizie ca fiind
 * ÎN VIGOARE și ÎN LUCRU. Test string-match pe sursă (render efectiv DOM nu
 * e testabil aici — renderAlopDetail e funcție DOM), pe tiparul lui
 * alop-header-df-actual.test.mjs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

describe('#135 — ALOP detail: coerența afișării reviziei (vigoare vs. lucru)', () => {
  it('sursa citește df_revizie_vigoare_nr (derivarea pe dosar, nu pointerul)', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/alop.js'), 'utf8');
    expect(src).toMatch(/df_revizie_vigoare_nr/);
  });

  it('starea reviziilor e calculată o singură dată, în _revStare, cu marcaj de incoerență', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/alop.js'), 'utf8');
    expect(src).toMatch(/_revStare/);
    expect(src).toMatch(/incoerent:/);
  });

  it('renderAlopDetail NU mai deduce revizia în vigoare prin scădere aritmetică', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/alop.js'), 'utf8');
    const matches = src.match(/df_revizie_lucru_nr-1/g) || [];
    expect(matches.length).toBe(0);
  });

  it('chip-ul "Revizie în lucru" e condiționat pe _revStare.lucru, nu pe câmpul brut', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/alop.js'), 'utf8');
    expect(src).toMatch(/_revStare\.lucru!=null/);
    expect(src).not.toMatch(/a\.df_revizie_lucru_nr!=null\?/);
  });
});
