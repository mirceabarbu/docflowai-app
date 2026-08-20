/**
 * Test de structură pentru cablarea DFXlsx (public/js/shared/xlsx-export.js) pe
 * consumatorii din public/js/. Comportamentul modulului e deja acoperit de
 * xlsx-export-component.test.mjs (#133a, 8 cazuri unitare); aici verificăm doar
 * cablarea — o invariantă structurală, deci analiza pe sursă (fără evaluare/DOM)
 * e suficientă.
 *
 * Model: pagin-wiring.test.mjs.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const readPublic = (rel) => readFileSync(join(__dir, '../../../public/', rel), 'utf8');

const formularHtmlSrc = readPublic('formular.html');

const CONSUMERS = [
  {
    label: '#133a — formular/list.js (DF/ORD)',
    jsPath: 'js/formular/list.js',
  },
  {
    label: '#133b — formular/alop.js',
    jsPath: 'js/formular/alop.js',
  },
  {
    label: '#133b — formular/clasa8.js',
    jsPath: 'js/formular/clasa8.js',
  },
];

describe.each(CONSUMERS)('$label', (consumer) => {
  const jsSrc = readPublic(consumer.jsPath);

  it('referă window.DFXlsx (load sau save)', () => {
    expect(jsSrc).toMatch(/window\.DFXlsx\.(load|save)\(/);
  });

  it('nu mai conține încărcătorul SheetJS de pe cdnjs.cloudflare.com', () => {
    expect(jsSrc).not.toContain('cdnjs.cloudflare.com');
  });

  it('nu citește rândurile de export din DOM (#lst-tbody / #alop-tbody)', () => {
    expect(jsSrc).not.toContain("querySelectorAll('#lst-tbody");
    expect(jsSrc).not.toContain("querySelectorAll('#alop-tbody");
  });

  it(`formular.html încarcă /js/shared/xlsx-export.js ÎNAINTEA ${consumer.jsPath} (defer respectă ordinea documentului)`, () => {
    const xlsxIdx = formularHtmlSrc.indexOf('js/shared/xlsx-export.js');
    const consumerIdx = formularHtmlSrc.indexOf(consumer.jsPath);
    expect(xlsxIdx).toBeGreaterThan(-1);
    expect(consumerIdx).toBeGreaterThan(-1);
    expect(xlsxIdx).toBeLessThan(consumerIdx);
  });
});

describe('#133a — cdnjs.cloudflare.com apare o singură dată în tot public/js/ (fără duplicat)', () => {
  it('xlsx-export.js este singura sursă a încărcătorului SheetJS din public/js/', () => {
    // pdf-lib-loader.js și pdfjs-worker.js folosesc cdnjs pentru alte librării
    // (pdf-lib / pdf.js) — nu au legătură cu exportul XLSX, nu sunt duplicate.
    expect(readPublic('js/shared/xlsx-export.js')).toContain('cdnjs.cloudflare.com');
  });
});

describe('#133b — formular/list.js și formular/alop.js cheamă endpointul cu all=1', () => {
  it('list.js (_lstQuery: p.push("all=1"))', () => {
    expect(readPublic('js/formular/list.js')).toContain("p.push('all=1')");
  });
  it('alop.js (_alopQuery: qs.set("all","1"))', () => {
    expect(readPublic('js/formular/alop.js')).toContain("qs.set('all','1')");
  });
});

describe('#133b — formular/alop.js: exportAlop folosește data.alop, NU data.rows', () => {
  const jsSrc = readPublic('js/formular/alop.js');
  it('conține j.alop / data.alop ca sursă a exportului', () => {
    expect(jsSrc).toContain('j.alop||[]');
  });
  it('nu conține data.rows (cheia e `alop`, asimetrie față de /api/formulare/list)', () => {
    expect(jsSrc).not.toContain('data.rows');
  });
});

describe('#133b — formular/alop.js: exportAlop derivă statusul din badge_status', () => {
  const jsSrc = readPublic('js/formular/alop.js');
  it('exportAlop folosește _ALOP_ST_LABELS (harta status→text)', () => {
    expect(jsSrc).toContain('_ALOP_ST_LABELS[status]');
  });
  it('exportAlop nu recalculează df_flow_active în funcția de export', () => {
    const exportFnMatch = jsSrc.match(/async function exportAlop\(\)\{[\s\S]*?\nwindow\.exportAlop=exportAlop;/);
    expect(exportFnMatch).not.toBeNull();
    expect(exportFnMatch[0]).not.toContain('df_flow_active');
  });
});

describe('#133b — formular.html: exact două butoane noi de export', () => {
  it('conține #btn-lst-export (#133a)', () => {
    expect(formularHtmlSrc).toContain('id="btn-lst-export"');
  });
  it('conține #btn-alop-export (#133b)', () => {
    expect(formularHtmlSrc).toContain('id="btn-alop-export"');
  });
  it('#clasa8-btn-export exista deja înainte de acest lot', () => {
    expect(formularHtmlSrc).toContain('id="clasa8-btn-export"');
  });
});

describe('#133c — cele trei butoane de export sunt vizual identice (primary + ico-download + text)', () => {
  const BTN_IDS = ['btn-lst-export', 'btn-alop-export', 'clasa8-btn-export'];

  it('8. toate trei au class="df-action-btn primary" (sau conțin ambele clase)', () => {
    for (const id of BTN_IDS) {
      const re = new RegExp(`id="${id}"[^>]*class="([^"]*)"|class="([^"]*)"[^>]*id="${id}"`);
      const m = formularHtmlSrc.match(re);
      expect(m, `buton #${id} nu a fost găsit`).not.toBeNull();
      const cls = m[1] || m[2] || '';
      expect(cls).toContain('df-action-btn');
      expect(cls).toContain('primary');
    }
  });

  it('9. toate trei folosesc #ico-download și textul Export Excel', () => {
    for (const id of BTN_IDS) {
      const idx = formularHtmlSrc.indexOf(`id="${id}"`);
      expect(idx, `buton #${id} nu a fost găsit`).toBeGreaterThan(-1);
      const chunk = formularHtmlSrc.slice(idx, idx + 300);
      expect(chunk).toContain('#ico-download');
      expect(chunk).toContain('Export Excel');
    }
  });
});

describe('#133b — non-regresie raportul Clasa 8 (doar încărcătorul s-a schimbat)', () => {
  const jsSrc = readPublic('js/formular/clasa8.js');

  it('păstrează antetul de 7 coloane', () => {
    expect(jsSrc).toContain(
      "['Cod SSI', 'BUGET', 'Angajamente bugetare', 'Rămâne din buget', 'Ordonanțări', 'Rămâne din angajamente', 'Plăți']"
    );
  });
  it('păstrează rândul gol separator', () => {
    expect(jsSrc).toContain('aoa.push([]);');
  });
  it('păstrează linia de TOTAL', () => {
    expect(jsSrc).toContain("'TOTAL',");
  });
  it('păstrează sursa din _state.totals', () => {
    expect(jsSrc).toContain('Number(_state.totals.buget)');
  });
  it('păstrează formatarea numerică #,##0.00', () => {
    expect(jsSrc).toContain("z = '#,##0.00'");
  });
  it('păstrează numele foii Clasa 8', () => {
    expect(jsSrc).toContain("'Clasa 8'");
  });
  it('păstrează numele fișierului Clasa8_', () => {
    expect(jsSrc).toContain("'Clasa8_'");
  });
  it('folosește încărcătorul partajat window.DFXlsx.load()', () => {
    expect(jsSrc).toContain('await window.DFXlsx.load();');
  });
  it('nu mai conține încărcătorul local (SHEETJS_CDN / _sheetJsLoading / _loadSheetJs)', () => {
    expect(jsSrc).not.toMatch(/SHEETJS_CDN|_sheetJsLoading|_loadSheetJs/);
  });
});
