---
title: Fix — captura Forexebug se scurge între documente (openDoc nu resetează slotul principal)
model_suggested: Sonnet 4.6 (Default)   # frontend chirurgical, o singură atingere de logică
target_version: 3.9.725
branch: develop
migration: NU
cache_version_bump: NU   # formular/doc.js NU e în PRECACHE_ASSETS (verificat) — doar ?v=
---

# ⚠️ BRANCH: develop — NU atinge `main` (producție, o gestionează Mircea manual)

Un singur commit, un singur bump (3.9.724 → 3.9.725). Zero backend, zero migrație.

===============================================================================
## CONTEXT / CAUZĂ (verificat pe cod)
===============================================================================

Responsabilul CAB deschide DF/ORD, atașează captura Forexebug, iese FĂRĂ să
finalizeze, deschide alt document — și noul document afișează captura celui
anterior, deși n-a editat nimic.

Captura trăiește în `window.imgs` (`core.js:28`) + `src`-ul `<img>`-ului;
`showImg()` le setează, `clrImg()` le golește. Toate documentele se deschid prin
`openDoc(ft,id)` (`doc.js:691`). Blocul `// Captură` din openDoc face `showImg`
DOAR dacă serverul întoarce o imagine, dar **nu resetează niciodată slotul la
default înainte** ⇒ când noul document n-are captură, ramura `showImg` nu rulează
și rămâne `imgs['n-cimg']`/`['o-cimg']` + `src`-ul de la documentul anterior.

Asimetrie care confirmă fix-ul: slotul 2 de la ORD (`o-cimg2`) ARE deja garda, la
`doc.js:140` (`clrImg('o-cimg2','o-cph2'); // resetare default`). Slotul principal
(`o-cimg`/`n-cimg`) n-a primit-o niciodată în openDoc.

Severitate: nu e doar afișare. La salvare, `saveDoc` face
`if(imgs[ft==='ordnt'?'o-cimg':'n-cimg']) await uploadCaptura(ft,1)` (`doc.js:1047`),
deci dacă userul salvează noul document cu captura scursă, aceasta se **persistă pe
server pe documentul greșit**. Fix-ul închide ambele (după `clrImg`, `imgs` e null
⇒ nici salvarea nu urcă captura străină).

Fix = oglindim exact pattern-ul de la `doc.js:140`, pe slotul principal, în openDoc.

===============================================================================
## PAS 0 — PREFLIGHT (read-only)
===============================================================================

```bash
cd <repo>
git checkout develop && git pull --ff-only
git branch --show-current                          # Așteptat: develop
grep '"version"' package.json                      # Așteptat: "3.9.724"
grep -n 'formular/doc.js?v=' public/formular.html  # citește versiunea reală (aștept 3.9.698)
grep -rln 'formular/doc.js' public/*.html          # Așteptat: DOAR formular.html
grep -c 'formulare-capturi' public/js/formular/doc.js   # Așteptat: 2 (slot2 la ~141 + openDoc)
```

Dacă `version` ≠ 3.9.724, sau doc.js apare pe alte pagini → OPREȘTE-TE, raportează.

===============================================================================
## PAS 1 — doc.js: reset necondiționat al slotului principal în openDoc
===============================================================================

**old_str**
```javascript
    // Captură
    try{
      const capR=await fetch(`/api/formulare-capturi/${ftType(ft)}/${id}`,{credentials:'include'});
      if(capR.ok&&capR.headers.get('content-type')?.startsWith('image')){
        const blob=await capR.blob();
        const reader=new FileReader();
        reader.onload=e=>{
          const iid=ft==='ordnt'?'o-cimg':'n-cimg',phid=ft==='ordnt'?'o-cph':'n-cph';
          showImg(iid,phid,e.target.result);
        };
        reader.readAsDataURL(blob);
      }
    }catch(_){}
```
**new_str**
```javascript
    // Captură — resetare default ÎNAINTE de fetch. Altfel captura documentului
    // anterior persistă la openDoc→openDoc fără finalizare: leak vizual ȘI, dacă
    // userul salvează noul document, colN/colO citesc imgs['n-cimg']/['o-cimg'] →
    // saveDoc (uploadCaptura) ar urca captura străină pe documentul greșit.
    const _capIid=ft==='ordnt'?'o-cimg':'n-cimg',_capPh=ft==='ordnt'?'o-cph':'n-cph';
    clrImg(_capIid,_capPh);
    try{
      const capR=await fetch(`/api/formulare-capturi/${ftType(ft)}/${id}`,{credentials:'include'});
      if(capR.ok&&capR.headers.get('content-type')?.startsWith('image')){
        const blob=await capR.blob();
        const reader=new FileReader();
        reader.onload=e=>{
          showImg(_capIid,_capPh,e.target.result);
        };
        reader.readAsDataURL(blob);
      }
    }catch(_){}
```

> Notă: `o-cimg2` (slot 2 ORD) rămâne rezolvat separat la `doc.js:140` — NU-l atinge.

===============================================================================
## PAS 2 — test de regresie (fișier NOU, structural, în stil pagin-wiring)
===============================================================================

Creează `server/tests/unit/opendoc-capture-reset.test.mjs`:

