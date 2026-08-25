/**
 * #144 (P0-05) — test STRUCTURAL: nicio afirmație „calificat" nu mai poate fi
 * emisă din potrivire de nume sau din simpla prezență a extensiei.
 *
 * Testul e deliberat pe TEXTUL surselor: apără o INVARIANTĂ arhitecturală
 * (o singură definiție a calificării), care nu se poate exprima prin apeluri —
 * un al treilea motor care ar reintroduce `numeQTSP || extensieExistă` ar trece
 * orice test comportamental pe celelalte două.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = p => readFileSync(join(ROOT, p), 'utf8');

const ENGINES = [
  'services/certificate-verify.mjs',
  'verify.mjs',
];

describe('#144 — ambele motoare deleagă verdictul la qc-evidence.mjs', () => {
  for (const file of ENGINES) {
    describe(file, () => {
      const src = read(file);

      it('importă modulul comun', () => {
        expect(src).toMatch(/import\s*\{[^}]*evaluateQcEvidence[^}]*\}\s*from\s*['"][^'"]*qc-evidence\.mjs['"]/);
      });

      it('apelează evaluateQcEvidence', () => {
        expect(src).toMatch(/evaluateQcEvidence\s*\(/);
      });

      it('⭐ nu mai atribuie isQES dintr-un `||` (nume QTSP sau extensie prezentă)', () => {
        const assigns = src.match(/\bisQES\s*=\s*[^;\n]+/g) || [];
        expect(assigns.length).toBeGreaterThan(0);
        for (const a of assigns) {
          // singura formă admisă: derivare din rezultatul modulului
          expect(a).not.toMatch(/\|\|/);
          expect(a).toMatch(/qc\.isQES|false/);
        }
      });

      it('nu decide pe `qtsp.found` / `isKnownQTSP` (rămân doar etichete)', () => {
        expect(src).not.toMatch(/isQES\s*=\s*[^;\n]*(qtsp\.found|isKnownQTSP)/);
      });
    });
  }
});

describe('#144 — starea intermediară e afișată, nu pierdută', () => {
  const src = read('services/sign-trust-report.mjs');

  it('sign-trust-report.mjs are eticheta „CALIFICAT, FARA DOVADA QSCD"', () => {
    expect(src).toContain('CALIFICAT, FARA DOVADA QSCD');
  });

  it('tratează valoarea `qualified-no-qscd` / `qualified_no_qscd`', () => {
    expect(src).toMatch(/qualified-no-qscd/);
    expect(src).toMatch(/qualified_no_qscd/);
  });

  it('expune nivelul PAdES (#144/E2)', () => {
    expect(src).toMatch(/padesLevel/);
  });
});

describe('#144 — qc-evidence.mjs rămâne PUR', () => {
  const src = read('services/qc-evidence.mjs');

  it('nu are niciun import', () => {
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\brequire\s*\(/);
  });

  it('numele QTSP nu apare ca operand de decizie', () => {
    expect(src).not.toMatch(/KNOWN_QTSP|KNOWN_ROMANIAN_QTSP|issuerCN/);
  });
});

describe('#144/E1 — ltv_ready nu se mai bazează pe signing_time autodeclarat', () => {
  const src = read('services/certificate-verify.mjs');

  it('atribuirea lui ltv_ready cere o marcă temporală, nu result.signingTime', () => {
    const m = src.match(/result\.ltv_ready\s*=\s*[^;\n]+/);
    expect(m).not.toBeNull();
    expect(m[0]).not.toMatch(/result\.signingTime/);
    expect(m[0]).toMatch(/hasTimestamp/);
  });
});
