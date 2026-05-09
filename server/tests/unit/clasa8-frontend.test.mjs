/**
 * Smoke tests pentru public/js/formular/clasa8.js și formular.html
 * Verifică că modal-ul folosește clasa CSS corectă (.open, nu .is-open)
 * și că file picker-ul stilizat e corect wire-up.
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

  it('input file are container styled custom (nu nativ vizibil)', () => {
    const html = readFileSync(
      join(__dir, '../../../public/formular.html'), 'utf8'
    );
    expect(html).toMatch(/id=["']clasa8-import-file-btn["']/);
    expect(html).toMatch(/id=["']clasa8-import-file-name["']/);
    // input-ul nativ trebuie să fie clip-ascuns, nu vizibil
    const fileInputMatch = html.match(/<input[^>]*id=["']clasa8-import-file["'][^>]*>/s);
    expect(fileInputMatch).toBeTruthy();
    expect(fileInputMatch[0]).toMatch(/clip\s*:\s*rect\(0,0,0,0\)|position\s*:\s*absolute/);
  });

  it('JS face wire pe buton custom + actualizează numele fișierului', () => {
    expect(clasa8Js).toMatch(/clasa8-import-file-btn/);
    expect(clasa8Js).toMatch(/clasa8-import-file-name/);
  });
});
