---
prompt: 174
titlu: "O singură cale de lansare din ALOP: prefill-ul semnatarilor scris într-un singur loc"
model_suggested: "Sonnet 5, efort high"
branch: develop
versiune_curenta: v3.9.828
versiune_tinta: v3.9.829
migratii: NU
fisiere_din_public: DA  (UN singur fișier JS ⇒ bump `?v=` țintit; CACHE_VERSION — vezi Etapa 0)
zona_no_touch_atinsa: NU
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Pasul final obligatoriu: `git push origin develop`.

---

## Context — defect REPRODUS pe staging (03.09.2026, v3.9.828)

După #172 (setul complet de roluri), #172b (cursa de inițializare) și #173 (ecranul de
configurare), lansarea unui flux **din cardul ALOP** afișează în continuare cele **3 rânduri
implicite** ale ecranului (`ÎNTOCMIT/Inspector`, `VIZAT/Șef structură`, `APROBAT/Conducător`),
nu rolurile dosarului.

### Cauza — enumerare COMPLETĂ a navigărilor spre ecranul de flux

Există **exact trei** locuri care navighează cu `action=new_flow_prefill`:

| loc | folosit de | scrie `docflow_prefill_signers`? |
|---|---|---|
| `public/js/formular/core.js:953` (`mkFlow`) | butonul „Lansează flux semnare" **din documentul deschis** (`doc.js:809`) | **DA** — prin patch-ul din `alop.js` |
| `public/js/formular/alop.js:1116` (`alopLaunchDfFlow`) | butoanele **din cardul ALOP** | **NU** |
| `public/js/formular/alop.js:1145` (`alopLaunchOrdFlow`) | butoanele **din cardul ALOP** | **NU** |

(`bulk-signer.html:150` e un `<a href>` simplu, fără parametri de prefill — irelevant.)

Prefill-ul trăiește DOAR în patch-ul lui `mkFlow` (`alop.js:1418-1453`). Cele două `alopLaunch*`
fac `location.href = …` direct, ocolindu-l complet. Deci calea pe care utilizatorul o folosește
în mod normal — butoanele din card — n-a avut niciodată prefill.

⚠️ **#172, #172b și #173 sunt corecte pe ce ating.** Fără ele, calea reparată aici ar fi dat tot
un singur rând (filtrul), ar fi fost ștearsă de implicite (cursa) sau n-ar fi avut ce configura
(ecranul). Lipsea a patra piesă: **aceeași cale pentru toate butoanele.**

## Decizia

> Construcția prefill-ului devine **o funcție unică**, apelată din toate cele trei locuri.
> Cheia `docflow_prefill_signers` se scrie într-**un singur loc din tot codul**, iar un test
> static ține invariantul, ca a patra cale de mâine să nu apară pe furiș.

---

## Fapte VERIFICATE pe codul v3.9.828

- `alopLaunchDfFlow` (`:1101`) și `alopLaunchOrdFlow` (`:1122`) sunt **ÎN interiorul IIFE-ului**
  din `alop.js` și sunt exportate la `:1386-1387`.
- Patch-ul `mkFlow` e **ÎN AFARA IIFE-ului**, într-un handler `DOMContentLoaded` la finalul
  fișierului (`:1410`). ⇒ funcția partajată trebuie definită în IIFE **și expusă pe `window`**,
  altfel patch-ul n-o vede. Model deja folosit în proiect: blocul de exporturi de la `:1378+`.
- `window._alopContext` e setat la `:647`, `:965`, `:1024`, `:1349` și conține
  `{alopId, titlu, valoare, dfSemnatari, ordSemnatari}`.
- `sessionStorage['alop_id_for_flow']` e citit în `semdoc-initiator/main.js:2358-2359` **doar ca
  rezervă** pentru parametrii din URL. Calea din card îi pune deja în URL ⇒ **nu** e nevoie să
  scrii cheia și acolo. Nu o adăuga.
- `ALOP_ROL` e definit o singură dată azi, local în handlerul `DOMContentLoaded` (`:1414`).

---

## ⛔ Ce NU se atinge

