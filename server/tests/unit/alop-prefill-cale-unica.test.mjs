/**
 * #174 → REORIENTAT la #175.
 *
 * Testul păzea o cale unică de SCRIERE a prefill-ului din `alop.js` prin
 * sessionStorage (`_alopScriePrefill`, `ALOP_ROL`, cheia `docflow_prefill_signers`).
 * #175 a ÎNLOCUIT mecanismul: ecranul de flux CERE semnatarii de la server
 * (`GET /api/alop/:id`) pe baza lui `alop_id` din URL, prezent pe toate cele trei
 * căi de lansare. Nu mai există nimic de scris, deci nici o cale de scriere de păzit.
 *
 * Aserțiunile devin invariantul noii arhitecturi, mai TARE decât cel vechi:
 * `alop.js` nu mai scrie prefill DELOC. Cazul 8 (previzualizarea din card) rămâne
 * neschimbat — e regresia pe care lotul NU are voie s-o atingă.
 *
 * ⚠️ Filtrăm liniile de comentariu înainte de a număra (lecția #124i/#172/#172b/#173).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

const alopSrc = readFileSync(path.join(REPO, 'public/js/formular/alop.js'), 'utf8');

/** Sursa fără liniile de comentariu `//` (întregi, fără să atingă expresii inline). */
const codeSrc = alopSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

describe('#175 — alop.js nu mai scrie prefill de semnatari', () => {
  it('1 ⭐ `docflow_prefill_signers` a dispărut complet din alop.js', () => {
    const matches = codeSrc.match(/docflow_prefill_signers/g) || [];
    expect(matches.length).toBe(0);
  });

  it('2 ⭐ `_alopScriePrefill` nu mai există — nici definiție, nici apel, nici export', () => {
    const matches = codeSrc.match(/_alopScriePrefill/g) || [];
    expect(matches.length).toBe(0);
  });

  it('3 ⭐ harta `const ALOP_ROL=` s-a mutat în shared/alop-roluri.js', () => {
    const matches = codeSrc.match(/const ALOP_ROL=/g) || [];
    expect(matches.length).toBe(0);
  });

  it('4 alopLaunchDfFlow navighează cu alop_id + alop_doc_type=notafd în URL', () => {
    const fnBody = codeSrc.match(/async function alopLaunchDfFlow\([^)]*\)\s*\{[\s\S]*?\n\}/);
    expect(fnBody).toBeTruthy();
    expect(fnBody[0]).toContain("'&alop_id=' + encodeURIComponent(alopId)");
    expect(fnBody[0]).toContain("alop_doc_type=notafd");
  });

  it('5 alopLaunchOrdFlow navighează cu alop_id + alop_doc_type=ordnt în URL', () => {
    const fnBody = codeSrc.match(/async function alopLaunchOrdFlow\([^)]*\)\s*\{[\s\S]*?\n\}/);
    expect(fnBody).toBeTruthy();
    expect(fnBody[0]).toContain("'&alop_id=' + encodeURIComponent(alopId)");
    expect(fnBody[0]).toContain("alop_doc_type=ordnt");
  });

  it('6 patch-ul mkFlow păstrează rezerva alop_id_for_flow și nu construiește semnatari', () => {
    const fnBody = codeSrc.match(/window\.mkFlow=function\(ft\)\s*\{[\s\S]*?\n {2}\};/);
    expect(fnBody).toBeTruthy();
    expect(fnBody[0]).toContain("sessionStorage.setItem('alop_id_for_flow'");
    expect(fnBody[0]).not.toContain('prefillSigners');
  });

  it('7 harta rol→atribut există în public/js/shared/alop-roluri.js', () => {
    const shared = readFileSync(path.join(REPO, 'public/js/shared/alop-roluri.js'), 'utf8');
    expect(shared).toContain('var ROL_ATRIBUT');
    expect(shared).toContain('window.DFAlopRoluri');
  });

  it('8 regresie: filter(u=>u.user_id||u.same_as_initiator) (previzualizarea din card) există în continuare, exact 1 dată', () => {
    const matches = codeSrc.match(/filter\(u=>u\.user_id\|\|u\.same_as_initiator\)/g) || [];
    expect(matches.length).toBe(1);
  });
});
