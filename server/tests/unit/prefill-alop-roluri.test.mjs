/**
 * #172 — prefill ALOP trimite setul complet de roluri + garda pe semnatari completați.
 *
 * Nu există harness DOM pentru alop.js/main.js în repo — analiză statică pe sursă
 * (grep pe forme exacte), pe modelul reopen-button-render.test.mjs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

const alopSrc = readFileSync(path.join(REPO, 'public/js/formular/alop.js'), 'utf8');
const mainSrc = readFileSync(path.join(REPO, 'public/js/semdoc-initiator/main.js'), 'utf8');
const atribSrc = readFileSync(path.join(REPO, 'public/js/shared/atribute.js'), 'utf8');

describe('#172 prefill ALOP — set complet de roluri + gardă la lansare', () => {
  it('1 ⭐ mkFlow NU mai filtrează prefill-ul pe user_id/same_as_initiator', () => {
    // Sursa conține fraza în comentariul explicativ (#172) — verificăm forma FUNCȚIONALĂ,
    // adică prezența ei în afara liniilor de comentariu.
    const codeLines = alopSrc.split('\n').filter(l => !l.trim().startsWith('//'));
    expect(codeLines.join('\n')).not.toContain('filter(s=>s.user_id||s.same_as_initiator)');
  });

  it('2 previzualizarea cardului ALOP (linia :787) rămâne neschimbată — filtrul pe `u` există exact o dată', () => {
    const matches = alopSrc.match(/filter\(u=>u\.user_id\|\|u\.same_as_initiator\)/g) || [];
    expect(matches.length).toBe(1);
  });

  // #175 — harta s-a mutat din `public/js/formular/alop.js` în
  // `public/js/shared/alop-roluri.js` (ca `ROL_ATRIBUT`). Aserțiunea e IDENTICĂ:
  // fiecare atribut al unui rol trebuie să existe în `DFAtribute.LIST`, altfel
  // rândul pre-completat ar purta un atribut pe care select-ul nu-l poate afișa.
  // Se schimbă fișierul din care se citește, nu ce se verifică.
  it('3 vocabularul ROL_ATRIBUT (shared/alop-roluri.js) este subset al DFAtribute.LIST', () => {
    const roluriSrc = readFileSync(path.join(REPO, 'public/js/shared/alop-roluri.js'), 'utf8');
    const rolBlockMatch = roluriSrc.match(/var ROL_ATRIBUT\s*=\s*\{([\s\S]*?)\};/);
    expect(rolBlockMatch).toBeTruthy();
    const rolValues = [...rolBlockMatch[1].matchAll(/:\s*'([^']+)'/g)].map(m => m[1]);
    expect(rolValues.length).toBeGreaterThan(0);

    const listMatch = atribSrc.match(/var LIST = \[([\s\S]*?)\];/);
    expect(listMatch).toBeTruthy();
    const listValues = [...listMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1]);

    for (const rol of rolValues) {
      expect(listValues, `rolul "${rol}" din ALOP_ROL lipsește din DFAtribute.LIST`).toContain(rol);
    }
  });

  it('4 ⭐ validateForm include hasSigners în expresia lui valid', () => {
    const fnMatch = mainSrc.match(/function validateForm\(\)\s*\{[\s\S]*?\n {6}\}/);
    expect(fnMatch).toBeTruthy();
    expect(fnMatch[0]).toMatch(/const valid = hasPdf && hasProvider && hasSigners;/);
  });

  it('5 delegarea "change" pe tbody există (reevaluare la alegerea persoanei)', () => {
    expect(mainSrc).toContain('tbody.addEventListener("change"');
  });

  it('6 signerRowTemplate rămâne ștergibil — btnDel + tr.remove()', () => {
    expect(mainSrc).toContain('class="df-action-btn danger sm btnDel"');
    expect(mainSrc).toContain('tr.querySelector(".btnDel").addEventListener("click", () => { tr.remove(); refreshAllDropdowns?.(); });');
  });
});
