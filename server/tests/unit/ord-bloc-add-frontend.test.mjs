// @vitest-environment happy-dom
/**
 * #128h — adăugarea/ștergerea unui bloc de furnizor în formularul ORD.
 *
 * Se exercită codul REAL din public/js/formular/{core,doc,draft}.js peste un DOM care
 * reproduce structura de producție de după acest lot:
 *   #form-ordnt  (FĂRĂ data-bloc)
 *     #o-nrUnic  (BLOC ANTET — unic pe document, în afara blocurilor)
 *     #ord-blocuri
 *       .ord-bloc[data-bloc="0"]   ← markup istoric (id-uri păstrate: o-benef…, o-tbody, o-t-*)
 *       .ord-bloc[data-bloc="1"]…  ← din șablon, ZERO id-uri
 *
 * Convenția happy-dom + `new Function(src).call(globalThis)` e cea din
 * server/tests/unit/pagin-component.test.mjs. Capcană cunoscută: calea se rezolvă cu
 * dirname(fileURLToPath(import.meta.url)), NU cu `new URL('.', import.meta.url)`.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dir, '../../../public/js/formular/', p), 'utf8');

beforeAll(() => {
  // core.js/doc.js lovesc rețeaua la încărcare (loadBugetCodes etc.) — non-fatal, dar sub
  // happy-dom ar fi conexiuni reale. Stub global, local testului.
  globalThis.fetch = () => Promise.reject(new Error('fetch dezactivat în test'));
  new Function(read('core.js')).call(globalThis);

  // doc.js pornește initDocWorkflow() cu un setInterval care așteaptă ST.user (niciodată setat
  // aici) — îl neutralizăm doar pe durata evaluării, ca să nu rămână un timer deschis.
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  try { new Function(read('doc.js')).call(globalThis); } finally { globalThis.setInterval = realSetInterval; }

  // draft.js depinde de df-utils (window.df.parseDMYtoISO/isoToDMY) — stub minimal.
  globalThis.window.df = Object.assign(globalThis.window.df || {}, {
    parseDMYtoISO: (v) => v, isoToDMY: (v) => v,
  });
  try { globalThis.localStorage.clear(); } catch { /* noop */ }
  new Function(read('draft.js')).call(globalThis);
});

// ── Fixture: structura ORD de producție, redusă la esențial ─────────────────
function mountOrdForm() {
  document.body.innerHTML = `
    <div class="status" id="sBar"></div>
    <div id="form-ordnt">
      <input id="o-cif" value="12345678"/>
      <textarea id="o-den">Instituția Test</textarea>
      <input id="o-nr" value="7"/>
      <input id="o-data" value="15.08.2026"/>
      <input id="o-adata" value="[]"/>
      <input id="o-nrUnic" type="hidden" data-fld="nr_unic_inreg" value="NR-001"/>
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
      <button type="button" id="btn-add-bloc"></button>
    </div>`;
  globalThis.window.oI = 0;
}

const blocuri = () => [...document.querySelectorAll('.ord-bloc')];
const setRow = (tr, vals) => {
  Object.entries(vals).forEach(([f, v]) => {
    const inp = tr.querySelector(`[data-f="${f}"]`);
    if (inp) inp.value = v;
  });
};
const lastRow = (bloc) => bloc.querySelector('tbody tr:last-child');

beforeEach(() => {
  mountOrdForm();
  globalThis.window.setOrdDfCtrlRows(null);
  globalThis.window.confirm = () => true;
});

