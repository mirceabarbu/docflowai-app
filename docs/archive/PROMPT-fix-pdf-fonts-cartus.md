# Fix combo: fonturi Calibri-compatible în Docker + reducere SAFETY_MARGIN cartuș

## ⚠️ BRANCH DEVELOP EXCLUSIV

NU face `git checkout main`, NU face `git merge main`, NU face `git push origin main`.
Toată munca rămâne pe `develop`. Verifică `git branch --show-current` înainte de orice commit.

## Context — diagnostic confirmat

S-au identificat **2 bug-uri distincte și independente** care apar simultan la inițierea unui flux cu DOCX uploaded:

### Bug A: text justify rearanjat + diacritice șterse după conversia LibreOffice

**Cauza** — Dockerfile-ul instalează doar `fonts-liberation` + `fonts-dejavu-core`. DOCX-urile generate de Microsoft Office folosesc **Calibri** ca default font (din 2007 încoace). LibreOffice de pe Railway nu găsește Calibri și cade pe Liberation Sans, care **nu e metric-compatible cu Calibri** — width-urile glyf-urilor diferă, justify-ul calculat pentru Calibri se aplică pe glyf-uri Liberation → break-uri de linie deplasate, alinieri ratate, diacritice românești randate inconsistent (depinde de coverage-ul glyf-urilor fallback).

PDF-ul iese **deja stricat din LibreOffice**, înainte de orice procesare Node. Conversia a fost dovedită pe DOCX `raspuns_adresa_22_04.docx` (al unui client din Primaria Test): cu Carlito instalat local, PDF-ul are justify perfect, diacritice corecte; cu doar Liberation, exact comportamentul raportat.

**Fix** — adaugă în Dockerfile pachetele Debian `fonts-crosextra-carlito` (clon free Calibri-metric-compatible, dezvoltat de Google pentru ChromeOS) și `fonts-crosextra-caladea` (clon Cambria). Ambele sunt în repository-ul standard Debian/Ubuntu, fără dependențe ciudate, license OFL.

### Bug B: pagină albă suplimentară adăugată inutil pentru PDF-uri dense

**Cauza** — în `server/index.mjs:1167`, `SAFETY_MARGIN = 60` (folosit în calculul `requiredFreeY = (footerY + 32) + cartusTotalH + SAFETY_MARGIN`). Pentru un PDF de o pagină cu body-ul care coboară aproape de footer (cum sunt PDF-urile densely-formatted gen scrisori comerciale), `minContentY` (Y-ul minim al conținutului real) e ~165-180pt, iar `requiredFreeY` cu SAFETY_MARGIN=60 ajunge la ~184pt. Diferența de doar 15-20pt face ca `fitsAtBottom = false`, `lowestGap = null`, deci `needsNewPage = true`. Apoi pagina nouă e creată goală (doar cu cartuș sus și footer jos) — total inutil când vizual era loc pe pagina existentă.

**Reproducere pe DOCX-ul Mircea**: `minContentY = 167`, `requiredFreeY = 184` (cu SAFETY_MARGIN=60) → `needsNewPage = true`. Cu SAFETY_MARGIN=25, `requiredFreeY = 149` → `fitsAtBottom = true` (167 ≥ 149) → cartușul plasat pe pagina existentă, NU se mai creează pagină nouă.

**Fix** — reduce `SAFETY_MARGIN` de la 60 la 25. Justificare:
- Cartușul desenat are titleH=20 + rows*cellH (≤78pt per row) → înălțime totală maximă ~330pt pentru 4+ semnatari
- Cu SAFETY_MARGIN=25, cartușul stă la minim 25pt sub body-ul existent — vizual confortabil, fără overlap
- Pentru PDF-uri foarte aerisite, comportamentul e neschimbat (fitsAtBottom rămâne true)
- Pentru PDF-uri dense, evită pagina goală inutilă
- Pentru PDF-uri unde body-ul ajunge până la footer (`minContentY < ~80`), tot intră în branch-ul `lowestGap` sau `needsNewPage` corect

===============================================================================

## Pas 1 — Verifică starea curentă

```bash
git branch --show-current
# Așteptat: develop

grep -n "SAFETY_MARGIN" server/index.mjs
# Așteptat: o singură linie: 1167:    const SAFETY_MARGIN = 60;

grep -n "fonts-" Dockerfile
# Așteptat: 2 linii (fonts-liberation, fonts-dejavu-core)
```

===============================================================================

## Pas 2 — Fix A: adaugă fonturi Calibri-compatible în Dockerfile

