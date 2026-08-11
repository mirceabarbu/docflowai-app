/**
 * #121: teste structurale (readFileSync) — filtre listă ALOP + dimensionare De la/Până la/Status.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dir = fileURLToPath(new URL('.', import.meta.url));
const formularHtml = readFileSync(join(__dir, '../../../public/formular.html'), 'utf8');
const alopJs = readFileSync(join(__dir, '../../../public/js/formular/alop.js'), 'utf8');
const formularCss = readFileSync(join(__dir, '../../../public/css/formular/formular.css'), 'utf8');

describe('#121 — filtre listă ALOP + dimensionare (structural)', () => {
  it('formular.html conține markup-ul filtrelor ALOP', () => {
    expect(formularHtml).toMatch(/id="flt-a-q"/);
    expect(formularHtml).toMatch(/id="flt-a-status"/);
    expect(formularHtml).toMatch(/id="flt-a-from"/);
    expect(formularHtml).toMatch(/resetAlopFilters\(\)/);
    expect(formularHtml).toMatch(/id="flt-status-grp"/);
  });

  it('alop.js exportă funcțiile de filtrare și citește query params', () => {
    expect(alopJs).toMatch(/window\.resetAlopFilters\s*=/);
    expect(alopJs).toMatch(/window\.debouncedLoadAlop\s*=/);
    expect(alopJs).toMatch(/_populateAlopCompartimente/);
    expect(alopJs).toMatch(/qs\.set\('q'/);
    expect(alopJs).toMatch(/qs\.set\('status'/);
  });

  it('formular.css conține regulile de dimensionare pentru filtrele ALOP', () => {
    expect(formularCss).toMatch(/flt-a-status-grp/);
    expect(formularCss).toMatch(/flt-a-from-grp/);
  });
});
