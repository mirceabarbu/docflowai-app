/**
 * #161 — analiza statică: metoda de semnare pre-bifată pe STS Cloud QES la flux nou.
 *
 * `main.js` (semdoc-initiator) e script clasic mare, fără infrastructură de test
 * comportamental — verificăm doar cablarea statică, modelul prompt-157.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const readPublic = (rel) => readFileSync(join(__dir, '../../../public/', rel), 'utf8');

const mainJsSrc = readPublic('js/semdoc-initiator/main.js');
const initiatorHtmlSrc = readPublic('semdoc-initiator.html');

describe('#161 — pre-selecție implicită STS Cloud QES la flux nou', () => {
  it('definește constanta DEFAULT_PROVIDER_ID = sts-cloud în renderProviderRadios', () => {
    expect(mainJsSrc).toContain("const DEFAULT_PROVIDER_ID = 'sts-cloud';");
  });

  it('preferința salvată a utilizatorului rămâne verificată ÎNAINTEA default-ului', () => {
    const idxPreferred = mainJsSrc.indexOf('preferred && providers.some(p => p.id === preferred)');
    const idxDefault = mainJsSrc.indexOf('providers.some(p => p.id === DEFAULT_PROVIDER_ID)');
    expect(idxPreferred).toBeGreaterThan(-1);
    expect(idxDefault).toBeGreaterThan(-1);
    expect(idxPreferred).toBeLessThan(idxDefault);
  });

  it('default-ul e condiționat de prezența providerului STS în lista activă a org', () => {
    expect(mainJsSrc).toContain('providers.some(p => p.id === DEFAULT_PROVIDER_ID)');
  });

  it('vechea regulă „NU auto-selectăm" a fost înlocuită (comentariul vechi nu mai apare)', () => {
    expect(mainJsSrc).not.toContain('NU auto-selectăm dacă nu e preferință salvată');
  });

  it('public/semdoc-initiator.html referă main.js cu un ?v= prezent, tag <script> bine format', () => {
    const m = initiatorHtmlSrc.match(/<script src="\/js\/semdoc-initiator\/main\.js\?v=([0-9.]+)" defer><\/script>/);
    expect(m).not.toBeNull();
    expect(m[1].length).toBeGreaterThan(0);
  });
});
