/**
 * #172b — cursa de inițializare: implicitele nu mai șterg prefill-ul ALOP.
 *
 * Nu există harness DOM pentru main.js în repo — analiză statică pe sursă
 * (grep pe forme exacte), pe modelul reopen-button-render.test.mjs /
 * prefill-alop-roluri.test.mjs (#172).
 *
 * ⚠️ Comentariile dictate în prompt conțin intenționat numele funcțiilor
 * (applyAlopPrefill, setDefaults etc.) — lecția de la #124i/#172: filtrăm
 * liniile de comentariu înainte de a număra apelurile funcționale.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

const mainSrc = readFileSync(path.join(REPO, 'public/js/semdoc-initiator/main.js'), 'utf8');

/** Sursa fără liniile de comentariu `//` (întregi, fără să atingă expresii inline). */
const codeLines = mainSrc.split('\n').filter(l => !l.trim().startsWith('//'));
const codeSrc = codeLines.join('\n');

describe('#172b prefill ALOP — implicitele nu mai șterg prefill-ul', () => {
  it('1 function applyAlopPrefill() definită exact o dată', () => {
    const matches = codeSrc.match(/function applyAlopPrefill\(\)/g) || [];
    expect(matches.length).toBe(1);
  });

  it('2 ⭐ applyAlopPrefill() apelată exact de două ori în codul funcțional', () => {
    // exclude definiția funcției însăși ("function applyAlopPrefill()"), numără doar apelurile
    const calls = (codeSrc.match(/(?<!function )applyAlopPrefill\(\)/g) || []);
    expect(calls.length).toBe(2);
  });

  it('3 ⭐ setDefaults() din blocul Default load e gardat de !_prefillPus && !window._alopPrefillApplied', () => {
    const m = codeSrc.match(/const _prefillPus = applyAlopPrefill\(\);\s*\n\s*if \(([^)]+)\) \{\s*\n\s*setDefaults\(\);/);
    expect(m).toBeTruthy();
    const cond = m[1];
    expect(cond).toContain('!_restored');
    expect(cond).toContain('!_prefillPus');
    expect(cond).toContain('!window._alopPrefillApplied');
  });

  it('4 loadDbUsers NU mai conține aplicarea inline a prefill-ului (deleagă în applyAlopPrefill)', () => {
    expect(codeSrc).not.toContain('window._alopPrefillSigners.forEach(s => _alTbody.appendChild(signerRowTemplate(s)));');
    // reset-ul _alTbody.innerHTML="" trăiește DOAR în applyAlopPrefill (nu și direct în loadDbUsers)
    const alTbodyResets = (codeSrc.match(/_alTbody\.innerHTML = "";/g) || []);
    expect(alTbodyResets.length).toBe(1);
  });

  it('5 window._alopPrefillApplied = true apare exact o dată, în interiorul applyAlopPrefill', () => {
    const matches = codeSrc.match(/window\._alopPrefillApplied = true;/g) || [];
    expect(matches.length).toBe(1);
    const fnBody = codeSrc.match(/function applyAlopPrefill\(\)\s*\{[\s\S]*?\n {6}\}/);
    expect(fnBody).toBeTruthy();
    expect(fnBody[0]).toContain('window._alopPrefillApplied = true;');
  });

  it('6 applyAlopPrefill conține validateForm()', () => {
    const fnBody = codeSrc.match(/function applyAlopPrefill\(\)\s*\{[\s\S]*?\n {6}\}/);
    expect(fnBody).toBeTruthy();
    expect(fnBody[0]).toContain('validateForm();');
  });

  it('7 regresie #172: setDefaults conține în continuare cele trei roluri implicite', () => {
    const fnBody = codeSrc.match(/function setDefaults\(\)\s*\{[\s\S]*?\n {6}\}/);
    expect(fnBody).toBeTruthy();
    expect(fnBody[0]).toContain("rol: \"ÎNTOCMIT\"");
    expect(fnBody[0]).toContain("rol: \"VIZAT\"");
    expect(fnBody[0]).toContain("rol: \"APROBAT\"");
  });
});
