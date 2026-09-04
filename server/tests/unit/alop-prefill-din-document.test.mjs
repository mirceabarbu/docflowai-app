/**
 * #176 — dosarul ALOP se află din DOCUMENT, nu din contextul browserului.
 *
 * Analiză statică pe sursele de browser (pe modelul #172b/#174/#175): `main.js` e
 * script clasic, nu modul importabil.
 *
 * ⚠️ Liniile de comentariu `//` se filtrează ÎNAINTE de aserțiuni — comentariile
 * lotului conțin intenționat numele mecanismului retras (lecția #124i/#172/#172b/#173/#175).
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

const bodyOf = (name) => {
  const m = mainSrc.match(new RegExp(`(?:async )?function ${name}\\(\\)\\s*\\{[\\s\\S]*?\\n {6}\\}`));
  expect(m, `corpul ${name} nu a fost izolat`).toBeTruthy();
  return m[0];
};

describe('#176 — dosarul ALOP aflat din document', () => {
  it('1 ⭐ _alopDinDocument citește prefill_doc_id din URL ȘI din sessionStorage', () => {
    const body = bodyOf('_alopDinDocument');
    expect(body, 'lipsește sursa URL').toContain('up.get("prefill_doc_id")');
    expect(body, 'lipsește sursa sessionStorage — calea mkFlow fără context rămâne moartă')
      .toContain('sessionStorage.getItem("docflow_prefill_doc_id")');
    expect(body).toContain('up.get("prefill_doc_type")');
    expect(body).toContain('sessionStorage.getItem("docflow_prefill_doc_type")');
  });

  it('2 ⭐ dezambalează răspunsul `{ ok, document }` — nu presupune obiectul brut', () => {
    const body = bodyOf('_alopDinDocument');
    expect(body).toContain('_j.document');
  });

  it('3 ⭐ source_alop_id are precădere față de alop_id', () => {
    const body = bodyOf('_alopDinDocument');
    const iSrc = body.indexOf('source_alop_id');
    const iAlop = body.indexOf('doc.alop_id');
    expect(iSrc).toBeGreaterThan(-1);
    expect(iAlop).toBeGreaterThan(-1);
    expect(iSrc, 'source_alop_id trebuie evaluat PRIMUL').toBeLessThan(iAlop);
  });

  it('4 _alopPentruPrefill încearcă întâi cheia directă, apoi documentul', () => {
    const body = bodyOf('_alopPentruPrefill');
    const iDirect = body.indexOf('_alopDirect()');
    const iDoc = body.indexOf('_alopDinDocument()');
    expect(iDirect).toBeGreaterThan(-1);
    expect(iDoc).toBeGreaterThan(iDirect);
  });

  it('5 _alopIdDinUrl a dispărut complet din fișier', () => {
    expect(read('public/js/semdoc-initiator/main.js').match(/_alopIdDinUrl/g) || []).toHaveLength(0);
    expect(mainSrc).toContain('const _sursa = await _alopPentruPrefill();');
    expect(mainSrc).toContain('const { alopId, ft } = _sursa;');
  });

  it('6 ruta e /api/formulare-ord pentru ordnt și /api/formulare-df altfel', () => {
    const body = bodyOf('_alopDinDocument');
    expect(body).toContain('"/api/formulare-ord"');
    expect(body).toContain('"/api/formulare-df"');
    expect(body).toMatch(/ft === "ordnt" \? "\/api\/formulare-ord" : "\/api\/formulare-df"/);
  });

  it('7 regresie #172b — garda „Default load" e neschimbată, setDefaults rămâne sub ea', () => {
    const guard = 'if (!_restored && !_prefillPus && !window._alopPrefillApplied) {';
    expect(mainSrc).toContain(guard);
    const iPrefill = mainSrc.indexOf('const _prefillPus = await applyAlopPrefill();');
    const iGuard = mainSrc.indexOf(guard);
    expect(iPrefill).toBeGreaterThan(-1);
    expect(iGuard).toBeGreaterThan(iPrefill);
    expect(mainSrc.slice(iGuard, iGuard + 200)).toContain('setDefaults();');
  });

  it('8 regresie #175 — docflow_prefill_signers apare în public/js exact o dată, ca removeItem', () => {
    const hits = [];
    for (const f of jsFiles('public/js')) {
      const src = stripComments(read(f));
      for (const m of src.matchAll(/sessionStorage\.(\w+)\(["']docflow_prefill_signers/g)) {
        hits.push({ file: f, op: m[1] });
      }
    }
    expect(hits).toHaveLength(1);
    expect(hits[0].op).toBe('removeItem');
  });

  it('9 applyAlopPrefill NU șterge docflow_prefill_doc_id', () => {
    const body = mainSrc.match(/async function applyAlopPrefill\(\)\s*\{[\s\S]*?\n {6}\}/)[0];
    expect(body.match(/removeItem\(["']docflow_prefill_doc_id/g) || []).toHaveLength(0);
    expect(body.match(/removeItem\(["']docflow_prefill_doc_type/g) || []).toHaveLength(0);
  });
});
