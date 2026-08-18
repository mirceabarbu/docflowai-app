/**
 * #128p — câmpul „Revizuirea" (#n-rev) rămâne editabil pe revizii DF aflate încă la
 * P1 (draft/returnat); `revizie_nr` (întregul intern al lanțului) rămâne DOAR al
 * serverului. `nr_unic_inreg` (#n-nrUnic) rămâne blocat — invariantul #126.
 *
 * doc.js nu are harness DOM/jsdom în acest repo (frontend-ul e SPA fără build) — ca
 * și restul testelor unit din acest folder (ex. revizie-bar-visibility.test.mjs,
 * alop-autosave-link.test.mjs), acestea sunt guarduri de sursă (regex pe corpul
 * funcției), nu execuție reală de DOM.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');
const DOC = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');

function bodyOf(src, fnMatch) {
  const m = src.match(fnMatch);
  expect(m, `corpul funcției nu a fost găsit (${fnMatch})`).toBeTruthy();
  return m[0];
}

describe('#128p — #n-rev editabil pe revizii P1, #n-nrUnic rămâne blocat', () => {
  const applyBody = bodyOf(DOC, /function applyDfRoleState\(status,role\)\{[\s\S]*?\n\}\n/);

  it('7 ⭐ #n-rev primește o excepție separată de disabled față de restul antetului', () => {
    expect(applyBody).toMatch(/n-rev/);
    // Excepția e o linie separată de bulk-disable-ul antetBody (nu antrenată în forEach)
    const m = applyBody.match(/const _rev=document\.getElementById\('n-rev'\);\s*\n\s*if\(_rev\)_rev\.disabled=([^;]+);/);
    expect(m, 'atribuirea disabled pe #n-rev nu a fost găsită').toBeTruthy();
    const expr = m[1];
    // 8 — pe R0 draft (_antetEditabil true), expresia rămâne editabilă (disabled=false)
    expect(expr).toMatch(/_antetEditabil/);
    // 7/9 — pe revizie (_revNr>0), editabil DOAR pe draft/returnat
    expect(expr).toMatch(/_revNr>0/);
    expect(expr).toMatch(/status==='draft'/);
    expect(expr).toMatch(/status==='returnat'/);
    // Nu trebuie să includă alte statusuri ca editabile (pending_p2/completed rămân blocate
    // implicit — nu apar în lista de excepții "sau")
    expect(expr).not.toMatch(/pending_p2/);
    expect(expr).not.toMatch(/completed/);
  });

  it('6 — #n-nrUnic rămâne în bulk-disable-ul general al antetului, fără nicio excepție', () => {
    // n-nrUnic apare doar în bulk querySelectorAll (via id-ul HTML, disabled controlat de _antetEditabil),
    // NU printr-o atribuire dedicată de disabled ca la #n-rev.
    const dedicated = applyBody.match(/document\.getElementById\('n-nrUnic'\)[\s\S]{0,120}\.disabled\s*=/);
    expect(dedicated, '#n-nrUnic NU trebuie să aibă o excepție dedicată de disabled').toBeFalsy();
  });

  it('10 — setModeP2Df() include n-rev în lista de câmpuri blocate la P2', () => {
    const p2Body = bodyOf(DOC, /function setModeP2Df\(\)\{[\s\S]*?\n\}\n/);
    expect(p2Body).toMatch(/'n-rev'/);
  });

  it('11 — avertisment de divergență: input-handler pe #n-rev, comparație pe String(...).trim(), fără alert()', () => {
    expect(applyBody).toMatch(/_rev\.addEventListener\('input'/);
    expect(applyBody).toMatch(/String\(_rev\.value\|\|''\)\.trim\(\)\s*!==\s*String\(_curRevNr\)/);
    expect(applyBody).not.toMatch(/alert\(/);
  });

  it('revizie_nr (întregul intern) NU e derivat din valoarea tastată în #n-rev', () => {
    // Câmpul care se citește din server rămâne ST.docRevizieNr — n-rev nu scrie în el nicăieri
    // în applyDfRoleState.
    expect(applyBody).not.toMatch(/ST\.docRevizieNr[^=]*=\s*_rev\.value/);
  });
});
