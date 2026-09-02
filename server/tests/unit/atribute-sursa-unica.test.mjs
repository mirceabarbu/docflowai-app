/**
 * #168 — „ÎNREGISTRAT CAB" + lista de atribute de semnatar consolidată într-o sursă unică.
 *
 * `public/js/shared/atribute.js` e un script CLASIC ce expune window.DFAtribute; îl evaluăm
 * peste un window minimal (nu are nevoie de DOM real). Restul cazurilor sunt analiză statică
 * pe cele două fișiere consumatoare + cele două pagini HTML gazdă, ca în admin-cancel-ui.test.mjs.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import vm from 'vm';

const __dir = dirname(fileURLToPath(import.meta.url));
const readPublic = (rel) => readFileSync(join(__dir, '../../../public/', rel), 'utf8');

const atributeSrc = readPublic('js/shared/atribute.js');
const templatesSrc = readPublic('js/templates/templates.js');
const mainSrc = readPublic('js/semdoc-initiator/main.js');
const semdocInitiatorHtml = readPublic('semdoc-initiator.html');
const templatesHtml = readPublic('templates.html');

let DFAtribute;

beforeAll(() => {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(atributeSrc, sandbox);
  DFAtribute = sandbox.window.DFAtribute;
});

describe('#168 — DFAtribute (sursa unică)', () => {
  it('⭐ conține ÎNREGISTRAT CAB, exact pe poziția ÎNREGISTRAT + 1', () => {
    const idxInreg = DFAtribute.LIST.indexOf('ÎNREGISTRAT');
    const idxCab = DFAtribute.LIST.indexOf('ÎNREGISTRAT CAB');
    expect(idxInreg).toBeGreaterThanOrEqual(0);
    expect(idxCab).toBe(idxInreg + 1);
  });

  it('ÎNREGISTRAT rămâne prezent, distinct de cel nou', () => {
    expect(DFAtribute.LIST).toContain('ÎNREGISTRAT');
    expect(DFAtribute.LIST.filter((a) => a === 'ÎNREGISTRAT')).toHaveLength(1);
  });

  it('__alt__ e ultimul element din listă', () => {
    expect(DFAtribute.LIST[DFAtribute.LIST.length - 1]).toBe('__alt__');
  });

  it('lista are 20 de elemente, fără duplicate', () => {
    expect(DFAtribute.LIST).toHaveLength(20);
    expect(new Set(DFAtribute.LIST).size).toBe(20);
  });

  it('⭐ buildOptions() fără argument emite 20 de <option> și niciun selected', () => {
    const html = DFAtribute.buildOptions();
    expect((html.match(/<option/g) || [])).toHaveLength(20);
    expect(html).not.toContain(' selected');
  });

  it('buildOptions("APROBAT") emite exact un selected, pe valoarea corectă', () => {
    const html = DFAtribute.buildOptions('APROBAT');
    expect((html.match(/ selected/g) || [])).toHaveLength(1);
    expect(html).toContain('value="APROBAT" selected');
  });

  it('buildOptions("CEVA INEXISTENT") emite zero selected, fără excepție', () => {
    expect(() => DFAtribute.buildOptions('CEVA INEXISTENT')).not.toThrow();
    const html = DFAtribute.buildOptions('CEVA INEXISTENT');
    expect(html).not.toContain(' selected');
  });

  it('eticheta lui __alt__ e "Alt atribut...", restul au eticheta identică cu valoarea', () => {
    const html = DFAtribute.buildOptions();
    expect(html).toContain('<option value="__alt__">Alt atribut...</option>');
    expect(html).toContain('<option value="APROBAT">APROBAT</option>');
    expect(html).toContain('<option value="ÎNREGISTRAT CAB">ÎNREGISTRAT CAB</option>');
  });
});

describe('#168 — analiză statică: nu mai există a doua copie', () => {
  it('⭐ templates.js NU mai conține literalul LUAT LA CUNOȘTINȚĂ și referă DFAtribute', () => {
    expect(templatesSrc).not.toContain("'LUAT LA CUNOȘTINȚĂ'");
    expect(templatesSrc).toContain('DFAtribute');
  });

  it('⭐ main.js NU mai conține <option value="APROBAT" și referă DFAtribute', () => {
    expect(mainSrc).not.toContain('<option value="APROBAT"');
    expect(mainSrc).toContain('DFAtribute');
  });
});

describe('#168 — analiză statică: ordinea de încărcare', () => {
  it('⭐ semdoc-initiator.html: shared/atribute.js apare înaintea semdoc-initiator/main.js', () => {
    const idxAtribute = semdocInitiatorHtml.indexOf('js/shared/atribute.js');
    const idxMain = semdocInitiatorHtml.indexOf('js/semdoc-initiator/main.js');
    expect(idxAtribute).toBeGreaterThan(-1);
    expect(idxMain).toBeGreaterThan(-1);
    expect(idxAtribute).toBeLessThan(idxMain);
  });

  it('⭐ templates.html: shared/atribute.js apare înaintea templates/templates.js, fără defer', () => {
    const idxAtribute = templatesHtml.indexOf('js/shared/atribute.js');
    const idxTemplates = templatesHtml.indexOf('js/templates/templates.js');
    expect(idxAtribute).toBeGreaterThan(-1);
    expect(idxTemplates).toBeGreaterThan(-1);
    expect(idxAtribute).toBeLessThan(idxTemplates);

    const line = templatesHtml.split('\n').find((l) => l.includes('js/shared/atribute.js'));
    expect(line).toBeTruthy();
    expect(line).not.toContain('defer');
  });
});
