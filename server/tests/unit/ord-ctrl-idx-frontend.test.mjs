// @vitest-environment happy-dom
/**
 * #128g — frontendul ȘTAMPILEAZĂ pointerul către rândul sursă din DF.
 *
 * `onDfSelect` (public/js/formular/list.js) pune `tr.dataset.ctrlIdx` pe fiecare rând
 * pre-populat din `rows_ctrl`; `getOR()` (public/js/formular/core.js) îl citește CONDIȚIONAT
 * și îl trimite ca `ctrl_idx`. Un rând adăugat manual (`addOR()`) rămâne FĂRĂ — serverul cade
 * pe derivarea pozițională, exact ca înainte de lot.
 *
 * Convenția happy-dom + `new Function(src).call(globalThis)` e cea din
 * server/tests/unit/ord-blocuri-frontend.test.mjs (capcană cunoscută: calea se rezolvă cu
 * `dirname(fileURLToPath(import.meta.url))`, nu `new URL('.', import.meta.url)`).
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const coreSrc = readFileSync(join(__dir, '../../../public/js/formular/core.js'), 'utf8');
const listSrc = readFileSync(join(__dir, '../../../public/js/formular/list.js'), 'utf8');

let _dfDoc = null;   // documentul DF întors de fetch-ul din onDfSelect

beforeAll(() => {
  // list.js citește window.df.esc / isoToDMY la încărcare (IIFE) — stub minimal.
  globalThis.window.df = { esc: (s) => String(s ?? ''), isoToDMY: (s) => String(s ?? '') };
  globalThis.ST = { docRole: {}, docStatus: {} };
  // `sv` trăiește în doc.js (nu-l încărcăm aici); `oI` e un `let` de top-level din core.js,
  // care sub `new Function` nu devine global — list.js îl resetează (`oI=0`) în strict mode.
  globalThis.sv = (id, val) => { const e = document.getElementById(id); if (e && val != null) e.value = val; };
  globalThis.oI = 0;
  globalThis.fetch = (url) => {
    if (String(url).includes('/api/formulare-df/')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ document: _dfDoc }) });
    }
    return Promise.reject(new Error('fetch dezactivat în test'));
  };
  new Function(coreSrc).call(globalThis);
  new Function(listSrc).call(globalThis);
});

function domORD() {
  document.body.innerHTML = `
    <div class="status" id="sBar"></div>
    <input id="o-nrUnic"/><input id="o-cif"/><textarea id="o-den"></textarea>
    <input id="o-df-id"/>
    <table><tbody id="o-tbody"></tbody></table>
  `;
  globalThis.window.oI = 0;
  globalThis.oI = 0;
}

const CTRL_ROWS = [
  { cod_angajament: 'A0', indicator_angajament: 'I0', program: 'P0', cod_SSI: 'S0' },
  { cod_angajament: 'A1', indicator_angajament: 'I1', program: 'P1', cod_SSI: 'S1' },
  { cod_angajament: 'A2', indicator_angajament: 'I2', program: 'P2', cod_SSI: 'S2' },
];

beforeEach(() => {
  domORD();
  _dfDoc = { nr_unic_inreg: 'DF-1', cif: '123', den_inst_pb: 'Instituția', rows_ctrl: CTRL_ROWS };
});

describe('#128g — ștampilarea ctrl_idx în frontend', () => {
  it('8. onDfSelect pe un DF cu 3 rânduri rows_ctrl ⇒ dataset.ctrlIdx = "0", "1", "2"', async () => {
    await globalThis.window.onDfSelect('df-uuid');
    const trs = [...document.querySelectorAll('#o-tbody tr')];
    expect(trs).toHaveLength(3);
    expect(trs.map((tr) => tr.dataset.ctrlIdx)).toEqual(['0', '1', '2']);
    // pre-fill-ul de identitate rămâne cel de dinainte
    expect(trs[2].querySelector('[data-f="cod_angajament"]').value).toBe('A2');
  });

  it('9. getOR() întoarce ctrl_idx NUMERIC pe rândurile pre-populate', async () => {
    await globalThis.window.onDfSelect('df-uuid');
    const rows = globalThis.window.getOR();
    expect(rows.map((r) => r.ctrl_idx)).toEqual([0, 1, 2]);
    expect(typeof rows[0].ctrl_idx).toBe('number');
  });

  it('10. ⭐ rând adăugat manual prin addOR() ⇒ FĂRĂ ctrl_idx în obiectul întors', () => {
    globalThis.window.addOR();
    const rows = globalThis.window.getOR();
    expect(rows).toHaveLength(1);
    expect('ctrl_idx' in rows[0]).toBe(false);
  });

  it('11. mix: 3 rânduri din DF + unul manual ⇒ doar primele 3 poartă ctrl_idx', async () => {
    await globalThis.window.onDfSelect('df-uuid');
    globalThis.window.addOR();
    const rows = globalThis.window.getOR();
    expect(rows).toHaveLength(4);
    expect(rows.slice(0, 3).map((r) => r.ctrl_idx)).toEqual([0, 1, 2]);
    expect('ctrl_idx' in rows[3]).toBe(false);
  });

  it('12. DF fără rows_ctrl ⇒ un rând gol (addOR), fără ctrl_idx', async () => {
    _dfDoc = { nr_unic_inreg: 'DF-2', rows_ctrl: [] };
    await globalThis.window.onDfSelect('df-uuid');
    const rows = globalThis.window.getOR();
    expect(rows).toHaveLength(1);
    expect('ctrl_idx' in rows[0]).toBe(false);
  });
});
