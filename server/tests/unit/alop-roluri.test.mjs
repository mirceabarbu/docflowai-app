/**
 * #173 — vocabularul rolurilor ALOP e sursă unică.
 *
 * Testele parsează fișierele care conțin COPIILE (routes/alop.mjs pentru
 * defaults, public/js/formular/alop.js pentru etichete + atribute) și cad dacă
 * cineva schimbă doar una dintre copii. Analiză statică deliberată: importul
 * rutei ar trage tot lanțul de DB, iar `alop.js` e script de browser.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ALOP_ROLURI, ROLURI_OBLIGATORII, MAX_ROLURI_SABLON,
  esteRolCunoscut, atributImplicit,
} from '../../services/alop-roluri.mjs';
import { esteAtributValid } from '../../services/atribute.mjs';

const ROOT = resolve(process.cwd());
const readSrc = (p) => readFileSync(resolve(ROOT, p), 'utf8');

/** Extrage `role: 'x'` din blocul unei constante de tip array. */
function rolesFromConst(src, constName) {
  const m = src.match(new RegExp(`const ${constName}\\s*=\\s*\\[([\\s\\S]*?)\\n\\];`));
  expect(m, `constanta ${constName} nu a fost găsită`).toBeTruthy();
  return [...m[1].matchAll(/role:\s*'([^']+)'/g)].map((x) => x[1]);
}

describe('#173 — ALOP_ROLURI', () => {
  it('1. fiecare atribut al unui rol e un atribut valid', () => {
    for (const [role, def] of Object.entries(ALOP_ROLURI)) {
      expect(esteAtributValid(def.atribut), `rolul ${role} → ${def.atribut}`).toBe(true);
    }
  });

  it('2. rolurile din DF_/ORD_DEFAULT_SEMNATARI sunt toate cunoscute', () => {
    const src = readSrc('server/routes/alop.mjs');
    const df = rolesFromConst(src, 'DF_DEFAULT_SEMNATARI');
    const ord = rolesFromConst(src, 'ORD_DEFAULT_SEMNATARI');
    expect(df.length).toBe(6);
    expect(ord.length).toBe(4);
    for (const r of [...df, ...ord]) {
      expect(esteRolCunoscut(r), `rol necunoscut în defaults: ${r}`).toBe(true);
    }
  });

  it('4. paritate cu frontendul: ALOP_ROL + ROLE_LABEL din public/js/formular/alop.js', () => {
    const src = readSrc('public/js/formular/alop.js');

    const mRol = src.match(/const ALOP_ROL\s*=\s*\{([\s\S]*?)\n\s*\};/);
    expect(mRol, 'ALOP_ROL nu a fost găsit').toBeTruthy();
    const feAtrib = {};
    for (const x of mRol[1].matchAll(/([a-z_]+)\s*:\s*'([^']+)'/g)) feAtrib[x[1]] = x[2];

    const mLab = src.match(/const ROLE_LABEL\s*=\s*\{([\s\S]*?)\n\};/);
    expect(mLab, 'ROLE_LABEL nu a fost găsit').toBeTruthy();
    const feLabel = {};
    for (const x of mLab[1].matchAll(/([a-z_]+)\s*:\s*'([^']+)'/g)) feLabel[x[1]] = x[2];

    expect(Object.keys(feAtrib).sort()).toEqual(Object.keys(ALOP_ROLURI).sort());
    expect(Object.keys(feLabel).sort()).toEqual(Object.keys(ALOP_ROLURI).sort());
    for (const [role, def] of Object.entries(ALOP_ROLURI)) {
      expect(feAtrib[role], `atribut divergent pentru ${role}`).toBe(def.atribut);
      expect(feLabel[role], `etichetă divergentă pentru ${role}`).toBe(def.eticheta);
    }
  });

  it('6. ALOP_ROLURI e înghețat (și definițiile din el)', () => {
    expect(Object.isFrozen(ALOP_ROLURI)).toBe(true);
    expect(Object.isFrozen(ALOP_ROLURI.initiator)).toBe(true);
    expect(Object.isFrozen(ROLURI_OBLIGATORII)).toBe(true);
  });

  it('helpers: esteRolCunoscut / atributImplicit', () => {
    expect(esteRolCunoscut('initiator')).toBe(true);
    expect(esteRolCunoscut('rol_inventat')).toBe(false);
    expect(esteRolCunoscut(null)).toBe(false);
    expect(esteRolCunoscut('toString')).toBe(false);   // fără moștenire din Object.prototype
    expect(atributImplicit('cfp_propriu')).toBe('VIZĂ CFPP');
    expect(atributImplicit('rol_inventat')).toBe(null);
  });

  it('initiator e obligatoriu, iar plafonul de roluri e definit', () => {
    expect(ROLURI_OBLIGATORII).toContain('initiator');
    expect(MAX_ROLURI_SABLON).toBeGreaterThan(Object.keys(ALOP_ROLURI).length);
  });
});
