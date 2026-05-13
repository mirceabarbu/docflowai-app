# DocFlowAI — 🚨 HOTFIX STS: stampFooterOnPdf save-order bug (v3.9.439)

```
DocFlowAI v3.9.438 → v3.9.439 (SW v154 → v155)
Branch: develop (apoi cherry-pick → main pentru production)
Subiect: hotfix(pades): salvează PDF DUPĂ addPage cartuș (page mismatch fix)

═══════════════════════════════════════════════════════════
DIAGNOSTIC — BUG REAL în server/index.mjs:stampFooterOnPdf
═══════════════════════════════════════════════════════════

SIMPTOM observat:
  Java signing service:
    INFO: prepare: câmp NOU la (40.0,733.8898) 515.30396x65.0
    INFO: drawCustomCartus: OK — 515.30396x65.0
    ERROR: java.lang.IndexOutOfBoundsException: Requested page number 2
           is out of bounds.

CAUZĂ ROOT (BUG VECHI — pre-existent, NU este de la refactorul org v3.9.437):

  Funcția stampFooterOnPdf în server/index.mjs salvează PDF-ul ÎNAINTE
  de a adăuga pagina nouă pentru cartuș (când e necesară).

  Ordinea actuală a operațiilor:
    1. drawText footer pe ultima pagină existentă
    2. ❌ pdfDoc.save() → stampedPdfB64   ← SALVAT AICI, ÎNAINTE
    3. signerRects: detectează needsNewPage prin detectMinContentY
    4. Dacă needsNewPage = true:
         pdfDoc.addPage(...)              ← se adaugă pagina ÎN pdfDoc
         drawText footer pe pagina nouă
         cartusPageNum = pdfDoc.getPageCount()  → N+1
    5. signerRects.push({ page: cartusPageNum, ... })
    6. return { pdfB64: stampedPdfB64, signerRects }
                          ↑                 ↑
                     PDF cu N pagini   rect cu page=N+1
                     (vechiul snapshot,   (referă pagina
                      fără pagina nouă)    nouă)

  Rezultat: padesRect.page = 2 dar PDF-ul are doar 1 pagină.
  STS callback → cloud-signing.mjs trimite la Java:
    page: sigPage = 2,  pdfBase64: <PDF cu 1 pagină>
  Java:
    appearance.setPageNumber(2);
    signer.signExternalContainer(...);  ← iText: page 2 not found → IOOBE

DE CE A „MERS PÂNĂ IERI":
  Bug-ul e LATENT — apare DOAR când needsNewPage = true (PDF dens,
  cartușul nu încape pe ultima pagină existentă). Pentru PDF-uri mai
  aerisite, needsNewPage = false → cartușul se desenează pe pagina N
  existentă → page=N corect → save ordering nu contează.

  PDF-ul „Proba_landscape" (sau orice PDF dens-completat) declanșează
  needsNewPage=true → bug exposed.

  Confirmă observația: în producție (cod de 3 zile, neatins de
  refactor) același bug. Era latent până azi când a fost testat cu
  PDF-ul declanșator.

═══════════════════════════════════════════════════════════
ZONĂ NO-TOUCH — RESPECTATĂ INTEGRAL
═══════════════════════════════════════════════════════════
- server/signing/providers/STSCloudProvider.mjs   — NEATINS
- server/routes/flows/cloud-signing.mjs           — NEATINS
- server/routes/flows/bulk-signing.mjs            — NEATINS
- server/signing/pades.mjs                        — NEATINS
- server/signing/java-pades-client.mjs            — NEATINS
- microserviciul Java                             — NEATINS

  Atingem DOAR server/index.mjs:stampFooterOnPdf — în afara zonei
  NO-TOUCH conform regulilor proiectului. Funcția desenează footer
  + decide poziția cartușului, NU implementează logica de signing.

═══════════════════════════════════════════════════════════
PASUL 1 — Mutarea pdfDoc.save() DUPĂ addPage
═══════════════════════════════════════════════════════════

În server/index.mjs, în funcția stampFooterOnPdf (în jurul liniei 1031),
mută calculul `stampedPdfB64` din locul curent (înainte de `signerRects`)
DUPĂ blocul `if (signers.length) { ... }`.

old_str:
    const isAncore = flowData.flowType === 'ancore';
    const stampedPdfB64 = Buffer.from(await pdfDoc.save({ useObjectStreams: !isAncore })).toString('base64');

    const signerRects = [];
    const signers = Array.isArray(flowData.signers) ? flowData.signers : [];

new_str:
    const isAncore = flowData.flowType === 'ancore';

    const signerRects = [];
    const signers = Array.isArray(flowData.signers) ? flowData.signers : [];

ȘI mută definiția lui `stampedPdfB64` JOS:

old_str:
        // h=65: 7 linii (6 + linia delegare opțională) + padding + chenar
        signerRects.push({ page: cartusPageNum, x, y, w: cellW, h: 65 });
      }
    }

    if (signerRects.length) return { pdfB64: stampedPdfB64, signerRects };
    return stampedPdfB64;

new_str:
        // h=65: 7 linii (6 + linia delegare opțională) + padding + chenar
        signerRects.push({ page: cartusPageNum, x, y, w: cellW, h: 65 });
      }
    }

    // FIX v3.9.439: salvăm PDF-ul DUPĂ ce eventual s-a adăugat pagina
    // nouă pentru cartuș. Anterior, save-ul era ÎNAINTE de addPage →
    // padesRect.page=N+1 dar PDF-ul salvat avea doar N pagini → Java
    // arunca IndexOutOfBoundsException la signExternalContainer.
    const stampedPdfB64 = Buffer.from(await pdfDoc.save({ useObjectStreams: !isAncore })).toString('base64');

    if (signerRects.length) return { pdfB64: stampedPdfB64, signerRects };
    return stampedPdfB64;

═══════════════════════════════════════════════════════════
PASUL 2 — Test de regresie
═══════════════════════════════════════════════════════════

Adaugă un test unit care verifică că PDF-ul returnat are ACELAȘI
număr de pagini ca cel maxim referit în signerRects. Locație recomandată:
server/tests/unit/stamp-footer-page-count.test.mjs

create_file:
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';

describe('stampFooterOnPdf: signerRects.page vs actual pageCount', () => {
  let stampFooterOnPdf;

  beforeAll(async () => {
    // Importăm dinamic — modulul îl expune din server/index.mjs prin diInjector
    const mod = await import('../../index.mjs');
    stampFooterOnPdf = mod.stampFooterOnPdf || mod.default?.stampFooterOnPdf;
    expect(typeof stampFooterOnPdf).toBe('function');
  });

  // Helper: generează PDF dens (fill complet ultima pagină → forțează needsNewPage)
  async function buildDensePdfB64() {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);  // A4 portrait
    const font = await doc.embedFont(StandardFonts.Helvetica);
    // Umplere conținut până jos (lasă <60pt liber în partea de jos)
    for (let y = 800; y >= 60; y -= 10) {
      page.drawText(`linie densă la y=${y}`, { x: 40, y, size: 8, font });
    }
    const bytes = await doc.save();
    return Buffer.from(bytes).toString('base64');
  }

  it('PDF dens → needsNewPage=true → returnat trebuie să aibă pagina referită în signerRects', async () => {
    const inputB64 = await buildDensePdfB64();
    const result = await stampFooterOnPdf(inputB64, {
      flowId: 'test-flow', createdAt: new Date().toISOString(),
      initName: 'Test', initFunctie: 'Tester', institutie: 'Test', compartiment: 'QA',
      signers: [
        { name: 'A', rol: 'INTOCMIT',  functie: 'F1', email: 'a@x.ro' },
        { name: 'B', rol: 'APROBAT',   functie: 'F2', email: 'b@x.ro' },
      ],
      flowType: 'tabel',
    });

    expect(result).toBeTruthy();
    expect(typeof result === 'object').toBe(true);
    expect(Array.isArray(result.signerRects)).toBe(true);
    expect(result.signerRects.length).toBe(2);

    // Reîncărcăm PDF-ul returnat și numărăm paginile
    const returnedDoc = await PDFDocument.load(Buffer.from(result.pdfB64, 'base64'));
    const actualPageCount = returnedDoc.getPageCount();

    // INVARIANT CRITIC: max(signerRects.page) <= actualPageCount
    const maxRectPage = Math.max(...result.signerRects.map(r => r.page));
    expect(maxRectPage).toBeLessThanOrEqual(actualPageCount);
  });

  it('PDF aerisit → needsNewPage=false → page === N (rămâne 1)', async () => {
    // PDF cu o singură linie — multă spațiu liber → cartușul încape pe page 1
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('hello world', { x: 40, y: 800, size: 12, font });
    const inputB64 = Buffer.from(await doc.save()).toString('base64');

    const result = await stampFooterOnPdf(inputB64, {
      flowId: 'test-flow', createdAt: new Date().toISOString(),
      initName: 'Test', signers: [{ name: 'A', rol: 'INTOCMIT', functie: 'F1', email: 'a@x.ro' }],
      flowType: 'tabel',
    });
    expect(result.signerRects[0].page).toBe(1);
    const returnedDoc = await PDFDocument.load(Buffer.from(result.pdfB64, 'base64'));
    expect(returnedDoc.getPageCount()).toBe(1);
  });
});

NOTĂ: dacă `stampFooterOnPdf` NU este exportat din `server/index.mjs`,
verifică prin:
  grep "export.*stampFooterOnPdf\|module.exports.*stampFooterOnPdf" server/index.mjs

Dacă nu este exportat, adaugă la finalul lui server/index.mjs:
  export { stampFooterOnPdf };

═══════════════════════════════════════════════════════════
PASUL 3 — Cache busting
═══════════════════════════════════════════════════════════

3.1 — package.json:
  old_str:   "version": "3.9.438",
  new_str:   "version": "3.9.439",

3.2 — public/sw.js:
  old_str: const CACHE_VERSION = 'docflowai-v154';
  new_str: const CACHE_VERSION = 'docflowai-v155';

3.3 — public/admin.html (dacă există):
  sed -i 's/v=3\.9\.438/v=3.9.439/g' public/admin.html

═══════════════════════════════════════════════════════════
VERIFICARE OBLIGATORIE
═══════════════════════════════════════════════════════════

1. Save mutat la locul corect:
   awk '/const stampedPdfB64 = Buffer.from\(await pdfDoc.save/{ count++; print NR": "$0 } END{print "TOTAL: "count}' server/index.mjs
   → exact 1 ocurență, în interiorul stampFooterOnPdf, DUPĂ blocul if(signers.length)

2. Niciun import de save înainte de signerRects:
   grep -B 1 "const signerRects = \[\]" server/index.mjs | head -5
   → linia anterioară NU trebuie să fie const stampedPdfB64=...

3. Test rulat verde:
   npx vitest run server/tests/unit/stamp-footer-page-count.test.mjs
   → 2 passed

4. TESTE COMPLETE:
   npm test
   ATENȚIE: testele existente pe stampFooterOnPdf (din
   flows-create.test.mjs, df-refuse-restore.test.mjs etc.) folosesc
   stub-uri vi.fn() — neafectate de fix.

5. Sintaxă:
   npm run check

═══════════════════════════════════════════════════════════
COMMIT pe develop + cherry-pick pe main pentru production hotfix
═══════════════════════════════════════════════════════════

# Pe develop:
git add server/index.mjs \
        server/tests/unit/stamp-footer-page-count.test.mjs \
        public/sw.js \
        package.json

git commit -m "hotfix(pades): salveaza PDF DUPA addPage cartus (page mismatch fix) (v3.9.439)

BUG ROOT (pre-existent, latent): stampFooterOnPdf in server/index.mjs
salva pdfDoc INAINTE de blocul care eventual adauga pagina noua pentru
cartus. Cand needsNewPage=true (PDF dens), padesRect.page=N+1 dar PDF-ul
returnat avea doar N pagini. La signing, Java primea PDF cu N pagini si
cerea widget pe pagina N+1 -> IndexOutOfBoundsException.

Fix: const stampedPdfB64 = pdfDoc.save() mutat din pozitia ~1031
in pozitia ~1135 (dupa loop-ul signerRects.push), garantand ca PDF-ul
salvat are deja pagina noua daca s-a adaugat.

Trigger: PDF-uri suficient de dense incat detectMinContentY sa decida
needsNewPage=true. Pentru PDF-uri aerisite, bug-ul era latent.

Niciun fisier din zona NO-TOUCH (STS, cloud-signing, pades.mjs,
java-pades-client, Java service) modificat — fix-ul este la nivelul
generatorului de footer.

Test regresie nou: server/tests/unit/stamp-footer-page-count.test.mjs
verifica invariantul max(signerRects.page) <= pdfDoc.getPageCount().

Cache: 3.9.438 -> 3.9.439, SW v154 -> v155."

git push origin develop

# HOTFIX la production (main):
# Daca develop are alte commit-uri ne-mergeate in main de 3+ zile,
# folosim cherry-pick pentru a aplica DOAR acest fix:

git checkout main
git pull origin main
git cherry-pick <COMMIT_HASH_FROM_DEVELOP>
# Rezolva conflicte daca exista (nu ar trebui — fix izolat)
git push origin main

# Railway va auto-deploya production-ul.

═══════════════════════════════════════════════════════════
TEST POST-DEPLOY (atât staging cât și production)
═══════════════════════════════════════════════════════════

1. Reîncearcă semnarea PT_14FB0CF7CE (sau creează flux nou cu același
   PDF dens „Proba_landscape"):
   → STS callback → Java prepare → fără IndexOutOfBoundsException
   → semnătură finalizată cu succes

2. Verifică în log-urile Java service-ului că NU mai apare:
   railway logs --service docflowai-signing-service | grep "out of bounds"
   → 0 ocurențe noi după deploy

3. Test cu PDF aerisit (pentru regresie):
   → semnarea continuă să funcționeze (cartuș pe pagină existentă)

4. Verifică în DB că noile fluxuri au padesRect.page consistent cu PDF:
   SELECT id, data->'signers'->0->'padesRect'->>'page' AS rect_page,
          octet_length((data->>'pdfB64')::bytea) AS pdf_size
     FROM flows WHERE created_at > NOW() - INTERVAL '1 hour';
   → rect_page coerent cu mărimea PDF-ului (PDF mare → rect_page 2,
     PDF mic → rect_page 1)

STOP dacă:
- Eroarea persistă pe fluxul nou → confirmă cu grep că fix-ul a
  fost aplicat: grep -n "FIX v3.9.439" server/index.mjs (1 ocurență)
- Java service încă raportează „out of bounds" → posibil ai încă
  fluxuri vechi cu padesRect corupt în DB; pentru ele trebuie repair
  manual sau reupload PDF
- Test regression eșuează → verifică export-ul stampFooterOnPdf
  din server/index.mjs

═══════════════════════════════════════════════════════════
REPAIR fluxuri afectate (opțional, dacă există în DB)
═══════════════════════════════════════════════════════════

Fluxurile create în ultimele zile cu PDF-uri dense au padesRect.page
greșit în DB. Două opțiuni:

A. Cere inițiatorului să anuleze și să reinițieze fluxul cu același
   PDF — la creare nouă, fix-ul aplicat va seta corect rect.page.

B. Dacă vrei să le repari în loc, rulează SQL-ul:
   UPDATE flows
      SET data = jsonb_set(
            data,
            '{signers}',
            (SELECT jsonb_agg(
                CASE WHEN s->'padesRect' IS NOT NULL
                  THEN jsonb_set(s, '{padesRect,page}',
                       to_jsonb((s->'padesRect'->>'page')::int - 1))
                ELSE s END)
              FROM jsonb_array_elements(data->'signers') s)
          )
    WHERE id IN ('PT_6ADE21C4B3', 'PT_14FB0CF7CE'); -- adaugă ID-urile afectate

Verifică ÎNAINTE dacă PDF-ul are într-adevăr o pagină mai puțin decât
rect.page înainte de a aplica:
  SELECT id, data->'signers'->0->'padesRect'->>'page' AS rect_page,
         (SELECT COUNT(*) FROM jsonb_array_elements(data->'signers'))
    FROM flows WHERE id = 'PT_14FB0CF7CE';
```
