/**
 * #173 — paritate între lista de atribute de pe SERVER (services/atribute.mjs)
 * și copia din browser (public/js/shared/atribute.js, window.DFAtribute, #168).
 *
 * Cade dacă cineva adaugă un atribut într-un singur loc. NU „repara" divergența
 * schimbând doar una dintre liste — sunt aceeași listă, în două runtime-uri.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ATRIBUTE, esteAtributValid } from '../../services/atribute.mjs';

function listaDinPublic() {
  const src = readFileSync(resolve(process.cwd(), 'public/js/shared/atribute.js'), 'utf8');
  const m = src.match(/var LIST\s*=\s*\[([\s\S]*?)\n\s*\];/);
  expect(m, 'LIST nu a fost găsit în public/js/shared/atribute.js').toBeTruthy();
  // Comentariile de linie (`// #168 — …`) conțin text cu diacritice și ghilimele;
  // se elimină ÎNAINTE de extragerea literalilor (lecția #124i/#172).
  const body = m[1].replace(/\/\/[^\n]*/g, '');
  return [...body.matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

describe('#173 — paritate atribute server ↔ public', () => {
  it('3. ⭐ lista din public, minus __alt__, e IDENTICĂ (conținut și ordine) cu ATRIBUTE', () => {
    const pub = listaDinPublic();
    expect(pub[pub.length - 1]).toBe('__alt__');   // santinela rămâne ULTIMA
    expect(pub.filter((a) => a !== '__alt__')).toEqual([...ATRIBUTE]);
  });

  it('5. esteAtributValid respinge santinela __alt__', () => {
    expect(esteAtributValid('__alt__')).toBe(false);
  });

  it('esteAtributValid: acceptă cu trim, respinge non-string și necunoscute', () => {
    expect(esteAtributValid('APROBAT')).toBe(true);
    expect(esteAtributValid('  VIZĂ CFPP  ')).toBe(true);
    expect(esteAtributValid('XYZ')).toBe(false);
    expect(esteAtributValid('')).toBe(false);
    expect(esteAtributValid(undefined)).toBe(false);
    expect(esteAtributValid(42)).toBe(false);
  });

  it('ATRIBUTE e înghețat și nu conține duplicate', () => {
    expect(Object.isFrozen(ATRIBUTE)).toBe(true);
    expect(new Set(ATRIBUTE).size).toBe(ATRIBUTE.length);
  });
});
