// @vitest-environment happy-dom
/**
 * #128n — capturi per BLOC de furnizor, partea de FRONTEND.
 *
 * Convenția happy-dom + `new Function(src).call(globalThis)` e cea din ord-atasamente-bloc.test.mjs.
 * Capcană cunoscută: calea se rezolvă cu dirname(fileURLToPath(import.meta.url)),
 * ⛔ NU `new URL('.', import.meta.url)` (aruncă sub happy-dom).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dir, '../../../public/js/formular/');
const read = (p) => readFileSync(join(SRC_DIR, p), 'utf8');
const readShared = (p) => readFileSync(join(__dir, '../../../public/js/shared/', p), 'utf8');

const PNG = 'data:image/png;base64,AAAA';
const PNG2 = 'data:image/png;base64,BBBB';

beforeAll(() => {
  globalThis.fetch = () => Promise.reject(new Error('fetch dezactivat la încărcare'));
  globalThis.df = globalThis.df || {};
  globalThis.df.esc = (s) => String(s ?? '');
  globalThis.df.getCsrf = () => 'csrf-test';
  new Function(readShared('file-item.js')).call(globalThis);
  new Function(read('core.js')).call(globalThis);
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  try { new Function(read('doc.js')).call(globalThis); } finally { globalThis.setInterval = realSetInterval; }
  try { new Function(read('list.js')).call(globalThis); } catch (_) { /* dependențe de pagină */ }
});

function mountOrdForm() {
  document.body.innerHTML = `
    <div class="status" id="sBar"></div>
    <div id="form-ordnt">
      <input id="o-cif"/><input id="o-den"/><input id="o-nr"/><input id="o-data"/>
      <div id="ord-blocuri">
        <div class="ord-bloc" data-bloc="0">
          <textarea id="o-benef" data-fld="beneficiar"></textarea>
          <input type="hidden" id="o-adata" value="[]" data-role="att-data"/>
          <table class="doc-t"><tbody id="o-tbody"></tbody></table>
          <div class="cap-zone" id="o-czone"><img class="cap-img" id="o-cimg"/></div>
          <div class="cap-zone" id="o-czone2"><img class="cap-img" id="o-cimg2"/></div>
        </div>
      </div>
    </div>`;
  window.ST.docId = { ordnt: 'ORD-1', notafd: 'DF-1' };
  // Harta globală se resetează între teste — blocul 0 rămâne pe ea, prin design.
  window.imgs['o-cimg'] = null;
  window.imgs['o-cimg2'] = null;
  window.imgs['n-cimg'] = null;
}

/** Bloc 2+ montat din ȘABLONUL REAL — testăm markup-ul livrat, nu o copie de fixture. */
function mountBloc(idx) {
  const el = window._sablonBloc(idx);
  document.getElementById('ord-blocuri').appendChild(el);
  return el;
}

const blocuri = () => [...document.querySelectorAll('.ord-bloc')];

beforeEach(() => { mountOrdForm(); vi.restoreAllMocks(); });