Editează `Dockerfile`. După linia `fonts-dejavu-core \`, adaugă 2 linii noi `fonts-crosextra-carlito \` și `fonts-crosextra-caladea \`. Rezultatul final al secțiunii RUN:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
  libreoffice-writer \
  libreoffice-calc \
  libreoffice-impress \
  libreoffice-draw \
  fonts-liberation \
  fonts-dejavu-core \
  fonts-crosextra-carlito \
  fonts-crosextra-caladea \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*
```

Verificare:

```bash
grep -E "fonts-(liberation|dejavu|crosextra)" Dockerfile
# Așteptat: 4 linii
```

===============================================================================

## Pas 3 — Fix B: reduce SAFETY_MARGIN în stampFooterOnPdf

În `server/index.mjs` linia 1167, modifică `60` în `25`. Folosește str_replace pe blocul de context pentru a fi sigur că modifici fix linia corectă (sunt multe `60` în fișier):

```javascript
// ÎNAINTE:
      // Try 1: bottom placement clasic (pentru PDF-uri aerisite — body-ul nu
      //         coboară până jos). Cartușul stă lipit de footer.
      const SAFETY_MARGIN = 60;

// DUPĂ:
      // Try 1: bottom placement clasic (pentru PDF-uri aerisite — body-ul nu
      //         coboară până jos). Cartușul stă lipit de footer.
      // v3.9.492: redus de la 60 la 25 — PDF-uri Office dense (scrisori, formulare)
      //   au body până aproape de footer. 60pt forța pagină nouă chiar și când
      //   diferența era de doar 10-20pt. 25pt e suficient pentru separare vizuală
      //   cartuș/body fără overlap. Repro: raspuns_adresa_22_04.docx → minContentY=167,
      //   requiredFreeY cu 60 = 184 (fails), cu 25 = 149 (fits).
      const SAFETY_MARGIN = 25;
```

Verificare:

```bash
grep -n "SAFETY_MARGIN" server/index.mjs
# Așteptat: o singură linie, acum cu 25
```

===============================================================================

## Pas 4 — Adaugă un test integration pentru regresie placement cartuș

Creează `server/tests/integration/stamp-cartus-placement.test.mjs` cu un test care verifică matematic decizia placement pentru PDF-ul Mircea. Asta previne regresia dacă cineva reactivează SAFETY_MARGIN=60 sau modifică formula.

```javascript
// stamp-cartus-placement.test.mjs
//
// Test guard: pentru un PDF de o pagină A4 cu body dens până aproape de footer
// (caz raportat — raspuns_adresa_22_04.docx, minContentY=167), cartușul de 2
// semnatari TREBUIE plasat pe pagina existentă, NU pe pagină nouă.
//
// Repro istoric: SAFETY_MARGIN=60 → needsNewPage=true (pagină albă suplimentară).
// Cu SAFETY_MARGIN=25 → fitsAtBottom=true → cartuș pe pagina existentă.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

describe('stampFooterOnPdf: placement cartuș pentru PDF-uri dense', () => {
  it('SAFETY_MARGIN trebuie ≤ 30 pentru a permite plasare pe pagină existentă când minContentY≥150', () => {
    const src = readFileSync(path.join(REPO, 'server/index.mjs'), 'utf8');
    const m = src.match(/const SAFETY_MARGIN\s*=\s*(\d+)/);
    expect(m, 'SAFETY_MARGIN definition not found in server/index.mjs').toBeTruthy();
    const safetyMargin = parseInt(m[1], 10);
    expect(safetyMargin, 'SAFETY_MARGIN > 30 va cauza pagină albă suplimentară pe PDF-uri Office dense — vezi raspuns_adresa_22_04.docx repro').toBeLessThanOrEqual(30);
  });

  it('formula requiredFreeY pentru 2 semnatari cu PDF dens (minContentY=167) → fitsAtBottom=true', () => {
    const footerY = 14;
    const cartusTotalH = 78; // 1 row × cellHCheck=78 pentru pH=842
    const SAFETY_MARGIN = 25; // valoarea așteptată după fix
    const requiredFreeY = (footerY + 32) + cartusTotalH + SAFETY_MARGIN;
    const minContentY = 167; // raspuns_adresa_22_04.docx
    const fitsAtBottom = (minContentY >= requiredFreeY);
    expect(fitsAtBottom, `cu SAFETY_MARGIN=${SAFETY_MARGIN}, requiredFreeY=${requiredFreeY}, minContentY=${minContentY} → ar trebui să fits`).toBe(true);
  });
});
```

