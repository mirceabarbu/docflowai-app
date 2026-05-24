/**
 * v3.9.505 (BUG CRITIC) — guard că openDoc resetează state-ul la fetch fail.
 *
 * Test string-match: helper _resetDocStateOnError trebuie să existe și să fie
 * apelat în openDoc înainte de return la !r.ok || !j.ok.
 *
 * Comportament dynamic e testabil doar manual pe staging (deschide doc aprobat,
 * apoi click pe doc fără acces → UI nu mai trebuie să afișeze state-ul vechi).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

describe('openDoc state cleanup la fetch fail (v3.9.505)', () => {
  it('helper _resetDocStateOnError e declarat', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    expect(src).toMatch(/v3\.9\.505 \(BUG CRITIC\)/);
    expect(src).toMatch(/function _resetDocStateOnError\(ft\)/);
  });

  it('helper resetează TOATE state-urile cheie', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    const m = src.match(/function _resetDocStateOnError\(ft\)\s*\{[\s\S]*?\n\}/);
    expect(m, 'corpul helper-ului nu a fost găsit').toBeTruthy();
    const body = m[0];
    // State-uri ST.doc* resetate
    expect(body).toMatch(/ST\.docId\[ft\]\s*=\s*null/);
    expect(body).toMatch(/ST\.docStatus\[ft\]\s*=\s*null/);
    expect(body).toMatch(/ST\.docAprobat\[ft\]\s*=\s*false/);
    expect(body).toMatch(/ST\.docFlowId\[ft\]\s*=\s*null/);
    expect(body).toMatch(/ST\.docRevizieNr\[ft\]\s*=\s*0/);
    expect(body).toMatch(/ST\.docAreRevizieNoua\[ft\]\s*=\s*false/);
    // UI cleanup
    expect(body).toMatch(/setLockedBar\(ft,\s*''\)/);
    expect(body).toMatch(/motiv-bar-/);
    expect(body).toMatch(/banner-an-urmator-/);
    expect(body).toMatch(/actions-/);
    expect(body).toMatch(/docs-list-/);
  });

  it('openDoc apelează _resetDocStateOnError înainte de return la fetch fail', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    // Match blocul if(!r.ok || !j.ok) din openDoc
    const m = src.match(/if\(!r\.ok\|\|!j\.ok\)\s*\{[\s\S]*?return;\s*\}/);
    expect(m, 'blocul if(!r.ok||!j.ok) din openDoc nu e găsit').toBeTruthy();
    const block = m[0];
    expect(block).toMatch(/_resetDocStateOnError\(ft\)/);
    expect(block).toMatch(/setS\(/);
    // Helper-ul trebuie să fie ÎNAINTE de setS (curățăm state, apoi mesaj user)
    const idxReset = block.indexOf('_resetDocStateOnError');
    const idxSetS  = block.indexOf('setS(');
    expect(idxReset).toBeLessThan(idxSetS);
  });

  it('mesajul de eroare include status HTTP pentru debugging', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    expect(src).toMatch(/HTTP \$\{r\.status\}/);
  });

  it('r.json() are .catch pentru răspunsuri non-JSON (ex. 500 cu HTML)', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    // În openDoc trebuie să fie un .catch după r.json() — defensiv
    const m = src.match(/async function openDoc\(ft,\s*id\)\s*\{[\s\S]*?\n\}/);
    expect(m, 'corpul openDoc nu e găsit').toBeTruthy();
    expect(m[0]).toMatch(/r\.json\(\)\.catch/);
  });
});
