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
const componentsCssSrc = readFileSync(join(__dir, '../../../public/css/df/components.css'), 'utf8');
const adminCssSrc = readFileSync(join(__dir, '../../../public/css/admin/admin.css'), 'utf8');

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

describe('PAGIN-3 — CSS de paginare mutat în components.css + limit 50', () => {
  it('components.css conține regulile de paginare', () => {
    expect(componentsCssSrc).toContain('.pagination{');
    expect(componentsCssSrc).toContain('.pg-btn{');
    expect(componentsCssSrc).toContain('.pg-info{');
  });

  it('admin.css nu mai conține regulile de paginare (fără duplicare)', () => {
    expect(adminCssSrc).not.toContain('.pg-btn{');
  });

  it('flows.js folosește limit 50, nu mai conține limit 10', () => {
    expect(flowsJsSrc).toContain('limit: 50');
    expect(flowsJsSrc).not.toContain('limit: 10');
    expect(flowsJsSrc).not.toContain('resp.limit || 10');
  });
});
