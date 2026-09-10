// server/tests/unit/password-policy.test.mjs
// #181 (v3.9.836) — politica de parole ca SURSĂ UNICĂ. Teste pure, fără DB.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validatePassword, MIN_PASSWORD_LEN, MAX_PASSWORD_LEN } from '../../services/password-policy.mjs';
import { generatePassword } from '../../middleware/auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../../../public');
const readPublic = (rel) => readFileSync(path.join(publicDir, rel), 'utf8');

const rep = (n) => 'a'.repeat(n);

describe('#181 password-policy — frontierele de lungime', () => {
  it('sub prag ⇒ password_too_short; exact pe prag ⇒ ok (ambele laturi ale frontierei)', () => {
    const under = validatePassword(rep(MIN_PASSWORD_LEN - 1));   // 9 caractere
    expect(under.ok).toBe(false);
    expect(under.error).toBe('password_too_short');

    const exact = validatePassword(rep(MIN_PASSWORD_LEN));       // 10 caractere
    expect(exact).toEqual({ ok: true });
  });

  it('exact pe plafon ⇒ ok; peste plafon ⇒ password_too_long cu max', () => {
    expect(validatePassword(rep(MAX_PASSWORD_LEN))).toEqual({ ok: true });

    const over = validatePassword(rep(MAX_PASSWORD_LEN + 1));
    expect(over.ok).toBe(false);
    expect(over.error).toBe('password_too_long');
    expect(over.max).toBe(MAX_PASSWORD_LEN);
    expect(over.max).toBe(200);   // ancoră: plafonul nu s-a mutat tăcut
  });
});

describe('#181 password-policy — absența parolei', () => {
  // Șirul gol e DELIBERAT password_missing, nu password_too_short: apelanții
  // tratează câmpul gol ca „nu atinge parola" / „generează una".
  const cases = [
    ['null', null],
    ['undefined', undefined],
    ['șir gol', ''],
    ['număr', 12345],
    ['obiect', {}],
    ['array', []],
    ['boolean', false],
  ];
  for (const [eticheta, valoare] of cases) {
    it(`${eticheta} ⇒ password_missing, fără să arunce`, () => {
      let out;
      expect(() => { out = validatePassword(valoare); }).not.toThrow();
      expect(out).toEqual({ ok: false, error: 'password_missing' });
    });
  }
});

describe('#181 password-policy — platforma își respectă propria politică', () => {
  // Testul care oprește pe cineva să urce pragul la 12 și să invalideze TĂCUT toate
  // parolele emise chiar de platformă (reset-password, bulk-import, GWS, maintenance).
  it('generatePassword() trece validatePassword() de 50 de ori la rând', () => {
    for (let i = 0; i < 50; i++) {
      const generata = generatePassword();
      const verdict = validatePassword(generata);
      expect(verdict, `parola generată "${generata}" (${generata.length} car.) nu respectă politica`).toEqual({ ok: true });
    }
  });
});

describe('#181 password-policy — mesajul e derivat din constantă', () => {
  it('mesajul de la password_too_short conține valoarea lui MIN_PASSWORD_LEN', () => {
    const out = validatePassword(rep(MIN_PASSWORD_LEN - 1));
    expect(out.message).toContain(String(MIN_PASSWORD_LEN));
    expect(out.message).toMatch(/minim/i);
  });
});

describe('#191 password-policy — frontendul rămâne aliniat la MIN_PASSWORD_LEN', () => {
  const jsFiles = [
    'js/admin/organizations.js',
    'js/df-user-modals.js',
    'js/semdoc-signer/modals.js',
  ];
  const htmlFiles = [
    'admin.html',
    'semdoc-signer.html',
  ];
  const expectedMessage = validatePassword('a'.repeat(MIN_PASSWORD_LEN - 1)).message;

  for (const rel of jsFiles) {
    it(`${rel} verifică lungimea parolei față de MIN_PASSWORD_LEN (${MIN_PASSWORD_LEN})`, () => {
      const src = readPublic(rel);
      const thresholdPattern = new RegExp('\\.length\\s*<\\s*' + MIN_PASSWORD_LEN + '\\b');
      expect(src).toMatch(thresholdPattern);
    });

    it(`${rel} nu conține un prag de PAROLĂ mai mic decât MIN_PASSWORD_LEN (excluzând codul TOTP)`, () => {
      const src = readPublic(rel);
      const matches = [...src.matchAll(/(\w+)\.length\s*<\s*(\d+)/g)];
      const belowThreshold = matches.filter(([, , num]) => Number(num) < MIN_PASSWORD_LEN);
      // Singurul prag sub MIN_PASSWORD_LEN tolerat e codul TOTP de 6 cifre (variabila `code`).
      for (const match of belowThreshold) {
        expect(match[1], `prag suspect sub MIN_PASSWORD_LEN găsit: "${match[0]}"`).toBe('code');
      }
    });

    it(`${rel} folosește mesajul identic cu cel al serverului`, () => {
      const src = readPublic(rel);
      expect(src).toContain(expectedMessage);
    });
  }

  for (const rel of htmlFiles) {
    it(`${rel} afișează eticheta „minim ${MIN_PASSWORD_LEN} caractere"`, () => {
      const src = readPublic(rel);
      expect(src).toContain(`minim ${MIN_PASSWORD_LEN} caractere`);
    });
  }
});
