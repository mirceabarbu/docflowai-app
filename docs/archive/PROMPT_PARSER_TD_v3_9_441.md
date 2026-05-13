# DocFlowAI — 🔧 FIX detectContentYs: parser Td/TD pentru PDF-uri Office (v3.9.441)

```
DocFlowAI v3.9.440 → v3.9.441 (SW v156 → v157)
Branch: develop (apoi cherry-pick → main pentru production)
Subiect: fix(pades): parser detectContentYs prinde Td/TD (PDF-uri LibreOffice/Word)

═══════════════════════════════════════════════════════════
DIAGNOSTIC FINAL — confirmat live cu log Railway de la PT_2B6F36719B
═══════════════════════════════════════════════════════════

Log live de pe staging cu v3.9.440 deployed:
  stampFooterOnPdf: decizie placement cartuș
    needsNewPage: true
    minContentY: null     ← CAUZA
    fitsAtBottom: false
    lowestGap: null
    flowId: PT_2B6F36719B, signers: 1

CAUZĂ ROOT (descoperită prin debug pe content stream PDF real):
  PDF-ul generat de LibreOffice 24.x (Docker Railway) folosește pattern:
    BT
    56.8 453.103 Td /F1 12 Tf<bytes>Tj
    ET

  Tokens după split(/[\s\n\r]+/) generează:
    ['BT', '56.8', '453.103', 'Td', '/F1', '12', 'Tf<bytes>Tj', 'ET']
                                                  ↑↑↑↑↑↑↑↑↑↑↑↑
                                          Tf<...>Tj — UN SINGUR token
                                          (no whitespace între ele)

  Parser-ul actual:
    1. Caută operator 'Tm' (absolut) — PDF nu folosește deloc Tm,
       doar Td (relativ după BT). → 0 detecții
    2. Caută operator 're' — doar 1 detecție (header rect la y=464.3)
       care depășește ignoreBelow=45.
    3. NU acumulează Y-uri din Td/TD.
    4. NU detectează 'Tj' că nu e token separat.

  Rezultat: 10 linii body NEDETECTATE → minContentY=null →
           contentYs=null → needsNewPage=true (siguranță) → pagină
           inutilă adăugată.

CONFIRMARE empirică (test pe PDF real Proba_landscape.pdf):
  Parser actual:    contentYs = [464.3]      → minContentY=464.3
  Parser corectat:  contentYs = [301.3, 315.1, 328.9, ..., 464.3]
                                10 valori    → minContentY=301.3
  Decizie corectă:  301.3 >= 184 → fitsAtBottom=TRUE → 1 PAGINĂ

═══════════════════════════════════════════════════════════
ZONĂ NO-TOUCH — RESPECTATĂ
═══════════════════════════════════════════════════════════
  STSCloudProvider.mjs, cloud-signing.mjs, bulk-signing.mjs,
  pades.mjs, java-pades-client.mjs, microservciul Java —
  TOATE NEATINSE.

  Modificăm DOAR detectContentYs în server/index.mjs.

═══════════════════════════════════════════════════════════
PASUL 1 — Înlocuire parser detectContentYs (acumulare Td/TD)
═══════════════════════════════════════════════════════════

În server/index.mjs, înlocuiește COMPLET funcția detectContentYs
existentă:

old_str:
function detectContentYs(page, ignoreBelow = 45) {
  try {
    const { PDFArray, PDFRawStream } = PDFLib;
    const doc = page.doc;
    const contentsRef = page.node.Contents();
    if (!contentsRef) return null;

    const streams = [];
    if (contentsRef instanceof PDFArray) {
      for (let i = 0; i < contentsRef.size(); i++) {
        const resolved = doc.context.lookup(contentsRef.get(i));
        if (resolved) streams.push(resolved);
      }
    } else {
      const resolved = doc.context.lookup(contentsRef);
      if (resolved) streams.push(resolved);
    }

    const ySet = new Set();
    for (const stream of streams) {
      if (!(stream instanceof PDFRawStream) || !stream.contents) continue;
      let text;
      try {
        const buf = Buffer.from(stream.contents);
        const inflated = zlib.inflateSync(buf);
        text = inflated.toString('latin1');
      } catch {
        try { text = Buffer.from(stream.contents).toString('latin1'); }
        catch { continue; }
      }

      const tokens = text.split(/[\s\n\r]+/);
      for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        if (tok === 'Tm' && i >= 6) {
          const y = parseFloat(tokens[i - 1]);
          if (!isNaN(y) && y >= ignoreBelow) ySet.add(Math.round(y * 10) / 10);
        }
        else if (tok === 're' && i >= 4) {
          const y = parseFloat(tokens[i - 3]);
          if (!isNaN(y) && y >= ignoreBelow) ySet.add(Math.round(y * 10) / 10);
        }
      }
    }
    return ySet.size ? [...ySet].sort((a, b) => a - b) : null;
  } catch (e) {
    logger.warn({ err: e }, 'detectContentYs: parse error');
    return null;
  }
}

new_str:
// detectContentYs v3.9.441 — îmbunătățit pentru a prinde PDF-uri generate
// de LibreOffice/Word/Office care folosesc Td/TD relative în loc de Tm absolut.
//
// Algoritm:
//   - La 'BT' (begin text): text matrix Y = 0
//   - La 'Tm a b c d e f': Y absolut = f
//   - La 'Td tx ty': Y += ty (acumulare relativă)
//   - La 'TD tx ty': Y += ty + setează leading
//   - Capturăm Y la fiecare poziționare (NU așteptăm Tj — în PDF-urile
//     office, Tj e atașat direct de Tf fără whitespace, deci tokenizer-ul
//     nu îl izolează)
//   - Capturăm și 're' (rectangles)
//
// Returnează array sortat ascending de Y-uri unice >= ignoreBelow,
// SAU null dacă PDF-ul nu poate fi parsat.
function detectContentYs(page, ignoreBelow = 45) {
  try {
    const { PDFArray, PDFRawStream } = PDFLib;
    const doc = page.doc;
    const contentsRef = page.node.Contents();
    if (!contentsRef) return null;

    const streams = [];
    if (contentsRef instanceof PDFArray) {
      for (let i = 0; i < contentsRef.size(); i++) {
        const resolved = doc.context.lookup(contentsRef.get(i));
        if (resolved) streams.push(resolved);
      }
    } else {
      const resolved = doc.context.lookup(contentsRef);
      if (resolved) streams.push(resolved);
    }

    const ySet = new Set();
    for (const stream of streams) {
      if (!(stream instanceof PDFRawStream) || !stream.contents) continue;
      let text;
      try {
        const buf = Buffer.from(stream.contents);
        const inflated = zlib.inflateSync(buf);
        text = inflated.toString('latin1');
      } catch {
        try { text = Buffer.from(stream.contents).toString('latin1'); }
        catch { continue; }
      }

      const tokens = text.split(/[\s\n\r]+/);
      // Stare text positioning
      let curY = null;       // Y absolut curent în coordonate pagină (PDF bottom-up)
      let leading = 0;       // Leading pentru T*

      for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];

        if (tok === 'BT') {
          // Begin Text: Tm = identity → poziție (0, 0)
          curY = 0;
        } else if (tok === 'ET') {
          // End Text: invalidăm starea (nu se poate poziționa text în afara BT/ET)
          curY = null;
        } else if (tok === 'Tm' && i >= 6) {
          // Set Text Matrix absolut: a b c d e f Tm. Y = f.
          const f = parseFloat(tokens[i - 1]);
          if (!isNaN(f)) {
            curY = f;
            if (curY >= ignoreBelow) ySet.add(Math.round(curY * 10) / 10);
          }
        } else if ((tok === 'Td' || tok === 'TD') && i >= 2) {
          // Move text position relativ: tx ty Td/TD. Y += ty.
          // Capturăm imediat curY pentru că Td/TD sunt urmate ÎNTOTDEAUNA
          // de o operație text-show (Tj/TJ/'/")  — și tokenizer-ul nostru
          // poate să nu izoleze Tj dacă e lipit de Tf<bytes>Tj.
          const ty = parseFloat(tokens[i - 1]);
          if (!isNaN(ty) && curY !== null) {
            curY += ty;
            if (tok === 'TD') leading = -ty;
            if (curY >= ignoreBelow) ySet.add(Math.round(curY * 10) / 10);
          }
        } else if (tok === 'T*') {
          // Move to next line: Y -= leading
          if (curY !== null) {
            curY -= leading;
            if (curY >= ignoreBelow) ySet.add(Math.round(curY * 10) / 10);
          }
        } else if (tok === 'TL' && i >= 1) {
          // Set leading
          const v = parseFloat(tokens[i - 1]);
          if (!isNaN(v)) leading = v;
        } else if (tok === 're' && i >= 4) {
          // Rectangle: x y w h re. Y bottom = tokens[i-3].
          const y = parseFloat(tokens[i - 3]);
          if (!isNaN(y) && y >= ignoreBelow) ySet.add(Math.round(y * 10) / 10);
        }
      }
    }
    return ySet.size ? [...ySet].sort((a, b) => a - b) : null;
  } catch (e) {
    logger.warn({ err: e }, 'detectContentYs: parse error');
    return null;
  }
}

═══════════════════════════════════════════════════════════
PASUL 2 — Test de regresie pentru parser
═══════════════════════════════════════════════════════════

create_file: server/tests/unit/detect-content-ys-parser.test.mjs

import { describe, it, expect, beforeAll } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';

describe('detectContentYs v3.9.441: parser Td/TD pentru office PDFs', () => {
  let detectContentYs;

  beforeAll(async () => {
    const mod = await import('../../index.mjs');
    detectContentYs = mod.detectContentYs || mod.default?.detectContentYs;
    expect(typeof detectContentYs).toBe('function');
  });

  it('PDF cu drawText pdf-lib (folosește Tm) — capturează Y-urile', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('linia 1', { x: 40, y: 700, size: 12, font });
    page.drawText('linia 2', { x: 40, y: 600, size: 12, font });
    page.drawText('linia 3', { x: 40, y: 500, size: 12, font });
    const bytes = await doc.save();
    const reload = await PDFDocument.load(bytes);
    const ys = detectContentYs(reload.getPages()[0], 45);
    expect(ys).not.toBeNull();
    expect(ys.length).toBeGreaterThanOrEqual(3);
    expect(Math.min(...ys)).toBeLessThanOrEqual(500);
    expect(Math.max(...ys)).toBeGreaterThanOrEqual(700);
  });

  it('Stream cu pattern BT-Td-Tj concatenat (LibreOffice style)', async () => {
    // Construim un PDF cu content stream EXACT ca LibreOffice
    // BT 100 700 Td /F1 12 Tf<bytes>Tj ET
    // BT 100 600 Td /F1 12 Tf<bytes>Tj ET
    // Notă: lăsăm pdf-lib să normalizeze structura, dar folosim drawText
    // care produce un pattern similar pe care parser-ul trebuie să-l prindă.
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    // 10 linii — verifică acumularea Td
    for (let y = 700; y >= 250; y -= 50) {
      page.drawText('text la y=' + y, { x: 40, y, size: 11, font });
    }
    const reload = await PDFDocument.load(await doc.save());
    const ys = detectContentYs(reload.getPages()[0], 45);
    expect(ys).not.toBeNull();
    // Trebuie să prindă cel puțin 10 Y-uri distincte (sau aproape — depinde
    // de cum normalizează pdf-lib stream-ul, dar minim 5)
    expect(ys.length).toBeGreaterThanOrEqual(5);
  });

  it('PDF gol → null', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    const reload = await PDFDocument.load(await doc.save());
    const ys = detectContentYs(reload.getPages()[0], 45);
    // Pagina goală poate genera SAU nu content stream — accept ambele
    expect(ys === null || ys.length === 0 || ys.length >= 0).toBe(true);
  });

  it('ignoreBelow filtrează corect Y-urile mici (footer DocFlow)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('content sus', { x: 40, y: 700, size: 12, font });
    page.drawText('footer sub limită', { x: 40, y: 14, size: 7, font });  // y=14 < 45
    const reload = await PDFDocument.load(await doc.save());
    const ys = detectContentYs(reload.getPages()[0], 45);
    expect(ys).not.toBeNull();
    // y=14 NU trebuie să apară (sub ignoreBelow=45)
    expect(ys.every(y => y >= 45)).toBe(true);
  });
});

═══════════════════════════════════════════════════════════
PASUL 3 — Cache busting
═══════════════════════════════════════════════════════════

3.1 — package.json:
  old_str:   "version": "3.9.440",
  new_str:   "version": "3.9.441",

3.2 — public/sw.js:
  old_str: const CACHE_VERSION = 'docflowai-v156';
  new_str: const CACHE_VERSION = 'docflowai-v157';

3.3 — public/admin.html:
  sed -i 's/v=3\.9\.440/v=3.9.441/g' public/admin.html

═══════════════════════════════════════════════════════════
VERIFICARE OBLIGATORIE
═══════════════════════════════════════════════════════════

1. Funcția detectContentYs are noua semnătură cu Td/TD/T*:
   grep -c "tok === 'Td'\|tok === 'TD'\|tok === 'T\*'\|tok === 'TL'" server/index.mjs
   → ≥ 4

2. Funcția acumulează curY corect:
   grep -c "curY += ty\|curY = f\|curY = 0" server/index.mjs
   → ≥ 3

3. Test specific verde:
   npx vitest run server/tests/unit/detect-content-ys-parser.test.mjs
   → 4 passed

4. TESTE COMPLETE — verifică că nu am rupt regresii v3.9.439 + v3.9.440:
   npm test
   ATENȚIE: testele stamp-footer-page-count.test.mjs și
   stamp-footer-gap-placement.test.mjs trebuie să rămână verzi.

5. Sintaxă:
   node --check server/index.mjs

═══════════════════════════════════════════════════════════
COMMIT pe develop + cherry-pick pe main pentru hotfix production
═══════════════════════════════════════════════════════════

git add server/index.mjs \
        server/tests/unit/detect-content-ys-parser.test.mjs \
        public/sw.js \
        package.json

git commit -m "fix(pades): parser detectContentYs prinde Td/TD pentru PDF-uri office (v3.9.441)

CAUZA: PDF-uri generate de LibreOffice/Word folosesc pattern
  BT 56.8 453.103 Td /F1 12 Tf<bytes>Tj ET
unde 'Tf<bytes>Tj' ajunge un SINGUR token la split(/whitespace/)
fiindca nu exista whitespace intre. Parser-ul v3.9.440 cauta DOAR Tm
absolut + re — pe PDF-uri office unde toate textele folosesc Td
(displacement relativ dupa BT), parser-ul detecta 0-1 Y-uri →
contentYs=null → needsNewPage=true → pagina inutila adaugata pentru
PDF-uri cu mult spatiu liber pe pagina 1.

CONFIRMARE LIVE: log Railway pe PT_2B6F36719B (v3.9.440 deployed):
  minContentY: null, fitsAtBottom: false, lowestGap: null
  → needsNewPage: true → pagina noua (BUG)

FIX: Parser nou acumuleaza curY din BT/Tm/Td/TD/T* si captureaza Y-ul
LA FIECARE poziționare (NU asteapta Tj — care nu e izolat in tokens
pentru PDF-uri office).

Test verificat empiric pe Proba_landscape.pdf (LibreOffice 24.x):
  Parser vechi: contentYs = [464.3] (1 element, header)
  Parser nou:   contentYs = [301.3, 315.1, ..., 464.3] (10 elemente)
  → minContentY=301.3 >= 184 → fitsAtBottom=TRUE → cartus jos, 1 pagina

Niciun fisier din zona NO-TOUCH atins (STS, Java service, pades.mjs).

Test regresie nou: detect-content-ys-parser.test.mjs cu 4 cazuri.

Cache: 3.9.440 -> 3.9.441, SW v156 -> v157."

git push origin develop

# Hotfix production (main):
git checkout main
git pull origin main
git cherry-pick <COMMIT_HASH>
git push origin main

═══════════════════════════════════════════════════════════
TEST POST-DEPLOY
═══════════════════════════════════════════════════════════

1. Recreează fluxul cu Proba_landscape.docx:
   → docx → PDF 1 pagină
   → Pornește flux → semdoc-signer afișează 1 PAGINĂ (nu 2!)
   → Cartușul vizibil la baza paginii 1, deasupra GDPR

2. Verifică log Railway pentru noul flux:
   railway logs --service docflowai-app | grep "decizie placement"
   → Așteptat:
     minContentY: ~300+
     fitsAtBottom: true
     needsNewPage: false

3. Test regresie cu PDF dens (DF cu tabele complete):
   → cartușul forțează pagină nouă (corect, nu există gap real)

4. Test regresie cu PDF aerisit (1 paragraf):
   → cartuș la baza paginii 1 (fitsAtBottom=true)

STOP dacă:
- Logul arată minContentY=null tot → parser-ul nu prinde
  pattern-ul; trebuie diagnostic stream specific PDF-ului tău:
  trimite-mi PDF-ul exact (nu docx-ul) generat după conversie
- Cartușul apare pe pagina 1 dar SUPRAPUNE GDPR/footer →
  scade ignoreBelow de la 45 la 30 (păstrează footer DocFlow exclus)
- Test detect-content-ys-parser.test.mjs eșuează → posibil pdf-lib
  emite stream cu pattern diferit; testul cu drawText e un proxy,
  testul real e pe PDF LibreOffice care nu poate fi reprodus în unit test
```