```javascript
/**
 * Regresie: openDoc trebuie să reseteze slotul PRINCIPAL de captură ÎNAINTE de a
 * încărca documentul, altfel captura documentului anterior se scurge în cel nou
 * (bug raportat CAB, v3.9.725). Invariantă structurală ⇒ analiză pe sursă.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const docJs = readFileSync(join(__dir, '../../../public/js/formular/doc.js'), 'utf8');

describe('openDoc — reset captură principală (anti-leak între documente)', () => {
  it('clrImg pe slotul principal apare chiar înaintea fetch-ului de captură din openDoc', () => {
    // Marker unic pentru fetch-ul din openDoc (slotul 2 folosește un URL diferit, cu ?slot=2)
    const marker = 'formulare-capturi/${ftType(ft)}';
    const idx = docJs.indexOf(marker);
    expect(idx).toBeGreaterThan(-1);
    // În fereastra imediat dinaintea fetch-ului trebuie să existe resetul slotului principal.
    const before = docJs.slice(Math.max(0, idx - 300), idx);
    expect(before).toMatch(/clrImg\(_capIid\s*,\s*_capPh\)/);
  });

  it('slotul 2 ORD (o-cimg2) rămâne resetat separat (neatins)', () => {
    expect(docJs).toContain("clrImg('o-cimg2','o-cph2')");
  });
});
```

===============================================================================
## PAS 3 — formular.html: bump ?v= pe doc.js
===============================================================================

**old_str**
```html
<script src="/js/formular/doc.js?v=3.9.698" defer></script>
```
**new_str**
```html
<script src="/js/formular/doc.js?v=3.9.725" defer></script>
```

> ⚠️ Bump țintit DOAR pe doc.js. NU atinge celelalte `?v=` din pagină.

===============================================================================
## PAS 4 — bump versiune
===============================================================================

**old_str**
```json
  "version": "3.9.724",
```
**new_str**
```json
  "version": "3.9.725",
```

> ⛔ NU bump `CACHE_VERSION` din `public/sw.js` — doc.js nu e în PRECACHE. Lasă `docflowai-v297`.

===============================================================================
## PAS 5 — VERIFICARE
===============================================================================

```bash
node --check public/js/formular/doc.js             # Așteptat: fără erori
grep -c 'clrImg(_capIid,_capPh)' public/js/formular/doc.js   # Așteptat: 1
grep -n 'formular/doc.js?v=3.9.725' public/formular.html     # Așteptat: prezent
npm test                    # Așteptat: verde, inclusiv opendoc-capture-reset (2 teste noi)
git status --short          # Așteptat: doc.js, formular.html, opendoc-capture-reset.test.mjs, package.json = 4
```

Dacă `clrImg(_capIid,_capPh)` ≠ 1 sau testul nou nu trece → OPREȘTE-TE, raportează.

===============================================================================
## PAS 6 — COMMIT (doar develop)
===============================================================================

```bash
git add public/js/formular/doc.js public/formular.html \
        server/tests/unit/opendoc-capture-reset.test.mjs package.json
git status --short
git commit -m "fix: reset captura la openDoc — nu mai persistă captura documentului anterior v3.9.725"
git push origin develop
```

===============================================================================
## ACCEPTANCE MANUAL (Mircea, pe staging, hard refresh)
===============================================================================

1. Deschide DF #A, atașează o captură, NU finaliza.
2. Deschide DF #B (care NU are captură) → slotul de captură trebuie să fie GOL
   (placeholder), nu captura lui #A.
3. Repetă DF→ORD și ORD→DF (leak cross-tip: `n-cimg` ↔ `o-cimg`).
4. Deschide un document care ARE captură → captura lui proprie apare corect.
5. Verifică slotul 2 ORD („Informații complete contract") — neschimbat.
6. (opțional) Deschide #A cu captură, apoi #B fără, SALVEAZĂ #B → pe server #B NU
   trebuie să primească captura lui #A.

===============================================================================
## RAPORT FINAL (completează după rulare)
===============================================================================

- [ ] Versiune: 3.9.724 → 3.9.725
- [ ] `clrImg(_capIid,_capPh)` = 1 în doc.js; slotul 2 (`o-cimg2`) neatins
- [ ] doc.js?v=3.9.725 pe formular.html; restul `?v=` neatinse
- [ ] `CACHE_VERSION` NEATINS (docflowai-v297)
- [ ] `npm test` verde, opendoc-capture-reset (2 teste) prezent
- [ ] git status curat înainte de commit; commit + push pe develop
- [ ] Commit hash: __________
- [ ] Observații / abateri: __________

===============================================================================
## ⛔ CONSTRÂNGERI ABSOLUTE
===============================================================================

- ⛔ Doar `develop`. Zero `main`.
- ⛔ O SINGURĂ atingere de logică: blocul `// Captură` din openDoc. NU atinge
     `newDoc`/`resetF`/`saveDoc`/`uploadCaptura`/`colN`/`colO`, nici slotul 2 (`o-cimg2`).
- ⛔ Zero backend, zero migrație, zero `.sql`. NU bump `CACHE_VERSION`.
- ⛔ NU bulk-sed pe `?v=` — doar doc.js.
- ⛔ Păstrează `showImg`/`clrImg` neschimbate (le folosim, nu le modificăm).
- ⛔ old_str negăsit / versiune ≠ 724 / doc.js pe alte pagini → oprește-te, raportează.
