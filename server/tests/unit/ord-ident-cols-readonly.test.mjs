import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE = readFileSync(resolve(__dirname, '../../../public/js/formular/core.js'), 'utf8');
const DOC = readFileSync(resolve(__dirname, '../../../public/js/formular/doc.js'), 'utf8');

// prompt #100.1 — coloanele de identitate ORD (cod_angajament, indicator_angajament,
// program, cod_SSI) sunt DERIVATE din DF-ul aprobat, nu introduse de utilizator.
// Testul apără INVARIANTA (nu implementarea): dacă cineva redenumește un data-f în
// core.js fără să sincronizeze doc.js, blocarea devine tăcut inoperantă.
describe('prompt #100.1 — ORD: coloane de identitate needitabile când e legat de DF', () => {
  const identCols = ['cod_angajament', 'indicator_angajament', 'program', 'cod_SSI'];

  it('addOR() (core.js) generează cele 4 câmpuri de identitate cu data-f', () => {
    for (const f of identCols) {
      expect(CORE).toContain(`data-f="${f}"`);
    }
  });

  it('doc.js declară ORD_IDENT_COLS cu exact cele 4 câmpuri', () => {
    const m = DOC.match(/const ORD_IDENT_COLS\s*=\s*\[([^\]]+)\]/);
    expect(m).not.toBeNull();
    const listed = m[1].split(',').map((s) => s.trim().replace(/['"]/g, ''));
    expect(listed.sort()).toEqual([...identCols].sort());
  });

  it('lockOrdIdentityCols foloseşte readOnly, NU disabled', () => {
    const start = DOC.indexOf('function lockOrdIdentityCols');
    expect(start).toBeGreaterThan(-1);
    const end = DOC.indexOf('\n}', start);
    const body = DOC.slice(start, end);
    expect(body).toContain('inp.readOnly=linked');
    expect(body).not.toMatch(/inp\.disabled\s*=/);
  });

  it('câmpul sursă al lui "linked" e #o-df-id (hidden, sursa de adevăr la salvare)', () => {
    const start = DOC.indexOf('function lockOrdIdentityCols');
    const end = DOC.indexOf('\n}', start);
    const body = DOC.slice(start, end);
    expect(body).toContain("getElementById('o-df-id')");
  });

  it('lockOrdIdentityCols e reaplicată după fiecare lockAll pe ordnt', () => {
    // Fiecare apel lockAll('ordnt',...) sau lockAll(ft,...) urmat (undeva în aceeași
    // funcţie) de reaplicarea blocării — verificăm doar că numărul de apeluri
    // lockOrdIdentityCols() e cel puţin egal cu numărul de call-site-uri lockAll
    // relevante pentru ordnt (grosier, dar suficient ca gardă anti-regresie).
    const lockAllOrdntSites = (DOC.match(/lockAll\('ordnt'/g) || []).length;
    const lockOrdIdentCalls = (DOC.match(/lockOrdIdentityCols\(\)/g) || []).length;
    expect(lockAllOrdntSites).toBeGreaterThan(0);
    expect(lockOrdIdentCalls).toBeGreaterThanOrEqual(lockAllOrdntSites);
  });
});
