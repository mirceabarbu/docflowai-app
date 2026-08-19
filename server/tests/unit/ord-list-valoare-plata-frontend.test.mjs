// @vitest-environment happy-dom
/**
 * #130 — coloanele „Valoare ORD" / „Plătit" din lista Ordonanțărilor.
 *
 * `_lstBani`/`_lstPlata` (public/js/formular/list.js) formatează sumele; comutarea clasei
 * `lst-tip-ord` decide vizibilitatea coloanelor (CSS unic, nicio decizie separată pe <th>/<td>).
 * Convenția happy-dom + `new Function(src).call(globalThis)` e cea din
 * server/tests/unit/ord-ctrl-idx-frontend.test.mjs.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const listSrc = readFileSync(join(__dir, '../../../public/js/formular/list.js'), 'utf8');
const htmlSrc = readFileSync(join(__dir, '../../../public/formular.html'), 'utf8');
const cssSrc = readFileSync(join(__dir, '../../../public/css/formular/formular.css'), 'utf8');

beforeAll(() => {
  globalThis.window.df = { esc: (s) => String(s ?? ''), isoToDMY: (s) => String(s ?? '') };
  globalThis.ST = { docRole: {}, docStatus: {} };
  new Function(listSrc).call(globalThis);
});

describe('#130 — _lstBani / _lstPlata', () => {
  it('_lstBani formatează valid și „—" pentru non-numeric', () => {
    expect(window._lstBani(100)).toMatch(/100.*lei/);
    expect(window._lstBani(null)).toBe('—');
    expect(window._lstBani('abc')).toBe('—');
  });

  it('_lstPlata(null, 100) → liniuță, NU „0,00 lei"', () => {
    const html = window._lstPlata(null, 100);
    expect(html).toContain('—');
    expect(html).not.toContain('0,00');
  });

  it('_lstPlata(100,100) → verde; _lstPlata(40,100) → chihlimbar; _lstPlata(0,100) → neutru', () => {
    const full = window._lstPlata(100, 100);
    const partial = window._lstPlata(40, 100);
    const zero = window._lstPlata(0, 100);
    expect(full).toContain('#22c55e');
    expect(partial).toContain('#f59e0b');
    expect(zero).not.toContain('#22c55e');
    expect(zero).not.toContain('#f59e0b');
  });
});

describe('#130 — antet HTML: exact două <th class="lst-col-ord">', () => {
  it('formular.html conține exact 2 <th class="lst-col-ord">', () => {
    const matches = htmlSrc.match(/<th class="lst-col-ord">/g) || [];
    expect(matches.length).toBe(2);
  });
});

describe('#130 — CSS: comutarea e pe container, o singură regulă', () => {
  it('regula .lst-table-wrap:not(.lst-tip-ord) .lst-col-ord există', () => {
    expect(cssSrc).toContain('.lst-table-wrap:not(.lst-tip-ord) .lst-col-ord{display:none}');
  });
  it('nu există reguli separate display pe th/td.lst-col-ord în afara acestei clase de container', () => {
    const occurrences = cssSrc.split('.lst-col-ord{display').length - 1;
    expect(occurrences).toBe(1);
    expect(cssSrc).toContain('.lst-table-wrap:not(.lst-tip-ord) .lst-col-ord{display:none}');
  });
});

describe('#130 — comutarea clasei lst-tip-ord în switchListTab și loadList', () => {
  it('switchListTab și loadList conțin toggle-ul clasei lst-tip-ord', () => {
    const switchFn = listSrc.slice(listSrc.indexOf('function switchListTab'), listSrc.indexOf('function switchListTab') + 400);
    expect(switchFn).toContain("classList.toggle('lst-tip-ord'");
    const loadFn = listSrc.slice(listSrc.indexOf('async function loadList'), listSrc.indexOf('async function loadList') + 400);
    expect(loadFn).toContain("classList.toggle('lst-tip-ord'");
  });
});
