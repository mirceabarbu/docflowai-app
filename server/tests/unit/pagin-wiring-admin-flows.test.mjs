/**
 * Test de structură pentru cablarea DFPagin pe public/js/admin/flows.js (PAGIN-2).
 * Comportamentul componentei e deja acoperit de PAGIN-1 (pagin-component.test.mjs);
 * aici verificăm doar cablarea — o invariantă structurală, deci analiza pe sursă
 * (fără evaluare/DOM) e suficientă.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const flowsJsSrc = readFileSync(join(__dir, '../../../public/js/admin/flows.js'), 'utf8');
const adminHtmlSrc = readFileSync(join(__dir, '../../../public/admin.html'), 'utf8');

describe('PAGIN-2 — cablare DFPagin pe admin/flows.js', () => {
  it('flows.js apelează DFPagin.render exact o dată', () => {
    // Match doar apelul propriu-zis `DFPagin.render(` — nu și verificarea
    // `typeof window.DFPagin.render === "function"` din ramura fail-safe.
    const matches = flowsJsSrc.match(/DFPagin\.render\(/g) || [];
    expect(matches.length).toBe(1);
  });

  it('flows.js nu mai conține paginarea scrisă de mână', () => {
    expect(flowsJsSrc).not.toContain('pg-btn');
    expect(flowsJsSrc).not.toContain('Math.abs(p - page)');
    expect(flowsJsSrc).not.toContain('resp.limit || 50');
  });

  it('flows.js nu mai conține contorul dublu "Pagina X din Y · N fluxuri total"', () => {
    expect(flowsJsSrc).not.toContain('flux${total!==1');
  });

  it('admin.html încarcă /js/shared/pagin.js', () => {
    expect(adminHtmlSrc).toContain('/js/shared/pagin.js');
  });

  it('admin.html încarcă pagin.js ÎNAINTEA flows.js (defer respectă ordinea documentului)', () => {
    const paginIdx = adminHtmlSrc.indexOf('js/shared/pagin.js');
    const flowsIdx = adminHtmlSrc.indexOf('js/admin/flows.js');
    expect(paginIdx).toBeGreaterThan(-1);
    expect(flowsIdx).toBeGreaterThan(-1);
    expect(paginIdx).toBeLessThan(flowsIdx);
  });

  it('flows.js păstrează ramura fail-safe pentru DFPagin indisponibil', () => {
    expect(flowsJsSrc).toContain('window.DFPagin &&');
  });
});
