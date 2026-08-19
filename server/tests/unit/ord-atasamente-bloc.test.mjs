// @vitest-environment happy-dom
/**
 * #128m — atașamente per BLOC de furnizor, partea de FRONTEND.
 *
 * Cele trei trasee (creare · salvare · redeschidere) + non-regresia blocului 0 și a DF-ului.
 * Convenția happy-dom + `new Function(src).call(globalThis)` e cea din pagin-component.test.mjs.
 * Capcană cunoscută: calea se rezolvă cu dirname(fileURLToPath(import.meta.url)).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dir, '../../../public/js/formular/');
const read = (p) => readFileSync(join(SRC_DIR, p), 'utf8');
const readShared = (p) => readFileSync(join(__dir, '../../../public/js/shared/', p), 'utf8');

beforeAll(() => {
  globalThis.fetch = () => Promise.reject(new Error('fetch dezactivat la încărcare'));
  globalThis.df = globalThis.df || {};
  globalThis.df.esc = (s) => String(s ?? '');
  globalThis.df.getCsrf = () => 'csrf-test';
  // Componenta partajată de chip-uri (window.renderFileItem) — folosită de randarea listelor.
  new Function(readShared('file-item.js')).call(globalThis);
  new Function(read('core.js')).call(globalThis);
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  try { new Function(read('doc.js')).call(globalThis); } finally { globalThis.setInterval = realSetInterval; }
  // list.js se încarcă ÎNAINTE de montarea DOM-ului: delegarea #128j/#128m cade atunci pe
  // `document` (fallback-ul din _wireBenefDelegation), deci supraviețuiește remontării
  // fixture-ului în beforeEach — exact ce ne trebuie ca să testăm delegarea.
  try { new Function(read('list.js')).call(globalThis); } catch (_) { /* dependențe de pagină */ }
});

const ATT_ZONE = `
  <div class="att-zone"><div class="att-list" data-role="att-list"></div></div>
  <div class="att-br">
    <button type="button" class="att-btn" data-role="att-btn"></button>
    <input type="file" class="att-inp" data-role="att-input" multiple/>
  </div>
  <input type="hidden" data-role="att-data" value="[]"/>`;

function mountOrdForm() {
  document.body.innerHTML = `
    <div class="status" id="sBar"></div>
    <div id="form-ordnt">
      <div id="ord-blocuri">
        <div class="ord-bloc" data-bloc="0">
          <textarea id="o-benef" data-fld="beneficiar"></textarea>
          <div class="att-zone"><div class="att-list" id="o-alist" data-role="att-list"></div></div>
          <div class="att-br">
            <button class="att-btn" data-role="att-btn" onclick="document.getElementById('o-ainp').click()"></button>
            <input type="file" id="o-ainp" class="att-inp" data-role="att-input" multiple
                   onchange="addAtt(event,'o-alist','o-adata')"/>
          </div>
          <input type="hidden" id="o-adata" value="[]" data-role="att-data"/>
          <table class="doc-t"><tbody id="o-tbody"></tbody></table>
        </div>
      </div>
    </div>
    <div id="form-notafd">
      <div class="att-zone"><div class="att-list" id="n-fdal"></div></div>
      <div class="att-br"><button class="att-btn"></button>
        <input type="file" id="n-fdai" class="att-inp" multiple/></div>
      <input type="hidden" id="n-fdad" value="[]"/>
      <div class="att-list" id="n-alist"></div>
      <input type="hidden" id="n-adata" value="[]"/>
    </div>`;
  window.ST.docId = { ordnt: 'ORD-1', notafd: 'DF-1' };
}

/** Bloc 2+ montat direct (fără addBlocOrd) — markup identic cu _sablonBloc, fără id-uri. */
function mountBloc(idx) {
  const el = document.createElement('div');
  el.className = 'ord-bloc';
  el.setAttribute('data-bloc', String(idx));
  el.innerHTML = `<textarea data-fld="beneficiar"></textarea>${ATT_ZONE}`;
  document.getElementById('ord-blocuri').appendChild(el);
  return el;
}

const dataEl = (bl) => bl.querySelector('[data-role="att-data"]');
const listEl = (bl) => bl.querySelector('[data-role="att-list"]');
const blocuri = () => [...document.querySelectorAll('.ord-bloc')];
const okJson = (body) => ({ ok: true, status: 200, json: () => Promise.resolve(body) });

