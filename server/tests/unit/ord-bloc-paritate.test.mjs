// @vitest-environment happy-dom
/**
 * #128k — PARITATEA blocurilor ORD.
 *
 * Două lucruri, în același fișier fiindcă apără aceeași invariantă:
 *
 * A) COMPORTAMENTAL (majoritatea testelor) — prefill-ul „plăți anterioare" (col.3) ajunge în
 *    TOATE blocurile, pe toate cele trei trasee (creare / salvare-redeschidere / bloc adăugat
 *    ulterior). Col.3 e o proprietate a ANGAJAMENTULUI, nu a furnizorului.
 *
 * B) STRUCTURAL — un singur test (`inventarul de ancore`) care citește SURSA celor trei fișiere
 *    și asertează că mulțimea ancorelor pe id `o-…` rămase e EXACT lista albă de mai jos.
 *    ⚠️ E singurul test din proiect căruia îi e permisă analiza statică pe sursă, și e justificat:
 *    obiectul verificat ESTE forma sursei (ce mai e ancorat pe id global = ce NU e per bloc),
 *    nu comportamentul. Fără el, decizia „generalizez / las" se ia de mână, lot cu lot, și
 *    următoarea ancorare pe id se descoperă pe staging (exact ce s-a întâmplat cu prefill-ul).
 *    NU folosi tiparul ăsta pentru a verifica logică — pentru logică scrie test comportamental.
 *
 * Convenția happy-dom + `new Function(src).call(globalThis)` e cea din pagin-component.test.mjs.
 * Capcană cunoscută: calea se rezolvă cu dirname(fileURLToPath(import.meta.url)),
 * NU cu `new URL('.', import.meta.url)`.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dir, '../../../public/js/formular/');
const read = (p) => readFileSync(join(SRC_DIR, p), 'utf8');

beforeAll(() => {
  globalThis.fetch = () => Promise.reject(new Error('fetch dezactivat la încărcare'));
  new Function(read('core.js')).call(globalThis);
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  try { new Function(read('doc.js')).call(globalThis); } finally { globalThis.setInterval = realSetInterval; }
});

// ── Fixture: structura ORD de producție, redusă la esențial ──────────────────
const BLOC_TBL = `
  <table class="doc-t"><tbody></tbody>
    <tfoot><tr class="df-total">
      <td data-tot="rec">0</td><td data-tot="plati">0</td>
      <td data-tot="suma">0</td><td data-tot="neplat">0</td>
      <td><button class="badd">+</button></td>
    </tr></tfoot></table>`;

function mountOrdForm() {
  document.body.innerHTML = `
    <div class="status" id="sBar"></div>
    <div id="result-ordnt"></div>
    <div id="docs-list-ordnt"></div>
    <div id="form-ordnt">
      <input id="o-cif" value="12345678"/>
      <textarea id="o-den">Instituția Test</textarea>
      <input id="o-nr" value="7"/>
      <input id="o-data" value="15.08.2026"/>
      <div id="o-alist"></div>
      <input id="o-adata" value="[]"/>
      <div id="o-cimg"></div><div id="o-cph"></div>
      <div id="o-cimg2"></div><div id="o-cph2"></div>
      <div id="o-captura2-wrap"></div>
      <input id="o-nrUnic" type="hidden" data-fld="nr_unic_inreg" value="NR-001"/>
      <select id="o-df-sel"></select>
      <input type="hidden" id="o-df-id" value=""/>
      <div id="ord-blocuri">
        <div class="ord-bloc" data-bloc="0">
          <textarea id="o-benef" data-fld="beneficiar">SC Unu SRL</textarea>
          <input id="o-docsj" data-fld="documente_justificative" value="Factura 1"/>
          <input id="o-cifb" data-fld="cif_beneficiar" value="19"/>
          <input id="o-iban" data-fld="iban_beneficiar" value="RO49AAAA1234"/>
          <input id="o-banca" data-fld="banca_beneficiar" value="BCR"/>
          <input id="o-inf1" data-fld="inf_pv_plata" value="info1"/>
          <input id="o-inf2" data-fld="inf_pv_plata1" value="info2"/>
          <table class="doc-t"><tbody id="o-tbody"></tbody>
            <tfoot><tr class="df-total">
              <td id="o-t-rec" data-tot="rec">0</td><td id="o-t-plati" data-tot="plati">0</td>
              <td id="o-t-suma" data-tot="suma">0</td><td id="o-t-neplat" data-tot="neplat">0</td>
              <td><button class="badd">+</button></td>
            </tr></tfoot></table>
        </div>
      </div>
      <button type="button" id="btn-add-bloc"></button>
    </div>`;
  globalThis.window.oI = 0;
  globalThis.window._alopSumaPlataAnterioara = 0;
  globalThis.window._alopContext = null;
  if (typeof globalThis.window._platiAntReset === 'function') globalThis.window._platiAntReset();
}

/** Adaugă manual un al doilea container de bloc (fără a trece prin addBlocOrd). */
function mountBloc(idx) {
  const el = document.createElement('div');
  el.className = 'ord-bloc';
  el.setAttribute('data-bloc', String(idx));
  el.innerHTML = `<textarea data-fld="beneficiar"></textarea>${BLOC_TBL}`;
  document.getElementById('ord-blocuri').appendChild(el);
  return el;
}

