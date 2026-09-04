/**
 * #177 — „Renunță" rupe și LEGĂTURA CU DOCUMENTUL, nu doar PDF-ul.
 *
 * Analiză statică pe `public/js/semdoc-initiator/main.js` (pe modelul
 * #172b/#174/#175/#176): script clasic, nu modul importabil.
 *
 * ⚠️ Liniile de comentariu `//` se filtrează ÎNAINTE de aserțiuni — comentariul
 * din lot conține intenționat numele cheilor și ar auto-potrivi numărătorile
 * (lecția #124i/#172/#172b/#173/#175).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

const read = (p) => readFileSync(path.join(REPO, p), 'utf8');
/** Sursa fără liniile de comentariu `//` întregi. */
const stripComments = (src) =>
  src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*')).join('\n');

const rawSrc = read('public/js/semdoc-initiator/main.js');
const mainSrc = stripComments(rawSrc);

const bodyOf = (name) => {
  const m = mainSrc.match(new RegExp(`(?:async )?function ${name}\\(\\)\\s*\\{[\\s\\S]*?\\n {6}\\}`));
  expect(m, `corpul ${name} nu a fost izolat`).toBeTruthy();
  return m[0];
};

describe('#177 — „Renunță" rupe și legătura cu documentul', () => {
  it('1 ⭐ _rupeLegaturaDocument șterge din sessionStorage toate cele trei chei', () => {
    const body = bodyOf('_rupeLegaturaDocument');
    expect(body).toContain('sessionStorage.removeItem("docflow_prefill_doc_id")');
    expect(body).toContain('sessionStorage.removeItem("docflow_prefill_doc_type")');
    expect(body).toContain('sessionStorage.removeItem("alop_id_for_flow")');
  });

  it('2 ⭐ curăță URL-ul cu history.replaceState și elimină toți cei cinci parametri', () => {
    const body = bodyOf('_rupeLegaturaDocument');
    expect(body).toContain('history.replaceState(');
    expect(body).toMatch(/\["action", "prefill_doc_id", "prefill_doc_type", "alop_id", "alop_doc_type"\]/);
  });

  it('3 ⭐ handler-ul „Renunță" apelează _rupeLegaturaDocument()', () => {
    const m = mainSrc.match(/\$\("btnRenunta"\)\.addEventListener\("click", \(\) => \{[\s\S]*?\n {6}\}\);/);
    expect(m, 'handlerul btnRenunta nu a fost izolat').toBeTruthy();
    expect(m[0]).toContain('_rupeLegaturaDocument();');
  });

  it('4 ascunde #formAttachPreview (style.display = "none")', () => {
    const body = bodyOf('_rupeLegaturaDocument');
    expect(body).toContain('$("formAttachPreview")');
    expect(body).toContain('_fa.style.display = "none"');
  });

  it('5 regresie — blocul meta citește dfId/ordId din prefill_doc_id/docflow_prefill_doc_id', () => {
    expect(mainSrc).toContain('m.dfId');
    expect(mainSrc).toContain('m.ordId');
    expect(mainSrc).toContain('prefill_doc_id');
    expect(mainSrc).toContain('docflow_prefill_doc_id');
  });

  it('6 regresie — ștergerile de după creare rămân intacte (contor total = 2)', () => {
    const hits = mainSrc.match(/removeItem\("docflow_prefill_doc_id"\)/g) || [];
    expect(hits).toHaveLength(2);
    expect(mainSrc).toContain('sessionStorage.removeItem("alop_id_for_flow")');
    const alopHits = mainSrc.match(/removeItem\("alop_id_for_flow"\)/g) || [];
    expect(alopHits).toHaveLength(2);
  });

  it('7 regresie — handler-ul păstrează setDefaults/autoFillFromProfile/validateForm în ordine', () => {
    const m = mainSrc.match(/\$\("btnRenunta"\)\.addEventListener\("click", \(\) => \{[\s\S]*?\n {6}\}\);/);
    expect(m).toBeTruthy();
    const body = m[0];
    const iSet = body.indexOf('setDefaults();');
    const iAuto = body.indexOf('autoFillFromProfile(');
    const iVal = body.indexOf('validateForm(');
    expect(iSet).toBeGreaterThan(-1);
    expect(iAuto).toBeGreaterThan(iSet);
    expect(iVal).toBeGreaterThan(iAuto);
  });

  it('8 window._alopPrefillApplied NU e resetat în handler-ul btnRenunta', () => {
    const m = mainSrc.match(/\$\("btnRenunta"\)\.addEventListener\("click", \(\) => \{[\s\S]*?\n {6}\}\);/);
    expect(m).toBeTruthy();
    expect(m[0]).not.toContain('_alopPrefillApplied');
  });
});
