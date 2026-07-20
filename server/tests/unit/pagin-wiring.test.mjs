/**
 * Test de structură pentru cablarea DFPagin pe consumatorii din public/js/.
 * Comportamentul componentei e deja acoperit de PAGIN-1 (pagin-component.test.mjs);
 * aici verificăm doar cablarea — o invariantă structurală, deci analiza pe sursă
 * (fără evaluare/DOM) e suficientă.
 *
 * Consumatorii următori (PAGIN-5…10) se adaugă în tabloul CONSUMERS de mai jos,
 * NU într-un fișier nou.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const readPublic = (rel) => readFileSync(join(__dir, '../../../public/', rel), 'utf8');

const adminHtmlSrc = readPublic('admin.html');
const componentsCssSrc = readPublic('css/df/components.css');
const adminCssSrc = readPublic('css/admin/admin.css');

const CONSUMERS = [
  {
    label: 'PAGIN-2 — admin/flows.js',
    jsPath: 'js/admin/flows.js',
    htmlPath: 'admin.html',
    htmlSrc: adminHtmlSrc,
    mustContain: ['window.DFPagin &&'],
    mustNotContain: ['pg-btn', 'Math.abs(p - page)'],
  },
  {
    label: 'PAGIN-4 — admin/users.js',
    jsPath: 'js/admin/users.js',
    htmlPath: 'admin.html',
    htmlSrc: adminHtmlSrc,
    mustContain: ['DFPagin.render(', 'window.DFPagin &&', 'onChange', '_currentPage = p'],
    mustNotContain: ['pg-btn', 'Math.abs(p-current)', 'prev.onclick'],
  },
  {
    label: 'PAGIN-5 — admin/audit.js',
    jsPath: 'js/admin/audit.js',
    htmlPath: 'admin.html',
    htmlSrc: adminHtmlSrc,
    mustContain: ['DFPagin.render(', 'window.DFPagin &&', 'AUDIT_PAGE_SIZE', 'onChange: (p) => loadAuditEvents(p)'],
    mustNotContain: ['onclick="loadAuditEvents(', '‹ Anterior', 'Următor ›', 'limit: 50'],
  },
];

describe.each(CONSUMERS)('$label', (consumer) => {
  const jsSrc = readPublic(consumer.jsPath);

  it('apelează DFPagin.render exact o dată', () => {
    // Match doar apelul propriu-zis `DFPagin.render(` — nu și verificarea
    // `typeof window.DFPagin.render === "function"` din ramura fail-safe.
    const matches = jsSrc.match(/DFPagin\.render\(/g) || [];
    expect(matches.length).toBe(1);
  });

  it.each(consumer.mustContain)('conține "%s"', (needle) => {
    expect(jsSrc).toContain(needle);
  });

  it.each(consumer.mustNotContain)('nu mai conține "%s"', (needle) => {
    expect(jsSrc).not.toContain(needle);
  });

  it(`${consumer.htmlPath} încarcă /js/shared/pagin.js ÎNAINTEA ${consumer.jsPath} (defer respectă ordinea documentului)`, () => {
    const paginIdx = consumer.htmlSrc.indexOf('js/shared/pagin.js');
    const consumerIdx = consumer.htmlSrc.indexOf(consumer.jsPath);
    expect(paginIdx).toBeGreaterThan(-1);
    expect(consumerIdx).toBeGreaterThan(-1);
    expect(paginIdx).toBeLessThan(consumerIdx);
  });
});

describe('PAGIN-2 — cablare DFPagin pe admin/flows.js (aserțiuni specifice)', () => {
  const flowsJsSrc = readPublic('js/admin/flows.js');

  it('admin.html încarcă /js/shared/pagin.js', () => {
    expect(adminHtmlSrc).toContain('/js/shared/pagin.js');
  });

  it('flows.js nu mai conține contorul dublu "Pagina X din Y · N fluxuri total"', () => {
    expect(flowsJsSrc).not.toContain('flux${total!==1');
  });
});

describe('PAGIN-3 — CSS de paginare mutat în components.css + limit 50', () => {
  const flowsJsSrc = readPublic('js/admin/flows.js');

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

describe('PAGIN-4 — users.js paginare CLIENT-SIDE (aserțiune specifică)', () => {
  const usersJsSrc = readPublic('js/admin/users.js');

  it('onChange setează starea locală și re-randează, fără fetch', () => {
    expect(usersJsSrc).toContain('onChange: (p)=>{ _currentPage = p; renderPage(); }');
  });
});

describe('PAGIN-5 — admin.html container #audit-pagination fără style inline', () => {
  it('conține <div id="audit-pagination"></div>, fără atribut style', () => {
    expect(adminHtmlSrc).toContain('<div id="audit-pagination"></div>');
  });
});
