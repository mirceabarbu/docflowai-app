// @vitest-environment happy-dom
/**
 * #220 — chip-ul „DF aprobat" din formularul ORD (public/js/formular/doc.js) + linkul de
 * previzualizare din antetul dosarului ALOP (public/js/formular/alop.js).
 *
 * Convenția happy-dom + `new Function(src).call(globalThis)` e cea din
 * server/tests/unit/ord-list-valoare-plata-frontend.test.mjs / ord-bloc-paritate.test.mjs.
 * Ordinea de încărcare replică pagina: df-api.js, file-item.js (chip-ul), core.js, doc.js, list.js.
 *
 * Stub-uri: `fetch` (respins), `setInterval` (neutralizat la încărcarea doc.js), `window.df.esc`
 * (identitate — furnizat de core.js dacă lipsește), `window.openAttPreview` (spion).
 *
 * Cazuri:
 *  12 ⭐ ORD salvat cu df_aprobat_semnat:true ⇒ chip cu „DF <nr> R<rev>", Previzualizează,
 *        Descarcă spre /api/formulare-ord/<id>/df-aprobat.pdf, FĂRĂ Șterge
 *  13 ⭐ click Previzualizează ⇒ window.openAttPreview(url rutei noi, ..., 'application/pdf')
 *  14 ⭐ decizia 3: după schimbarea `o-df-sel` (selectDfAprobat) chip-ul e gol
 *  15    df_aprobat_semnat:false ⇒ chip gol
 *  16    static: alop.js are linkul condiționat de df_revizie_vigoare_flow_id + previewDfVigoare pe window
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const PUB = join(__dir, '../../../public/');
const read = (p) => readFileSync(join(PUB, p), 'utf8');

const alopSrc = read('js/formular/alop.js');
const docSrc  = read('js/formular/doc.js');
const htmlSrc = read('formular.html');

beforeAll(() => {
  globalThis.fetch = () => Promise.reject(new Error('fetch dezactivat la încărcare'));
  globalThis.window.df = globalThis.window.df || {};
  globalThis.window.df.esc = globalThis.window.df.esc || ((s) => String(s ?? ''));
  new Function(read('js/shared/df-api.js')).call(globalThis);
  new Function(read('js/shared/file-item.js')).call(globalThis);
  new Function(read('js/formular/core.js')).call(globalThis);
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  try { new Function(docSrc).call(globalThis); } finally { globalThis.setInterval = realSetInterval; }
  new Function(read('js/formular/list.js')).call(globalThis);
});

function mount() {
  document.body.innerHTML = `
    <div class="status" id="sBar"></div>
    <div id="form-ordnt">
      <input id="o-nrUnic" type="hidden" value=""/>
      <select id="o-df-sel"><option value="">—</option><option value="df-1">DF-1</option><option value="df-2">DF-2</option></select>
      <input type="hidden" id="o-df-id" value=""/>
      <div id="o-df-aprobat-chip"></div>
      <div id="o-tbody"></div>
    </div>`;
  globalThis.ST = globalThis.ST || {};
  globalThis.ST.docId = { ordnt: null, notafd: null };
  globalThis.ST.docRole = {}; globalThis.ST.docStatus = {};
  globalThis.window.oI = 0;
}

// Starea „salvată" se setează prin `window._setOrdDfSalvat(doc)` (seam de test, ca `_attIds`),
// exact ce face populateOrd la încărcarea documentului; hidden-ul + ST.docId le setează testul.
describe('#220 — chip „DF aprobat" (doc.js)', () => {
  beforeEach(mount);

  const ORD = { id: 'ord-9', df_id: 'df-1', df_nr: 'DF-2026-17', df_revizie_nr: 2, df_aprobat_semnat: true };

  it('12 ⭐ ORD salvat cu DF aprobat ⇒ chip cu nume, Previzualizează, Descarcă, fără Șterge', () => {
    expect(typeof window.renderOrdDfAprobatChip).toBe('function');
    expect(typeof window.previewOrdDfAprobat).toBe('function');
    globalThis.ST.docId.ordnt = ORD.id;
    document.getElementById('o-df-id').value = ORD.df_id;
    window._setOrdDfSalvat(ORD);
    window.renderOrdDfAprobatChip();
    const host = document.getElementById('o-df-aprobat-chip');
    expect(host.innerHTML).toContain('DF DF-2026-17 R2');
    expect(host.innerHTML).toContain('Previzualizează');
    expect(host.innerHTML).toContain('Descarcă');
    expect(host.innerHTML).toContain('href="/api/formulare-ord/ord-9/df-aprobat.pdf"');
    expect(host.innerHTML).not.toContain('Șterge');
    expect(host.querySelector('.df-file-item')).not.toBeNull();
  });

  it('13 ⭐ click Previzualizează ⇒ openAttPreview cu URL-ul rutei noi și application/pdf', () => {
    globalThis.ST.docId.ordnt = ORD.id;
    document.getElementById('o-df-id').value = ORD.df_id;
    window._setOrdDfSalvat(ORD);
    window.renderOrdDfAprobatChip();
    const spy = vi.fn();
    window.openAttPreview = spy;
    const a = document.querySelector('#o-df-aprobat-chip a[onclick]');
    expect(a).not.toBeNull();
    expect(a.getAttribute('onclick')).toContain('previewOrdDfAprobat()');
    window.previewOrdDfAprobat();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('/api/formulare-ord/ord-9/df-aprobat.pdf');
    expect(spy.mock.calls[0][1]).toContain('DF DF-2026-17 R2');
    expect(spy.mock.calls[0][2]).toBe('application/pdf');
  });

  it('14 ⭐ decizia 3: schimbarea DF-ului din listă (selectDfAprobat) golește chip-ul', async () => {
    globalThis.ST.docId.ordnt = ORD.id;
    document.getElementById('o-df-id').value = ORD.df_id;
    document.getElementById('o-df-sel').value = ORD.df_id;
    window._setOrdDfSalvat(ORD);
    window.renderOrdDfAprobatChip();
    expect(document.getElementById('o-df-aprobat-chip').innerHTML).not.toBe('');

    document.getElementById('o-df-sel').value = 'df-2';
    // fetch e respins ⇒ onDfSelect se oprește în try/catch; chip-ul e re-randat ÎNAINTE.
    await window.selectDfAprobat().catch(() => {});
    expect(document.getElementById('o-df-id').value).toBe('df-2');
    expect(document.getElementById('o-df-aprobat-chip').innerHTML).toBe('');
  });

  it('15 df_aprobat_semnat:false ⇒ chip gol', () => {
    globalThis.ST.docId.ordnt = ORD.id;
    document.getElementById('o-df-id').value = ORD.df_id;
    window._setOrdDfSalvat({ ...ORD, df_aprobat_semnat: false });
    window.renderOrdDfAprobatChip();
    expect(document.getElementById('o-df-aprobat-chip').innerHTML).toBe('');
  });

  it('15b ORD nou (ST.docId.ordnt null) ⇒ chip gol chiar dacă starea salvată există', () => {
    globalThis.ST.docId.ordnt = ORD.id;
    document.getElementById('o-df-id').value = ORD.df_id;
    window._setOrdDfSalvat(ORD);
    window.renderOrdDfAprobatChip();
    expect(document.getElementById('o-df-aprobat-chip').innerHTML).not.toBe('');
    globalThis.ST.docId.ordnt = null;
    document.getElementById('o-df-id').value = '';
    window.renderOrdDfAprobatChip();
    expect(document.getElementById('o-df-aprobat-chip').innerHTML).toBe('');
  });

  it('gazda #o-df-aprobat-chip există în formular.html, sub hidden-ul o-df-id', () => {
    const i1 = htmlSrc.indexOf('id="o-df-id"');
    const i2 = htmlSrc.indexOf('id="o-df-aprobat-chip"');
    expect(i1).toBeGreaterThan(-1);
    expect(i2).toBeGreaterThan(i1);
  });

  it('newDoc(ordnt) golește chip-ul (SPA — documentul precedent nu persistă)', () => {
    const src = docSrc.slice(docSrc.indexOf('function newDoc('), docSrc.indexOf('function newDoc(') + 4000);
    expect(src).toContain('renderOrdDfAprobatChip()');
  });
});

describe('#220 — antetul dosarului ALOP (alop.js, static)', () => {
  it('16 linkul de previzualizare e condiționat de df_revizie_vigoare_flow_id și cheamă previewDfVigoare', () => {
    expect(alopSrc).toContain('a.df_revizie_vigoare_flow_id');
    const idx = alopSrc.indexOf("previewDfVigoare('");
    expect(idx).toBeGreaterThan(-1);
    const around = alopSrc.slice(Math.max(0, idx - 400), idx);
    expect(around).toContain('df_revizie_vigoare_flow_id');
    expect(around).toContain('Previzualizează');
  });

  it('16b previewDfVigoare e expusă pe window și folosește ruta existentă /flows/:id/signed-pdf', () => {
    expect(alopSrc).toMatch(/window\.previewDfVigoare\s*=\s*previewDfVigoare/);
    const fn = alopSrc.slice(alopSrc.indexOf('function previewDfVigoare('));
    expect(fn.slice(0, 600)).toContain('/signed-pdf');
    expect(fn.slice(0, 600)).toContain('openAttPreview');
  });
});
