/**
 * #174 — o singură cale de lansare din ALOP: prefill-ul semnatarilor scris
 * într-un singur loc, chemat de toate cele trei căi (mkFlow patch,
 * alopLaunchDfFlow, alopLaunchOrdFlow).
 *
 * Analiză statică pe sursă (grep pe forme exacte), pe modelul
 * prefill-alop-cursa.test.mjs (#172b).
 *
 * ⚠️ Comentariile dictate în prompt conțin intenționat numele funcției
 * (_alopScriePrefill) — lecția de la #124i/#172/#172b/#173: filtrăm liniile
 * de comentariu înainte de a număra apelurile funcționale.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

const alopSrc = readFileSync(path.join(REPO, 'public/js/formular/alop.js'), 'utf8');

/** Sursa fără liniile de comentariu `//` (întregi, fără să atingă expresii inline). */
const codeLines = alopSrc.split('\n').filter(l => !l.trim().startsWith('//'));
const codeSrc = codeLines.join('\n');

describe('#174 prefill ALOP — cale unică pentru toate căile de lansare', () => {
  it('1 ⭐ sessionStorage.setItem(\'docflow_prefill_signers\' apare exact o dată în tot fișierul', () => {
    const matches = codeSrc.match(/sessionStorage\.setItem\('docflow_prefill_signers'/g) || [];
    expect(matches.length).toBe(1);
  });

  it('2 ⭐ alopLaunchDfFlow apelează _alopScriePrefill( înainte de location.href', () => {
    const fnBody = codeSrc.match(/async function alopLaunchDfFlow\([^)]*\)\s*\{[\s\S]*?\n\}/);
    expect(fnBody).toBeTruthy();
    const body = fnBody[0];
    const callIdx = body.indexOf('_alopScriePrefill(');
    const navIdx = body.indexOf('location.href');
    expect(callIdx).toBeGreaterThan(-1);
    expect(navIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeLessThan(navIdx);
  });

  it('3 ⭐ alopLaunchOrdFlow apelează _alopScriePrefill( înainte de location.href', () => {
    const fnBody = codeSrc.match(/async function alopLaunchOrdFlow\([^)]*\)\s*\{[\s\S]*?\n\}/);
    expect(fnBody).toBeTruthy();
    const body = fnBody[0];
    const callIdx = body.indexOf('_alopScriePrefill(');
    const navIdx = body.indexOf('location.href');
    expect(callIdx).toBeGreaterThan(-1);
    expect(navIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeLessThan(navIdx);
  });

  it('4 const ALOP_ROL= apare exact o dată în fișier (mutat, nu duplicat)', () => {
    const matches = codeSrc.match(/const ALOP_ROL=/g) || [];
    expect(matches.length).toBe(1);
  });

  it('5 patch-ul mkFlow nu mai conține prefillSigners — construcția inline a dispărut', () => {
    const fnBody = codeSrc.match(/window\.mkFlow=function\(ft\)\s*\{[\s\S]*?\n {2}\};/);
    expect(fnBody).toBeTruthy();
    expect(fnBody[0]).not.toContain('prefillSigners');
  });

  it('6 window._alopScriePrefill e exportat exact o dată în blocul de exporturi', () => {
    const matches = codeSrc.match(/window\._alopScriePrefill\s*=\s*_alopScriePrefill;/g) || [];
    expect(matches.length).toBe(1);
  });

  it('7 garda de identitate ctx.alopId!==alopId e prezentă în corpul funcției', () => {
    const fnBody = codeSrc.match(/function _alopScriePrefill\([^)]*\)\s*\{[\s\S]*?\n\}/);
    expect(fnBody).toBeTruthy();
    expect(fnBody[0]).toContain('ctx.alopId!==alopId');
  });

  it('8 regresie: filter(u=>u.user_id||u.same_as_initiator) (previzualizarea din card) există în continuare, exact 1 dată', () => {
    const matches = codeSrc.match(/filter\(u=>u\.user_id\|\|u\.same_as_initiator\)/g) || [];
    expect(matches.length).toBe(1);
  });
});
