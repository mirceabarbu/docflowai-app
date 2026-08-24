import { describe, it, expect } from 'vitest';
import { needsLargeBody, LARGE_PDF_PATHS } from '../../services/body-limit.mjs';

describe('needsLargeBody — tabelul din CONTEXT (#142)', () => {
  const cases = [
    ['/api/verify/signature', false], // singura schimbare — era 50MB (substring), acum 1MB
    ['/api/flows', true],
    ['/api/flows/PZ_1', true],
    ['/flows/PZ_1/sign', true],
    ['/flows/PZ_1/upload-signed-pdf', true],
    ['/flows/PZ_1/reinitiate-review', true],
    ['/flows/PZ_1/detect-acroform-fields', true],
    ['/flows/PZ_1/signing-callback', true],
    ['/api/formulare-ord/123', true],
    ['/api/formulare-df/123', true],
    ['/api/formulare-oficiale/1', true],
    ['/api/formulare-atasamente/1', true],
    ['/api/formulare/generate', true],
    ['/api/registratura/intrari/9/atasament', true],
    ['/api/bulk-signing/s1/poll', false],
  ];

  it.each(cases)('%s => %s', (path, expected) => {
    expect(needsLargeBody(path)).toBe(expected);
  });
});

describe('needsLargeBody — anti-regresie startsWith', () => {
  // Dacă cineva "simplifică" regula la startsWith, aceste două pică —
  // fiindcă fragmentele '/upload-signed-pdf' și '/reinitiate-review' nu sunt
  // la începutul căii, ci în interior. Testul dovedește că regula corectă e
  // pe frontieră de segment (indexOf), NU pe prefix.
  it('/flows/PZ_1/upload-signed-pdf => true', () => {
    expect(needsLargeBody('/flows/PZ_1/upload-signed-pdf')).toBe(true);
  });
  it('/flows/PZ_1/reinitiate-review => true', () => {
    expect(needsLargeBody('/flows/PZ_1/reinitiate-review')).toBe(true);
  });
});

describe('needsLargeBody — frontieră de segment', () => {
  it('fragment ca prefix de cuvânt, nu segment => false', () => {
    expect(needsLargeBody('/api/flowsomething')).toBe(false);
  });
});

describe('needsLargeBody — fail-safe', () => {
  it('null => false', () => {
    expect(needsLargeBody(null)).toBe(false);
  });
  it('undefined => false', () => {
    expect(needsLargeBody(undefined)).toBe(false);
  });
  it("'' => false", () => {
    expect(needsLargeBody('')).toBe(false);
  });
});

describe('LARGE_PDF_PATHS — inventar', () => {
  it('are exact 12 intrări', () => {
    expect(LARGE_PDF_PATHS.length).toBe(12);
  });
});
