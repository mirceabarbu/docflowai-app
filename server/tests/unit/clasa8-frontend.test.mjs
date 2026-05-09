/**
 * Smoke tests pentru public/js/formular/clasa8.js
 * Verifică că modal-ul folosește clasa CSS corectă (.open, nu .is-open).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dir = fileURLToPath(new URL('.', import.meta.url));
const clasa8Js = readFileSync(
  join(__dir, '../../../public/js/formular/clasa8.js'), 'utf8'
);

describe('clasa8.js — modal class name regression', () => {
  it('NU folosește `.is-open` pentru #clasa8-import-modal', () => {
    // .is-open e specific trasabilitate-modal, NU .df-modal-bg
    const matches = clasa8Js.match(/['"]is-open['"]/g) || [];
    expect(matches.length).toBe(0);
  });

  it('folosește `.open` pentru a deschide/închide modalul', () => {
    expect(clasa8Js).toMatch(/classList\.(add|remove|toggle)\(\s*['"]open['"]/);
  });

  it('expune clasa8CloseImport pe window', () => {
    expect(clasa8Js).toMatch(/window\.clasa8CloseImport\s*=/);
  });
});
