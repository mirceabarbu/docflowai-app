// @vitest-environment happy-dom
/**
 * #128l — rândurile blocurilor 2+ se PIERDEAU la finalizarea P2.
 *
 * `completeAsP2` trimitea `{rows:getOR()}` — getOR() citește EXCLUSIV `#o-tbody` (blocul 0),
 * iar `/complete` înlocuiește întregul array `rows` ⇒ rândurile furnizorilor 2+ dispăreau
 * definitiv (beneficiarul lor supraviețuia în `blocuri` ⇒ simptomul „bloc completat, tabel gol").
 *
 * Aici se apără: (A) corpul cererii acoperă toate blocurile; (B) validările de client
 * (validateSecB, pre-checkul din showP2Modal) nu se mai uită doar la blocul 0.
 *
 * Convenția happy-dom + `new Function(src).call(globalThis)` e cea din ord-bloc-paritate.test.mjs.
 * Capcană cunoscută: calea se rezolvă cu dirname(fileURLToPath(import.meta.url)).
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
    <div id="result-ordnt"></div><div id="result-notafd"></div>
    <div id="docs-list-ordnt"></div>
    <div id="form-ordnt">
      <input id="o-cif" value="12345678"/>
      <textarea id="o-den">Instituția Test</textarea>
      <input id="o-nr" value="7"/>
      <input id="o-data" value="15.08.2026"/>
      <div id="o-alist"></div><input id="o-adata" value="[]"/>
      <div id="o-cimg"></div><div id="o-cph"></div>
      <div id="o-cimg2"></div><div id="o-cph2"></div>
      <div id="o-captura2-wrap"></div>
      <input id="o-nrUnic" type="hidden" data-fld="nr_unic_inreg" value="NR-001"/>
      <select id="o-df-sel"><option value="D1" selected>D1</option></select>
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

function mountBloc(idx) {
  const el = document.createElement('div');
  el.className = 'ord-bloc';
  el.setAttribute('data-bloc', String(idx));
  el.innerHTML = `
    <textarea data-fld="beneficiar">SC Doi SRL</textarea>
    <input data-fld="documente_justificative" value="Factura 2"/>
    <input data-fld="cif_beneficiar" value="29"/>
    <input data-fld="iban_beneficiar" value="RO49BBBB"/>
    <input data-fld="banca_beneficiar" value="BT"/>
    <input data-fld="inf_pv_plata" value="info-2"/>
    ${BLOC_TBL}`;
  document.getElementById('ord-blocuri').appendChild(el);
  return el;
}

/** Umple primul rând al unui bloc (îl creează cu addOR dacă lipsește). */
function fillRow(bl, { cod = 'A-01', rec = '0', ant = '0', suma = '0' } = {}) {
  const tb = bl.querySelector('tbody');
  if (!tb.querySelector('tr')) window.addOR(bl);
  const tr = tb.querySelector('tr');
  const set = (f, v) => { const i = tr.querySelector(`[data-f="${f}"]`); if (i) i.value = v; };
  set('cod_angajament', cod);
  set('receptii', rec);
  set('plati_anterioare', ant);
  set('suma_ordonantata_plata', suma);
  return tr;
}

const blocuri = () => [...document.querySelectorAll('.ord-bloc')];
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

/** Stub-uri pentru dependențele lui completeAsP2 care nu fac obiectul testului. */
function stubComplete() {
  window.uploadCaptura = vi.fn(async () => {});
  window.uploadAttachments = vi.fn(async () => {});
  window._alopLinkDoc = vi.fn(() => {});
  window.df = { getCsrf: () => 'csrf-token' };
  const spy = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, document: {} }) }));
  globalThis.fetch = spy;
  window.fetch = spy;
  return spy;
}
const corpul = (spy) => JSON.parse(spy.mock.calls[0][1].body);

beforeEach(() => { mountOrdForm(); vi.restoreAllMocks(); });

