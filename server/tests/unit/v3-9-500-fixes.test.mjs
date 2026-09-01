/**
 * v3.9.500 — guard-uri pentru fix-urile frontend (string-match)
 * Issue I-1: prefill plati_anterioare în newDoc(ordnt)
 * Issue I-2: wrap captura 2 vizibil mereu + setModeP2Ord enable pe o-czone2
 * Issue I-3: uploadAttachments/fetchAttachments/renderAttachments declarate
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

describe('I-1: prefill plati_anterioare în newDoc(ordnt)', () => {
  it('newDoc(ord) face fetch la /api/alop/:id și prefill prima rânduri', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    expect(src).toMatch(/v3\.9\.500 \(Issue I-1\)/);
    const m = src.match(/function newDoc\(ft\)\{[\s\S]*?_updateBackBtn\(ft\);\s*\}/);
    expect(m, 'newDoc nu e găsit').toBeTruthy();
    expect(m[0]).toMatch(/_alopContext/);
    expect(m[0]).toMatch(/cicluri_istorice/);
    expect(m[0]).toMatch(/plati_anterioare/);
  });
});

describe('I-2: wrap captura 2 vizibil mereu + setModeP2Ord pe o-czone2', () => {
  it('populateOrd setează _wrap2.style.display="" necondiționat', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    expect(src).toMatch(/v3\.9\.500 \(Issue I-2\)/);
    // #128g: fereastra era 2000 — arbitrară, iar orice linie adăugată în capul lui populateOrd
    // o depășea (aici: re-ștampilarea ctrl_idx pe rândurile ORD). 3000 păstrează intenția
    // („display='' apare în populateOrd, nu oriunde în fișier") fără fragilitate la lungime.
    // #128k: ancorare pe DECLARAȚIA funcției, nu pe prima MENȚIUNE a numelui — un comentariu
    // care pomenește `populateOrd` mai sus în fișier muta fereastra pe text irelevant.
    // #167: fereastra fixă a fost lărgită deja de două ori (2000→3000) și a picat din nou la
    // primul comentariu adăugat în capul funcției. Se ancorează acum pe CORPUL funcției, exact
    // ca testul `setModeP2Ord` de mai jos: populateOrd e top-level, deci `\n}` la coloana 0 o
    // închide. Aceeași intenție („display='' apare în populateOrd, nu oriunde în fișier"),
    // fără cliches de lungime.
    const m = src.match(/async function populateOrd\([\s\S]*?\n\}/);
    expect(m).toBeTruthy();
    expect(m[0]).toMatch(/_wrap2\.style\.display=''/);
  });

  it('setModeP2Ord enable pointer-events pe ambele zone de captură', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    const m = src.match(/function setModeP2Ord\(\)\s*\{[\s\S]*?\n\}/);
    expect(m, 'setModeP2Ord nu e găsit').toBeTruthy();
    expect(m[0]).toMatch(/o-czone'\)/);
    expect(m[0]).toMatch(/o-czone2'\)/);
    expect(m[0]).toMatch(/czone2\.style\.pointerEvents=''/);
  });
});

describe('I-3: atașamente — funcții declarate și exportate', () => {
  it('uploadAttachments / fetchAttachments / renderAttachments / remAttServer declarate', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    // v3.9.501: signature extinsă cu slot (ft, slot=1)
    // #128m (v3.9.773): și cu blocul de furnizor (ft, slot=1, bloc=0)
    expect(src).toMatch(/async function uploadAttachments\(ft(?:,\s*slot\s*=\s*1)?(?:,\s*bloc\s*=\s*0)?\)/);
    expect(src).toMatch(/async function fetchAttachments\(ft(?:,\s*slot\s*=\s*1)?(?:,\s*bloc\s*=\s*0)?\)/);
    expect(src).toMatch(/function renderAttachments\(ft(?:,\s*slot\s*=\s*1)?(?:,\s*bloc\s*=\s*0)?\)/);
    expect(src).toMatch(/async function remAttServer/);
  });

  it('funcțiile exportate ca window globals', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    expect(src).toMatch(/window\.uploadAttachments\s*=/);
    expect(src).toMatch(/window\.fetchAttachments\s*=/);
    expect(src).toMatch(/window\.renderAttachments\s*=/);
    expect(src).toMatch(/window\.remAttServer\s*=/);
  });

  it('uploadAttachments apelat în completeAsP2 + saveDoc + _autoSaveDb', () => {
    const docSrc  = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    const listSrc = readFileSync(path.join(REPO, 'public/js/formular/list.js'), 'utf8');
    // v3.9.501: apeluri cu slot explicit (ft, 1) și (ft, 2)
    const docCount = (docSrc.match(/await uploadAttachments\(ft(?:,\s*\d)?\)/g) || []).length;
    expect(docCount).toBeGreaterThanOrEqual(2);
    expect(listSrc).toMatch(/await uploadAttachments\(ft(?:,\s*\d)?\)/);
  });

  it('loadDoc apelează fetchAttachments după încărcare captură', () => {
    const src = readFileSync(path.join(REPO, 'public/js/formular/doc.js'), 'utf8');
    // v3.9.501: comentariu actualizat + apel cu slot explicit
    expect(src).toMatch(/v3\.9\.50[01]: încarcă lista de atașamente/);
    expect(src).toMatch(/await fetchAttachments\(ft(?:,\s*\d)?\)/);
  });
});