describe('#128h — un singur bloc: NON-REGRESIE', () => {
  it('1. ⭐ colO() și collectOrdDb() produc payload-ul de dinaintea lotului (un bloc, toate rândurile bloc_idx:0)', () => {
    const { addOR, colO, collectOrdDb, getOR } = globalThis.window;
    addOR(); setRow(lastRow(blocuri()[0]), { cod_angajament: 'AG1', receptii: '100,00' });
    addOR(); setRow(lastRow(blocuri()[0]), { cod_angajament: 'AG2', receptii: '200,00' });

    const out = colO();
    expect(out.docFd.length).toBe(1);
    expect(out.docFd[0]).toMatchObject({
      nr_unic_inreg: 'NR-001', beneficiar: 'SC Unu SRL', documente_justificative: 'Factura 1',
      iban_beneficiar: 'RO49AAAA1234', cif_beneficiar: '19', banca_beneficiar: 'BCR',
      inf_pv_plata: 'info1', inf_pv_plata1: 'info2',
    });
    expect(out.docFd[0].rowTfd).toEqual(getOR());
    expect(out.docFd[0].rowTfd.length).toBe(2);

    const db = collectOrdDb();
    expect(db.blocuri.length).toBe(1);
    expect(db.blocuri[0].bloc_idx).toBe(0);
    expect(db.blocuri[0].nr_unic_inreg).toBe('NR-001');
    expect(db.rows.length).toBe(2);
    expect(db.rows.every((r) => r.bloc_idx === 0)).toBe(true);
    expect(db.rows).toEqual(getOR().map((r) => ({ ...r, bloc_idx: 0 })));
  });

  it('7. addOR() fără argument adaugă în blocul 0', async () => {
    const { addOR, addBlocOrd } = globalThis.window;
    await addBlocOrd();                       // blocul 1 primește 1 rând gol (fără DF)
    const before = document.querySelectorAll('#o-tbody tr').length;
    addOR();
    expect(document.querySelectorAll('#o-tbody tr').length).toBe(before + 1);
    expect(blocuri()[1].querySelectorAll('tbody tr').length).toBe(1); // neatins
  });
});

