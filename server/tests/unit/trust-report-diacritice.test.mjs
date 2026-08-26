/**
 * #150 (A) — ordinea corectă strip↔mapare pentru diacritice în Raportul de
 * încredere. Codul vechi ștergea ă/ș/ț (în afara Latin-1) ÎNAINTE de a le
 * mapa prin tabelul `diacr` — "Semnătură" devenea "Semntur". `ro()` nu e
 * exportată (funcție privată în modul), deci re-derivăm identic aici din
 * sursă ca să testăm exact comportamentul, nu o reimplementare paralelă.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SRC  = readFileSync(join(ROOT, 'server', 'services', 'sign-trust-report.mjs'), 'utf8');

function loadRo() {
  const diacrMatch = SRC.match(/const diacr = \{[\s\S]*?\};/);
  const roMatch    = SRC.match(/const ro = t => [\s\S]*?;\n/);
  if (!diacrMatch || !roMatch) throw new Error('nu am gasit diacr/ro in sursa');
  // eslint-disable-next-line no-new-func
  const fn = new Function(`${diacrMatch[0]}\n${roMatch[0]}\nreturn ro;`);
  return fn();
}

describe('#150 (A) — ro() mapează diacriticele ÎNAINTE de a curăța ce nu e Latin-1', () => {
  const ro = loadRo();

  it('⭐⭐ 1. ro("Semnătură") === "Semnatura" (cade pe codul vechi, unde dă "Semntur")', () => {
    expect(ro('Semnătură')).toBe('Semnatura');
  });

  it('⭐ 2. ro("în lanț") === "in lant"', () => {
    expect(ro('în lanț')).toBe('in lant');
  });

  it('⭐ 3. ro("Calificat pe dovadă: QcSSCD") — niciun caracter lipsă', () => {
    expect(ro('Calificat pe dovadă: QcSSCD')).toBe('Calificat pe dovada: QcSSCD');
  });

  it('⭐ 4. un caracter neredabil (emoji) e eliminat, nu aruncă', () => {
    expect(() => ro('Semnat ✅ OK')).not.toThrow();
    expect(ro('Semnat ✅ OK')).toBe('Semnat  OK');
  });

  it('⭐ 5. ASCII pur trece neschimbat', () => {
    expect(ro('DocFlowAI Trust Report v1')).toBe('DocFlowAI Trust Report v1');
  });

  it('acoperă ambele forme Unicode (virgulă + sedilă) și majuscule', () => {
    expect(ro('ȘȚșțŞŢşţ')).toBe('STstSTst');
  });
});