===============================================================================

## Pas 5 — Rulează testele

```bash
npm test 2>&1 | tail -30
```

**Așteptat:**
- noul test `stamp-cartus-placement.test.mjs` rulează cu 2 it() — ambele verzi
- nicio regresie pe restul suite-ului (npm test verde, fără regresii)

===============================================================================

## Pas 6 — Bump versiune

```bash
sed -i 's/"version": "3.9.491"/"version": "3.9.492"/' package.json
grep '"version"' package.json
# Așteptat: "version": "3.9.492",

sed -i "s/CACHE_VERSION = 'docflowai-v206'/CACHE_VERSION = 'docflowai-v207'/" public/sw.js
grep CACHE_VERSION public/sw.js | head -1
# Așteptat: const CACHE_VERSION = 'docflowai-v207';
```

===============================================================================

## Pas 7 — Commit + push

```bash
git add Dockerfile server/index.mjs server/tests/integration/stamp-cartus-placement.test.mjs package.json public/sw.js
git status
# Așteptat: 5 fișiere modificate, niciun untracked

git commit -m "fix(pdf): fonts Calibri-compatible (Carlito/Caladea) în Docker + SAFETY_MARGIN cartuș 60→25 pentru PDF-uri Office dense"
git push origin develop
```

===============================================================================

## RAPORT FINAL

La final raportează exact:

1. **Diff Dockerfile:** confirmă cele 2 linii adăugate (fonts-crosextra-carlito + fonts-crosextra-caladea)
2. **Diff server/index.mjs:** confirmă SAFETY_MARGIN 60 → 25 + comment explicativ
3. **Test nou:** path și număr de `it()` adăugate
4. **Rezultat npm test:** verde sau roșu? Câte teste rulează acum față de înainte?
5. **Versiune:** 3.9.491 → 3.9.492 (package.json), v206 → v207 (sw.js)
6. **Commit SHA:** primele 7 caractere
7. **Push:** confirmare `develop -> develop`

**Verificare manuală OBLIGATORIE după deploy staging** (Railway auto-deploy pe push develop, ~2-3 min):

```
1. Login app.docflowai.ro (staging)
2. Inițiază flux NOU cu DOCX-ul raspuns_adresa_22_04.docx (sau orice DOCX similar)
3. Confirm: PDF-ul afișat are JUSTIFY păstrat + diacritice românești corecte (poziții cu ț, hărți cu ă+ț, etc.)
4. Confirm: NU mai apare pagină albă suplimentară între body și pagina cu cartuș
5. Cartușul TREBUIE să apară pe ACEEAȘI pagină cu body-ul, deasupra footer-ului
```

Dacă Bug A persistă (text încă "stricat" după deploy), verifică pe Railway container că fonturile s-au instalat:

```bash
# Pe Railway shell (dacă accesibil):
fc-list | grep -iE "carlito|caladea"
# Așteptat: linii cu /usr/share/fonts/.../Carlito-*.ttf + Caladea-*.ttf
```

Dacă lipsesc, înseamnă că Dockerfile build-ul a folosit cache vechi — invalidează cache-ul pe Railway (Settings → Redeploy fresh).

===============================================================================

## ⚠️ CONSTRÂNGERI ABSOLUTE — NO-TOUCH

NU modifica niciun fișier din lista de mai jos (per `CLAUDE.md`):

```
server/signing/providers/STSCloudProvider.mjs
server/routes/flows/cloud-signing.mjs
server/routes/flows/bulk-signing.mjs
server/signing/pades.mjs
server/signing/java-pades-client.mjs
```

NU atinge `detectContentYs()` sau `findLowestUsableGap()` (parser fragil pe content streams cu format exotic — risc să strici și mai mult). Doar modifică constanta `SAFETY_MARGIN` care e parametru al deciziei, NU parserul în sine.

NU atinge `pdfLooksSigned()` (poate cauza rescrierea PDF-urilor deja semnate — risc invalidare semnături calificate existente).

NU schimba `useObjectStreams: !isAncore` la linia 1274 (am dovedit local că NU e cauza problemei — pdf-lib păstrează corect fonturile și layout-ul independent de useObjectStreams pe DOCX-ul testat).

NU schimba branch (rămâi pe `develop` tot timpul). NU face merge cu `main`. NU rula `git checkout main` sub nicio formă.

Dacă vreun pas eșuează (test guard sau npm test roșu), OPREȘTE-TE și raportează diff-ul exact și mesajul de eroare — NU încerca să "repari" prin relaxarea testului sau ștergere de cod.
