/**
 * #175 — prefill-ul ALOP se CERE de la server, nu se cară prin sessionStorage.
 *
 * Analiză statică pe sursele de browser (pe modelul #172b/#174): `main.js` și
 * `alop.js` sunt scripturi clasice, nu module importabile.
 *
 * ⚠️ Liniile de comentariu `//` se filtrează ÎNAINTE de aserțiuni — comentariile
 * lotului conțin intenționat numele mecanismului retras (lecția #124i/#172/#172b/#173).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

const read = (p) => readFileSync(path.join(REPO, p), 'utf8');
/** Sursa fără liniile de comentariu `//` întregi. */
const stripComments = (src) =>
  src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*')).join('\n');

const mainSrc = stripComments(read('public/js/semdoc-initiator/main.js'));
const alopSrc = stripComments(read('public/js/formular/alop.js'));

/** Toate fișierele .js din public/js, recursiv. */
function jsFiles(dir) {
  const out = [];
  for (const name of readdirSync(path.join(REPO, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(path.join(REPO, rel)).isDirectory()) out.push(...jsFiles(rel));
    else if (name.endsWith('.js')) out.push(rel);
  }
  return out;
}

describe('#175 — prefill ALOP citit de la server', () => {
  it('1 ⭐ `docflow_prefill_signers` apare în public/js DOAR ca removeItem', () => {
    const hits = [];
    for (const f of jsFiles('public/js')) {
      const src = stripComments(read(f));
      for (const m of src.matchAll(/sessionStorage\.(\w+)\("?'?docflow_prefill_signers/g)) {
        hits.push({ file: f, op: m[1] });
      }
      expect(src.match(/docflow_prefill_signers/g) || [], `${f}: apariții neașteptate`)
        .toHaveLength((src.match(/removeItem\(["']docflow_prefill_signers/g) || []).length);
    }
    expect(hits.length).toBe(1);
    expect(hits[0].op).toBe('removeItem');
    expect(hits.filter((h) => h.op === 'setItem')).toHaveLength(0);
    expect(hits.filter((h) => h.op === 'getItem')).toHaveLength(0);
  });

  it('2 ⭐ applyAlopPrefill e async și cere dosarul de la /api/alop/', () => {
    expect(mainSrc).toContain('async function applyAlopPrefill()');
    const body = mainSrc.match(/async function applyAlopPrefill\(\)\s*\{[\s\S]*?\n {6}\}/);
    expect(body, 'corpul applyAlopPrefill nu a fost izolat').toBeTruthy();
    expect(body[0]).toContain('/api/alop/');
    expect(body[0]).toContain('_apiFetch');
  });

  it('3 ⭐ ambele locuri de apel folosesc `await applyAlopPrefill()`', () => {
    const awaited = mainSrc.match(/await applyAlopPrefill\(\)/g) || [];
    expect(awaited.length).toBe(2);
    // Exclude declarația (`async function applyAlopPrefill()`) — doar APELURILE contează.
    const bare = mainSrc.match(/(?<!await )(?<!function )\bapplyAlopPrefill\(\)/g) || [];
    expect(bare, 'a rămas un apel fără await').toHaveLength(0);
  });

  // #176 — INTENȚIA rămâne aceeași („fără dosar, niciun apel de rețea pe fluxul normal"),
  // dar mecanismul s-a schimbat: `_alopIdDinUrl` a fost înlocuit de `_alopPentruPrefill`
  // (cheia directă, apoi documentul). Garda din applyAlopPrefill e acum pe rezultatul
  // rezolvării, iar `_alopDinDocument` iese ÎNAINTE de orice fetch când nu există document.
  it('4 fără dosar, applyAlopPrefill iese devreme — niciun apel de rețea pe fluxul normal', () => {
    const body = mainSrc.match(/async function applyAlopPrefill\(\)\s*\{[\s\S]*?\n {6}\}/)[0];
    const idxGuard = body.indexOf('if (!_sursa) return false;');
    const idxFetch = body.indexOf('_apiFetch');
    expect(idxGuard).toBeGreaterThan(-1);
    expect(idxFetch).toBeGreaterThan(idxGuard);
    expect(body).toContain('await _alopPentruPrefill()');

    // Nici rezolvarea din document nu lovește rețeaua fără un id de document.
    const dinDoc = mainSrc.match(/async function _alopDinDocument\(\)\s*\{[\s\S]*?\n {6}\}/)[0];
    const idxDocGuard = dinDoc.indexOf('if (!docId || !dtype) return null;');
    expect(idxDocGuard).toBeGreaterThan(-1);
    expect(dinDoc.indexOf('_apiFetch')).toBeGreaterThan(idxDocGuard);
  });

  it('5 alop.js nu mai conține scriitorul, harta sau cheia de sesiune', () => {
    expect(alopSrc.match(/_alopScriePrefill/g) || []).toHaveLength(0);
    expect(alopSrc.match(/const ALOP_ROL=/g) || []).toHaveLength(0);
    expect(alopSrc.match(/docflow_prefill_signers/g) || []).toHaveLength(0);
  });

  it('6 shared/alop-roluri.js e încărcat FĂRĂ defer, înaintea consumatorului, în ambele pagini', () => {
    for (const [page, consumer] of [
      ['public/semdoc-initiator.html', 'js/semdoc-initiator/main.js'],
      ['public/formular.html', 'js/formular/alop.js'],
    ]) {
      const html = read(page);
      const tag = html.match(/<script src="\/js\/shared\/alop-roluri\.js[^>]*><\/script>/);
      expect(tag, `${page}: scriptul lipsește`).toBeTruthy();
      expect(tag[0], `${page}: nu trebuie să aibă defer`).not.toContain('defer');
      expect(html.indexOf(tag[0])).toBeLessThan(html.indexOf(consumer));
    }
  });

  it('7 _alopLeagaPersoane e chemată din cel puțin două locuri și e idempotentă', () => {
    const calls = mainSrc.match(/_alopLeagaPersoane\(\);/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const body = mainSrc.match(/function _alopLeagaPersoane\(\)\s*\{[\s\S]*?\n {6}\}/);
    expect(body).toBeTruthy();
    expect(body[0], 'lipsește garda pe selecția deja făcută').toContain('sel.value) return');
    expect(body[0]).toContain('data-want-email');
  });

  it('8 ⭐ blocul „Default load" păstrează garda — un dosar necitibil nu lasă tabelul gol', () => {
    expect(mainSrc).toContain(
      'if (!_restored && !_prefillPus && !window._alopPrefillApplied) {'
    );
    const idx = mainSrc.indexOf('const _prefillPus = await applyAlopPrefill();');
    const idxGuard = mainSrc.indexOf('if (!_restored && !_prefillPus && !window._alopPrefillApplied) {');
    expect(idx).toBeGreaterThan(-1);
    expect(idxGuard).toBeGreaterThan(idx);
    expect(mainSrc.slice(idxGuard, idxGuard + 200)).toContain('setDefaults();');
  });
});