// ═════════════════════════════════════════════════════════════════════════════
describe('#128n — șablonul de bloc are zone de captură fără id-uri', () => {
  it('8 ⭐ blocul din _sablonBloc are DOUĂ zone cap-zone (data-cap-slot 1 și 2) și ZERO id-uri', () => {
    const el = window._sablonBloc(1);
    const zones = el.querySelectorAll('[data-role="cap-zone"]');
    expect(zones).toHaveLength(2);
    expect([...zones].map(z => z.getAttribute('data-cap-slot'))).toEqual(['1', '2']);
    // fiecare zonă își are propriul input/placeholder/img
    [...zones].forEach(z => {
      expect(z.querySelector('[data-role="cap-input"]')).toBeTruthy();
      expect(z.querySelector('[data-role="cap-ph"]')).toBeTruthy();
      expect(z.querySelector('[data-role="cap-img"]')).toBeTruthy();
    });
    // regula #128h: șablonul nu emite NICIUN atribut id
    expect(el.querySelectorAll('[id]')).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('#128n — helperii de rezolvare a capturii unui bloc', () => {
  it('9 capSrcBloc e null pe un bloc proaspăt; capSetBloc pune/scoate data-URL-ul', () => {
    const b1 = mountBloc(1);
    expect(window.capSrcBloc(b1, 1)).toBeNull();

    window.capSetBloc(b1, 1, PNG);
    expect(window.capSrcBloc(b1, 1)).toBe(PNG);
    const img = window.capZona(b1, 1).querySelector('[data-role="cap-img"]');
    const ph = window.capZona(b1, 1).querySelector('[data-role="cap-ph"]');
    expect(img.style.display).toBe('block');
    expect(ph.style.display).toBe('none');

    window.capSetBloc(b1, 1, null);
    expect(window.capSrcBloc(b1, 1)).toBeNull();
    expect(img.style.display).toBe('none');
    expect(ph.style.display).toBe('');
  });

  it('10 ⭐ sloturile sunt INDEPENDENTE — capSetBloc(…,2,…) nu atinge slotul 1 și invers', () => {
    const b1 = mountBloc(1);
    window.capSetBloc(b1, 2, PNG2);
    expect(window.capSrcBloc(b1, 2)).toBe(PNG2);
    // fără discriminatorul data-cap-slot, querySelector ar fi luat mereu PRIMA zonă
    expect(window.capSrcBloc(b1, 1)).toBeNull();

    window.capSetBloc(b1, 1, PNG);
    expect(window.capSrcBloc(b1, 1)).toBe(PNG);
    expect(window.capSrcBloc(b1, 2)).toBe(PNG2);

    window.capSetBloc(b1, 1, null);
    expect(window.capSrcBloc(b1, 2)).toBe(PNG2);
  });

  it('un src care nu e data:image (placeholder/gol) NU e considerat captură', () => {
    const b1 = mountBloc(1);
    window.capZona(b1, 1).querySelector('[data-role="cap-img"]').setAttribute('src', '/icons.svg');
    expect(window.capSrcBloc(b1, 1)).toBeNull();
  });

  it('11 capturaBloc(0,…) citește din harta `imgs`, NU din DOM-ul blocului 0', () => {
    window.imgs['o-cimg'] = PNG;
    window.imgs['o-cimg2'] = PNG2;
    expect(window.capturaBloc(0, 1)).toBe(PNG);
    expect(window.capturaBloc(0, 2)).toBe(PNG2);

    // blocul 0 n-are zone marcate data-role ⇒ dovada că sursa e harta, nu DOM-ul
    expect(document.querySelector('.ord-bloc[data-bloc="0"] [data-role="cap-zone"]')).toBeNull();

    const b1 = mountBloc(1);
    window.capSetBloc(b1, 1, 'data:image/png;base64,CCCC');
    expect(window.capturaBloc(1, 1)).toBe('data:image/png;base64,CCCC');
    expect(window.capturaBloc(0, 1)).toBe(PNG);  // neschimbat
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('#128n — payload-ul de PDF (colO)', () => {
  it('12 ⭐ capturiBlocuri are un element per bloc, în ordinea bloc_idx; [0].c1 === captureImageBase64', () => {
    window.imgs['o-cimg'] = PNG;
    window.imgs['o-cimg2'] = PNG2;
    const b1 = mountBloc(1), b2 = mountBloc(2);
    window.capSetBloc(b1, 1, 'data:image/png;base64,B1S1');
    window.capSetBloc(b2, 2, 'data:image/png;base64,B2S2');

    const p = window.colO();
    expect(p.capturiBlocuri).toHaveLength(3);
    expect(p.capturiBlocuri[0]).toEqual({ c1: PNG, c2: PNG2 });
    expect(p.capturiBlocuri[1]).toEqual({ c1: 'data:image/png;base64,B1S1', c2: null });
    expect(p.capturiBlocuri[2]).toEqual({ c1: null, c2: 'data:image/png;base64,B2S2' });

    // SURSĂ UNICĂ: cheile istorice sunt o proiecție a aceleiași funcții
    expect(p.captureImageBase64).toBe(p.capturiBlocuri[0].c1);
    expect(p.captureImageBase64_2).toBe(p.capturiBlocuri[0].c2);
  });

  it('un singur bloc ⇒ capturiBlocuri are exact un element, identic cu cheile istorice', () => {
    window.imgs['o-cimg'] = PNG;
    const p = window.colO();
    expect(p.capturiBlocuri).toHaveLength(1);
    expect(p.capturiBlocuri[0]).toEqual({ c1: PNG, c2: null });
    expect(p.captureImageBase64).toBe(PNG);
  });

  it('13 window.imgs rămâne la EXACT 3 chei după crearea a două blocuri suplimentare', () => {
    const b1 = mountBloc(1), b2 = mountBloc(2);
    window.capSetBloc(b1, 1, PNG);
    window.capSetBloc(b2, 2, PNG2);
    window.colO();
    expect(Object.keys(window.imgs).sort()).toEqual(['n-cimg', 'o-cimg', 'o-cimg2']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('#128n — delegarea handlerelor de captură (blocul 0 e sărit)', () => {
  it('butonul „Șterge imaginea" al unui bloc 2+ golește DOAR slotul lui', () => {
    const b1 = mountBloc(1);
    window.capSetBloc(b1, 1, PNG);
    window.capSetBloc(b1, 2, PNG2);

    const btn2 = b1.querySelector('[data-role="cap-clr"][data-cap-slot="2"]');
    btn2.dispatchEvent(new window.Event('click', { bubbles: true }));

    expect(window.capSrcBloc(b1, 2)).toBeNull();
    expect(window.capSrcBloc(b1, 1)).toBe(PNG);
  });

  it('⛔ blocul 0 e SĂRIT de delegare (are handlere inline în formular.html)', () => {
    const b0 = blocuri()[0];
    // montăm în blocul 0 markup marcat data-role, ca să dovedim că garda, nu absența
    // markup-ului, e cea care oprește delegarea
    b0.insertAdjacentHTML('beforeend',
      '<div class="cap-zone" data-role="cap-zone" data-cap-slot="1">' +
      '<div class="cap-ph" data-role="cap-ph"></div><img data-role="cap-img"/></div>' +
      '<button data-role="cap-clr" data-cap-slot="1"></button>');
    window.capSetBloc(b0, 1, PNG);

    b0.querySelector('[data-role="cap-clr"]').dispatchEvent(new window.Event('click', { bubbles: true }));
    expect(window.capSrcBloc(b0, 1)).toBe(PNG);  // NEATINS de delegare
  });
});