// ═════════════════════════════════════════════════════════════════════════════
describe('#128l — completeAsP2 trimite rândurile TUTUROR blocurilor', () => {
  it('⭐ REGRESIA: două blocuri cu rânduri → corpul conține ambele, cu bloc_idx 0 și 1', async () => {
    fillRow(blocuri()[0], { cod: 'A-01', rec: '5000', suma: '3000' });
    fillRow(mountBloc(1), { cod: 'B-02', rec: '1000', suma: '435' });

    window.ST.docId.ordnt = 'O1';
    const spy = stubComplete();
    await window.completeAsP2('ordnt');
    await flush();

    const rows = corpul(spy).rows;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.bloc_idx)).toEqual([0, 1]);
    expect(rows.map((r) => r.cod_angajament)).toEqual(['A-01', 'B-02']);
    // Fără fix: un singur rând (blocul 0) ⇒ 435 lei pierduți.
    expect(rows[1].suma_ordonantata_plata).toBe('435');
  });

  it('⭐ NON-REGRESIE: un singur bloc → corp echivalent cu cel de dinainte, plus bloc_idx:0', async () => {
    fillRow(blocuri()[0], { cod: 'A-01', rec: '5000', suma: '3000' });

    window.ST.docId.ordnt = 'O1';
    const spy = stubComplete();
    await window.completeAsP2('ordnt');
    await flush();

    const rows = corpul(spy).rows;
    const vechi = window.getOR();                 // exact ce se trimitea înainte de #128l
    expect(rows).toHaveLength(vechi.length);
    expect(rows.map(({ bloc_idx, ...r }) => r)).toEqual(vechi);
    expect(rows.every((r) => r.bloc_idx === 0)).toBe(true);
  });

  it('ramura DF (notafd) rămâne neschimbată — corpul e exact collectDfP2Db(), fără rows de ORD', async () => {
    // DOM minim de DF ca validateSecB(notafd) să treacă: bifa Secțiunea A + un rând cu cod.
    const df = document.createElement('div');
    df.innerHTML = `
      <input type="checkbox" id="n-ck-seca" checked/>
      <input type="checkbox" id="n-ck-fararezv"/>
      <input id="n-sumfara" value="0"/><input id="n-sumfararezvcrbug" value="0"/>
      <input type="checkbox" id="n-ck-interzis"/><input type="checkbox" id="n-ck-intrucat"/>
      <input id="n-intrucat" value=""/>
      <table><tbody id="n-ctbody"><tr>
        <td><input data-f="cod_angajament" value="A-01"/></td>
      </tr></tbody></table>`;
    document.body.appendChild(df);

    window.ST.docId.notafd = 'D1';
    const asteptat = window.collectDfP2Db();
    const spy = stubComplete();
    await window.completeAsP2('notafd');
    await flush();

    expect(corpul(spy)).toEqual(asteptat);
    expect(corpul(spy).rows).toBeUndefined();
    expect(spy.mock.calls[0][0]).toContain('/D1/complete');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('#128l — validateSecB acoperă toate blocurile', () => {
  const mesaj = () => document.getElementById('sBar').textContent;

  it('blocul 2 fără niciun cod angajament → respinge, cu mesaj „Furnizor 2 — …"', () => {
    fillRow(blocuri()[0], { cod: 'A-01', rec: '5000', suma: '3000' });
    const b1 = mountBloc(1);
    fillRow(b1, { cod: '', rec: '1000', suma: '435' });

    expect(window.validateSecB('ordnt')).toBe(false);
    expect(mesaj()).toContain('Furnizor 2 — Adăugați cel puțin un rând angajament.');
  });

  it('un singur bloc fără cod → mesaj FĂRĂ prefixul „Furnizor"', () => {
    fillRow(blocuri()[0], { cod: '', rec: '1000', suma: '0' });
    expect(window.validateSecB('ordnt')).toBe(false);
    expect(mesaj()).toContain('Adăugați cel puțin un rând angajament.');
    expect(mesaj()).not.toContain('Furnizor');
  });

  it('col.5 negativă în BLOCUL 2 → respinge (înainte trecea: se citea doar blocul 0)', () => {
    fillRow(blocuri()[0], { cod: 'A-01', rec: '5000', suma: '3000' });
    fillRow(mountBloc(1), { cod: 'B-02', rec: '100', suma: '435' });   // 100 − 0 − 435 < 0

    expect(window.validateSecB('ordnt')).toBe(false);
    expect(mesaj()).toContain('Recepții neplătite negative');
    expect(mesaj()).toContain('Furnizor 2 — rândul 1');
  });

  it('NON-REGRESIE: col.5 negativă cu UN bloc → mesaj byte-identic cu cel de azi', () => {
    fillRow(blocuri()[0], { cod: 'A-01', rec: '100', suma: '435' });
    expect(window.validateSecB('ordnt')).toBe(false);
    // „❌ " e prefixul lui setS(...,'err'), nu al mesajului.
    expect(mesaj()).toBe('❌ ⛔ Recepții neplătite negative: rândul 1 (-335,00). Suma ordonanțată '
      + '(col.4) depășește disponibilul (col.2 − col.3). Reduceți col.4 sau verificați col.2/col.3.');
  });

  it('două blocuri valide → trece', () => {
    fillRow(blocuri()[0], { cod: 'A-01', rec: '5000', suma: '3000' });
    fillRow(mountBloc(1), { cod: 'B-02', rec: '1000', suma: '435' });
    expect(window.validateSecB('ordnt')).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('#128l — pre-checkul din showP2Modal nu mai fals-blochează', () => {
  it('blocul 0 fără col.4 dar blocul 1 CU col.4 → fără alertul generic', async () => {
    fillRow(blocuri()[0], { cod: 'A-01', rec: '5000', suma: '0' });
    fillRow(mountBloc(1), { cod: 'B-02', rec: '1000', suma: '435' });

    const alerte = [];
    globalThis.alert = (m) => alerte.push(m);
    window.alert = globalThis.alert;
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, users: [] }) }));

    await window.showP2Modal('ordnt');
    expect(alerte).toHaveLength(0);   // mesajul precis vine din _validateOrd, nu alertul generic
  });

  it('TOATE blocurile fără col.4 → alertul generic rămâne', async () => {
    fillRow(blocuri()[0], { cod: 'A-01', rec: '5000', suma: '0' });
    fillRow(mountBloc(1), { cod: 'B-02', rec: '1000', suma: '0' });

    const alerte = [];
    globalThis.alert = (m) => alerte.push(m);
    window.alert = globalThis.alert;

    await window.showP2Modal('ordnt');
    expect(alerte).toHaveLength(1);
    expect(alerte[0]).toContain('col.4');
  });
});
