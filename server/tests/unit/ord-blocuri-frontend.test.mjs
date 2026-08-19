// @vitest-environment happy-dom
/**
 * #128f — colO()/valF() (public/js/formular/core.js) rezolvă câmpurile blocului beneficiar
 * ORD prin containerul [data-bloc="i"] + [data-fld="..."], nu prin id-uri globale (o-benef,
 * o-cifb, ...). Formularul afișează azi un singur bloc (data-bloc="0" pe #form-ordnt) — id-urile
 * existente rămân neatinse pe câmpurile lui.
 *
 * Convenția happy-dom + `new Function(src).call(globalThis)` e cea din
 * server/tests/unit/pagin-component.test.mjs — scriptul e clasic (fără import), evaluat peste
 * DOM real, apoi comportamentul REAL (window.colO/valF/markEl) e exercitat direct.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// happy-dom substituie global.URL — `new URL('.', import.meta.url)` aruncă TypeError sub el
// (capcană cunoscută din PAGIN-1). Rezolvăm calea direct din import.meta.url.
const __dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dir, '../../../public/js/formular/core.js'), 'utf8');

const ORD_BLOC_FLDS = [
  'nr_unic_inreg', 'beneficiar', 'documente_justificative', 'iban_beneficiar',
  'cif_beneficiar', 'banca_beneficiar', 'inf_pv_plata', 'inf_pv_plata1',
];
const FLD_TAG = {
  nr_unic_inreg: 'input', beneficiar: 'textarea', documente_justificative: 'input',
  iban_beneficiar: 'input', cif_beneficiar: 'input', banca_beneficiar: 'input',
  inf_pv_plata: 'input', inf_pv_plata1: 'input',
};

beforeAll(() => {
  // core.js apelează loadBugetCodes() (fetch către /api/clasa8/buget/coduri) chiar la
  // încărcare — non-fatal (try/catch), dar sub happy-dom fetch-ul real ar încerca o
  // conexiune de rețea reală (ECONNREFUSED, zgomot în output). Stub minimal, local testului.
  globalThis.fetch = () => Promise.reject(new Error('fetch dezactivat în test'));
  new Function(src).call(globalThis);
});

// ── Helpers de construcție DOM ──────────────────────────────────────────────
function baseChrome() {
  // Câmpuri antet ORD (nescopate pe bloc — neatinse de #128f) + status bar (setS scrie în #sBar).
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="status" id="sBar"></div>
    <input id="o-cif" value="12345678"/>
    <textarea id="o-den">Instituția Test</textarea>
    <input id="o-nr" value="7"/>
    <input id="o-data" value="15.08.2026"/>
    <input id="o-adata" value="[]"/>
  `;
  document.body.appendChild(wrap);
}

function makeBloc(idx, vals, rows, { tbodyId, ids } = {}) {
  const div = document.createElement('div');
  div.setAttribute('data-bloc', String(idx));
  for (const fld of ORD_BLOC_FLDS) {
    const el = document.createElement(FLD_TAG[fld]);
    el.setAttribute('data-fld', fld);
    if (ids && ids[fld]) el.id = ids[fld];
    el.value = vals[fld] ?? '';
    div.appendChild(el);
  }
  const table = document.createElement('table');
  const tbody = document.createElement('tbody');
  if (tbodyId) tbody.id = tbodyId;
  (rows || []).forEach((r) => {
    const tr = document.createElement('tr');
    for (const [f, v] of Object.entries(r)) {
      const td = document.createElement('td');
      const inp = document.createElement('input');
      inp.setAttribute('data-f', f);
      inp.value = v;
      td.appendChild(inp);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  div.appendChild(table);
  document.body.appendChild(div);
  return div;
}

const rowA = { cod_angajament: 'AG1', indicator_angajament: 'I1', program: 'P1', cod_SSI: 'S1',
  receptii: '100,00', plati_anterioare: '20,00', suma_ordonantata_plata: '30,00', receptii_neplatite: '50,00' };
const rowB = { cod_angajament: 'AG2', indicator_angajament: 'I2', program: 'P2', cod_SSI: 'S2',
  receptii: '200,00', plati_anterioare: '0,00', suma_ordonantata_plata: '10,00', receptii_neplatite: '190,00' };

const blocValsComplete = {
  nr_unic_inreg: 'NR-001', beneficiar: 'SC Test SRL', documente_justificative: 'Factura 1',
  iban_beneficiar: 'RO49AAAA1234', cif_beneficiar: '19', banca_beneficiar: 'BCR',
  inf_pv_plata: 'info1', inf_pv_plata1: 'info2',
};

// Id-urile de producție (public/formular.html) — RĂMASE pe câmpurile blocului 0 (§2 din prompt).
const PROD_IDS = {
  nr_unic_inreg: 'o-nrUnic', beneficiar: 'o-benef', documente_justificative: 'o-docsj',
  iban_beneficiar: 'o-iban', cif_beneficiar: 'o-cifb', banca_beneficiar: 'o-banca',
  inf_pv_plata: 'o-inf1', inf_pv_plata1: 'o-inf2',
};

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('#128f — colO() rezolvă docFd pe bloc', () => {
  it('1. ⭐ NON-REGRESIE: un singur container [data-bloc="0"] → docFd cu UN element, valori identice cu varianta pe id-uri', () => {
    baseChrome();
    makeBloc(0, blocValsComplete, [rowA, rowB], { tbodyId: 'o-tbody', ids: PROD_IDS });

    // "Varianta pe id-uri" — comportamentul VECHI (g(id)) citea aceste 8 valori direct după
    // id-ul global de producție (o-nrUnic, o-benef, ...), care rămâne pe elementele blocului 0.
    const expectedFromIds = {};
    for (const fld of ORD_BLOC_FLDS) {
      expectedFromIds[fld] = (document.getElementById(PROD_IDS[fld]).value || '').trim();
    }
    const expectedRows = globalThis.window.getOR();

    const out = globalThis.window.colO();
    expect(Array.isArray(out.docFd)).toBe(true);
    expect(out.docFd.length).toBe(1);
    for (const fld of ORD_BLOC_FLDS) {
      expect(out.docFd[0][fld]).toBe(expectedFromIds[fld]);
      expect(expectedFromIds[fld]).toBe(blocValsComplete[fld]);
    }
    expect(out.docFd[0].rowTfd).toEqual(expectedRows);
    expect(out.docFd[0].rowTfd.length).toBe(2);
  });

  it('2. DOUĂ containere [data-bloc] → docFd cu 2 elemente, fiecare cu valorile lui', () => {
    baseChrome();
    const vals0 = blocValsComplete;
    const vals1 = { ...blocValsComplete, nr_unic_inreg: 'NR-002', beneficiar: 'SC Al Doilea SRL',
      cif_beneficiar: '20', iban_beneficiar: 'RO49BBBB5678' };
    makeBloc(0, vals0, [rowA]);
    makeBloc(1, vals1, [rowB]);

    const out = globalThis.window.colO();
    expect(out.docFd.length).toBe(2);
    for (const fld of ORD_BLOC_FLDS) {
      expect(out.docFd[0][fld]).toBe(vals0[fld]);
      expect(out.docFd[1][fld]).toBe(vals1[fld]);
    }
    expect(out.docFd[0].nr_unic_inreg).not.toBe(out.docFd[1].nr_unic_inreg);
  });

  it('3. rowTfd al fiecărui bloc conține DOAR rândurile din containerul lui', () => {
    baseChrome();
    makeBloc(0, blocValsComplete, [rowA]);
    makeBloc(1, blocValsComplete, [rowB, rowB]);

    const out = globalThis.window.colO();
    expect(out.docFd[0].rowTfd.length).toBe(1);
    expect(out.docFd[0].rowTfd[0].cod_angajament).toBe('AG1');
    expect(out.docFd[1].rowTfd.length).toBe(2);
    expect(out.docFd[1].rowTfd.every((r) => r.cod_angajament === 'AG2')).toBe(true);
  });

  it('6. fără niciun [data-bloc] în DOM (regresie de markup) → nu aruncă; docFd = []', () => {
    baseChrome();
    // fără makeBloc() — nicio secțiune [data-bloc] în pagină
    let out;
    expect(() => { out = globalThis.window.colO(); }).not.toThrow();
    expect(out.docFd).toEqual([]);
  });
});

describe('#128f — valF(\'ordnt\') validează pe bloc', () => {
  it('4. bloc incomplet (bloc unic) → valF întoarce false și marchează exact câmpurile lipsă', () => {
    baseChrome();
    const incomplete = { ...blocValsComplete, nr_unic_inreg: '', beneficiar: '', cif_beneficiar: 'abc' };
    makeBloc(0, incomplete, [rowA], { tbodyId: 'o-tbody' });

    const ok = globalThis.window.valF('ordnt');
    expect(ok).toBe(false);

    const el = (fld) => document.querySelector(`[data-fld="${fld}"]`);
    expect(el('nr_unic_inreg').classList.contains('err')).toBe(true);
    expect(el('beneficiar').classList.contains('err')).toBe(true);
    expect(el('cif_beneficiar').classList.contains('err')).toBe(true); // 'abc' nu trece CR
    // câmpurile complete NU sunt marcate
    expect(el('documente_justificative').classList.contains('err')).toBe(false);
    expect(el('iban_beneficiar').classList.contains('err')).toBe(false);
    expect(el('banca_beneficiar').classList.contains('err')).toBe(false);
  });

  it('5. ⭐ două blocuri, al DOILEA incomplet → false, marcarea cade pe câmpul din blocul 2, NU pe omologul din blocul 1', () => {
    baseChrome();
    const bloc1vals = { ...blocValsComplete, nr_unic_inreg: 'NR-INCOMPLET-B2', beneficiar: '' };
    makeBloc(0, blocValsComplete, [rowA]);
    makeBloc(1, bloc1vals, [rowB]);

    const ok = globalThis.window.valF('ordnt');
    expect(ok).toBe(false);

    const containers = document.querySelectorAll('[data-bloc]');
    const benefBloc0 = containers[0].querySelector('[data-fld="beneficiar"]');
    const benefBloc1 = containers[1].querySelector('[data-fld="beneficiar"]');
    expect(benefBloc0.classList.contains('err')).toBe(false); // blocul 1 e complet — rămâne curat
    expect(benefBloc1.classList.contains('err')).toBe(true);  // blocul 2 e incomplet — marcat
  });

  it('valF(\'ordnt\') pe un bloc unic COMPLET + un rând angajament → true', () => {
    baseChrome();
    makeBloc(0, blocValsComplete, [rowA], { tbodyId: 'o-tbody' });
    const ok = globalThis.window.valF('ordnt');
    expect(ok).toBe(true);
  });
});
