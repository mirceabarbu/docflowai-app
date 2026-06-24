/**
 * Verificare blocantă: suma benzilor de plăți (pct.5) == total angajament actualizat (pct.4).
 *
 * Testează funcția PURĂ reală `evalSumaPlatiPure` din public/js/formular/core.js — extrasă din
 * sursă între marcajele /*__P5_PURE_START__*\/ și /*__P5_PURE_END__*\/ (fără copie/paste), plus
 * smoke-tests pe wiring-ul DOM (verificaSumaPlati, indicator, gate la Transmite P2).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dir = fileURLToPath(new URL('.', import.meta.url));
const coreJs = readFileSync(join(__dir, '../../../public/js/formular/core.js'), 'utf8');
const docJs  = readFileSync(join(__dir, '../../../public/js/formular/doc.js'), 'utf8');
const html   = readFileSync(join(__dir, '../../../public/formular.html'), 'utf8');

// Extrage funcția pură reală (nu o copie) din sursa shipped.
function loadPure() {
  const m = coreJs.match(/\/\*__P5_PURE_START__\*\/([\s\S]*?)\/\*__P5_PURE_END__\*\//);
  if (!m) throw new Error('Marcajele __P5_PURE__ lipsesc din core.js');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[1]}; return evalSumaPlatiPure;`)();
}
const evalSumaPlatiPure = loadPure();

describe('evalSumaPlatiPure — logica pură', () => {
  const base = { cuang: true, cuplati: true, faraplati: false, stingere: false };

  it('sume egale → ok=true, aplicabil=true, diferenta 0', () => {
    const r = evalSumaPlatiPure({ ...base, sumaAngajament: 550000, sumaPlati: 550000 });
    expect(r.aplicabil).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.diferenta).toBe(0);
  });

  it('exemplul din ghid: 0+29000+250000+271000+0+0 = 550000 → ok', () => {
    const sumaPlati = 0 + 29000 + 250000 + 271000 + 0 + 0;
    const r = evalSumaPlatiPure({ ...base, sumaAngajament: 550000, sumaPlati });
    expect(r.ok).toBe(true);
    expect(r.aplicabil).toBe(true);
  });

  it('sume diferite → ok=false, diferenta corectă (semnată)', () => {
    const r = evalSumaPlatiPure({ ...base, sumaAngajament: 550000, sumaPlati: 500000 });
    expect(r.aplicabil).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.diferenta).toBe(-50000);
  });

  it('diferență pozitivă (plăți > angajament)', () => {
    const r = evalSumaPlatiPure({ ...base, sumaAngajament: 100000, sumaPlati: 100050 });
    expect(r.ok).toBe(false);
    expect(r.diferenta).toBe(50);
  });

  it('rotunjire pe 2 zecimale: diferență ≤ 0.01 lei → ok (toleranță floating-point)', () => {
    const r = evalSumaPlatiPure({ ...base, sumaAngajament: 100.005, sumaPlati: 100.004 });
    expect(r.ok).toBe(true);
  });

  it('diferență de 1 ban (0.01) → tot ok (la limita toleranței)', () => {
    const r = evalSumaPlatiPure({ ...base, sumaAngajament: 100.00, sumaPlati: 100.01 });
    expect(r.ok).toBe(true);
  });

  it('diferență de 2 bani (0.02) → NU ok', () => {
    const r = evalSumaPlatiPure({ ...base, sumaAngajament: 100.00, sumaPlati: 100.02 });
    expect(r.ok).toBe(false);
  });

  it('„Stingere" bifat → aplicabil=false (NU blochează, chiar dacă sumele diferă)', () => {
    const r = evalSumaPlatiPure({
      cuang: true, cuplati: false, faraplati: false, stingere: true,
      sumaAngajament: 550000, sumaPlati: 0
    });
    expect(r.aplicabil).toBe(false);
  });

  it('fără „Cu angajamente" → aplicabil=false', () => {
    const r = evalSumaPlatiPure({
      cuang: false, cuplati: false, faraplati: false, stingere: false,
      sumaAngajament: 550000, sumaPlati: 0
    });
    expect(r.aplicabil).toBe(false);
  });

  it('„Fără plăți" cu tabel gol (sumaPlati=0) → aplicabil=false (nu blochează fals)', () => {
    const r = evalSumaPlatiPure({
      cuang: true, cuplati: false, faraplati: true, stingere: false,
      sumaAngajament: 550000, sumaPlati: 0
    });
    expect(r.aplicabil).toBe(false);
  });

  it('„Fără plăți" dar cu benzi completate (viitor) → aplicabil=true, verifică egalitatea', () => {
    const r = evalSumaPlatiPure({
      cuang: true, cuplati: false, faraplati: true, stingere: false,
      sumaAngajament: 550000, sumaPlati: 300000
    });
    expect(r.aplicabil).toBe(true);
    expect(r.ok).toBe(false);
  });

  it('angajament 0 → aplicabil=false (nimic de comparat)', () => {
    const r = evalSumaPlatiPure({ ...base, sumaAngajament: 0, sumaPlati: 0 });
    expect(r.aplicabil).toBe(false);
  });
});

describe('wiring DOM/UI', () => {
  it('verificaSumaPlati citește totalul pct.4 din n-vtbody (stab) sau n-ramana (ramane)', () => {
    expect(coreJs).toMatch(/function verificaSumaPlati\(/);
    expect(coreJs).toMatch(/sf\('n-vtbody','valt_actualiz'\)/);
    expect(coreJs).toMatch(/n-ramana/);
  });

  it('sumează toate cele 6 benzi de plăți din n-ptbody', () => {
    for (const band of ['plati_ani_precedenti','plati_estim_ancrt','plati_estim_an_np1','plati_estim_an_np2','plati_estim_an_np3','plati_estim_ani_ulter']) {
      expect(coreJs).toContain(band);
    }
  });

  it('indicatorul se reîmprospătează din upTot (chokepoint mutații) + togglurile pct.4/pct.5', () => {
    expect(coreJs).toMatch(/window\._updateSumaPlatiIndicator/);
    // upTot + p4toggle + p5toggle + p5SubToggle apelează indicatorul
    const calls = coreJs.match(/_updateSumaPlatiIndicator\(\)/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });

  it('există elementul indicator în formular.html sub tabelul pct.5', () => {
    expect(html).toMatch(/id=["']n-p5-check["']/);
    expect(html).toMatch(/class=["']p5-suma-check["']/);
  });

  it('gate blocant în _validateDf — folosește aplicabil && !ok', () => {
    expect(docJs).toMatch(/verificaSumaPlati\(\)/);
    expect(docJs).toMatch(/vp\.aplicabil\s*&&\s*!vp\.ok/);
  });
});