- **NU** modifica pașii „Pas 1" din `alopLaunch*` (apelurile `link-df` / `link-ord`) și nici
  „Pas 0" din `alopLaunchOrdFlow` (`genPdf`). Ordinea lor față de navigare rămâne EXACT aceeași.
- **NU** schimba parametrii din URL construiți de cele două funcții.
- **NU** atinge `public/js/semdoc-initiator/main.js` (#172b e corect acolo) și nici
  `public/js/formular/core.js`.
- **NU** adăuga `alop_id_for_flow` pe calea din card.
- **NU** atinge `alop.js:787` (`filter(u=>…)` — previzualizarea din card).
- **NU** atinge legătura cu documentul la „Renunță" — e lotul #175, separat.
- Zero server, zero migrații.

---

## ETAPA 0 — ancore (READ-ONLY)

```bash
cd "$(git rev-parse --show-toplevel)"
git branch --show-current                                   # Așteptat: develop
node -e "console.log(require('./package.json').version)"     # Așteptat: 3.9.828

grep -c "docflow_prefill_signers" public/js/formular/alop.js   # Așteptat: 1
grep -c "const ALOP_ROL=" public/js/formular/alop.js           # Așteptat: 1
grep -c "action=new_flow_prefill" public/js/formular/alop.js   # Așteptat: 2
grep -n "formular/alop.js?v=" public/*.html                    # notează valoarea CURENTĂ
grep -n "js/formular/alop.js" public/sw.js                     # Așteptat: 0 ⇒ CACHE_VERSION neatins
```

Dacă vreo ancoră nu se potrivește, **OPREȘTE-TE** și raportează.

---

## ETAPA A — funcția partajată, în IIFE

`old_str`
```js
// ── Acțiuni ALOP ──────────────────────────────────────────────────────────────
async function alopLaunchDfFlow(alopId,dfId){
```

`new_str`
```js
// ── Acțiuni ALOP ──────────────────────────────────────────────────────────────

// #174 — SURSA UNICĂ pentru semnatarii pre-completați care pleacă spre ecranul de flux.
// Înainte, construcția trăia DOAR în patch-ul mkFlow de la finalul fișierului, iar cele
// două funcții de lansare din cardul ALOP navigau direct ⇒ două din trei căi nu trimiteau
// nimic, și utilizatorul primea rândurile implicite ale ecranului în locul rolurilor
// dosarului. Acum toate trei trec pe aici, iar cheia de sesiune se scrie într-un singur
// loc din tot codul (test static ține invariantul).
// Întoarce numărul de roluri scrise (0 = nimic de trimis).
const ALOP_ROL={
  initiator:'ÎNTOCMIT', sef_compartiment:'VIZAT', responsabil_cab:'VERIFICAT',
  sef_cab:'VIZAT', director_economic:'VIZĂ ECONOMICĂ',
  ordonator_credite:'APROBAT', cfp_propriu:'VIZĂ CFPP'
};
function _alopScriePrefill(alopId,ft){
  const ctx=window._alopContext;
  // Gardă de identitate: contextul poate fi al ALTUI dosar (rămas de la o navigare
  // anterioară). Fără ea, am pre-completa fluxul dosarului A cu semnatarii dosarului B.
  if(!ctx||!alopId||ctx.alopId!==alopId)return 0;
  const semnatari=ft==='notafd'?ctx.dfSemnatari:ctx.ordSemnatari;
  const initiatorName=(ctx.dfSemnatari||[]).find(s=>s.role==='initiator')?.name||'';
  // Setul COMPLET de roluri (#172), cu numele gol unde nu se știe cine e.
  // Atributul salvat pe rol are precădere (#173): un rol PERSONALIZAT nu are intrare în
  // tabela de mapare și ar cădea altfel pe „SEMNAT" pe un document financiar.
  // ⛔ NU aduce PERSOANA din șablon aici: refreshAllDropdowns restaurează selecția după
  //    EMAIL, iar șablonul ține user_id+name — lot separat.
  const prefillSigners=(semnatari||[])
    .map(s=>({
      name:s.same_as_initiator?initiatorName:(s.name||''),
      rol:(s.atribut||ALOP_ROL[s.role]||'SEMNAT'),
      functie:s.functie||''
    }));
  if(!prefillSigners.length)return 0;
  try{
    sessionStorage.setItem('docflow_prefill_signers',JSON.stringify(prefillSigners));
  }catch(e){console.warn('ALOP prefill semnatari warn:',e);return 0;}
  return prefillSigners.length;
}

async function alopLaunchDfFlow(alopId,dfId){
```

---

## ETAPA B — cele două căi din card o folosesc

### B.1 — DF

`old_str`
```js
  // Pas 2: navighează la semdoc-initiator cu parametri în URL (nu sessionStorage)
  location.href = '/semdoc-initiator.html?action=new_flow_prefill'
    + '&alop_id=' + encodeURIComponent(alopId)
    + '&alop_doc_type=notafd'
    + '&prefill_doc_id=' + encodeURIComponent(dfId||'')
    + '&prefill_doc_type=notafd';
```

`new_str`
```js
  // Pas 2 (#174): semnatarii dosarului, prin sursa unică. Trebuie ÎNAINTE de navigare —
  // ecranul de flux citește cheia la încărcare.
  _alopScriePrefill(alopId,'notafd');
  // Pas 3: navighează la semdoc-initiator cu parametri în URL (nu sessionStorage)
  location.href = '/semdoc-initiator.html?action=new_flow_prefill'
    + '&alop_id=' + encodeURIComponent(alopId)
    + '&alop_doc_type=notafd'
    + '&prefill_doc_id=' + encodeURIComponent(dfId||'')
    + '&prefill_doc_type=notafd';
```

### B.2 — ORD

`old_str`
```js
  // Pas 2: navighează la semdoc-initiator cu parametri în URL (nu sessionStorage)
  location.href = '/semdoc-initiator.html?action=new_flow_prefill'
    + '&alop_id=' + encodeURIComponent(alopId)
    + '&alop_doc_type=ordnt'
    + '&prefill_doc_id=' + encodeURIComponent(ordId||'')
    + '&prefill_doc_type=ordnt';
```

`new_str`
```js
  // Pas 2 (#174): semnatarii dosarului, prin sursa unică. Trebuie ÎNAINTE de navigare.
  _alopScriePrefill(alopId,'ordnt');
  // Pas 3: navighează la semdoc-initiator cu parametri în URL (nu sessionStorage)
  location.href = '/semdoc-initiator.html?action=new_flow_prefill'
    + '&alop_id=' + encodeURIComponent(alopId)
    + '&alop_doc_type=ordnt'
    + '&prefill_doc_id=' + encodeURIComponent(ordId||'')
    + '&prefill_doc_type=ordnt';
```

---

## ETAPA C — exportul pe `window`

Patch-ul `mkFlow` e în afara IIFE-ului ⇒ are nevoie de funcție pe `window`.

`old_str`
```js
  window.alopLaunchDfFlow           = alopLaunchDfFlow;
  window.alopLaunchOrdFlow          = alopLaunchOrdFlow;
```

`new_str`
```js
  window.alopLaunchDfFlow           = alopLaunchDfFlow;
  window.alopLaunchOrdFlow          = alopLaunchOrdFlow;
  window._alopScriePrefill          = _alopScriePrefill;   // #174 — folosit de patch-ul mkFlow (în afara IIFE)
```

---

## ETAPA D — patch-ul `mkFlow` deleagă

`old_str`
```js
  const _orig=window.mkFlow;
  if(typeof _orig!=='function')return;
  // Mapare rol ALOP → atribut semnătură în semdoc-initiator
  const ALOP_ROL={
    initiator:'ÎNTOCMIT', sef_compartiment:'VIZAT', responsabil_cab:'VERIFICAT',
    sef_cab:'VIZAT', director_economic:'VIZĂ ECONOMICĂ',
    ordonator_credite:'APROBAT', cfp_propriu:'VIZĂ CFPP'
  };
  window.mkFlow=function(ft){
    const ctx=window._alopContext;
    const alopId=new URLSearchParams(location.search).get('alop_id')||ctx?.alopId;
    if(alopId){
      sessionStorage.setItem('alop_id_for_flow',alopId+'|'+ft);
      if(ctx){
        const semnatari=ft==='notafd'?ctx.dfSemnatari:ctx.ordSemnatari;
        const initiatorName=(ctx.dfSemnatari||[]).find(s=>s.role==='initiator')?.name||'';
        // #172 — SETUL COMPLET de roluri, nu doar cele cu persoană atribuită.
        // Înainte exista `.filter(s=>s.user_id||s.same_as_initiator)`. Cum `alop_sabloane`
        // e gol, iar `alop.mjs` ștampilează `user_id` DOAR pe rândul `initiator`, filtrul
        // lăsa un singur rând — iar aplicarea din semdoc-initiator GOLEȘTE tabelul înainte
        // să-l pună. Rezultat: prefill-ul ștergea rolurile implicite în loc să le completeze.
        // Acum trimitem toate rolurile șablonului, cu numele gol unde nu se știe cine e;
        // utilizatorul completează persoanele, iar rândurile care nu se aplică documentului
        // se șterg cu butonul „Șterge" al rândului.
        // ⛔ NU aduce PERSOANA din șablon aici: `refreshAllDropdowns` restaurează selecția
        //    după EMAIL, iar șablonul ține `user_id`+`name`. Aducerea persoanei cere
        //    rezolvarea user_id→email din `_dbUsers` și selecție după email — lotul #173.
        const prefillSigners=(semnatari||[])
          .map(s=>({
            name:s.same_as_initiator?initiatorName:(s.name||''),
            // #173 — atributul salvat pe rol are precădere: un rol PERSONALIZAT nu are
            // intrare în ALOP_ROL și ar cădea altfel pe „SEMNAT" pe un document financiar.
            rol:(s.atribut||ALOP_ROL[s.role]||'SEMNAT'),
            functie:s.functie||''
          }));
        if(prefillSigners.length){
          sessionStorage.setItem('docflow_prefill_signers',JSON.stringify(prefillSigners));
        }
      }
    }
    _orig(ft);
  };
```

`new_str`
```js
  const _orig=window.mkFlow;
  if(typeof _orig!=='function')return;
  window.mkFlow=function(ft){
    const ctx=window._alopContext;
    const alopId=new URLSearchParams(location.search).get('alop_id')||ctx?.alopId;
    if(alopId){
      sessionStorage.setItem('alop_id_for_flow',alopId+'|'+ft);
      // #174 — construcția s-a mutat în sursa unică din IIFE (vezi „Acțiuni ALOP").
      // Comportament neschimbat pe această cale; ce se schimbă e că acum și butoanele
      // din cardul ALOP trec prin aceeași funcție.
      if(typeof window._alopScriePrefill==='function')window._alopScriePrefill(alopId,ft);
    }
    _orig(ft);
  };
```

⚠️ Garda de identitate din `_alopScriePrefill` (`ctx.alopId!==alopId`) e NOUĂ pe această cale.
Practic nu schimbă nimic (pe `formular.html` parametrul din URL și contextul sunt ale aceluiași
dosar), dar dacă vreodată diferă, comportamentul corect e să NU pre-completăm, nu să
pre-completăm greșit. Consemnează asta în raport ca schimbare intenționată.

---

## ETAPA E — teste

Fișier NOU: `server/tests/unit/alop-prefill-cale-unica.test.mjs` (analiză statică pe
`public/js/formular/alop.js`), pe modelul `server/tests/unit/prefill-alop-cursa.test.mjs`.

⚠️ Elimină liniile de comentariu înainte de aserțiuni. Comentariile dictate mai sus conțin
intenționat numele funcției și ar auto-potrivi numărătorile (lecția de la #124i, #172, #172b,
#173).

Cazuri obligatorii:

1. ⭐ `sessionStorage.setItem('docflow_prefill_signers'` apare **exact o dată** în tot fișierul —
   invariantul „un singur scriitor". Cade dacă cineva adaugă a patra cale care își scrie singură
   cheia.
2. ⭐ Corpul lui `alopLaunchDfFlow` conține `_alopScriePrefill(` **înainte** de `location.href`
   (compară pozițiile în text, nu doar prezența).
3. ⭐ Idem pentru `alopLaunchOrdFlow`.
4. `const ALOP_ROL=` apare **exact o dată** în fișier (mutat, nu duplicat).
5. Patch-ul `mkFlow` nu mai conține `prefillSigners` — construcția inline a dispărut.
6. `window._alopScriePrefill` e exportat exact o dată în blocul de exporturi.
7. Garda de identitate `ctx.alopId!==alopId` e prezentă în corpul funcției.
8. Regresie: `filter(u=>u.user_id||u.same_as_initiator)` (`:787`, previzualizarea din card)
   există în continuare, exact 1 dată.

```bash
node --check public/js/formular/alop.js
npx vitest run server/tests/unit/alop-prefill-cale-unica.test.mjs
npx vitest run server/tests/unit/prefill-alop-roluri.test.mjs server/tests/unit/prefill-alop-cursa.test.mjs
npm test
npm run test:db
```

⚠️ `prefill-alop-roluri.test.mjs` (#172) asertează pe `alop.js`. Dacă mutarea codului îl face să
cadă, **OPREȘTE-TE și raportează** — nu-l modifica. Aserțiunile lui (absența filtrului vechi,
prezența lui `:787`, acordul `ALOP_ROL`↔`DFAtribute`) ar trebui să treacă neatinse, fiindcă
mutăm blocul, nu îi schimbăm conținutul.

---

## ETAPA F — versiune, cache busting, commit

1. `package.json`: `3.9.828` → `3.9.829`.
2. `CACHE_VERSION` **NEATINS** (fișierul nu e în `PRECACHE_ASSETS`, confirmat în Etapa 0).
3. Bump `?v=` doar pe assetul atins:

```bash
NEW=3.9.829
sed -i -E "s#(js/formular/alop\.js\?v=)[0-9.]+#\1$NEW#g" public/*.html
grep -n "formular/alop.js?v=" public/*.html
grep -c "<script" public/formular.html
```

⛔ `\1`, nu `\g<1>`. ⛔ Fără bulk-sed pe alte `?v=`.

4. `git add` explicit: `public/js/formular/alop.js`, `public/formular.html`, testul nou,
   `package.json`. **Niciodată `git add -A`.**
5. Commit:
   ```
   fix(#174): prefill-ul ALOP scris intr-un singur loc, pe toate caile — v3.9.829

   Exista o singura constructie a semnatarilor pre-completati, in patch-ul
   mkFlow. Cele doua functii de lansare din cardul ALOP navigau direct cu
   location.href, ocolind-o => doua din trei cai nu trimiteau nimic si
   utilizatorul primea randurile implicite ale ecranului in locul rolurilor
   dosarului. Constructia devine functie unica in IIFE, exportata pe window
   pentru patch-ul mkFlow, chemata din toate trei. Cheia de sesiune se scrie
   acum intr-un singur loc, cu test static care tine invariantul.
   Gardă noua: contextul ALOP trebuie sa fie al aceluiasi dosar.
   ```
6. `git push origin develop`

---

## RAPORT FINAL — obligatoriu

1. Ancorele din Etapa 0, cu valorile OBȚINUTE (inclusiv `?v=` vechi).
2. `grep -c "docflow_prefill_signers"` înainte și după (așteptat 1 și 1).
3. Rezultatul fiecărui caz de test, cu accent pe 1, 2 și 3.
4. Confirmă explicit că `prefill-alop-roluri.test.mjs` și `prefill-alop-cursa.test.mjs` au trecut
   NEMODIFICATE.
5. Numerele reale `npm test` / `npm run test:db`; dacă `test:db` a rulat REAL.
6. Ieșirea `grep` de după `sed`.
7. Garda de identitate: consemneaz-o ca schimbare intenționată pe calea `mkFlow`.
8. Divergențe prompt↔cod — raportate, NU reparate tăcut.
9. Constatări colaterale — consemnate, nereparate.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. UN SINGUR fișier de producție: `public/js/formular/alop.js`.
- Zero server, zero migrații, `CACHE_VERSION` neatins.
- Testele de la #172 și #172b NEMODIFICATE.
- Ordinea „Pas 1 link-df/link-ord" → navigare NESCHIMBATĂ.
- `git add` explicit.
- `old_str` care nu se potrivește exact ⇒ **OPREȘTE-TE și raportează**.
