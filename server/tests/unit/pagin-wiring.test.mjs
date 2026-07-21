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
const registraturaHtmlSrc = readPublic('registratura.html');
const formularHtmlSrc = readPublic('formular.html');
const semdocHtmlSrc = readPublic('semdoc-initiator.html');

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
  {
    label: 'PAGIN-6 — admin/primarii.js',
    jsPath: 'js/admin/primarii.js',
    htmlPath: 'admin.html',
    htmlSrc: adminHtmlSrc,
    mustContain: ['DFPagin.render(', 'window.DFPagin &&', 'PR_PAGE_SIZE', 'onChange: (p) => prLoad(p)'],
    mustNotContain: ['btnStyle', 'onclick="prLoad(', '‹ Precedent', 'pagini</span>', 'pr-info'],
  },
  {
    label: 'PAGIN-7 — registratura/main.js',
    jsPath: 'js/registratura/main.js',
    htmlPath: 'registratura.html',
    htmlSrc: registraturaHtmlSrc,
    mustContain: ['DFPagin.render(', 'window.DFPagin &&', "mode: 'numbered'", 'renderPag('],
    mustNotContain: ["$('reg-prev')", "$('reg-next')", "$('regin-prev')", "$('regin-next')", 'Pagina ${stateOut.page}', 'Pagina ${stateIn.page}'],
  },
  {
    label: 'PAGIN-8 — formular/list.js',
    jsPath: 'js/formular/list.js',
    htmlPath: 'formular.html',
    htmlSrc: formularHtmlSrc,
    mustContain: ['DFPagin.render(', 'window.DFPagin &&', "mode: 'numbered'"],
    mustNotContain: ['lst-page-info', 'lst-prev', 'lst-next', 'changeLstPage'],
  },
  {
    label: 'PAGIN-9 — formular/alop.js',
    jsPath: 'js/formular/alop.js',
    htmlPath: 'formular.html',
    htmlSrc: formularHtmlSrc,
    mustContain: ['DFPagin.render(', 'window.DFPagin &&', "mode: 'numbered'"],
    mustNotContain: ['alop-page-info', 'alop-prev', 'alop-next', 'changeAlopPage'],
  },
  {
    label: 'PAGIN-10 — semdoc-initiator/main.js',
    jsPath: 'js/semdoc-initiator/main.js',
    htmlPath: 'semdoc-initiator.html',
    htmlSrc: semdocHtmlSrc,
    mustContain: ['DFPagin.render(', 'window.DFPagin &&', "mode: 'numbered'"],
    mustNotContain: ['fluxPageInfo', 'fluxPrevBtn', 'fluxNextBtn'],
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

describe('PAGIN-6 — admin.html container #pr-pager fără style inline + fără #pr-info', () => {
  it('conține <div id="pr-pager"></div>, fără atribut style', () => {
    expect(adminHtmlSrc).toContain('<div id="pr-pager"></div>');
  });

  it('nu mai conține id="pr-info"', () => {
    expect(adminHtmlSrc).not.toContain('id="pr-info"');
  });
});

describe('PAGIN-7 — registratura.html containere fără prev/next static', () => {
  it('conține <div id="reg-pagination"></div> și <div id="regin-pagination"></div>', () => {
    expect(registraturaHtmlSrc).toContain('<div id="reg-pagination"></div>');
    expect(registraturaHtmlSrc).toContain('<div id="regin-pagination"></div>');
  });

  it('nu mai conține butoanele statice reg-prev/regin-prev', () => {
    expect(registraturaHtmlSrc).not.toContain('id="reg-prev"');
    expect(registraturaHtmlSrc).not.toContain('id="regin-prev"');
  });
});

describe('PAGIN-8 — formular.html #lst-pagination fără prev/next static', () => {
  it('conține <div id="lst-pagination"></div>', () => {
    expect(formularHtmlSrc).toContain('<div id="lst-pagination"></div>');
  });
  it('nu mai conține butoanele statice lst-prev/lst-next + onclick changeLstPage', () => {
    expect(formularHtmlSrc).not.toContain('id="lst-prev"');
    expect(formularHtmlSrc).not.toContain('id="lst-next"');
    expect(formularHtmlSrc).not.toContain('onclick="changeLstPage(');
  });
  it('NU atinge #alop-pagination (rămâne pentru PAGIN-9)', () => {
    expect(formularHtmlSrc).toContain('id="alop-pagination"');
  });
  it('NU atinge contorul #lst-count (feature #90)', () => {
    expect(formularHtmlSrc).toContain('id="lst-count"');
  });
});

describe('PAGIN-9 — formular.html #alop-pagination fără prev/next static', () => {
  it('conține <div id="alop-pagination"></div>', () => {
    expect(formularHtmlSrc).toContain('<div id="alop-pagination"></div>');
  });
  it('nu mai conține butoanele statice alop-prev/alop-next + onclick changeAlopPage', () => {
    expect(formularHtmlSrc).not.toContain('id="alop-prev"');
    expect(formularHtmlSrc).not.toContain('id="alop-next"');
    expect(formularHtmlSrc).not.toContain('onclick="changeAlopPage(');
  });
  it('#lst-pagination (PAGIN-8) rămâne container gol', () => {
    expect(formularHtmlSrc).toContain('<div id="lst-pagination"></div>');
  });
});

describe('PAGIN-10 — semdoc-initiator.html #fluxPagination fără prev/next static', () => {
  it('conține <div id="fluxPagination"></div>', () => {
    expect(semdocHtmlSrc).toContain('<div id="fluxPagination"></div>');
  });
  it('nu mai conține butoanele statice fluxPrevBtn/fluxNextBtn/fluxPageInfo', () => {
    expect(semdocHtmlSrc).not.toContain('id="fluxPrevBtn"');
    expect(semdocHtmlSrc).not.toContain('id="fluxNextBtn"');
    expect(semdocHtmlSrc).not.toContain('id="fluxPageInfo"');
  });
  it('NU atinge contorul #fluxCounter', () => {
    expect(semdocHtmlSrc).toContain('id="fluxCounter"');
  });
  it('semdoc-initiator.html încarcă /js/shared/pagin.js ÎNAINTEA main.js', () => {
    const paginIdx = semdocHtmlSrc.indexOf('js/shared/pagin.js');
    const mainIdx = semdocHtmlSrc.indexOf('js/semdoc-initiator/main.js');
    expect(paginIdx).toBeGreaterThan(-1);
    expect(mainIdx).toBeGreaterThan(-1);
    expect(paginIdx).toBeLessThan(mainIdx);
  });
});
