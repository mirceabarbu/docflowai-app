# DocFlowAI — 🎯 FIX placement cartuș: detectare gap + plasare în spațiu liber (v3.9.440)

```
DocFlowAI v3.9.439 → v3.9.440 (SW v155 → v156)
Branch: develop (apoi cherry-pick → main)
Subiect: fix(pades): plasare cartuș în largest empty band, nu doar la bottom

═══════════════════════════════════════════════════════════
DIAGNOSTIC — confirmat cu date reale din PDF
═══════════════════════════════════════════════════════════

După v3.9.439, semnarea NU mai crashează, dar `stampFooterOnPdf`
forțează pagină nouă și pentru PDF-uri cu MULT spațiu liber pe pagina
existentă.

DATE CONCRETE (parse pdfplumber pe PT_552313C132 portrait 595×842):
  Conținut Y descrescător (PDF coords, bottom-up origin):
    y=711.7, 670.3, 656.5, ..., 546.1, 532.3   ← body ends here
    [GAP 482pt — complet gol]
    y=50.7   ← GDPR notice (mic, italic, la baza paginii)
    y=41.5, 32.3, 19.6   ← footer DocFlowAI (sub ignoreBelow)

LOGICA ACTUALĂ în detectMinContentY + stampFooterOnPdf:
  minContentY = 50.7 (singurul care depășește ignoreBelow=45)
  requiredFreeY = (footerY=14)+32+cellH(78)+SAFETY(60) = 184
  50.7 < 184  →  needsNewPage = true  →  PDF de 2 pagini

PROBLEMA: algoritmul caută loc DOAR „la bază, deasupra footer-ului".
Nu observă banda goală de 482pt din mijlocul paginii care ar încăpea
cartușul de >6 ori.

═══════════════════════════════════════════════════════════
SOLUȚIA — gap-based placement
═══════════════════════════════════════════════════════════

Pas 1: Detectăm TOATE Y-urile cu conținut (nu doar minimum).
Pas 2: Găsim CEA MAI JOASĂ bandă goală suficient de mare.
Pas 3: Dacă există → plasăm cartușul acolo (just deasupra
       conținutului inferior, cu margin).
Pas 4: Dacă nu există → fallback la pagină nouă.

VISUAL: cartușul va apărea în banda de spațiu liber (similar cu
„signature block" la finalul body-ului, deasupra GDPR notice).
Pentru PT_552313: cartuș la y≈80 (deasupra GDPR la y=50.7),
păstrând body-ul intact sus și GDPR-ul vizibil jos.

═══════════════════════════════════════════════════════════
ZONĂ NO-TOUCH — RESPECTATĂ
═══════════════════════════════════════════════════════════
- server/signing/providers/STSCloudProvider.mjs   — NEATINS
- server/routes/flows/cloud-signing.mjs           — NEATINS
- server/routes/flows/bulk-signing.mjs            — NEATINS
- server/signing/pades.mjs                        — NEATINS
- server/signing/java-pades-client.mjs            — NEATINS
- microserviciul Java                             — NEATINS

  Modificăm DOAR server/index.mjs (detectMinContentY +
  stampFooterOnPdf), aceeași zonă atinsă în v3.9.439.

═══════════════════════════════════════════════════════════
PASUL 1 — Adaugă detectContentYs (înlocuiește/completează detectMinContentY)
═══════════════════════════════════════════════════════════

În server/index.mjs, ÎNLOCUIEȘTE COMPLET funcția detectMinContentY
existentă (linia ~926-976) cu următoarea variantă extinsă:

old_str:
function detectMinContentY(page, ignoreBelow = 45) {
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

    let minY = Infinity;
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
          if (!isNaN(y) && y >= ignoreBelow && y < minY) minY = y;
        }
        else if (tok === 're' && i >= 4) {
          const y = parseFloat(tokens[i - 3]);
          if (!isNaN(y) && y >= ignoreBelow && y < minY) minY = y;
        }
      }
    }

    return minY === Infinity ? null : minY;
  } catch (e) {
    logger.warn({ err: e }, 'detectMinContentY: parse error, fallback to safe');
    return null;
  }
}

new_str:
// detectContentYs — returnează TOATE pozițiile Y unde există conținut
// pe pagină (text matrix Y + rectangle bottom Y), sortate crescător.
// Returnează null dacă PDF-ul nu poate fi parsat (criptat / structură exotică).
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

// detectMinContentY — wrapper pentru backward compat
function detectMinContentY(page, ignoreBelow = 45) {
  const ys = detectContentYs(page, ignoreBelow);
  return ys && ys.length ? ys[0] : null;
}

// findLowestUsableGap — caută cea mai JOASĂ bandă goală >= minGapSize.
// Preferăm gap-uri jos pe pagină (cartușul stă semantic la sfârșitul
// documentului, deasupra zonei de footer/GDPR).
//
// Returnează: { gapBottom, gapTop, gapSize } sau null.
//   gapBottom = Y-ul conținutului inferior (limită inferioară a gap-ului)
//   gapTop    = Y-ul conținutului superior (limită superioară a gap-ului)
function findLowestUsableGap(ys, minGapSize) {
  if (!ys || ys.length < 2) return null;
  // ys e sortat ascending. Iterăm de la jos în sus și luăm PRIMA gap suficientă.
  for (let i = 0; i < ys.length - 1; i++) {
    const gapSize = ys[i + 1] - ys[i];
    if (gapSize >= minGapSize) {
      return { gapBottom: ys[i], gapTop: ys[i + 1], gapSize };
    }
  }
  return null;
}

═══════════════════════════════════════════════════════════
PASUL 2 — Modifică stampFooterOnPdf să încerce gap placement
═══════════════════════════════════════════════════════════

Localizează blocul (linia ~1060-1080) cu apelul detectMinContentY +
calculul needsNewPage:

old_str:
      const lastPageExisting = pdfDoc.getPages()[pdfDoc.getPageCount() - 1];
      const { width: pWLast, height: hLast } = lastPageExisting.getSize();
      const cellHCheck = Math.max(56, Math.min(78,
        (Math.max(120, hLast * 0.30) - ((rows - 1) * rowGap)) / rows));
      // Cartușul ar începe la (footerY + 32) și ar urca cu rows * cellH + gaps
      const cartusTopIfFit = (footerY + 32) + rows * cellHCheck + (rows - 1) * rowGap;
      // Marjă de siguranță deasupra cartușului (60pt = vizibil clar separat)
      const SAFETY_MARGIN = 60;
      const requiredFreeY = cartusTopIfFit + SAFETY_MARGIN;
      // Detectăm Y-ul minim al conținutului existent (ignorăm footer-ul DocFlowAI)
      const minContentY = detectMinContentY(lastPageExisting, 45);
      // Decizie: pagină nouă dacă detectarea eșuează (siguranță) SAU
      // dacă cartușul + marjă ar suprapune conținutul.
      const needsNewPage = (minContentY === null) || (minContentY < requiredFreeY);

new_str:
      const lastPageExisting = pdfDoc.getPages()[pdfDoc.getPageCount() - 1];
      const { width: pWLast, height: hLast } = lastPageExisting.getSize();
      const cellHCheck = Math.max(56, Math.min(78,
        (Math.max(120, hLast * 0.30) - ((rows - 1) * rowGap)) / rows));
      const cartusTotalH = rows * cellHCheck + (rows - 1) * rowGap;

      // ── Detectare conținut + găsire gap optim ──────────────────────────
      // v3.9.440: în loc să forțăm cartușul „la bază", căutăm cea mai joasă
      // bandă goală pe pagină care încape cartușul (+ margin). Asta permite
      // plasare mid-page când există GDPR notice / alt conținut mic la bază.
      const contentYs = detectContentYs(lastPageExisting, 45);
      const minContentY = contentYs && contentYs.length ? contentYs[0] : null;

      // Try 1: bottom placement clasic (pentru PDF-uri aerisite — body-ul nu
      //         coboară până jos). Cartușul stă lipit de footer.
      const SAFETY_MARGIN = 60;
      const requiredFreeY = (footerY + 32) + cartusTotalH + SAFETY_MARGIN;
      const fitsAtBottom = (minContentY !== null) && (minContentY >= requiredFreeY);

      // Try 2: gap placement mid-page (pentru PDF-uri cu GDPR/footer la bază
      //         dar body-ul scurt). Avem nevoie de cartusH + 2*15 (margin).
      const GAP_MARGIN = 15;
      const REQUIRED_GAP = cartusTotalH + 2 * GAP_MARGIN;
      let lowestGap = null;
      if (!fitsAtBottom && contentYs) {
        lowestGap = findLowestUsableGap(contentYs, REQUIRED_GAP);
      }

      // Decizie finală: pagină nouă DOAR dacă nici fits-at-bottom nici gap.
      // Fallback: dacă detectarea eșuează (contentYs=null), forțăm pagină nouă.
      const needsNewPage = (contentYs === null) || (!fitsAtBottom && !lowestGap);

      logger.info({ flowId: flowData.flowId,
        signers: signers.length, rows, cellHCheck, cartusTotalH,
        minContentY, fitsAtBottom,
        lowestGap: lowestGap ? `${lowestGap.gapBottom}→${lowestGap.gapTop} (${lowestGap.gapSize.toFixed(0)}pt)` : null,
        needsNewPage,
      }, 'stampFooterOnPdf: decizie placement cartuș');

PASUL 2.b — în continuarea aceleiași funcții, modifică selecția cartusPage
și calculul startY ca să folosească lowestGap când e cazul.

old_str:
      // ── Alege / creează pagina pentru cartus ──────────────────────────────
      let cartusPage, cartusPageNum, topMargin;
      if (needsNewPage) {

new_str:
      // ── Alege / creează pagina pentru cartus ──────────────────────────────
      // gapPlacement = true → folosim lowestGap (mid-page placement)
      // gapPlacement = false + needsNewPage = false → fits-at-bottom
      // needsNewPage = true → pagină nouă
      const gapPlacement = !needsNewPage && !fitsAtBottom && lowestGap !== null;
      let cartusPage, cartusPageNum, topMargin;
      if (needsNewPage) {

ȘI mai jos, găsește calculul startY pentru else (cartuș pe pagina existentă):

old_str:
      let startY;
      if (needsNewPage) {
        // Sus: prima linie de celule la (height - topMargin - cellH)
        startY = height - topMargin - cellH;
      } else {
        // Jos: deasupra footer-ului
        const blockBottom = footerY + 41;
        const blockTop    = blockBottom + rows * cellH + (rows - 1) * rowGap;
        startY = Math.min(height - topMargin, blockTop) - cellH;
      }

new_str:
      let startY;
      if (needsNewPage) {
        // Pagină nouă: sus
        startY = height - topMargin - cellH;
      } else if (gapPlacement) {
        // Mid-page placement: cartuș plasat în banda goală, JUST DEASUPRA
        // conținutului inferior (visual: signature block înainte de GDPR/footer)
        // gapBottom = Y-ul conținutului de jos. Cartușul începe la
        // gapBottom + GAP_MARGIN. Pentru rows>1, cellH se scade pentru row 0.
        const blockBottom = lowestGap.gapBottom + GAP_MARGIN;
        const blockTop    = blockBottom + rows * cellH + (rows - 1) * rowGap;
        startY = blockTop - cellH;
      } else {
        // Bottom placement clasic: deasupra footer-ului
        const blockBottom = footerY + 41;
        const blockTop    = blockBottom + rows * cellH + (rows - 1) * rowGap;
        startY = Math.min(height - topMargin, blockTop) - cellH;
      }

═══════════════════════════════════════════════════════════
PASUL 3 — Test de regresie pentru gap placement
═══════════════════════════════════════════════════════════

create_file: server/tests/unit/stamp-footer-gap-placement.test.mjs

import { describe, it, expect, beforeAll } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';

describe('stampFooterOnPdf v3.9.440: gap placement', () => {
  let stampFooterOnPdf;

  beforeAll(async () => {
    const mod = await import('../../index.mjs');
    stampFooterOnPdf = mod.stampFooterOnPdf || mod.default?.stampFooterOnPdf;
    expect(typeof stampFooterOnPdf).toBe('function');
  });

  // Helper: PDF cu body sus + GDPR jos (simulează cazul Mircea PT_552313)
  async function buildPdfWithGdprAtBottom() {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    // Body sus (y=550 - y=750)
    for (let y = 550; y <= 750; y += 18) {
      page.drawText('Body content line at y=' + y, { x: 40, y, size: 11, font });
    }
    // GDPR notice JOS (y=50, sub gap mare)
    page.drawText('GDPR notice — small text at bottom of page', { x: 40, y: 50, size: 7, font });
    return Buffer.from(await doc.save()).toString('base64');
  }

  it('PDF cu body sus + GDPR jos → cartuș plasat în GAP, NU pagină nouă', async () => {
    const inputB64 = await buildPdfWithGdprAtBottom();
    const result = await stampFooterOnPdf(inputB64, {
      flowId: 'test-gap', createdAt: new Date().toISOString(),
      initName: 'Test', signers: [
        { name: 'A', rol: 'INTOCMIT', functie: 'F1', email: 'a@x.ro' },
      ],
      flowType: 'tabel',
    });
    expect(typeof result === 'object').toBe(true);
    expect(result.signerRects).toHaveLength(1);

    // Verifică: NU s-a adăugat pagină nouă
    const returnedDoc = await PDFDocument.load(Buffer.from(result.pdfB64, 'base64'));
    expect(returnedDoc.getPageCount()).toBe(1);

    // Cartușul e pe pagina 1
    expect(result.signerRects[0].page).toBe(1);

    // Y-ul cartușului trebuie să fie ÎN gap (între y=50 GDPR și y=550 body):
    // gapBottom=50, GAP_MARGIN=15 → startY ≈ 65 (cell bottom)
    // Cartuș top = startY + 78 = 143. Trebuie < 550 (sub body).
    const rect = result.signerRects[0];
    expect(rect.y).toBeGreaterThan(50);     // deasupra GDPR
    expect(rect.y + rect.h).toBeLessThan(550);  // sub body
  });

  it('PDF dens (fără gap) → fallback pagină nouă', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    // Umplere completă: linii la fiecare 10pt de sus până jos
    for (let y = 800; y >= 60; y -= 10) {
      page.drawText('linie densă y=' + y, { x: 40, y, size: 8, font });
    }
    const inputB64 = Buffer.from(await doc.save()).toString('base64');

    const result = await stampFooterOnPdf(inputB64, {
      flowId: 'test-dense', createdAt: new Date().toISOString(),
      initName: 'Test', signers: [{ name: 'A', rol: 'INTOCMIT', functie: 'F1', email: 'a@x.ro' }],
      flowType: 'tabel',
    });
    const returnedDoc = await PDFDocument.load(Buffer.from(result.pdfB64, 'base64'));
    expect(returnedDoc.getPageCount()).toBe(2);
    expect(result.signerRects[0].page).toBe(2);  // pe pagina nouă

    // Și INVARIANTUL DIN v3.9.439: max(rect.page) <= getPageCount
    const maxRectPage = Math.max(...result.signerRects.map(r => r.page));
    expect(maxRectPage).toBeLessThanOrEqual(returnedDoc.getPageCount());
  });

  it('PDF aerisit (body scurt sus) → cartuș la bottom (nu gap, nu pagină nouă)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('Single line at top', { x: 40, y: 800, size: 12, font });
    const inputB64 = Buffer.from(await doc.save()).toString('base64');

    const result = await stampFooterOnPdf(inputB64, {
      flowId: 'test-light', createdAt: new Date().toISOString(),
      initName: 'Test', signers: [{ name: 'A', rol: 'INTOCMIT', functie: 'F1', email: 'a@x.ro' }],
      flowType: 'tabel',
    });
    const returnedDoc = await PDFDocument.load(Buffer.from(result.pdfB64, 'base64'));
    expect(returnedDoc.getPageCount()).toBe(1);
    expect(result.signerRects[0].page).toBe(1);
    // Cartuș jos (deasupra footer-ului) — y mic
    expect(result.signerRects[0].y).toBeLessThan(150);
  });
});

═══════════════════════════════════════════════════════════
PASUL 4 — Cache busting
═══════════════════════════════════════════════════════════

4.1 — package.json:
  old_str:   "version": "3.9.439",
  new_str:   "version": "3.9.440",

4.2 — public/sw.js:
  old_str: const CACHE_VERSION = 'docflowai-v155';
  new_str: const CACHE_VERSION = 'docflowai-v156';

4.3 — public/admin.html (dacă există referințe):
  sed -i 's/v=3\.9\.439/v=3.9.440/g' public/admin.html

═══════════════════════════════════════════════════════════
VERIFICARE OBLIGATORIE
═══════════════════════════════════════════════════════════

1. Funcțiile noi există:
   grep -c "function detectContentYs\|function findLowestUsableGap\|function detectMinContentY" server/index.mjs
   → 3

2. Logica gap placement aplicată:
   grep -c "gapPlacement\|lowestGap\|fitsAtBottom" server/index.mjs
   → ≥ 6

3. Sintaxă:
   node --check public/sw.js
   npm run check

4. Test specific de placement:
   npx vitest run server/tests/unit/stamp-footer-gap-placement.test.mjs
   → 3 passed

5. TESTE COMPLETE:
   npm test
   ATENȚIE: testul stamp-footer-page-count.test.mjs din v3.9.439
   trebuie să continue să fie verde (invariant max(rect.page)<=pageCount).

═══════════════════════════════════════════════════════════
COMMIT pe develop + cherry-pick pe main
═══════════════════════════════════════════════════════════

git add server/index.mjs \
        server/tests/unit/stamp-footer-gap-placement.test.mjs \
        public/sw.js \
        package.json

git commit -m "fix(pades): plasare cartus in largest empty band (v3.9.440)

Continuare fix v3.9.439 — algoritmul plasa cartusul DOAR la baza
paginii. Cand existau notite GDPR mici la y<60, requiredFreeY=184 era
depasit -> needsNewPage=true forta pagina noua si pentru PDF-uri cu
482pt de spatiu liber MID-PAGE.

Solutie: detectContentYs returneaza TOATE Y-urile de continut (nu doar
min). findLowestUsableGap gaseste cea mai joasa banda goala >= cartusH+30.
Daca exista gap utilizabil -> plasare mid-page (just deasupra continutului
inferior, semantic similar cu signature block). Fallback la pagina noua
DOAR daca nu exista nici gap nici loc la bottom.

Layout 3-tier:
  1. fitsAtBottom (PDF aerisit, body nu coboara mult) -> cartus jos
  2. gapPlacement (PDF cu body sus + GDPR jos) -> cartus in gap
  3. needsNewPage (PDF dens fara gap) -> pagina noua

Niciun fisier din zona NO-TOUCH atins. Java/STS/cloud-signing
continua sa primeasca rect.page valid (consistenta v3.9.439 pastrata).

Test regresie nou: stamp-footer-gap-placement.test.mjs cu 3 cazuri
(GDPR, dense, light).

Cache: 3.9.439 -> 3.9.440, SW v155 -> v156."

git push origin develop

# Hotfix production:
git checkout main
git pull origin main
git cherry-pick <COMMIT_HASH>
git push origin main

═══════════════════════════════════════════════════════════
TEST POST-DEPLOY
═══════════════════════════════════════════════════════════

1. Recreează fluxul cu același PDF care a generat PT_552313C132:
   → finalizează semnarea STS
   → PDF rezultat trebuie să aibă **1 PAGINĂ** (nu 2)
   → Cartușul vizibil mid-page, deasupra notiței GDPR
   → Notița GDPR vizibilă (nu acoperită)

2. Verifică în Railway logs noua linie de log:
   railway logs | grep "stampFooterOnPdf: decizie placement cartuș"
   → JSON cu fitsAtBottom, lowestGap, needsNewPage — interpretare ușoară

3. Test cu PDF DF (formular oficial dens, 4 semnatari):
   → ar trebui să forțeze pagină nouă (lipsă gap suficient)
   → fără regresie

4. Test cu PDF generat din Word (1 paragraf):
   → cartuș la bottom (fitsAtBottom = true)
   → fără regresie

STOP dacă:
- Cartușul apare pe pagina 1 dar SUPRAPUNE GDPR-ul
  → mărește GAP_MARGIN de la 15 la 25 în PASUL 2
- Cartușul apare prea aproape de body-ul de sus
  → verifică formula startY pentru gapPlacement; gapBottom + GAP_MARGIN
    + cartusTotalH trebuie să fie clar < gapTop
- Test stamp-footer-gap-placement.test.mjs eșuează la „cartuș în gap":
  → posibil pdf-lib emite Td/TD în loc de Tm pentru text — în acest
    caz detectContentYs nu prinde toate Y-urile; soluție: îmbunătățire
    parser cu Td (acumulator) sau folosire pdf-parse/pdfjs pentru
    detecție mai precisă

═══════════════════════════════════════════════════════════
RECUPERARE PDF-uri afectate (PT_552313, PT_3255 etc.)
═══════════════════════════════════════════════════════════

PDF-urile deja generate cu v3.9.439 (2 pagini) NU se actualizează
automat. Dacă inițiatorul vrea PDF cu cartuș mid-page:
  1. Anulează fluxul vechi
  2. Reinițiază flux nou cu același PDF original
  3. Noul flux folosește v3.9.440 → 1 pagină

Pentru fluxuri în curs (semnate parțial), nu poți re-genera fără
pierdere semnături. Fluxul rămâne 2-pagini, dar cartușul e funcțional.
```
