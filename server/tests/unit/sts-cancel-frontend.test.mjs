/**
 * #125 — invariante structurale pe semdoc-signer/main.js.
 *
 * Butonul „Anulează" părea mort pentru că (a) nu exista nicio cerere spre server care
 * să elibereze `stsPending` și (b) `startStsPolling` distrugea conținutul lui #signBox,
 * iar `loadFlow()` nu îl reconstruia. Ambele trebuie să rămână acoperite.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const mainJs = readFileSync(join(__dir, '../../../public/js/semdoc-signer/main.js'), 'utf8');

describe('semdoc-signer — anulare STS (#125)', () => {
  it('salvează markup-ul original al lui #signBox înainte de a-l suprascrie', () => {
    expect(mainJs).toMatch(/_signBoxBackup/);
    const idx = mainJs.indexOf("signBox.innerHTML = `");
    expect(idx).toBeGreaterThan(-1);
    // Salvarea apare ÎNAINTEA suprascrierii, și e condiționată (o singură dată).
    const before = mainJs.slice(Math.max(0, idx - 400), idx);
    expect(before).toMatch(/_signBoxBackup\s*===\s*null.*_signBoxBackup\s*=\s*signBox\.innerHTML/s);
  });

  it('cancelStsPolling e async, cheamă /sts-cancel și restaurează #signBox', () => {
    const m = mainJs.match(/async function cancelStsPolling\([\s\S]*?\n      \}/);
    expect(m).toBeTruthy();
    const body = m[0];
    expect(body).toMatch(/sts-cancel/);
    expect(body).toMatch(/method:\s*'POST'/);
    expect(body).toMatch(/signBox\.innerHTML\s*=\s*_signBoxBackup/);
    expect(body).toMatch(/loadFlow\(\)/);
  });

  it('mesajele de la server trec printr-o plasă care blochează textul brut de excepție', () => {
    expect(mainJs).toMatch(/function _stsSafeMessage/);
    expect(mainJs).toMatch(/JSON\|undefined\|TypeError\|SyntaxError/);
    // ambele ramuri (waiting + error) folosesc plasa
    expect(mainJs.match(/_stsSafeMessage\(j\.message/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
