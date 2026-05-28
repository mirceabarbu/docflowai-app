/**
 * v3.9.518 — Fix cauza root regresie ALOP↔ORD link
 *
 * Guard că _alopLinkDoc e apelat ACUM și în _autoSaveDb (list.js) — nu doar
 * în saveDoc (doc.js). Înainte de fix, auto-save-ul cu debounce 800ms câștiga
 * cursa cu Save manual și crea ORD-ul fără link → regresie.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

describe('ALOP↔ORD link în _autoSaveDb (v3.9.518 fix cauza root)', () => {
  const LIST = readFileSync(path.join(REPO, 'public/js/formular/list.js'), 'utf8');
  const DOC  = readFileSync(path.join(REPO, 'public/js/formular/doc.js'),  'utf8');

  it('list.js: _autoSaveDb apelează _alopLinkDoc pe ramura POST', () => {
    // Extrage corpul funcției _autoSaveDb
    const m = LIST.match(/async function _autoSaveDb\(ft\)\{[\s\S]*?\n\}\s*\nfunction _scheduleAutoSaveDb/);
    expect(m, 'corpul _autoSaveDb nu a fost găsit').toBeTruthy();
    const body = m[0];
    // Trebuie să existe apel _alopLinkDoc pe ramura POST (după ST.docId[ft]=j.document.id)
    expect(body).toMatch(/_alopLinkDoc\?\.\(ft\s*,\s*j\.document\.id\)|_alopLinkDoc\(ft\s*,\s*j\.document\.id\)/);
  });

  it('list.js: _autoSaveDb apelează _alopLinkDoc și pe ramura PUT (safety net)', () => {
    const m = LIST.match(/async function _autoSaveDb\(ft\)\{[\s\S]*?\n\}\s*\nfunction _scheduleAutoSaveDb/);
    const body = m[0];
    // Apel pe ramura PUT cu docId (nu j.document.id, fiindcă pe PUT j.document poate lipsi)
    expect(body).toMatch(/_alopLinkDoc\?\.\(ft\s*,\s*docId\)|_alopLinkDoc\(ft\s*,\s*docId\)/);
  });

  it('list.js: cel puțin 2 apeluri _alopLinkDoc în _autoSaveDb (POST + PUT)', () => {
    const m = LIST.match(/async function _autoSaveDb\(ft\)\{[\s\S]*?\n\}\s*\nfunction _scheduleAutoSaveDb/);
    const body = m[0];
    const count = (body.match(/_alopLinkDoc/g) || []).length;
    expect(count, '_alopLinkDoc trebuie apelat de minim 2 ori în _autoSaveDb (POST + PUT)').toBeGreaterThanOrEqual(2);
  });

  it('doc.js: saveDoc apelează _alopLinkDoc și pe ramura PUT (safety net)', () => {
    const m = DOC.match(/async function saveDoc\(ft\)\{[\s\S]*?\n\}\s*\n/);
    expect(m, 'corpul saveDoc nu a fost găsit').toBeTruthy();
    const body = m[0];
    // Calls on both POST (j.document.id) and PUT (docId) branches
    const callsCount = (body.match(/_alopLinkDoc\(ft\s*,/g) || []).length;
    expect(callsCount, 'saveDoc trebuie să apeleze _alopLinkDoc de min 2 ori (POST + PUT)').toBeGreaterThanOrEqual(2);
  });
});