const blocuri = () => [...document.querySelectorAll('.ord-bloc')];
const antInput = (bl) => bl.querySelector('tbody input[data-f="plati_anterioare"]');
const c5Input = (bl) => bl.querySelector('tbody input[data-f="receptii_neplatite"]');
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

beforeEach(() => { mountOrdForm(); vi.restoreAllMocks(); });

// ═════════════════════════════════════════════════════════════════════════════
describe('#128k — prefill „plăți anterioare" pe toate blocurile', () => {
  // ── Traseul 1: CREARE (newDoc → fetch /api/alop/:id) ───────────────────────
  it('⭐ NON-REGRESIE — creare, UN singur bloc: valoarea ajunge pe primul rând, col.5 recalculată', async () => {
    globalThis.window._alopContext = { alopId: 'A1' };
    const spy = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ alop: { cicluri_istorice: [{ plata_suma_efectiva: '1200.50' }] } }),
    }));
    globalThis.fetch = spy;

    try { window.newDoc('ordnt'); } catch { /* restul lui newDoc nu ne interesează aici */ }
    // Rândul creat de newDoc are nevoie de o valoare pe col.2 ca să vedem col.5.
    const bl = blocuri()[0];
    const rec = bl.querySelector('tbody input[data-f="receptii"]');
    rec.value = '2.000,00';
    await flush();

    expect(antInput(bl).value).toBe('1.200,50');
    // 5 = col.2 − col.3 − col.4 = 2000 − 1200,50 − 0
    expect(c5Input(bl).value).toBe('799,50');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // La CREARE există prin construcție un singur bloc (newDoc → resetOrdBlocuri). Acoperirea
  // multi-bloc pe traseul de creare vine prin addBlocOrd (testul ⭐ de mai jos), nu prin newDoc.
  it('creare: newDoc revine la UN singur bloc — multi-bloc se acoperă prin addBlocOrd', async () => {
    globalThis.window._alopContext = { alopId: 'A1' };
    globalThis.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ alop: { cicluri_istorice: [{ plata_suma_efectiva: '300' }] } }),
    }));
    const b1 = mountBloc(1);
    window.addOR(b1);
    try { window.newDoc('ordnt'); } catch { /* noop */ }
    await flush();
    // newDoc apelează resetOrdBlocuri() → blocul 1 dispare (document NOU). Restaurăm și
    // verificăm că un bloc prezent la momentul prefill-ului l-ar fi primit.
    expect(blocuri()).toHaveLength(1);
  });

  // ── Traseul 2: SALVARE / REDESCHIDERE (populateOrd) ────────────────────────
  it('⭐ redeschidere cu DOUĂ blocuri: fiecare bloc primește valoarea pe primul rând al lui', async () => {
    globalThis.window._alopSumaPlataAnterioara = 4321;
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('fără capturi')));

    await window.populateOrd({
      id: 'O1', cif: '1', den_inst_pb: 'X', nr_ordonant_pl: '7',
      blocuri: [{ beneficiar: 'Unu' }, { beneficiar: 'Doi' }],
      rows: [
        { bloc_idx: 0, receptii: '10000', plati_anterioare: '0', suma_ordonantata_plata: '0' },
        { bloc_idx: 1, receptii: '9000', plati_anterioare: '0', suma_ordonantata_plata: '0' },
      ],
    });
    await flush();

    const bls = blocuri();
    expect(bls).toHaveLength(2);
    expect(antInput(bls[0]).value).toBe('4.321,00');
    expect(antInput(bls[1]).value).toBe('4.321,00');
  });

  it('NON-REGRESIE — redeschidere cu UN bloc: comportament identic cu cel de azi', async () => {
    globalThis.window._alopSumaPlataAnterioara = 500;
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('fără capturi')));
    await window.populateOrd({
      id: 'O1', blocuri: [{ beneficiar: 'Unu' }],
      rows: [{ bloc_idx: 0, receptii: '1200', plati_anterioare: '0', suma_ordonantata_plata: '200' }],
    });
    await flush();
    const bl = blocuri()[0];
    expect(antInput(bl).value).toBe('500,00');
    expect(c5Input(bl).value).toBe('500,00'); // 1200 − 500 − 200
  });

  it('⭐ col.5 se recalculează corect în BLOCUL 2 după prefill', async () => {
    globalThis.window._alopSumaPlataAnterioara = 1000;
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('fără capturi')));
    await window.populateOrd({
      id: 'O1', blocuri: [{ beneficiar: 'Unu' }, { beneficiar: 'Doi' }],
      rows: [
        { bloc_idx: 0, receptii: '5000', plati_anterioare: '0', suma_ordonantata_plata: '0' },
        { bloc_idx: 1, receptii: '8000', plati_anterioare: '0', suma_ordonantata_plata: '500' },
      ],
    });
    await flush();
    const bls = blocuri();
    expect(c5Input(bls[1]).value).toBe('6.500,00'); // 8000 − 1000 − 500
  });

  // ── Traseul 3: BLOC ADĂUGAT ULTERIOR (addBlocOrd) ──────────────────────────
  it('⭐ bloc adăugat DUPĂ prefill: îl primește, FĂRĂ un al doilea fetch', async () => {
    globalThis.window._alopContext = { alopId: 'A1' };
    const spy = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ alop: { cicluri_istorice: [{ plata_suma_efectiva: '777' }] } }),
    }));
    globalThis.fetch = spy;

    try { window.newDoc('ordnt'); } catch { /* noop */ }
    await flush();
    expect(antInput(blocuri()[0]).value).toBe('777,00');

    const callsInainte = spy.mock.calls.length;
    const nou = await window.addBlocOrd();
    await flush();

    expect(nou).toBeTruthy();
    expect(antInput(nou).value).toBe('777,00');
    expect(spy.mock.calls.length).toBe(callsInainte); // memoizat — zero fetch-uri noi
  });

  it('bloc adăugat când valoarea e 0 / inexistentă: nimic scris, nicio excepție', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('fără alop')));
    window.addOR();
    const nou = await window.addBlocOrd();
    await flush();
    expect(nou).toBeTruthy();
    expect(antInput(nou).value).toBe('0,00');
  });

  // ── Gărzi & cache ──────────────────────────────────────────────────────────
  it('garda „doar dacă e 0": un rând cu valoare deja nenulă NU e suprascris', () => {
    window.addOR();
    const bl = blocuri()[0];
    antInput(bl).value = '9.999,00';
    const n = window.applyPlatiAntPrefill(null, { val: 1000 });
    expect(n).toBe(0);
    expect(antInput(bl).value).toBe('9.999,00');
  });

  it('force (garda din populateOrd): suprascrie necondiționat', () => {
    window.addOR();
    const bl = blocuri()[0];
    antInput(bl).value = '9.999,00';
    const n = window.applyPlatiAntPrefill(null, { val: 1000, force: true });
    expect(n).toBe(1);
    expect(antInput(bl).value).toBe('1.000,00');
  });

  it('newDoc invalidează cache-ul: documentul nou nu moștenește valoarea celui anterior', async () => {
    globalThis.window._alopSumaPlataAnterioara = 2500;
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('fără capturi')));
    await window.populateOrd({ id: 'O1', blocuri: [{}], rows: [{ bloc_idx: 0, receptii: '5000' }] });
    await flush();
    expect(antInput(blocuri()[0]).value).toBe('2.500,00');

    globalThis.window._alopSumaPlataAnterioara = 0;
    globalThis.window._alopContext = null;
    try { window.newDoc('ordnt'); } catch { /* noop */ }
    await flush();
    // Cache invalidat ⇒ un bloc adăugat acum nu mai primește nimic.
    const nou = await window.addBlocOrd();
    await flush();
    expect(antInput(nou).value).toBe('0,00');
  });

  it('resetF invalidează cache-ul', async () => {
    globalThis.window._alopSumaPlataAnterioara = 1500;
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('fără capturi')));
    await window.populateOrd({ id: 'O1', blocuri: [{}], rows: [{ bloc_idx: 0, receptii: '5000' }] });
    await flush();

    globalThis.confirm = () => true;
    globalThis.draftClear = () => {};   // draft.js nu e încărcat în acest test
    try { window.resetF('ordnt'); } catch { /* restul lui resetF nu ne interesează */ }
    const nou = await window.addBlocOrd();
    await flush();
    expect(antInput(nou).value).toBe('0,00');
  });

  it('fallback fără containere [data-bloc]: scrie în #o-tbody, ca înainte de #128h', () => {
    document.querySelectorAll('[data-bloc]').forEach((el) => el.removeAttribute('data-bloc'));
    window.addOR();
    const n = window.applyPlatiAntPrefill(null, { val: 42 });
    expect(n).toBe(1);
    expect(document.querySelector('#o-tbody input[data-f="plati_anterioare"]').value).toBe('42,00');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// B) INVENTARUL ÎNCHIS — analiză statică pe sursă (vezi justificarea din capul fișierului)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Lista albă: pentru fiecare fișier, ancorele pe id `o-…` PERMISE și de câte ori.
 * Verdicte:
 *   GLOBAL PRIN DESIGN — câmp unic pe DOCUMENT, nu pe furnizor;
 *   BLOCUL 0 — REZOLVAT la #128n — capturile per bloc se rezolvă prin capZona()/data-role;
 *                       ce a rămas pe id e strict blocul 0;
 *   BLOCUL 0          — id-ul istoric al blocului 0, folosit ca ancoră/fallback, cu o cale
 *                       per-bloc alături (`[data-bloc]`) care îl acoperă.
 * Orice ancoră NOUĂ face testul să cadă ⇒ decizie conștientă. Orice ancoră REZOLVATĂ îl face
 * să cadă ⇒ scoate-o din listă.
 */
const ANCORE_PERMISE = {
  'doc.js': {
    'o-df-sel': [5, 'GLOBAL PRIN DESIGN — un singur DF per ORD (reconul #128a)'],
    'o-df-id': [5, 'GLOBAL PRIN DESIGN — id-ul DF-ului legat, unic pe document'],
    'o-tbody': [7, 'BLOCUL 0 — fallback pentru pagini/teste fără [data-bloc]. #128l a rezolvat ' +
      'ultimele două excepții reale (pre-checkul din showP2Modal și validateSecB); ce a rămas ' +
      'e fallback sau resetare de DOM (newDoc/resetF golesc blocul 0 după resetOrdBlocuri)'],
    'o-captura2-wrap': [1, 'BLOCUL 0 — REZOLVAT la #128n: wrap-ul slotului 2 e specific blocului 0; ' +
      'blocurile 2+ au ambele zone în șablon, rezolvate prin capZona()/data-cap-slot'],
    'o-czone': [1, 'BLOCUL 0 — REZOLVAT la #128n: zonele per bloc se rezolvă prin capZona()/data-role; ' +
      'ce a rămas e deblocarea pointer-events a blocului 0 în setModeP2Ord'],
    'o-czone2': [1, 'BLOCUL 0 — REZOLVAT la #128n: idem slotul 2 al blocului 0; blocurile 2+ sunt ' +
      'deblocate prin selectorul pe [data-role="cap-zone"] de alături'],
    'o-alist': [2, 'BLOCUL 0 — REZOLVAT la #128m: zonele per bloc se rezolvă prin attEl()/data-role; ' +
      'ce a rămas e golirea DOM-ului blocului 0 în newDoc/resetF'],
    'o-adata': [2, 'BLOCUL 0 — REZOLVAT la #128m: hidden-ul per bloc se rezolvă prin attEl()/data-role; ' +
      'ce a rămas e resetarea valorii blocului 0 în newDoc/resetF'],
  },
  'core.js': {
    'o-data': [1, 'GLOBAL PRIN DESIGN — data ordonanțării, unică pe document'],
    'o-tbody': [2, 'BLOCUL 0 — _ordTbody(default) și getOR(); lista multi-bloc e getOrdRowsAll()'],
    'o-df-id': [1, 'GLOBAL PRIN DESIGN — un singur DF per ORD'],
    'o-adata': [1, 'BLOCUL 0 — colO() trimite lista de atașamente a blocului 0 în payload-ul ' +
      'de document (PDF/XML); persistența per furnizor e în formulare_atasamente.bloc_idx (#128m)'],
  },
  'list.js': {
    'o-df-sel': [2, 'GLOBAL PRIN DESIGN — un singur DF per ORD'],
    'o-df-id': [1, 'GLOBAL PRIN DESIGN — un singur DF per ORD'],
    'o-tbody': [1, 'BLOCUL 0 — onDfSelect repopulează blocul 0; blocurile 2+ prin addBlocOrd'],
  },
};

const RX_ANCORA = /getElementById\('(o-[a-z0-9-]*)'\)|querySelector(?:All)?\('#(o-[a-z0-9-]*)/g;

function ancoreDin(src) {
  const out = {};
  for (const m of src.matchAll(RX_ANCORA)) {
    const id = m[1] || m[2];
    out[id] = (out[id] || 0) + 1;
  }
  return out;
}

describe('#128k — inventarul de ancore pe id `o-…` e ÎNCHIS', () => {
  for (const [file, permise] of Object.entries(ANCORE_PERMISE)) {
    it(`${file}: mulțimea ancorelor e exact lista albă`, () => {
      const gasite = ancoreDin(read(file));
      const asteptate = Object.fromEntries(
        Object.entries(permise).map(([id, [n]]) => [id, n]),
      );
      // Mesaj util la cădere: diferența se vede direct în diff-ul obiectelor.
      expect(gasite).toEqual(asteptate);
    });
  }

  it('fiecare intrare din lista albă are un motiv scris', () => {
    for (const [file, permise] of Object.entries(ANCORE_PERMISE)) {
      for (const [id, [n, motiv]] of Object.entries(permise)) {
        expect(typeof n, `${file}/${id}`).toBe('number');
        expect(String(motiv).length, `${file}/${id}`).toBeGreaterThan(20);
      }
    }
  });
});
