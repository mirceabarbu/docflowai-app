// @vitest-environment happy-dom
/**
 * #128i — validările înainte de P2 și blocarea pe rol se aplică TUTUROR blocurilor ORD.
 *
 * Se exercită codul REAL din public/js/formular/{core,doc}.js peste DOM-ul de producție de
 * după #128h (#ord-blocuri > .ord-bloc[data-bloc="0"] cu id-uri istorice + blocuri clonate
 * FĂRĂ id-uri). Fixture-ul e cel din ord-bloc-add-frontend.test.mjs, extins cu tabelul
 * complet al blocului 0 (validarea coloanei 4 are nevoie de rânduri reale).
 *
 * Capcană cunoscută: calea se rezolvă cu dirname(fileURLToPath(import.meta.url)),
 * NU cu `new URL('.', import.meta.url)`.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dir, '../../../public/js/formular/', p), 'utf8');

beforeAll(() => {
  globalThis.fetch = () => Promise.reject(new Error('fetch dezactivat în test'));
  new Function(read('core.js')).call(globalThis);
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  try { new Function(read('doc.js')).call(globalThis); } finally { globalThis.setInterval = realSetInterval; }
});

function mountOrdForm() {
  document.body.innerHTML = `
    <div class="status" id="sBar"></div>
    <div id="section-form">
    <div id="form-ordnt">
      <input id="o-cif" value="12345678"/>
      <textarea id="o-den">Instituția Test</textarea>
      <input id="o-nr" value="7"/>
      <input id="o-data" value="15.08.2026"/>
      <input id="o-nrUnic" type="hidden" data-fld="nr_unic_inreg" value="NR-001"/>
      <input type="hidden" id="o-df-id" value=""/>
      <select id="o-df-sel"><option value="DF-1" selected>DF-1</option></select>
      <div id="ord-blocuri">
        <div class="ord-bloc" data-bloc="0">
          <textarea id="o-benef" data-fld="beneficiar">SC Unu SRL</textarea>
          <input id="o-docsj" data-fld="documente_justificative" value="Factura 1"/>
          <input id="o-cifb" data-fld="cif_beneficiar" value="19"/>
          <input id="o-iban" data-fld="iban_beneficiar" value="RO49AAAA1234"/>
          <input id="o-banca" data-fld="banca_beneficiar" value="BCR"/>
          <input id="o-inf1" data-fld="inf_pv_plata" value="info1"/>
          <input id="o-inf2" data-fld="inf_pv_plata1" value="info2"/>
          <table class="doc-t">
            <tbody id="o-tbody"></tbody>
            <tfoot><tr class="df-total">
              <td class="num" id="o-t-rec" data-tot="rec">0</td>
              <td class="num" id="o-t-plati" data-tot="plati">0</td>
              <td class="num" id="o-t-suma" data-tot="suma">0</td>
              <td class="num" id="o-t-neplat" data-tot="neplat">0</td>
              <td><button class="badd" data-add-row>+</button></td>
            </tr></tfoot>
          </table>
        </div>
      </div>
    </div></div>`;
  globalThis.window.oI = 0;
}

const blocuri = () => [...document.querySelectorAll('.ord-bloc')];
const lastRow = (bloc) => bloc.querySelector('tbody tr:last-child');
const setRow = (tr, vals) => {
  Object.entries(vals).forEach(([f, v]) => {
    const inp = tr.querySelector(`[data-f="${f}"]`);
    if (inp) inp.value = v;
  });
};
// Un bloc „complet": câmpurile beneficiarului + un rând cu suma > 0.
function fillBloc(bl, { suma = '100,00', ...flds } = {}) {
  const vals = {
    beneficiar: 'SC Test SRL', documente_justificative: 'Factura', cif_beneficiar: '19',
    iban_beneficiar: 'RO49AAAA1234', banca_beneficiar: 'BCR', inf_pv_plata: 'info', ...flds,
  };
  Object.entries(vals).forEach(([f, v]) => {
    const el = bl.querySelector(`[data-fld="${f}"]`);
    if (el) el.value = v;
  });
  if (!bl.querySelector('tbody tr')) globalThis.window.addOR(bl);
  setRow(lastRow(bl), { suma_ordonantata_plata: suma });
}
const labels = () => globalThis.window._validateOrd().map((e) => e.label);

beforeEach(() => {
  mountOrdForm();
  globalThis.window.setOrdDfCtrlRows(null);
});

describe('#128i — validare: NON-REGRESIE cu un singur bloc', () => {
  it('1. ⭐ etichetele rămân IDENTICE cu cele de dinaintea lotului, FĂRĂ prefix „Furnizor"', () => {
    // bloc unic, cu toate câmpurile goale și niciun rând cu suma > 0
    ['o-benef', 'o-docsj', 'o-cifb', 'o-iban', 'o-banca', 'o-inf1'].forEach((id) => {
      document.getElementById(id).value = '';
    });
    globalThis.window.addOR();
    expect(labels()).toEqual([
      'Coloana 4 (Suma ordonanțată la plată): cel puțin un rând completat cu valoare > 0',
      'Beneficiar', 'Documente justificative', 'CIF beneficiar',
      'IBAN beneficiar', 'Bancă beneficiar', 'Informații privind plata',
    ]);
    expect(labels().some((l) => /Furnizor/.test(l))).toBe(false);
  });

  it('un singur bloc COMPLET → zero erori; erorile blocului 0 păstrează id-urile istorice', () => {
    fillBloc(blocuri()[0]);
    expect(labels()).toEqual([]);

    document.getElementById('o-benef').value = '';
    const errs = globalThis.window._validateOrd();
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ id: 'o-benef', label: 'Beneficiar' });
  });
});

describe('#128i — validare: mai multe blocuri', () => {
  it('2. ⭐ blocul 2 cu beneficiarul gol → „Furnizor 2 — Beneficiar", blocul 1 curat', async () => {
    fillBloc(blocuri()[0]);
    const b1 = await globalThis.window.addBlocOrd();
    fillBloc(b1, { beneficiar: '' });

    const errs = globalThis.window._validateOrd();
    expect(errs.map((e) => e.label)).toEqual(['Furnizor 2 — Beneficiar']);
    expect(errs[0].id).toBeNull();                                  // blocul 2 n-are id-uri
    expect(errs[0].el).toBe(b1.querySelector('[data-fld="beneficiar"]'));
    expect(errs.some((e) => /Furnizor 1/.test(e.label))).toBe(false);
  });

  it('3. ⭐ blocul 2 fără niciun rând cu suma > 0 → eroare pe blocul 2, blocul 1 curat', async () => {
    fillBloc(blocuri()[0]);
    const b1 = await globalThis.window.addBlocOrd();
    fillBloc(b1, { suma: '0,00' });

    expect(labels()).toEqual([
      'Furnizor 2 — Coloana 4 (Suma ordonanțată la plată): cel puțin un rând completat cu valoare > 0',
    ]);
  });

  it('4. două blocuri, ambele complete → zero erori', async () => {
    fillBloc(blocuri()[0]);
    const b1 = await globalThis.window.addBlocOrd();
    fillBloc(b1, { beneficiar: 'SC Doi SRL', cif_beneficiar: '20' });
    expect(labels()).toEqual([]);
  });

  it('erorile mai multor blocuri apar în ordinea blocurilor, fiecare prefixată', async () => {
    ['o-benef', 'o-iban'].forEach((id) => { document.getElementById(id).value = ''; });
    globalThis.window.addOR();
    setRow(lastRow(blocuri()[0]), { suma_ordonantata_plata: '10,00' });
    const b1 = await globalThis.window.addBlocOrd();
    fillBloc(b1, { banca_beneficiar: '' });

    expect(labels()).toEqual([
      'Furnizor 1 — Beneficiar', 'Furnizor 1 — IBAN beneficiar', 'Furnizor 2 — Bancă beneficiar',
    ]);
  });

  it('nr_unic_inreg NU se validează per bloc (e unic pe document)', async () => {
    fillBloc(blocuri()[0]);
    const b1 = await globalThis.window.addBlocOrd();
    fillBloc(b1);
    document.getElementById('o-nrUnic').value = '';
    expect(labels().some((l) => /înregistrare|nr_unic/i.test(l))).toBe(false);
  });
});

describe('#128i — derulare la prima eroare', () => {
  it('5. ⭐ eroarea dintr-un bloc fără id derulează la ELEMENTUL corect', async () => {
    fillBloc(blocuri()[0]);
    const b1 = await globalThis.window.addBlocOrd();
    fillBloc(b1, { banca_beneficiar: '' });

    const target = b1.querySelector('[data-fld="banca_beneficiar"]');
    const spy = vi.fn();
    target.scrollIntoView = spy;
    globalThis.window._scrollToFirstErr(globalThis.window._validateOrd());
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('erorile CU id continuă să deruleze prin getElementById (comportament DF neschimbat)', () => {
    const el = document.getElementById('o-benef');
    const spy = vi.fn();
    el.scrollIntoView = spy;
    globalThis.window._scrollToFirstErr([{ id: 'o-benef', label: 'Beneficiar' }]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('#128i — lockOrdIdentityCols pe toate blocurile', () => {
  const IDENT = ['cod_angajament', 'indicator_angajament', 'program', 'cod_SSI'];
  const identInputs = (bl) => IDENT.map((f) => bl.querySelector(`[data-f="${f}"]`));

  it('6. ⭐ DF selectat → identitatea readOnly (NU disabled) în toate blocurile + „+" dezactivat', async () => {
    globalThis.window.addOR();
    const b1 = await globalThis.window.addBlocOrd();
    document.getElementById('o-df-id').value = 'DF-1';
    globalThis.window.lockOrdIdentityCols();

    blocuri().forEach((bl) => {
      identInputs(bl).forEach((inp) => {
        expect(inp).toBeTruthy();
        expect(inp.readOnly).toBe(true);
        expect(inp.disabled).toBe(false);   // valorile trebuie să ajungă în payload (#100.1)
        expect(inp.tabIndex).toBe(-1);
      });
      expect(bl.querySelector('.badd').disabled).toBe(true);
    });
    expect(b1.querySelector('.badd')).toBeTruthy();
  });

  it('7. bloc adăugat ÎNAINTE și bloc adăugat DUPĂ selectarea DF-ului — ambele blocate', async () => {
    globalThis.window.addOR();
    const inainte = await globalThis.window.addBlocOrd();   // fără DF încă

    document.getElementById('o-df-id').value = 'DF-1';
    globalThis.window.setOrdDfCtrlRows([{ cod_angajament: 'A1', indicator_angajament: 'I1', program: 'P1', cod_SSI: 'S1' }]);
    const dupa = await globalThis.window.addBlocOrd();
    globalThis.window.lockOrdIdentityCols();

    [inainte, dupa].forEach((bl) => {
      identInputs(bl).forEach((inp) => { expect(inp.readOnly).toBe(true); expect(inp.disabled).toBe(false); });
      expect(bl.querySelector('.badd').disabled).toBe(true);
    });
  });

  it('fără DF legat → identitatea rămâne editabilă în toate blocurile', async () => {
    globalThis.window.addOR();
    const b1 = await globalThis.window.addBlocOrd();
    globalThis.window.lockOrdIdentityCols();
    [blocuri()[0], b1].forEach((bl) => {
      identInputs(bl).forEach((inp) => expect(inp.readOnly).toBe(false));
      expect(bl.querySelector('.badd').disabled).toBe(false);
    });
  });
});

describe('#128i — redeschiderea pe rol atinge toate blocurile', () => {
  it('8a. setModeP2Ord() deblochează recepții + plăți anterioare în toate blocurile', async () => {
    globalThis.window.addOR();
    const b1 = await globalThis.window.addBlocOrd();
    globalThis.window.ST.docRole = { ordnt: 'p2' };
    globalThis.window.setModeP2Ord();

    [blocuri()[0], b1].forEach((bl) => {
      ['receptii', 'plati_anterioare'].forEach((f) => {
        expect(bl.querySelector(`[data-f="${f}"]`).disabled).toBe(false);
      });
    });
  });

  it('8b. P1 în pending_p2 — col.4 se redeschide în toate blocurile', async () => {
    globalThis.window.addOR();
    const b1 = await globalThis.window.addBlocOrd();
    globalThis.window.lockAll('ordnt', true);
    globalThis.window._ordAllRowInputs('suma_ordonantata_plata').forEach((e) => { e.disabled = false; });

    [blocuri()[0], b1].forEach((bl) => {
      expect(bl.querySelector('[data-f="suma_ordonantata_plata"]').disabled).toBe(false);
      expect(bl.querySelector('[data-f="receptii"]').disabled).toBe(true);   // restul rămâne blocat
    });
  });
});