describe('#128h — adăugare bloc', () => {
  it('2. ⭐ un bloc nou → colO().docFd are 2 elemente, cu valori independente', async () => {
    const { addBlocOrd, colO } = globalThis.window;
    const el = await addBlocOrd();
    expect(el).toBeTruthy();
    el.querySelector('[data-fld="beneficiar"]').value = 'SC Doi SRL';
    el.querySelector('[data-fld="cif_beneficiar"]').value = '20';
    el.querySelector('[data-fld="iban_beneficiar"]').value = 'RO49BBBB5678';

    const out = colO();
    expect(out.docFd.length).toBe(2);
    expect(out.docFd[0].beneficiar).toBe('SC Unu SRL');
    expect(out.docFd[1].beneficiar).toBe('SC Doi SRL');
    expect(out.docFd[0].cif_beneficiar).toBe('19');
    expect(out.docFd[1].cif_beneficiar).toBe('20');
    // nr_unic_inreg e UNIC PE DOCUMENT — același pentru toate blocurile (citit din #o-nrUnic)
    expect(out.docFd[1].nr_unic_inreg).toBe('NR-001');
  });

  it('⭐ blocul nou nu emite niciun id; capturile lui sunt marcate DOAR prin data-role (#128n)', async () => {
    // șablonul PUR (înainte de orice rând) nu emite niciun id
    const gol = globalThis.window._sablonBloc(1);
    expect(gol.querySelectorAll('[id]').length).toBe(0);
    expect(gol.id).toBe('');

    const el = await globalThis.window.addBlocOrd();
    // singurele id-uri dintr-un bloc populat sunt cele ale rândurilor (`or-N`, contor GLOBAL
    // window.oI ⇒ unice între blocuri) — generate de addOR, folosite de delR.
    const ids = [...el.querySelectorAll('[id]')].map((e) => e.id);
    expect(ids.every((id) => /^or-\d+$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(el.id).toBe('');
    // #128n — șablonul conține ACUM secțiunea de captură (două sloturi per furnizor). Regula
    // care contează rămâne cea de la #128h și e verificată mai sus: ZERO atribute `id`.
    // Zonele se rezolvă exclusiv prin data-role + data-cap-slot.
    expect(el.querySelectorAll('[data-role="cap-zone"]').length).toBe(2);
    expect([...el.querySelectorAll('[data-role="cap-zone"]')]
      .map((z) => z.getAttribute('data-cap-slot'))).toEqual(['1', '2']);
    expect(el.querySelectorAll('.cap-zone[id],.cap-img[id],.cap-ph[id]').length).toBe(0);
    // …iar id-urile blocului 0 rămân UNICE în document
    ['o-benef', 'o-cifb', 'o-tbody', 'o-t-rec'].forEach((id) => {
      expect(document.querySelectorAll(`#${id}`).length).toBe(1);
    });
  });

  it('3. ⭐ rândurile fiecărui bloc rămân ale lui; lista plată e concatenată în ordinea bloc_idx', async () => {
    const { addOR, addBlocOrd, collectOrdDb, getOR } = globalThis.window;
    addOR(); setRow(lastRow(blocuri()[0]), { cod_angajament: 'B0-R1' });

    const b1 = await addBlocOrd();
    setRow(lastRow(b1), { cod_angajament: 'B1-R1' });
    addOR(b1); setRow(lastRow(b1), { cod_angajament: 'B1-R2' });

    // regresia de la §2.a: rândurile blocului 1 NU trebuie să apară în blocul 0
    expect(getOR().length).toBe(1);
    expect(document.querySelectorAll('#o-tbody tr').length).toBe(1);
    expect(blocuri()[0].querySelectorAll('tbody tr').length).toBe(1);
    expect(b1.querySelectorAll('tbody tr').length).toBe(2);

    const rows = collectOrdDb().rows;
    expect(rows.map((r) => r.cod_angajament)).toEqual(['B0-R1', 'B1-R1', 'B1-R2']);
    expect(rows.map((r) => r.bloc_idx)).toEqual([0, 1, 1]);
  });

  it('8. rândurile unui bloc nou poartă ctrl_idx (derivarea #128g funcționează pe ele)', async () => {
    const { setOrdDfCtrlRows, addBlocOrd, collectOrdDb } = globalThis.window;
    setOrdDfCtrlRows([
      { cod_angajament: 'A1', indicator_angajament: 'I1', program: 'P1', cod_SSI: 'S1' },
      { cod_angajament: 'A2', indicator_angajament: 'I2', program: 'P2', cod_SSI: 'S2' },
    ]);
    const b1 = await addBlocOrd();
    const trs = [...b1.querySelectorAll('tbody tr')];
    expect(trs.length).toBe(2);
    expect(trs.map((tr) => tr.dataset.ctrlIdx)).toEqual(['0', '1']);
    expect(trs[1].querySelector('[data-f="cod_angajament"]').value).toBe('A2');
    // coloanele de identitate ale blocului legat de DF sunt readOnly la creare
    expect(trs[0].querySelector('[data-f="cod_angajament"]').readOnly).toBe(true);

    const rows = collectOrdDb().rows.filter((r) => r.bloc_idx === 1);
    expect(rows.map((r) => r.ctrl_idx)).toEqual([0, 1]);
  });
});

describe('#128h — ștergere bloc', () => {
  it('4. ștergerea blocului 1 din trei → renumerotare contiguă 0,1 + bloc_idx actualizat pe rânduri', async () => {
    const { addBlocOrd, delBlocOrd, collectOrdDb } = globalThis.window;
    const b1 = await addBlocOrd();
    const b2 = await addBlocOrd();
    setRow(lastRow(blocuri()[0]), {});
    globalThis.window.addOR(); setRow(lastRow(blocuri()[0]), { cod_angajament: 'B0' });
    setRow(lastRow(b1), { cod_angajament: 'B1' });
    setRow(lastRow(b2), { cod_angajament: 'B2' });
    expect(blocuri().map((e) => e.getAttribute('data-bloc'))).toEqual(['0', '1', '2']);

    expect(delBlocOrd(b1)).toBe(true);
    expect(blocuri().length).toBe(2);
    expect(blocuri().map((e) => e.getAttribute('data-bloc'))).toEqual(['0', '1']);
    expect(blocuri()[1]).toBe(b2);

    const rows = collectOrdDb().rows;
    expect(rows.map((r) => r.cod_angajament)).toEqual(['B0', 'B2']);
    expect(rows.map((r) => r.bloc_idx)).toEqual([0, 1]);
    expect(collectOrdDb().blocuri.map((b) => b.bloc_idx)).toEqual([0, 1]);
  });

  it('5. blocul 0 nu poate fi șters (nici programatic, nici prin buton — care e ascuns)', async () => {
    const { addBlocOrd, delBlocOrd } = globalThis.window;
    await addBlocOrd();
    expect(delBlocOrd(blocuri()[0])).toBe(false);
    expect(blocuri().length).toBe(2);
    expect(document.getElementById('o-tbody')).toBeTruthy();
  });

  it('ștergerea cere confirmare — la „Anulează" blocul rămâne', async () => {
    const b1 = await globalThis.window.addBlocOrd();
    globalThis.window.confirm = () => false;
    expect(globalThis.window.delBlocOrd(b1)).toBe(false);
    expect(blocuri().length).toBe(2);
  });
});

describe('#128h — totaluri', () => {
  it('6. totalurile se calculează per bloc, iar blocul 0 scrie în continuare în #o-t-*', async () => {
    const { addOR, addBlocOrd, upTot } = globalThis.window;
    addOR(); setRow(lastRow(blocuri()[0]), { receptii: '100,00', plati_anterioare: '20,00', suma_ordonantata_plata: '30,00', receptii_neplatite: '50,00' });
    const b1 = await addBlocOrd();
    setRow(lastRow(b1), { receptii: '7,00', plati_anterioare: '1,00', suma_ordonantata_plata: '2,00', receptii_neplatite: '4,00' });
    upTot();

    expect(document.getElementById('o-t-rec').textContent).toBe('100,00');
    expect(document.getElementById('o-t-suma').textContent).toBe('30,00');
    expect(blocuri()[0].querySelector('[data-tot="rec"]').textContent).toBe('100,00');
    expect(b1.querySelector('[data-tot="rec"]').textContent).toBe('7,00');
    expect(b1.querySelector('[data-tot="plati"]').textContent).toBe('1,00');
    expect(b1.querySelector('[data-tot="suma"]').textContent).toBe('2,00');
    expect(b1.querySelector('[data-tot="neplat"]').textContent).toBe('4,00');
  });
});

describe('#128h — draft', () => {
  it('9. ⭐ draft VECHI (fără blocuri) se restaurează ca un singur bloc, fără excepții', () => {
    const { _draftApply } = globalThis.window.__draftTest || {};
    // API-ul public: _doRestore citește din window._pendingDraft
    const oldDraft = {
      ts: new Date().toISOString(),
      inputs: { 'o-benef': 'SC Veche SRL', 'o-cifb': '55' },
      checkboxes: {},
      rows: { 'o-tbody': [{ cod_angajament: 'VECHI', receptii: '10,00' }] },
    };
    expect(oldDraft.ordBlocuri).toBeUndefined();
    globalThis.window._pendingDraft = { ordnt: oldDraft };
    const errs = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => errs.push(a));
    expect(() => globalThis.window._doRestore('ordnt')).not.toThrow();
    spy.mockRestore();
    expect(errs).toEqual([]);
    expect(_draftApply).toBeUndefined(); // funcția rămâne internă modulului — test prin _doRestore

    expect(blocuri().length).toBe(1);
    expect(document.getElementById('o-benef').value).toBe('SC Veche SRL');
    const rows = globalThis.window.collectOrdDb().rows;
    expect(rows.length).toBe(1);
    expect(rows[0].cod_angajament).toBe('VECHI');
    expect(rows[0].bloc_idx).toBe(0);
  });

  it('10. draft cu 2 blocuri → restaurare cu 2 blocuri și valorile corecte (inclusiv rândurile)', async () => {
    const { draftSave, addBlocOrd, addOR } = globalThis.window;
    addOR(); setRow(lastRow(blocuri()[0]), { cod_angajament: 'B0-R1', receptii: '10,00' });
    const b1 = await addBlocOrd();
    b1.querySelector('[data-fld="beneficiar"]').value = 'SC Doi SRL';
    b1.querySelector('[data-fld="cif_beneficiar"]').value = '20';
    setRow(lastRow(b1), { cod_angajament: 'B1-R1', receptii: '5,00' });
    b1.querySelector('tbody tr').dataset.ctrlIdx = '3';
    draftSave('ordnt');

    // reset total al paginii, apoi restaurare din localStorage
    mountOrdForm();
    globalThis.window.draftLoadIfExists('ordnt');
    globalThis.window._doRestore('ordnt');

    expect(blocuri().length).toBe(2);
    const nb1 = blocuri()[1];
    expect(nb1.querySelector('[data-fld="beneficiar"]').value).toBe('SC Doi SRL');
    expect(nb1.querySelector('[data-fld="cif_beneficiar"]').value).toBe('20');
    expect(nb1.querySelectorAll('tbody tr').length).toBe(1);
    expect(nb1.querySelector('[data-f="cod_angajament"]').value).toBe('B1-R1');
    expect(nb1.querySelector('tbody tr').dataset.ctrlIdx).toBe('3');

    const rows = globalThis.window.collectOrdDb().rows;
    expect(rows.map((r) => [r.cod_angajament, r.bloc_idx])).toEqual([['B0-R1', 0], ['B1-R1', 1]]);
  });
});