beforeEach(() => { mountOrdForm(); vi.restoreAllMocks(); });

// ═════════════════════════════════════════════════════════════════════════════
describe('#128m — șablonul de bloc are zonă de atașamente fără id-uri', () => {
  it('9 ⭐ blocul creat din _sablonBloc are att-list/att-input/att-data prin data-role, ZERO id-uri', () => {
    const el = window._sablonBloc(1);
    expect(el.querySelector('[data-role="att-list"]')).toBeTruthy();
    expect(el.querySelector('[data-role="att-input"]')).toBeTruthy();
    expect(el.querySelector('[data-role="att-data"]')).toBeTruthy();
    expect(el.querySelector('[data-role="att-data"]').value).toBe('[]');
    expect(el.querySelectorAll('[id]')).toHaveLength(0);
  });

  it('blocul 0 din pagină păstrează id-urile ISTORICE și primește ȘI data-role', () => {
    const b0 = blocuri()[0];
    expect(dataEl(b0).id).toBe('o-adata');
    expect(listEl(b0).id).toBe('o-alist');
  });

  it('attEl rezolvă id-ul blocului 0 și cheia `bloc:N:…` a blocurilor 2+', () => {
    const b1 = mountBloc(1);
    expect(window.attEl('o-adata')).toBe(dataEl(blocuri()[0]));
    expect(window.attEl(window.attKeyBloc(1, 'data'))).toBe(dataEl(b1));
    expect(window.attEl(window.attKeyBloc(1, 'list'))).toBe(listEl(b1));
    // …iar cu un `ctx` din interiorul blocului, rezolvarea NU depinde de index (renumerotare).
    expect(window.attEl(window.attKeyBloc(9, 'data'), listEl(b1))).toBe(dataEl(b1));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('#128m — traseul CREARE: atașare pe un bloc nou (delegare)', () => {
  it('12 atașamentele blocului 1 nu apar în lista blocului 0 și invers', async () => {
    const b0 = blocuri()[0], b1 = mountBloc(1);
    dataEl(b0).value = JSON.stringify([{ id: 'a0', filename: 'zero.pdf' }]);
    dataEl(b1).value = JSON.stringify([{ id: 'a1', filename: 'unu.pdf' }]);

    window.renderAttachments('ordnt', 1, 0);
    window.renderAttachments('ordnt', 1, 1);

    expect(listEl(b0).innerHTML).toContain('zero.pdf');
    expect(listEl(b0).innerHTML).not.toContain('unu.pdf');
    expect(listEl(b1).innerHTML).toContain('unu.pdf');
    expect(listEl(b1).innerHTML).not.toContain('zero.pdf');
  });

  it('input-ul de fișier al unui bloc nou e legat prin DELEGARE (addAtt primește cheile blocului)', () => {
    const b1 = mountBloc(1);
    const spy = vi.fn();
    const real = window.addAtt; window.addAtt = spy;
    try {
      const inp = b1.querySelector('[data-role="att-input"]');
      inp.dispatchEvent(new window.Event('change', { bubbles: true }));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0].slice(1)).toEqual(['bloc:1:list', 'bloc:1:data']);
    } finally { window.addAtt = real; }
  });

  it('blocul 0 NU e dublat de delegare (are handler inline în pagină)', () => {
    const spy = vi.fn();
    const real = window.addAtt; window.addAtt = spy;
    try {
      document.getElementById('o-ainp').dispatchEvent(new window.Event('change', { bubbles: true }));
      expect(spy).not.toHaveBeenCalled();
    } finally { window.addAtt = real; }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('#128m — traseul SALVARE: uploadAttachments trimite ?bloc=N', () => {
  const pending = (name) => JSON.stringify([{ name, type: 'application/pdf', data: 'data:application/pdf;base64,QUJD' }]);

  it('10 fiecare bloc își urcă atașamentele pe blocul lui; blocul 0 FĂRĂ parametru (non-regresie)', async () => {
    const b0 = blocuri()[0], b1 = mountBloc(1), b2 = mountBloc(2);
    dataEl(b0).value = pending('b0.pdf');
    dataEl(b1).value = pending('b1.pdf');
    dataEl(b2).value = pending('b2.pdf');

    const urls = [];
    globalThis.fetch = vi.fn((url) => {
      urls.push(url);
      return Promise.resolve(okJson({ ok: true, atasament: { id: 'x', filename: 'f', mime_type: 'application/pdf', size_bytes: 3 } }));
    });

    await window.uploadAttachments('ordnt', 1);
    await window.uploadAttachmentsBlocuri('ordnt');

    expect(urls).toEqual([
      '/api/formulare-atasamente/ord/ORD-1?slot=1',
      '/api/formulare-atasamente/ord/ORD-1?slot=1&bloc=1',
      '/api/formulare-atasamente/ord/ORD-1?slot=1&bloc=2',
    ]);
  });

  it('14 ramura DF — cereri neschimbate (fără `bloc`), iar uploadAttachmentsBlocuri e no-op', async () => {
    document.getElementById('n-fdad').value = pending('df.pdf');
    const urls = [];
    globalThis.fetch = vi.fn((url) => {
      urls.push(url);
      return Promise.resolve(okJson({ ok: true, atasament: { id: 'x', filename: 'f', mime_type: 'application/pdf', size_bytes: 3 } }));
    });

    await window.uploadAttachments('notafd', 1);
    const failed = await window.uploadAttachmentsBlocuri('notafd');

    expect(urls).toEqual(['/api/formulare-atasamente/df/DF-1?slot=1']);
    expect(failed).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('#128m — traseul REDESCHIDERE: listele se cer per bloc', () => {
  it('11 ⭐ fiecare bloc 2+ își cere lista cu ?bloc=N și o randează în propria zonă', async () => {
    const b1 = mountBloc(1), b2 = mountBloc(2);
    const urls = [];
    globalThis.fetch = vi.fn((url) => {
      urls.push(url);
      const b = /bloc=(\d+)/.exec(url)?.[1] || '0';
      return Promise.resolve(okJson({ ok: true, atasamente: [
        { id: 'id' + b, filename: `fisier-b${b}.pdf`, mime_type: 'application/pdf', size_bytes: 3 },
      ] }));
    });

    await window.fetchAttachments('ordnt', 1);      // blocul 0 — apelul clasic din loadDoc
    await window.fetchAttachmentsBlocuri('ordnt');  // blocurile 2+

    expect(urls).toEqual([
      '/api/formulare-atasamente/ord/ORD-1?slot=1',
      '/api/formulare-atasamente/ord/ORD-1?slot=1&bloc=1',
      '/api/formulare-atasamente/ord/ORD-1?slot=1&bloc=2',
    ]);
    expect(listEl(blocuri()[0]).innerHTML).toContain('fisier-b0.pdf');
    expect(listEl(b1).innerHTML).toContain('fisier-b1.pdf');
    expect(listEl(b2).innerHTML).toContain('fisier-b2.pdf');
    expect(JSON.parse(dataEl(b2).value)[0].id).toBe('id2');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('#128m — lock', () => {
  it('13 lockCaptureAndAttachments(ft,true) blochează zonele TUTUROR blocurilor', () => {
    const b1 = mountBloc(1), b2 = mountBloc(2);
    window.lockCaptureAndAttachments('ordnt', true);
    for (const bl of [blocuri()[0], b1, b2]) {
      expect(bl.querySelector('[data-role="att-input"]').disabled).toBe(true);
      expect(bl.querySelector('[data-role="att-btn"]').disabled).toBe(true);
    }
    window.lockCaptureAndAttachments('ordnt', false);
    for (const bl of [blocuri()[0], b1, b2]) {
      expect(bl.querySelector('[data-role="att-input"]').disabled).toBe(false);
      expect(bl.querySelector('[data-role="att-btn"]').disabled).toBe(false);
    }
  });

  it('un bloc blocat nu deschide file picker-ul prin delegare', () => {
    const b1 = mountBloc(1);
    const inp = b1.querySelector('[data-role="att-input"]');
    const spy = vi.spyOn(inp, 'click');
    window.lockCaptureAndAttachments('ordnt', true);
    b1.querySelector('[data-role="att-btn"]').dispatchEvent(new window.Event('click', { bubbles: true }));
    expect(spy).not.toHaveBeenCalled();
    window.lockCaptureAndAttachments('ordnt', false);
    b1.querySelector('[data-role="att-btn"]').dispatchEvent(new window.Event('click', { bubbles: true }));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
