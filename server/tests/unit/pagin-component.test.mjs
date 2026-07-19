// @vitest-environment happy-dom
/**
 * Teste comportamentale pentru public/js/shared/pagin.js (componentă partajată
 * de paginare, PAGIN-1). Scriptul e clasic (fără `type="module"`), deci nu se
 * poate `import`-a direct — e evaluat cu `new Function(src)` peste DOM real
 * happy-dom, apoi comportamentul REAL (window.DFPagin) e exercitat.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// happy-dom substituie global.URL cu propria implementare (browser-like),
// care nu acceptă `new URL('.', import.meta.url)` (scheme file:) — de aceea
// rezolvăm calea cu fileURLToPath direct pe string-ul import.meta.url,
// fără să instanțiem clasa URL globală.
const __dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dir, '../../../public/js/shared/pagin.js'), 'utf8');

let DFPagin;

beforeAll(() => {
  new Function(src).call(globalThis);
  DFPagin = globalThis.window.DFPagin;
});

describe('pagin.js — se încarcă corect în happy-dom', () => {
  it('expune window.DFPagin cu pageWindow și render', () => {
    expect(DFPagin).toBeTruthy();
    expect(typeof DFPagin.pageWindow).toBe('function');
    expect(typeof DFPagin.render).toBe('function');
  });
});

describe('DFPagin.pageWindow (pur)', () => {
  it('1. totalPages=5, maxVisible=7 => [1,2,3,4,5], fără "…"', () => {
    const w = DFPagin.pageWindow(3, 5, 7);
    expect(w).toEqual([1, 2, 3, 4, 5]);
    expect(w).not.toContain('…');
  });

  it('2. page=10, totalPages=20 => conține 1, 20, fereastra 8..12 și exact două "…"', () => {
    const w = DFPagin.pageWindow(10, 20, 7);
    expect(w).toContain(1);
    expect(w).toContain(20);
    for (const p of [8, 9, 10, 11, 12]) expect(w).toContain(p);
    const dots = w.filter((x) => x === '…');
    expect(dots.length).toBe(2);
  });

  it('3. page=1, totalPages=20 => începe cu 1,2,3, fără "…" la început', () => {
    const w = DFPagin.pageWindow(1, 20, 7);
    expect(w.slice(0, 3)).toEqual([1, 2, 3]);
    expect(w[0]).not.toBe('…');
  });

  it('4. page=20, totalPages=20 => se termină cu 18,19,20, fără "…" la final', () => {
    const w = DFPagin.pageWindow(20, 20, 7);
    expect(w.slice(-3)).toEqual([18, 19, 20]);
    expect(w[w.length - 1]).not.toBe('…');
  });

  it('5. niciodată două "…" consecutive (mai multe combinații)', () => {
    const combos = [
      [1, 20], [5, 20], [10, 20], [16, 20], [20, 20],
      [1, 50], [25, 50], [50, 50],
      [7, 15], [1, 100], [100, 100],
    ];
    for (const [page, totalPages] of combos) {
      const w = DFPagin.pageWindow(page, totalPages, 7);
      for (let i = 0; i < w.length - 1; i++) {
        expect(!(w[i] === '…' && w[i + 1] === '…')).toBe(true);
      }
    }
  });

  it('6. un gol de exact o pagină e umplut cu pagina, nu cu "…"', () => {
    // page=5, totalPages=20, maxVisible=7 => windowStart=3 => gol de 1 pagină între ancora 1 și 3
    const w = DFPagin.pageWindow(5, 20, 7);
    expect(w).toEqual([1, 2, 3, 4, 5, 6, 7, '…', 20]);
  });

  it('7. totalPages=0 => []; page=99 cu totalPages=3 => clamp, fără excepție', () => {
    expect(DFPagin.pageWindow(1, 0, 7)).toEqual([]);
    expect(() => DFPagin.pageWindow(99, 3, 7)).not.toThrow();
    expect(DFPagin.pageWindow(99, 3, 7)).toEqual([1, 2, 3]);
  });
});

describe('DFPagin.render — mode simple', () => {
  function makeContainer() {
    const el = document.createElement('div');
    document.body.appendChild(el);
    return el;
  }

  it('8. total=5, limit=20 => container ascuns, zero copii randați', () => {
    const container = makeContainer();
    DFPagin.render({ container, total: 5, limit: 20, page: 1, mode: 'simple', onChange: () => {} });
    expect(container.style.display).toBe('none');
    expect(container.children.length).toBe(0);
  });

  it('9. total=45, limit=20, page=1 => text corect, prev disabled, next activ', () => {
    const container = makeContainer();
    DFPagin.render({ container, total: 45, limit: 20, page: 1, mode: 'simple', onChange: () => {} });
    const info = container.querySelector('.lst-page-info');
    expect(info.textContent).toBe('Pagina 1 din 3 (45 total)');
    const buttons = container.querySelectorAll('button');
    expect(buttons[0].disabled).toBe(true); // prev
    expect(buttons[1].disabled).toBe(false); // next
  });

  it('10. page=3 (ultima) => next disabled', () => {
    const container = makeContainer();
    DFPagin.render({ container, total: 45, limit: 20, page: 3, mode: 'simple', onChange: () => {} });
    const buttons = container.querySelectorAll('button');
    expect(buttons[1].disabled).toBe(true); // next
  });

  it('11. click pe next => onChange primit cu 2 (nu cu +1)', () => {
    const container = makeContainer();
    let received;
    DFPagin.render({
      container, total: 45, limit: 20, page: 1, mode: 'simple',
      onChange: (p) => { received = p; },
    });
    const buttons = container.querySelectorAll('button');
    buttons[1].click(); // next
    expect(received).toBe(2);
  });
});

describe('DFPagin.render — mode numbered', () => {
  function makeContainer() {
    const el = document.createElement('div');
    document.body.appendChild(el);
    return el;
  }

  it('12. total=234, limit=10, page=6 => .pg-info conține "51–60 din 234"', () => {
    const container = makeContainer();
    DFPagin.render({ container, total: 234, limit: 10, page: 6, mode: 'numbered', onChange: () => {} });
    const infos = Array.from(container.querySelectorAll('.pg-info')).map((n) => n.textContent);
    expect(infos).toContain('51–60 din 234');
  });

  it('13. ultima pagină clamează intervalul la total => "41–45 din 45"', () => {
    const container = makeContainer();
    DFPagin.render({ container, total: 45, limit: 10, page: 5, mode: 'numbered', onChange: () => {} });
    const infos = Array.from(container.querySelectorAll('.pg-info')).map((n) => n.textContent);
    expect(infos).toContain('41–45 din 45');
  });

  it('14. pagina curentă are clasa active; exact UNA singură', () => {
    const container = makeContainer();
    DFPagin.render({ container, total: 234, limit: 10, page: 6, mode: 'numbered', onChange: () => {} });
    const active = container.querySelectorAll('.pg-btn.active');
    expect(active.length).toBe(1);
    expect(active[0].textContent).toBe('6');
  });

  it('15. click pe un buton numerotat => onChange cu acel număr', () => {
    const container = makeContainer();
    let received;
    DFPagin.render({
      container, total: 234, limit: 10, page: 6, mode: 'numbered',
      onChange: (p) => { received = p; },
    });
    // page=6, totalPages=24 => fereastra vizibilă e 4..8 (vezi pageWindow), nu 3
    const btn7 = Array.from(container.querySelectorAll('.pg-btn')).find((b) => b.textContent === '7');
    btn7.click();
    expect(received).toBe(7);
  });

  it('16. click pe pagina CURENTĂ => onChange NU se apelează', () => {
    const container = makeContainer();
    let called = false;
    DFPagin.render({
      container, total: 234, limit: 10, page: 6, mode: 'numbered',
      onChange: () => { called = true; },
    });
    const active = container.querySelector('.pg-btn.active');
    active.click();
    expect(called).toBe(false);
  });

  it('17. elementele "…" nu au handler de click (nu declanșează onChange)', () => {
    const container = makeContainer();
    let called = false;
    DFPagin.render({
      container, total: 234, limit: 10, page: 6, mode: 'numbered',
      onChange: () => { called = true; },
    });
    const dots = Array.from(container.querySelectorAll('.pg-info')).filter((n) => n.textContent === '…');
    expect(dots.length).toBeGreaterThan(0);
    dots.forEach((d) => d.click());
    expect(called).toBe(false);
  });
});

describe('DFPagin.render — robustețe', () => {
  function makeContainer() {
    const el = document.createElement('div');
    document.body.appendChild(el);
    return el;
  }

  it('18. două apeluri render consecutive pe același container => fără dublare', () => {
    const container = makeContainer();
    DFPagin.render({ container, total: 234, limit: 10, page: 6, mode: 'numbered', onChange: () => {} });
    const countFirst = container.children.length;
    DFPagin.render({ container, total: 234, limit: 10, page: 6, mode: 'numbered', onChange: () => {} });
    expect(container.children.length).toBe(countFirst);
  });

  it('19. limit=0 => nu aruncă, tratează ca o singură pagină', () => {
    const container = makeContainer();
    expect(() => {
      DFPagin.render({ container, total: 50, limit: 0, page: 1, mode: 'simple', onChange: () => {} });
    }).not.toThrow();
    expect(container.style.display).toBe('none');
  });

  it('20. igienă XSS: sursa nu conține innerHTML și nu conține onclick=', () => {
    expect(src).not.toMatch(/innerHTML/);
    expect(src).not.toMatch(/onclick\s*=/);
  });
});
