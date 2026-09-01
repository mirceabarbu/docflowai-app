// @vitest-environment happy-dom
/**
 * #167 — INVARIANTUL select⟷hidden pe referința DF a unei ordonanțări.
 *
 * Din #167, GET /api/formulare-df/aprobate întoarce DOAR DF-uri cu aprobarea VIE. Un ORD deja
 * salvat poate purta un `df_id` a cărui aprobare s-a desfăcut ulterior (flux anulat, refuzat sau
 * șters) — legătura aia e un FAPT ISTORIC. Fără opțiunea „lipicioasă", selectul ar rămâne gol și
 * validarea de la completare (care citește SELECTUL, nu hidden-ul) ar bloca fals documentul.
 *
 * Se exercită codul REAL din public/js/formular/list.js (`_renderDfSelect`), nu o reimplementare.
 * Model: ord-bloc-comportamente-vii.test.mjs.
 *
 * ⛔ Afirmația centrală (cazul 6): `_renderDfSelect` NU scrie NICIODATĂ în #o-df-id — hidden-ul
 *    rămâne singura sursă de adevăr pentru ce se salvează.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
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
    <select id="o-df-sel"></select>
    <input type="hidden" id="o-df-id" value=""/>
    <div id="ord-blocuri"></div>
  </div></div>`;

const LISTA = [
  { id: 'df-a', nr_unic_inreg: 'DF-100', subtitlu_df: 'Achiziție birotică', revizie_nr: 0 },
  { id: 'df-b', nr_unic_inreg: 'DF-200', subtitlu_df: null, revizie_nr: 2 },
];

const sel = () => document.getElementById('o-df-sel');
const hidden = () => document.getElementById('o-df-id');
const opts = () => [...sel().options];
const sticky = () => opts().filter((o) => o.dataset.aprobat === '0');

// Alimentează `_dfAprobate` (privat în list.js) exact pe calea de producție: fetch pe rută.
const loadLista = async (documents) => {
  globalThis.fetch = () => Promise.resolve({
    ok: true, status: 200, json: () => Promise.resolve({ ok: true, documents }),
  });
  await window.loadDfAprobate();
};

beforeAll(() => {
  globalThis.fetch = () => Promise.reject(new Error('fetch nesetat'));
  document.body.innerHTML = SHELL;
  globalThis.esc = escHtml;
  window.df = Object.assign({}, window.df, {
    esc: escHtml, isoToDMY: (s) => s, getCsrf: () => 'csrf-test',
  });
  window.ST = { docId: {}, mode: {} };
  new Function(read('core.js')).call(globalThis);
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  try { new Function(read('doc.js')).call(globalThis); } finally { globalThis.setInterval = realSetInterval; }
  new Function(read('list.js')).call(globalThis);
});

beforeEach(async () => {
  document.body.innerHTML = SHELL;
  await loadLista(LISTA);        // reîncarcă lista ȘI resetează selectul proaspăt montat
  window._renderDfSelect('');    // resetează eticheta lipicioasă reținută de la testul precedent
});

describe('#167 — invariant #o-df-sel ⟷ #o-df-id', () => {
  it('1) ⭐ hidden cu id ABSENT din listă ⇒ opțiune lipicioasă, selectată, marcată', () => {
    hidden().value = 'df-mort';
    window._renderDfSelect('DF 999');

    const o = opts().find((x) => x.value === 'df-mort');
    expect(o).toBeTruthy();
    expect(sel().value).toBe('df-mort');
    expect(o.dataset.aprobat).toBe('0');
    expect(o.textContent).toContain('aprobare desfăcută');
    expect(o.textContent).toContain('DF 999');
  });

  it('2) ⭐ idempotență: două randări ⇒ O SINGURĂ opțiune lipicioasă', () => {
    hidden().value = 'df-mort';
    window._renderDfSelect('DF 999');
    window._renderDfSelect();

    expect(sticky()).toHaveLength(1);
    expect(opts().filter((o) => o.value === 'df-mort')).toHaveLength(1);
    expect(sel().value).toBe('df-mort');
  });

  it('3) ⭐ cursa R3: o randare întârziată NU pierde selecția din hidden', async () => {
    hidden().value = 'df-mort';
    window._renderDfSelect('DF 999');
    expect(sel().value).toBe('df-mort');

    // loadDfAprobate() de la init (fire-and-forget) sosește DUPĂ populateOrd și rescrie lista.
    await loadLista(LISTA);
    expect(sel().value).toBe('df-mort');
    expect(sticky()).toHaveLength(1);
  });

  it('4) hidden gol ⇒ nicio opțiune lipicioasă, value gol, exact 1 + lungimea listei opțiuni', () => {
    hidden().value = '';
    window._renderDfSelect('');

    expect(sticky()).toHaveLength(0);
    expect(sel().value).toBe('');
    expect(opts()).toHaveLength(1 + LISTA.length);
  });

  it('5) ⭐ hidden cu id PREZENT în listă ⇒ nicio dublură, opțiunea normală e selectată', () => {
    hidden().value = 'df-b';
    window._renderDfSelect('DF 200');

    expect(sticky()).toHaveLength(0);
    expect(opts().filter((o) => o.value === 'df-b')).toHaveLength(1);
    expect(opts()).toHaveLength(1 + LISTA.length);
    expect(sel().value).toBe('df-b');
    expect(sel().selectedOptions[0].textContent).toContain('DF-200');
  });

  it('6) ⭐ #o-df-id nu e scris NICIODATĂ de _renderDfSelect', async () => {
    for (const v of ['df-mort', '', 'df-b']) {
      hidden().value = v;
      const inainte = hidden().value;
      window._renderDfSelect('DF etichetă');
      expect(hidden().value).toBe(inainte);
      await loadLista(LISTA);            // și pe calea de randare din fetch
      expect(hidden().value).toBe(inainte);
    }
  });

  it('7) eticheta reținută se resetează la document NOU', () => {
    hidden().value = 'df-mort';
    window._renderDfSelect('DF 123');
    expect(opts().find((o) => o.value === 'df-mort').textContent).toContain('DF 123');

    // newDoc: hidden golit + _renderDfSelect('') ⇒ nicio lipicioasă, eticheta uitată.
    hidden().value = '';
    window._renderDfSelect('');
    expect(sticky()).toHaveLength(0);

    // o randare ulterioară cu alt hidden mort nu mai poartă eticheta veche
    hidden().value = 'df-alt-mort';
    window._renderDfSelect();
    const o = opts().find((x) => x.value === 'df-alt-mort');
    expect(o.textContent).not.toContain('DF 123');
    expect(o.textContent).toContain('DF legat');
  });
});
