/**
 * v3.9.627 — aserții pe renderBenefStatusBadge (badge stare beneficiar ANAF).
 * v3.9.504 — guard că _lookupByCif e prezent în list.js cu logica corectă:
 * - trigger onblur pe o-cifb (din HTML)
 * - strip RO prefix
 * - validare regex ^\d{2,10}$
 * - chain local → ANAF fallback
 * - suprascrie denumire+IBAN+bancă din local, doar denumire din ANAF
 *
 * Test string-match. Comportament real testabil doar manual pe staging
 * (depinde de ANAF live + tabela locală).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

// ── renderBenefStatusBadge (v3.9.627) ─────────────────────────────────────────
describe('renderBenefStatusBadge (v3.9.627) — string-match pe sursă', () => {
  it('funcția e declarată și expusă pe window', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/list.js'), 'utf8');
    expect(src).toMatch(/function renderBenefStatusBadge\(d,target\)/);  // #128j — bloc-țintă
    expect(src).toMatch(/window\.renderBenefStatusBadge\s*=\s*renderBenefStatusBadge/);
  });

  it('ramura radiated → text "RADIAT" și interpolează radiatedDate', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/list.js'), 'utf8');
    const m = src.match(/function renderBenefStatusBadge\(d,target\)\{[\s\S]*?\r?\nwindow\.renderBenefStatusBadge/);
    expect(m, 'corp renderBenefStatusBadge negăsit').toBeTruthy();
    const body = m[0];
    expect(body).toMatch(/d\.radiated/);
    expect(body).toMatch(/RADIAT/);
    expect(body).toMatch(/d\.radiatedDate/);
  });

  it('ramura inactive → text "INACTIV" și interpolează inactiveDate + reactivationDate', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/list.js'), 'utf8');
    const m = src.match(/function renderBenefStatusBadge\(d,target\)\{[\s\S]*?\r?\nwindow\.renderBenefStatusBadge/);
    expect(m, 'corp renderBenefStatusBadge negăsit').toBeTruthy();
    const body = m[0];
    expect(body).toMatch(/d\.inactive/);
    expect(body).toMatch(/INACTIV/);
    expect(body).toMatch(/d\.inactiveDate/);
    expect(body).toMatch(/d\.reactivationDate/);
  });

  it('ramura TVA anulat → vat===false && vatEndDate → "TVA anulat"', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/list.js'), 'utf8');
    const m = src.match(/function renderBenefStatusBadge\(d,target\)\{[\s\S]*?\r?\nwindow\.renderBenefStatusBadge/);
    expect(m, 'corp renderBenefStatusBadge negăsit').toBeTruthy();
    const body = m[0];
    expect(body).toMatch(/d\.vat===false/);
    expect(body).toMatch(/d\.vatEndDate/);
    expect(body).toMatch(/TVA anulat/);
  });

  it('ramura activ → "În funcțiune" și interpolează stareInregistrareText', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/list.js'), 'utf8');
    const m = src.match(/function renderBenefStatusBadge\(d,target\)\{[\s\S]*?\r?\nwindow\.renderBenefStatusBadge/);
    expect(m, 'corp renderBenefStatusBadge negăsit').toBeTruthy();
    const body = m[0];
    expect(body).toMatch(/În funcțiune/);
    expect(body).toMatch(/d\.stareInregistrareText/);
  });

  it('null → box.innerHTML=""', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/list.js'), 'utf8');
    const m = src.match(/function renderBenefStatusBadge\(d,target\)\{[\s\S]*?\r?\nwindow\.renderBenefStatusBadge/);
    expect(m, 'corp renderBenefStatusBadge negăsit').toBeTruthy();
    const body = m[0];
    expect(body).toMatch(/if\(!d\)\{/);
    expect(body).toMatch(/box\.innerHTML=''/);
  });
});

describe('CIF lookup auto-fill (v3.9.504)', () => {
  // #128j — declanșarea NU mai e inline (`onblur=`), ci DELEGATĂ pe #ord-blocuri, ca să
  // funcționeze și pe blocurile de furnizor adăugate dinamic (care nu au id-uri).
  it('HTML: o-cifb NU mai are onblur inline; spinner-ul are id + data-role', () => {
    const html = readFileSync(path.join(REPO, 'public/formular.html'), 'utf8');
    expect(html).not.toMatch(/onblur="[^"]*_lookupByCif/);
    expect(html).toMatch(/id="o-cifb-spin"[^>]*data-role="cifb-spin"/);
    expect(html).toMatch(/id="o-cifb"[^>]*data-fld="cif_beneficiar"/);
  });

  it('list.js: declanșarea e delegată — focusout pe [data-fld="cif_beneficiar"] → _lookupByCif(t)', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/list.js'), 'utf8');
    expect(src).toMatch(/addEventListener\('focusout'/);
    expect(src).toMatch(/matches\('\[data-fld="cif_beneficiar"\]'\)\)_lookupByCif\(t\)/);
  });

  it('list.js: funcția _lookupByCif e declarată și expusă pe window', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/list.js'), 'utf8');
    expect(src).toMatch(/v3\.9\.504/);
    expect(src).toMatch(/async function _lookupByCif\(target\)/);  // #128j — bloc-țintă
    expect(src).toMatch(/window\._lookupByCif\s*=\s*_lookupByCif/);
  });

  it('list.js: strip RO prefix și validare regex', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/list.js'), 'utf8');
    // RO prefix strip
    expect(src).toMatch(/replace\(\/\^RO\\s\*\//);
    // Validare format ^\d{2,10}$
    expect(src).toMatch(/\/\^\\d\{2,10\}\$\//);
  });

  it('list.js: chain local first, ANAF fallback only if not found', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/list.js'), 'utf8');
    // Bloc local înainte de ANAF
    const m = src.match(/async function _lookupByCif\(target\)[\s\S]*?\n\}\s*\n\s*window\._lookupByCif/);
    expect(m, 'corpul funcției _lookupByCif nu a fost găsit').toBeTruthy();
    const body = m[0];
    const idxLocal = body.indexOf('/api/beneficiari');
    const idxAnaf  = body.indexOf('/api/verify/cui');
    expect(idxLocal, '/api/beneficiari trebuie să fie în corp').toBeGreaterThan(-1);
    expect(idxAnaf,  '/api/verify/cui trebuie să fie în corp').toBeGreaterThan(-1);
    expect(idxLocal, 'local trebuie apelat ÎNAINTE de ANAF').toBeLessThan(idxAnaf);
    // ANAF e gated de `if(!resolved)`
    expect(body).toMatch(/if\(!resolved\)/);
  });

  it('list.js: ANAF response folosește j.data.name (nu denumire)', () => {
    // Confirmare că folosim contractul corect ANAF (anafClient.mjs returnează data.name)
    const src = readFileSync(path.join(REPO, 'public/js/formular/list.js'), 'utf8');
    expect(src).toMatch(/j\.data\.name/);
  });

  it('list.js: local hit completează denumire+IBAN+bancă; ANAF hit doar denumire', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/list.js'), 'utf8');
    // În blocul local: setF pentru toate 3 câmpuri
    const localBlock = src.match(/\/\/ 1\. Caută local[\s\S]*?\}catch/);
    expect(localBlock, 'blocul local nu e găsit').toBeTruthy();
    expect(localBlock[0]).toMatch(/setF\('beneficiar'/);
    expect(localBlock[0]).toMatch(/setF\('iban_beneficiar'/);
    expect(localBlock[0]).toMatch(/setF\('banca_beneficiar'/);

    // În blocul ANAF: setF DOAR pentru denumire (NU pentru IBAN/bancă)
    const anafBlock = src.match(/\/\/ 2\. Fallback ANAF[\s\S]*?showSpin\(false\)/);
    expect(anafBlock, 'blocul ANAF nu e găsit').toBeTruthy();
    expect(anafBlock[0]).toMatch(/setF\('beneficiar'/);
    // IBAN și bancă NU trebuie atinse în blocul ANAF
    const ibanInAnaf = anafBlock[0].match(/setF\('iban_beneficiar'/);
    const bancaInAnaf = anafBlock[0].match(/setF\('banca_beneficiar'/);
    expect(ibanInAnaf, 'IBAN NU trebuie suprascris din ANAF (ANAF nu returnează IBAN)').toBeNull();
    expect(bancaInAnaf, 'Bancă NU trebuie suprascrisă din ANAF').toBeNull();
  });
});
