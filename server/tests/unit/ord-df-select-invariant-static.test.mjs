/**
 * #167 — analiză STATICĂ a formei invariantului select⟷hidden (fără DOM).
 *
 * Tiparul din admin-cancel-ui.test.mjs: citim sursa și verificăm FORMA, nu comportamentul.
 * Testul apără trei decizii de arhitectură pe care un refactor le poate rupe tăcut:
 *
 *  - randarea lui #o-df-sel are UN SINGUR loc (`_renderDfSelect` în list.js) — altfel
 *    invariantul poate fi ocolit de o a doua scriere de innerHTML;
 *  - `alop.js` (ORD NOU) NU cheamă `_renderDfSelect`: acolo nu există fapt istoric de protejat,
 *    iar o opțiune inventată ar lega tăcut o ordonanțare de un DF NEAPROBAT;
 *  - în `doc.js`, hidden-ul se scrie ÎNAINTEA randării (funcția citește din el).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dir, '../../../public/js/formular/', p), 'utf8');
const count = (src, re) => (src.match(re) || []).length;

describe('#167 — forma invariantului (analiză statică)', () => {
  it('1) alop.js verifică prezența opțiunii înainte de s.value= — de EXACT două ori', () => {
    const src = read('alop.js');
    expect(count(src, /!\[\.\.\.s\.options\]\.some\(o=>o\.value===/g)).toBe(2);
    // câte una în alopDeschideORD și alopGoToORD
    expect(count(src, /o\.value===alop\.df_id/g)).toBe(1);
    expect(count(src, /o\.value===dfId/g)).toBe(1);
  });

  it('2) ⭐ alop.js NU apelează _renderDfSelect nicăieri (ORD nou ⇒ fără opțiune inventată)', () => {
    expect(count(read('alop.js'), /_renderDfSelect/g)).toBe(0);
  });

  it('3) ⭐ doc.js apelează _renderDfSelect de exact 2 ori, cu scrierea hidden-ului ÎNAINTE', () => {
    const src = read('doc.js');
    const lines = src.split('\n');
    const idx = lines.reduce((a, l, i) => (l.includes('_renderDfSelect(') ? [...a, i] : a), []);
    expect(idx).toHaveLength(2);
    for (const i of idx) {
      // linia imediat precedentă scrie #o-df-id
      expect(lines[i - 1]).toMatch(/getElementById\('o-df-id'\)/);
      expect(lines[i - 1]).toMatch(/dfId\.value=/);
    }
  });

  // Promptul #167 cerea `sel.innerHTML=` de EXACT o dată în list.js; în realitate sunt două,
  // iar a doua e PREEXISTENTĂ și fără legătură: `_populateCompartimente` randează filtrul
  // `#flt-comp`. Contorul brut era deja 2 înainte de acest lot. Aserția utilă e cea care spune
  // ce înseamnă de fapt regula: singura scriere care țintește #o-df-sel e cea din _renderDfSelect.
  it('4) ⭐ randarea lui #o-df-sel are UN SINGUR loc: _renderDfSelect', () => {
    const src = read('list.js');
    const start = src.indexOf('function _renderDfSelect(');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\n}', start);
    const corp = src.slice(start, end);
    expect(corp).toContain('sel.innerHTML=');

    // orice ALTĂ scriere de innerHTML din fișier nu are #o-df-sel în raza ei
    const restul = src.slice(0, start) + src.slice(end);
    for (const m of restul.split('\n').filter((l) => /\.innerHTML\s*=/.test(l))) {
      expect(m).not.toContain('o-df-sel');
    }
    // #o-df-sel se rezolvă prin getElementById într-un singur loc care apoi îl randează
    expect(count(corp, /getElementById\('o-df-sel'\)/g)).toBe(1);
  });
});
