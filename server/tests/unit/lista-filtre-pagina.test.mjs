// @vitest-environment happy-dom
/**
 * #218 — schimbarea unui filtru DF/ORD readuce lista la pagina 1.
 *
 * De pe pagina 3 din „Toate", alegerea unui status cu o singură pagină de rezultate trimitea
 * `page=3` → OFFSET dincolo de ultimul rând → zero rânduri → „0 documente", ca și cum filtrul
 * n-ar găsi nimic. Oglindește tiparul deja corect din lista ALOP (`_alopFilterChanged`,
 * `alop.js:215`). Convenția happy-dom + `new Function(src).call(globalThis)` e cea din
 * `server/tests/unit/ord-list-valoare-plata-frontend.test.mjs`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const listSrc = readFileSync(join(__dir, '../../../public/js/formular/list.js'), 'utf8');
const htmlSrc = readFileSync(join(__dir, '../../../public/formular.html'), 'utf8');

function setupDom() {
  document.body.innerHTML = `
    <div class="lst-table-wrap">
      <table><tbody id="lst-tbody"></tbody></table>
    </div>
    <div id="lst-empty" style="display:none"></div>
    <div id="lst-loading" style="display:none"></div>
    <div id="lst-pagination" style="display:none"></div>
    <div id="lst-count" hidden><span id="lst-count-n"></span><span id="lst-count-w"></span></div>
    <select id="flt-status"><option value="all">Toate</option><option value="pending_p2">La Responsabil CAB</option></select>
    <select id="flt-comp"><option value="">Toate</option></select>
    <input id="flt-from" />
    <input id="flt-to" />
    <input id="flt-nr" />
    <input id="flt-init" />
    <input id="flt-p2" />
  `;
}

function makeApiMock(responses) {
  const calls = [];
  const fetchMock = vi.fn((url) => {
    calls.push(url);
    const resp = typeof responses === 'function' ? responses(url, calls.length) : responses;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(resp) });
  });
  return { calls, fetchMock };
}

describe('#218 — lista.js: filtrele readuc pagina la 1', () => {
  let onChangeCb;

  beforeEach(() => {
    setupDom();
    globalThis.window.df = { esc: (s) => String(s ?? ''), isoToDMY: (s) => String(s ?? '') };
    globalThis.esc = (s) => String(s ?? '');
    globalThis.ST = { docRole: {}, docStatus: {}, orgProfile: {} };
    onChangeCb = null;
    globalThis.window.DFPagin = {
      render: vi.fn((opts) => { onChangeCb = opts.onChange; }),
    };
    new Function(listSrc).call(globalThis);
    // reset state (module-level `let _lstState` reinitialized by re-running the function each test)
  });

  it('1) ⭐⭐ paginare → page=2; apoi schimbare filtru → următoarea cerere are page=1', async () => {
    const { calls, fetchMock } = makeApiMock({ rows: [{ id: 'a', nr: '1' }], total: 40 });
    globalThis.window.DFApi = { fetch: fetchMock };

    await window.loadList();
    expect(calls[0]).toContain('page=1');

    // simulăm click pe pagina 2 din componenta de paginare
    expect(typeof onChangeCb).toBe('function');
    await onChangeCb(2);
    expect(calls[1]).toContain('page=2');

    // schimbăm un filtru și apelăm handler-ul nou
    document.getElementById('flt-status').value = 'pending_p2';
    expect(typeof window._lstFilterChanged).toBe('function');
    await window._lstFilterChanged();
    expect(calls[2]).toContain('page=1');
    expect(calls[2]).toContain('status=pending_p2');
  });

  it('2) ⭐ debounce (căutare) resetează și el pagina la 1', async () => {
    vi.useFakeTimers();
    const { calls, fetchMock } = makeApiMock({ rows: [{ id: 'a', nr: '1' }], total: 40 });
    globalThis.window.DFApi = { fetch: fetchMock };

    await window.loadList();
    await onChangeCb(3);
    expect(calls[1]).toContain('page=3');

    document.getElementById('flt-nr').value = '1234';
    window.debouncedLoadList();
    await vi.advanceTimersByTimeAsync(400);

    expect(calls[2]).toContain('page=1');
    expect(calls[2]).toContain('nr=1234');
    vi.useRealTimers();
  });

  it('3) ⭐ autovindecare: pagină goală dincolo de ultima → o singură reîncercare pe page=1', async () => {
    const { calls, fetchMock } = makeApiMock((url) => {
      // orice cerere cu page=1 întoarce gol; identic pentru orice altă pagină
      return { rows: [], total: 0 };
    });
    globalThis.window.DFApi = { fetch: fetchMock };

    window._lstState = window._lstState || {};
    // forțăm starea pe o pagină > 1 direct (simulăm că userul era pe pagina 3)
    await onChangeReadyState();

    async function onChangeReadyState() {
      // populăm _lstState.page=3 prin paginare, cu un răspuns ne-gol întâi
      globalThis.window.DFApi = { fetch: vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ rows: [{ id: 'x', nr: '1' }], total: 100 }) })) };
      await window.loadList();
      await onChangeCb(3);
    }

    // acum comutăm mock-ul la varianta care întoarce gol pe orice pagină, și reîncărcăm
    globalThis.window.DFApi = { fetch: fetchMock };
    await window.loadList();

    expect(calls.length).toBe(2); // cererea inițială (page=3) + o singură reîncercare (page=1)
    expect(calls[0]).toContain('page=3');
    expect(calls[1]).toContain('page=1');
  });

  it('4) neregresie: paginarea NU e resetată de modificare (onChange direct din paginare)', async () => {
    const { calls, fetchMock } = makeApiMock({ rows: [{ id: 'a', nr: '1' }], total: 40 });
    globalThis.window.DFApi = { fetch: fetchMock };

    await window.loadList();
    await onChangeCb(3);
    expect(calls[1]).toContain('page=3');
  });

  it('5) static: handler-ele flt-status/flt-comp/flt-from/flt-to din formular.html folosesc _lstFilterChanged, NU loadList() direct', () => {
    expect(htmlSrc).not.toMatch(/id="flt-comp"[^>]*onchange="loadList\(\)"/);
    expect(htmlSrc).not.toMatch(/id="flt-status"[^>]*onchange="loadList\(\)"/);
    expect(htmlSrc).not.toMatch(/onDatePickerChange\(this,'flt-from-display'\);loadList\(\);/);
    expect(htmlSrc).not.toMatch(/onDatePickerChange\(this,'flt-to-display'\);loadList\(\);/);

    expect(htmlSrc).toMatch(/id="flt-comp"[^>]*onchange="_lstFilterChanged\(\)"/);
    expect(htmlSrc).toMatch(/id="flt-status"[^>]*onchange="_lstFilterChanged\(\)"/);
    expect(htmlSrc).toMatch(/onDatePickerChange\(this,'flt-from-display'\);_lstFilterChanged\(\);/);
    expect(htmlSrc).toMatch(/onDatePickerChange\(this,'flt-to-display'\);_lstFilterChanged\(\);/);
  });
});
