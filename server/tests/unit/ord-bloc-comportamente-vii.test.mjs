// @vitest-environment happy-dom
/**
 * #128j — comportamentele „vii" (autocomplete beneficiar, lookup CIF local→ANAF, badge ANAF,
 * închiderea dropdown-ului, salvarea beneficiarului, avertizarea de buget) pe TOATE blocurile ORD.
 *
 * Se exercită codul REAL din public/js/formular/{core,doc,list}.js peste DOM-ul de producție
 * de după #128h. Blocurile 2+ se construiesc cu `_sablonBloc` REAL — deci testul dovedește și
 * că șablonul emite `data-role` fără id-uri.
 *
 * ⚠️ Delegarea se leagă la ÎNCĂRCAREA list.js, de containerul #ord-blocuri. De aceea shell-ul
 * (inclusiv #ord-blocuri) se montează O SINGURĂ DATĂ, înainte de load; `beforeEach` resetează
 * DOAR conținutul containerului. Asta e chiar poanta lotului: blocurile create ulterior (din
 * draft, din renderOrdBlocuri, din addBlocOrd) primesc comportamentul fără nicio cablare.
 *
 * Capcană cunoscută: calea se rezolvă cu dirname(fileURLToPath(import.meta.url)),
 * NU cu `new URL('.', import.meta.url)`.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dir, '../../../public/js/formular/', p), 'utf8');

const escHtml = (s) => (s === null || s === undefined ? '' : String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;'));

const SHELL = `
  <div class="status" id="sBar"></div>
  <div id="section-form"><div id="form-ordnt">
    <input id="o-cif" value="12345678"/>
    <input id="o-nrUnic" type="hidden" data-fld="nr_unic_inreg" value="NR-001"/>
    <input type="hidden" id="o-df-id" value=""/>
    <div id="ord-buget-warn" data-role="buget-warn" style="display:none"></div>
    <div id="ord-blocuri"></div>
  </div></div>
  <div id="form-notafd">
    <div id="secb-buget-warn" data-role="buget-warn" style="display:none"></div>
  </div>`;

const BLOC0 = `
  <div class="ord-bloc" data-bloc="0">
    <div class="ac-wrap">
      <textarea id="o-benef" data-fld="beneficiar"></textarea>
      <div id="o-benef-drop" class="ac-drop" data-role="benef-drop"></div>
      <div id="o-benef-status" data-role="benef-status"></div>
    </div>
    <span id="o-cifb-spin" data-role="cifb-spin" style="display:none">⏳</span>
    <input id="o-cifb" data-fld="cif_beneficiar"/>
    <input id="o-iban" data-fld="iban_beneficiar"/>
    <input id="o-banca" data-fld="banca_beneficiar"/>
    <input id="o-docsj" data-fld="documente_justificative"/>
    <table class="doc-t"><tbody id="o-tbody"></tbody>
      <tfoot><tr class="df-total">
        <td class="num" id="o-t-rec" data-tot="rec">0</td>
        <td class="num" id="o-t-plati" data-tot="plati">0</td>
        <td class="num" id="o-t-suma" data-tot="suma">0</td>
        <td class="num" id="o-t-neplat" data-tot="neplat">0</td>
        <td><button class="badd" data-add-row>+</button></td>
      </tr></tfoot></table>
  </div>`;

// ── fetch mock, rutat pe URL ────────────────────────────────────────────────
let routes;
const calls = [];
function installFetch() {
  calls.length = 0;
  globalThis.fetch = vi.fn((url, opts) => {
    calls.push({ url: String(url), opts });
    for (const [re, fn] of routes) if (re.test(String(url))) return fn(String(url), opts);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  });
}
const jsonRes = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

beforeAll(() => {
  globalThis.fetch = () => Promise.reject(new Error('fetch nesetat'));
  document.body.innerHTML = SHELL;                 // shell STABIL — delegarea se leagă de el
  // În producție `esc` e global (script-scope partajat); `new Function` îl închide în modul.
  globalThis.esc = escHtml;
  // df-utils.js e o dependență de LOAD (doc.js/list.js fac `const esc = window.df.esc`).
  window.df = Object.assign({}, window.df, {
    esc: escHtml,
    isoToDMY: (s) => s,
    getCsrf: () => 'csrf-test',
  });
  window.ST = { docId: {}, mode: {} };
  new Function(read('core.js')).call(globalThis);
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  try { new Function(read('doc.js')).call(globalThis); } finally { globalThis.setInterval = realSetInterval; }
  new Function(read('list.js')).call(globalThis);   // ← delegarea se leagă AICI, de #ord-blocuri
});

beforeEach(() => {
  vi.useFakeTimers();
  document.getElementById('ord-blocuri').innerHTML = BLOC0;
  window.oI = 0;
  routes = [];
  installFetch();
});
afterEach(() => { vi.useRealTimers(); });

const blocuri = () => [...document.querySelectorAll('.ord-bloc')];
const addBloc = (idx) => {
  const el = window._sablonBloc(idx);
  document.getElementById('ord-blocuri').appendChild(el);
  return el;
};
const fld = (bloc, f) => bloc.querySelector(`[data-fld="${f}"]`);
const role = (bloc, r) => bloc.querySelector(`[data-role="${r}"]`);
const type = (el, val) => { el.value = val; el.dispatchEvent(new window.Event('input', { bubbles: true })); };
const blur = (el) => el.dispatchEvent(new window.Event('focusout', { bubbles: true }));
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

const BENEF = (list) => [/\/api\/beneficiari\?/, () => jsonRes({ beneficiari: list })];

// ─────────────────────────────────────────────────────────────────────────────
describe('#128j — NON-REGRESIE cu un singur bloc', () => {
  it('1. ⭐ autocomplete, lookup CIF și badge scriu în ACELEAȘI elemente ca azi (#o-benef-drop, #o-benef-status, #o-cifb-spin)', async () => {
    routes = [BENEF([{ id: 7, denumire: 'SC Unu SRL', cif: '19', iban: 'RO49X', banca: 'BCR' }])];
    const b0 = blocuri()[0];

    type(document.getElementById('o-benef'), 'Unu');
    await vi.advanceTimersByTimeAsync(400);
    await vi.waitFor(() => expect(document.getElementById('o-benef-drop').style.display).toBe('block'));
    expect(document.getElementById('o-benef-drop').querySelectorAll('.ac-opt').length).toBe(1);
    expect(role(b0, 'benef-drop').id).toBe('o-benef-drop');   // aceeași destinație

    // lookup CIF: potrivire locală → auto-fill + badge ANAF (verificare separată)
    routes = [
      BENEF([{ id: 7, denumire: 'SC Unu SRL', cif: '55', iban: 'RO49X', banca: 'BCR' }]),
      [/\/api\/verify\/cui/, () => jsonRes({ ok: true, data: { radiated: true, radiatedDate: '01.01.2020' } })],
    ];
    document.getElementById('o-cifb').value = 'RO55';
    blur(document.getElementById('o-cifb'));
    await vi.waitFor(() => expect(document.getElementById('o-benef').value).toBe('SC Unu SRL'));
    expect(document.getElementById('o-cifb').value).toBe('55');            // normalizarea RO
    expect(document.getElementById('o-iban').value).toBe('RO49X');
    expect(document.getElementById('o-banca').value).toBe('BCR');
    await vi.waitFor(() => expect(document.getElementById('o-benef-status').innerHTML).toContain('RADIAT'));
    expect(document.getElementById('o-cifb-spin').style.display).toBe('none');
  });

  it('1b. renderBenefStatusBadge() fără bloc-țintă scrie tot în #o-benef-status', () => {
    window.renderBenefStatusBadge({ vat: false, vatEndDate: '02.02.2026' });
    expect(document.getElementById('o-benef-status').innerHTML).toContain('TVA anulat');
  });

  it('1c. CIF invalid nu declanșează niciun fetch (regex ^\\d{2,10}$ neatins)', () => {
    document.getElementById('o-cifb').value = 'abc';
    blur(document.getElementById('o-cifb'));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('#128j — comportamente pe blocurile 2+', () => {
  it('2. ⭐ tastarea în blocul 2 deschide dropdown-ul blocului 2; blocul 1 rămâne închis', async () => {
    routes = [BENEF([{ id: 9, denumire: 'SC Doi SRL', cif: '20', iban: 'RO2', banca: 'BT' }])];
    const b1 = addBloc(1);
    type(fld(b1, 'beneficiar'), 'Doi');
    await vi.advanceTimersByTimeAsync(400);
    await vi.waitFor(() => expect(role(b1, 'benef-drop').style.display).toBe('block'));
    expect(role(b1, 'benef-drop').querySelectorAll('.ac-opt').length).toBe(1);
    expect(document.getElementById('o-benef-drop').style.display).not.toBe('block');
    expect(document.getElementById('o-benef-drop').innerHTML).toBe('');
  });

  it('3. ⭐ blur pe CIF în blocul 2 → auto-fill + badge în blocul 2, blocul 1 COMPLET neatins', async () => {
    routes = [
      BENEF([{ id: 9, denumire: 'SC Doi SRL', cif: '20', iban: 'RO2', banca: 'BT' }]),
      [/\/api\/verify\/cui/, () => jsonRes({ ok: true, data: { inactive: true, inactiveDate: '03.03.2026' } })],
    ];
    const b1 = addBloc(1);
    fld(b1, 'cif_beneficiar').value = '20';
    blur(fld(b1, 'cif_beneficiar'));

    await vi.waitFor(() => expect(fld(b1, 'beneficiar').value).toBe('SC Doi SRL'));
    expect(fld(b1, 'iban_beneficiar').value).toBe('RO2');
    expect(fld(b1, 'banca_beneficiar').value).toBe('BT');
    await vi.waitFor(() => expect(role(b1, 'benef-status').innerHTML).toContain('INACTIV'));

    // blocul 1 — nimic scris
    expect(document.getElementById('o-benef').value).toBe('');
    expect(document.getElementById('o-iban').value).toBe('');
    expect(document.getElementById('o-banca').value).toBe('');
    expect(document.getElementById('o-benef-status').innerHTML).toBe('');
    expect(role(b1, 'benef-status').id).toBe('');   // blocul 2 nu are id-uri
  });

  it('4. debounce PER BLOC: tastare rapidă în blocul 1 apoi în blocul 2 → AMBELE căutări pleacă', async () => {
    routes = [BENEF([{ id: 1, denumire: 'X SRL', cif: '1', iban: '', banca: '' }])];
    const b0 = blocuri()[0];
    const b1 = addBloc(1);
    type(fld(b0, 'beneficiar'), 'Alfa');
    await vi.advanceTimersByTimeAsync(100);
    type(fld(b1, 'beneficiar'), 'Beta');
    await vi.advanceTimersByTimeAsync(400);
    const q = calls.filter((c) => /\/api\/beneficiari\?/.test(c.url)).map((c) => decodeURIComponent(c.url));
    expect(q.some((u) => u.includes('q=Alfa'))).toBe(true);
    expect(q.some((u) => u.includes('q=Beta'))).toBe(true);
  });

  it('4b. debounce în ACELAȘI bloc: două tastări rapide → o singură căutare (ultima)', async () => {
    routes = [BENEF([])];
    const b0 = blocuri()[0];
    type(fld(b0, 'beneficiar'), 'Al');
    await vi.advanceTimersByTimeAsync(100);
    type(fld(b0, 'beneficiar'), 'Alfa');
    await vi.advanceTimersByTimeAsync(400);
    const q = calls.filter((c) => /\/api\/beneficiari\?/.test(c.url));
    expect(q.length).toBe(1);
    expect(decodeURIComponent(q[0].url)).toContain('q=Alfa');
  });

  it('5. alegerea unei opțiuni din dropdown-ul blocului 2 completează câmpurile blocului 2', async () => {
    routes = [BENEF([{ id: 9, denumire: 'SC Doi SRL', cif: '20', iban: 'RO2', banca: 'BT' }])];
    const b1 = addBloc(1);
    type(fld(b1, 'beneficiar'), 'Doi');
    await vi.advanceTimersByTimeAsync(400);
    await vi.waitFor(() => expect(role(b1, 'benef-drop').querySelector('.ac-opt')).toBeTruthy());

    click(role(b1, 'benef-drop').querySelector('.ac-opt'));
    expect(fld(b1, 'beneficiar').value).toBe('SC Doi SRL');
    expect(fld(b1, 'cif_beneficiar').value).toBe('20');
    expect(fld(b1, 'iban_beneficiar').value).toBe('RO2');
    expect(fld(b1, 'banca_beneficiar').value).toBe('BT');
    expect(role(b1, 'benef-drop').style.display).toBe('none');
    expect(document.getElementById('o-benef').value).toBe('');  // blocul 1 neatins
  });

  it('6. ⭐ beneficiar cu APOSTROF în denumire — opțiunea se randează, se selectează, valoarea ajunge INTACTĂ', async () => {
    const DEN = "Ferma L'Aurora SRL";
    routes = [BENEF([{ id: 3, denumire: DEN, cif: '31', iban: 'RO3', banca: "Banca L'Est" }])];
    const b0 = blocuri()[0];
    type(fld(b0, 'beneficiar'), 'Ferma');
    await vi.advanceTimersByTimeAsync(400);
    const drop = document.getElementById('o-benef-drop');
    await vi.waitFor(() => expect(drop.querySelectorAll('.ac-opt').length).toBe(1));
    const opt = drop.querySelector('.ac-opt');
    expect(opt.dataset.benDen).toBe(DEN);          // dataset decodează entitatea &#39;
    click(opt);
    expect(fld(b0, 'beneficiar').value).toBe(DEN);
    expect(fld(b0, 'banca_beneficiar').value).toBe("Banca L'Est");
  });

  it('7. garda de cursă: răspunsul ANAF întârziat se ignoră dacă CIF-ul BLOCULUI s-a schimbat', async () => {
    let releaseCui;
    const b1 = addBloc(1);
    routes = [
      BENEF([{ id: 9, denumire: 'SC Doi SRL', cif: '20', iban: 'RO2', banca: 'BT' }]),
      [/\/api\/verify\/cui/, () => new Promise((res) => { releaseCui = () => res({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, data: { radiated: true } }) }); })],
    ];
    fld(b1, 'cif_beneficiar').value = '20';
    blur(fld(b1, 'cif_beneficiar'));
    await vi.waitFor(() => expect(fld(b1, 'beneficiar').value).toBe('SC Doi SRL'));

    fld(b1, 'cif_beneficiar').value = '99';        // utilizatorul schimbă CIF-ul între timp
    releaseCui();
    await vi.advanceTimersByTimeAsync(10);
    expect(role(b1, 'benef-status').innerHTML).toBe('');   // răspuns stale → ignorat
  });

  it('8. click în afară închide dropdown-urile TUTUROR blocurilor', async () => {
    routes = [BENEF([{ id: 1, denumire: 'X SRL', cif: '1', iban: '', banca: '' }])];
    const b0 = blocuri()[0];
    const b1 = addBloc(1);
    type(fld(b0, 'beneficiar'), 'Xa');
    type(fld(b1, 'beneficiar'), 'Xb');
    await vi.advanceTimersByTimeAsync(400);
    await vi.waitFor(() => {
      expect(role(b0, 'benef-drop').style.display).toBe('block');
      expect(role(b1, 'benef-drop').style.display).toBe('block');
    });
    click(document.getElementById('o-cif'));
    expect(role(b0, 'benef-drop').style.display).toBe('none');
    expect(role(b1, 'benef-drop').style.display).toBe('none');
  });

  it('8b. click ÎN dropdown-ul blocului 2 nu îl închide, dar îl închide pe al blocului 1', async () => {
    routes = [BENEF([{ id: 1, denumire: 'X SRL', cif: '1', iban: '', banca: '' }])];
    const b0 = blocuri()[0];
    const b1 = addBloc(1);
    type(fld(b0, 'beneficiar'), 'Xa');
    type(fld(b1, 'beneficiar'), 'Xb');
    await vi.advanceTimersByTimeAsync(400);
    await vi.waitFor(() => expect(role(b1, 'benef-drop').querySelector('.ac-opt')).toBeTruthy());
    click(role(b1, 'benef-drop').querySelector('.ac-opt'));
    expect(role(b0, 'benef-drop').style.display).toBe('none');
  });

  it('9. _saveBeneficiarIfNew: două blocuri completate → DOUĂ POST-uri; al doilea gol → UNUL singur', async () => {
    routes = [[/\/api\/beneficiari$/, () => jsonRes({ ok: true })]];
    const b0 = blocuri()[0];
    const b1 = addBloc(1);
    fld(b0, 'beneficiar').value = 'SC Unu SRL'; fld(b0, 'cif_beneficiar').value = '19';
    fld(b1, 'beneficiar').value = 'SC Doi SRL'; fld(b1, 'cif_beneficiar').value = '20';
    await window._saveBeneficiarIfNew();
    let posts = calls.filter((c) => c.opts?.method === 'POST');
    expect(posts.length).toBe(2);
    expect(JSON.parse(posts[0].opts.body).denumire).toBe('SC Unu SRL');
    expect(JSON.parse(posts[1].opts.body)).toMatchObject({ denumire: 'SC Doi SRL', cif: '20' });

    calls.length = 0;
    fld(b1, 'beneficiar').value = '   ';
    await window._saveBeneficiarIfNew();
    posts = calls.filter((c) => c.opts?.method === 'POST');
    expect(posts.length).toBe(1);
    expect(JSON.parse(posts[0].opts.body).denumire).toBe('SC Unu SRL');
  });
});

describe('#128j — avertizarea de buget pe toate blocurile', () => {
  const setSuma = (bloc, val) => {
    const inp = bloc.querySelector('tbody tr:last-child [data-f="suma_ordonantata_plata"]');
    inp.value = val;
  };

  it('10. totalul e pe TOATE blocurile, iar marcajul ord-buget-over se aplică rândurilor din ambele', async () => {
    routes = [[/buget-context/, () => jsonRes({ ok: true, context: { buget_an_curent: 100, cicluri_arhivate: 0, an_exercitiu: 2026 } })]];
    const b0 = blocuri()[0];
    const b1 = addBloc(1);
    window.addOR(b0); window.addOR(b1);

    await window._loadOrdBuget('DF-1');
    setSuma(b0, '60,00'); setSuma(b1, '10,00');
    window._checkOrdBuget();
    expect(document.querySelectorAll('.ord-buget-over').length).toBe(0);   // 70 ≤ 100
    expect(document.getElementById('ord-buget-warn').style.display).toBe('none');

    setSuma(b1, '50,00');                                                   // 60+50 = 110 > 100
    window._checkOrdBuget();
    expect(b0.querySelectorAll('tr.ord-buget-over').length).toBe(1);
    expect(b1.querySelectorAll('tr.ord-buget-over').length).toBe(1);
    expect(document.getElementById('ord-buget-warn').style.display).not.toBe('none');

    window._resetOrdBuget();
    expect(document.querySelectorAll('.ord-buget-over').length).toBe(0);
  });
});

describe('#128o — bannerul de buget în TOATE blocurile', () => {
  const setSuma = (bloc, val) => {
    const inp = bloc.querySelector('tbody tr:last-child [data-f="suma_ordonantata_plata"]');
    inp.value = val;
  };
  const SINGLE_MSG = '⛔ Suma ordonanțată (110,00 lei) depășește creditele bugetare ale anului 2026 (100,00 lei) cu 10,00 lei. Finalizarea va fi blocată.';
  const MULTI_MSG = '⛔ Suma ordonanțată (110,00 lei) depășește creditele bugetare ale anului 2026 (100,00 lei) cu 10,00 lei. Suma include toate blocurile de furnizor ale acestei ordonanțări, nu doar cel de mai sus. Finalizarea va fi blocată.';

  it('12. ⭐ bugul raportat: două blocuri, depășire ⇒ AMBELE bannere vizibile, același innerHTML', async () => {
    routes = [[/buget-context/, () => jsonRes({ ok: true, context: { buget_an_curent: 100, cicluri_arhivate: 0, an_exercitiu: 2026 } })]];
    const b0 = blocuri()[0];
    const b1 = addBloc(1);
    window.addOR(b0); window.addOR(b1);
    await window._loadOrdBuget('DF-1');
    setSuma(b0, '60,00'); setSuma(b1, '50,00');
    window._checkOrdBuget();

    // banner-ul blocului 0 e cel STATIC (#ord-buget-warn, în afara .ord-bloc, ca în formular.html)
    const w0 = document.getElementById('ord-buget-warn');
    const w1 = role(b1, 'buget-warn');
    expect(w0.style.display).not.toBe('none');
    expect(w1.style.display).not.toBe('none');
    expect(w0.innerHTML).toBe(w1.innerHTML);
    expect(w0.innerHTML).toBe(MULTI_MSG);
  });

  it('13. revenire sub plafon ⇒ ambele bannere ascunse și golite', async () => {
    routes = [[/buget-context/, () => jsonRes({ ok: true, context: { buget_an_curent: 100, cicluri_arhivate: 0, an_exercitiu: 2026 } })]];
    const b0 = blocuri()[0];
    const b1 = addBloc(1);
    window.addOR(b0); window.addOR(b1);
    await window._loadOrdBuget('DF-1');
    setSuma(b0, '60,00'); setSuma(b1, '50,00');
    window._checkOrdBuget();
    setSuma(b1, '10,00');                                                    // 60+10 = 70 ≤ 100
    window._checkOrdBuget();

    const w0 = document.getElementById('ord-buget-warn');
    const w1 = role(b1, 'buget-warn');
    expect(w0.style.display).toBe('none');
    expect(w1.style.display).toBe('none');
    expect(w0.innerHTML).toBe('');
    expect(w1.innerHTML).toBe('');
  });

  it('14. ⭐ paritate la un singur bloc: innerHTML EXACT identic cu textul de azi (fără propoziția nouă)', async () => {
    routes = [[/buget-context/, () => jsonRes({ ok: true, context: { buget_an_curent: 100, cicluri_arhivate: 0, an_exercitiu: 2026 } })]];
    const b0 = blocuri()[0];
    window.addOR(b0);
    await window._loadOrdBuget('DF-1');
    setSuma(b0, '110,00');
    window._checkOrdBuget();

    expect(document.getElementById('ord-buget-warn').innerHTML).toBe(SINGLE_MSG);
  });

  it('15. cu două blocuri, mesajul conține propoziția suplimentară despre cumul', async () => {
    routes = [[/buget-context/, () => jsonRes({ ok: true, context: { buget_an_curent: 100, cicluri_arhivate: 0, an_exercitiu: 2026 } })]];
    const b0 = blocuri()[0];
    const b1 = addBloc(1);
    window.addOR(b0); window.addOR(b1);
    await window._loadOrdBuget('DF-1');
    setSuma(b0, '60,00'); setSuma(b1, '50,00');
    window._checkOrdBuget();

    expect(document.getElementById('ord-buget-warn').innerHTML).toContain('Suma include toate blocurile de furnizor');
  });

  it('16. _resetOrdBuget() golește bannerele tuturor blocurilor', async () => {
    routes = [[/buget-context/, () => jsonRes({ ok: true, context: { buget_an_curent: 100, cicluri_arhivate: 0, an_exercitiu: 2026 } })]];
    const b0 = blocuri()[0];
    const b1 = addBloc(1);
    window.addOR(b0); window.addOR(b1);
    await window._loadOrdBuget('DF-1');
    setSuma(b0, '60,00'); setSuma(b1, '50,00');
    window._checkOrdBuget();

    window._resetOrdBuget();
    expect(document.getElementById('ord-buget-warn').style.display).toBe('none');
    expect(role(b1, 'buget-warn').style.display).toBe('none');
    expect(document.getElementById('ord-buget-warn').innerHTML).toBe('');
    expect(role(b1, 'buget-warn').innerHTML).toBe('');
  });

  it('17. structural: un bloc din _sablonBloc are exact UN [data-role="buget-warn"] și ZERO id-uri', () => {
    const b1 = addBloc(1);
    expect(b1.querySelectorAll('[data-role="buget-warn"]').length).toBe(1);
    expect(role(b1, 'buget-warn').id).toBe('');
  });

  it('18. ⭐ izolare DF: [data-role="buget-warn"] din #form-notafd nu e atins de _checkOrdBuget', async () => {
    routes = [[/buget-context/, () => jsonRes({ ok: true, context: { buget_an_curent: 100, cicluri_arhivate: 0, an_exercitiu: 2026 } })]];
    const b0 = blocuri()[0];
    window.addOR(b0);
    await window._loadOrdBuget('DF-1');
    setSuma(b0, '110,00');
    window._checkOrdBuget();

    const dfWarn = document.getElementById('secb-buget-warn');
    expect(dfWarn.style.display).toBe('none');
    expect(dfWarn.innerHTML).toBe('');
  });
});

describe('#128j — al treilea traseu: blocuri recreate, ZERO cablare', () => {
  it('11. ⭐ blocurile recreate de renderOrdBlocuri (draft / redeschidere doc) primesc comportamentul fără nicio cablare', async () => {
    routes = [BENEF([{ id: 9, denumire: 'SC Trei SRL', cif: '30', iban: 'RO3', banca: 'ING' }])];
    // exact ce face restaurarea din draft / deschiderea unui ORD salvat
    window.renderOrdBlocuri([{ beneficiar: 'SC Unu SRL' }, { beneficiar: 'vechi' }]);
    const b1 = blocuri()[1];
    expect(b1).toBeTruthy();
    expect(role(b1, 'benef-drop')).toBeTruthy();
    expect(role(b1, 'cifb-spin')).toBeTruthy();
    expect(b1.querySelectorAll('[id]').length).toBe(0);   // ⛔ șablonul NU emite id-uri

    type(fld(b1, 'beneficiar'), 'Trei');
    await vi.advanceTimersByTimeAsync(400);
    await vi.waitFor(() => expect(role(b1, 'benef-drop').style.display).toBe('block'));

    fld(b1, 'cif_beneficiar').value = '30';
    blur(fld(b1, 'cif_beneficiar'));
    await vi.waitFor(() => expect(fld(b1, 'beneficiar').value).toBe('SC Trei SRL'));
  });
});
