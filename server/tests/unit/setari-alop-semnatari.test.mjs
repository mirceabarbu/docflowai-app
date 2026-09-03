/**
 * #173 Etapa C+D — analiză statică pe ecranul de configurare a semnatarilor
 * impliciți și pe prefill-ul din `formular/alop.js`.
 *
 * ⚠️ Comentariile se elimină ÎNAINTE de aserțiuni (lecția #124i/#172/#172b):
 * altfel un `// … lichidare_sablon …` explicativ ar face testul verde pe un cod
 * care nu trimite câmpul.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p) => readFileSync(resolve(process.cwd(), p), 'utf8');
/** Elimină comentariile de linie și de bloc, păstrând poziția relativă a codului. */
const faraComentarii = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const HTML = read('public/setari.html');
const JS   = faraComentarii(read('public/js/setari/alop-semnatari.js'));

describe('#173 C — setari.html încarcă scripturile în ordinea corectă', () => {
  it('1. atribute.js FĂRĂ defer, alop-semnatari.js CU defer, atribute.js ÎNAINTE', () => {
    const mAtrib = HTML.match(/<script src="\/js\/shared\/atribute\.js\?v=[^"]+"([^>]*)>/);
    const mSem   = HTML.match(/<script src="\/js\/setari\/alop-semnatari\.js\?v=[^"]+"([^>]*)>/);
    expect(mAtrib, 'shared/atribute.js nu e încărcat în setari.html').toBeTruthy();
    expect(mSem, 'setari/alop-semnatari.js nu e încărcat în setari.html').toBeTruthy();

    expect(mAtrib[1]).not.toMatch(/\bdefer\b/);   // trebuie să expună DFAtribute sincron
    expect(mSem[1]).toMatch(/\bdefer\b/);
    expect(HTML.indexOf(mAtrib[0])).toBeLessThan(HTML.indexOf(mSem[0]));
  });

  it('secțiunea există, e ascunsă implicit și are ambele tabele', () => {
    expect(HTML).toMatch(/id="alop-sem-section"[^>]*style="display:none;/);
    expect(HTML).toContain('id="alop-sem-df-body"');
    expect(HTML).toContain('id="alop-sem-ord-body"');
    expect(HTML).toContain('id="alop-sem-save"');
  });
});

describe('#173 C — alop-semnatari.js', () => {
  it('2. gate-ul de vizibilitate acceptă admin ȘI org_admin (ca ruta)', () => {
    expect(JS).toMatch(/role\s*===\s*'admin'/);
    expect(JS).toMatch(/role\s*===\s*'org_admin'/);
    expect(JS).toContain('/auth/me');
  });

  it('3. payload-ul de salvare conține lichidare_sablon — nu poate fi omis tăcut', () => {
    const m = JS.match(/JSON\.stringify\(\{([\s\S]*?)\}\)/);
    expect(m, 'nu s-a găsit corpul POST-ului').toBeTruthy();
    expect(m[1]).toContain('lichidare_sablon');
    expect(m[1]).toContain('df_semnatari_sablon');
    expect(m[1]).toContain('ord_semnatari_sablon');
    // ...și e citit din GET, nu inventat gol la fiecare salvare.
    expect(JS).toMatch(/_lichidareSablon\s*=\s*s\.lichidare_sablon/);
  });

  it('4. santinela __alt__ e EXCLUSĂ din atributele oferite (nu e un atribut)', () => {
    const m = JS.match(/function atributeList\(\)\s*\{([\s\S]*?)\n {2}\}/);
    expect(m, 'atributeList nu a fost găsită').toBeTruthy();
    expect(m[1]).toMatch(/a\s*!==\s*'__alt__'/);
  });

  it('trimite CSRF pe POST și nu folosește localStorage/sessionStorage', () => {
    expect(JS).toContain('x-csrf-token');
    expect(JS).not.toMatch(/\b(localStorage|sessionStorage)\b/);
  });
});

describe('#173 D — prefill-ul respectă atributul configurat pe rol', () => {
  // #175 — precedența s-a mutat din `public/js/formular/alop.js` (unde trăia ca expresia
  // `s.atribut||ALOP_ROL[s.role]`) în `DFAlopRoluri.atribut()` din
  // `public/js/shared/alop-roluri.js`, ca să fie accesibilă și lui `semdoc-initiator`.
  // GARANȚIA e aceeași: atributul salvat explicit pe rol (rol PERSONALIZAT) bate harta
  // implicită, deci nu cade pe „SEMNAT" pe un document financiar. Se schimbă fișierul
  // din care se citește, nu ce se verifică.
  it('shared/alop-roluri.js folosește s.atribut înaintea hărții ROL_ATRIBUT[s.role]', () => {
    const src = faraComentarii(read('public/js/shared/alop-roluri.js'));
    const fn = src.match(/atribut:\s*function \(s\) \{([\s\S]*?)\n {4}\}/);
    expect(fn, 'funcția atribut() nu a fost găsită').toBeTruthy();
    const idxAtribut = fn[1].indexOf("s.atribut");
    const idxHarta = fn[1].indexOf('ROL_ATRIBUT[s.role]');
    expect(idxAtribut).toBeGreaterThan(-1);
    expect(idxHarta).toBeGreaterThan(-1);
    expect(idxAtribut, 's.atribut trebuie consultat ÎNAINTEA hărții').toBeLessThan(idxHarta);
    expect(fn[1]).toMatch(/return s\.atribut\.trim\(\);/);
  });
});
