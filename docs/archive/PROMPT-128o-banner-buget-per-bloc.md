# PROMPT #128o — bannerul de depășire de buget în TOATE blocurile de furnizor

> ## ⚠️ BRANCH: `develop`
> Toate commit-urile pe `develop`. **NU** propune și **NU** executa `checkout main`,
> `merge main`, `push origin main`. Deploy-ul în producție îl face Mircea manual.

**Model recomandat:** Sonnet 5 (lot chirurgical, un singur comportament)
**Target versiune:** `v3.9.775` (de la 3.9.774 — **citește `package.json`**)
**Migrații:** ZERO · **Fișiere de server:** ZERO

> ⚠️ Mesajul de commit: `git commit -m "subiect"`, o linie, **sintaxă bash**.
> ⛔ Fără `--amend`, fără `--force`.

---

## 1. Bugul, constatat de Mircea la testarea pe staging

Pe un ORD cu doi furnizori care depășește creditele bugetare:

- rândurile **ambelor** blocuri primesc marcajul roșu `ord-buget-over` (corect, din #128j);
- dar **bannerul explicativ apare doar în blocul 1**.

Utilizatorul care lucrează în blocul 2 vede numai roșu, fără niciun motiv, și trebuie să deruleze
înapoi la primul furnizor ca să afle de ce. Într-un formular care se completează de sus în jos,
de doi oameni diferiți (P1 și Responsabil CAB), asta înseamnă că avertismentul care blochează
finalizarea poate fi ratat complet.

**Cauza, verificată pe cod:** `_checkOrdBuget` (`public/js/formular/doc.js`, ~421) a fost extins
la #128j să marcheze rândurile TUTUROR blocurilor (`_ordAllRows()`), dar bannerul a rămas pe
`document.getElementById('ord-buget-warn')` — un singur `<div>` din markup-ul STATIC al blocului 0
(`public/formular.html:955`). Blocurile create din `_sablonBloc` n-au niciun echivalent.
Aceeași scăpare de acoperire în `_resetOrdBuget` (~401).

---

## 2. Ce face lotul

Bannerul devine **per bloc**: fiecare bloc de furnizor își are propriul `<div>`, iar
`_checkOrdBuget` / `_resetOrdBuget` scriu în **toate**, cu același text.

⭐ **Decizie de conținut, importantă:** mesajul rămâne IDENTIC în toate blocurile. Bugetul e
UNUL SINGUR pe document (un ORD are un singur DF, regula #128a), deci depășirea e a
documentului, nu a furnizorului. Un text diferit per bloc ar sugera fals că fiecare furnizor
are plafonul lui.

Ca să nu apară exact confuzia inversă — utilizatorul citește în blocul 2 o sumă mai mare decât
totalul blocului 2 și crede că e o eroare de calcul — mesajul primește **o singură propoziție în
plus, doar când există mai mult de un bloc**, care spune că suma e cumulată pe toți furnizorii.

⛔ **NU** face: nu atinge pragul, nu atinge tolerarea `+0.001`, nu atinge blocajul de pe server
(`validateOrdBugetAnCurent`), nu atinge `_ordAllRows` / `_ordAllRowInputs`, nu atinge DF-ul
(`#secb-buget-warn` din `form-notafd` rămâne **byte-identic**).

---

## 3. NO-TOUCH

⛔ `server/**` în întregime — lotul e strict frontend
⛔ `public/js/formular/draft.js`, `public/js/formular/list.js`
⛔ Calea DF: `#secb-buget-warn`, `_checkSecBBuget` și tot ce ține de `form-notafd`
⛔ Nicio migrație, niciun `CACHE_VERSION`
⛔ Zero refactorizări în trecere

---

## 4. Etapa A — markup

### A.1 Blocul 0 (`public/formular.html`, ~955)

`old_str`:
```html
    <div id="ord-buget-warn" class="secb-buget-warn" style="display:none"></div>
```
`new_str`:
```html
    <!-- #128o — `data-role` e selectorul UNIC prin care _checkOrdBuget găsește bannerele
         TUTUROR blocurilor. `id`-ul rămâne pentru compatibilitate (ancore, teste vechi). -->
    <div id="ord-buget-warn" class="secb-buget-warn" data-role="buget-warn" style="display:none"></div>
```

### A.2 Șablonul de bloc (`public/js/formular/core.js`, `_sablonBloc`)

În al doilea `df-block` (cel cu badge-ul **P2**), imediat **după** `</div>`-ul care închide
`<div style="overflow-x:auto;margin-bottom:6px">` (deci după tabel) și **înainte** de
`<div class="cap-lbl">…` adăugat la #128n, inserează:

```html
    <!-- #128o — bannerul de depășire de buget, per bloc. Textul e IDENTIC în toate blocurile:
         bugetul e unul singur pe document (un ORD are un singur DF), deci depășirea e a
         documentului. Fără el, utilizatorul din blocul 2 vede doar rânduri roșii fără motiv. -->
    <div class="secb-buget-warn" data-role="buget-warn" style="display:none"></div>
```

⚠️ Poziția contează: în blocul 0 bannerul stă **între tabel și eticheta de captură**. Dacă în
șablon îl pui altundeva, cele două blocuri arată diferit. Verifică vizual ordinea în markup
înainte să treci mai departe.

⚠️ Zero CSS nou: `.secb-buget-warn` e o regulă pe clasă (`public/css/formular/formular.css:318`).
Confirmă prin grep.

---

## 5. Etapa B — logica (`public/js/formular/doc.js`)

### B.1 Helperul de colectare

Adaugă imediat **înaintea** lui `_resetOrdBuget`:

```js
// #128o — bannerele de buget ale TUTUROR blocurilor de furnizor. Blocul 0 are markup static
// în formular.html, blocurile 2+ vin din `_sablonBloc`; ambele poartă `data-role="buget-warn"`.
// ⚠️ Scopat pe `#form-ordnt`, ca să nu prindă niciodată bannerul DF-ului.
function _ordBugetWarnEls(){
  return [...document.querySelectorAll('#form-ordnt [data-role="buget-warn"]')];
}
```

### B.2 `_resetOrdBuget`

`old_str`:
```js
  const warn=document.getElementById('ord-buget-warn');
  if(warn){warn.style.display='none';warn.innerHTML='';}
  _ordAllRows().forEach(tr=>tr.classList.remove('ord-buget-over'));
```
`new_str`:
```js
  _ordBugetWarnEls().forEach(w=>{w.style.display='none';w.innerHTML='';});
  _ordAllRows().forEach(tr=>tr.classList.remove('ord-buget-over'));
```

### B.3 `_checkOrdBuget`

`old_str`:
```js
function _checkOrdBuget(){
  const warn=document.getElementById('ord-buget-warn');
```
`new_str`:
```js
function _checkOrdBuget(){
  // #128o — bannerul se scrie în TOATE blocurile, nu doar în cel static al blocului 0.
  const warns=_ordBugetWarnEls();
  const _hideAll=()=>warns.forEach(w=>{w.style.display='none';w.innerHTML='';});
```

`old_str`:
```js
  if(!_ordBugetCtx){if(warn){warn.style.display='none';warn.innerHTML='';}return;}
```
`new_str`:
```js
  if(!_ordBugetCtx){_hideAll();return;}
```

`old_str`:
```js
  if(over){
    _ordAllRows().forEach(tr=>tr.classList.add('ord-buget-over'));
    if(warn){
      const dep=cumul-buget;
      warn.innerHTML='⛔ Suma ordonanțată '+(arhivat>0?`cumulată în anul ${esc(an)} (${esc(fMR(cumul))} lei, din care ${esc(fMR(arhivat))} lei deja ordonanțați în cicluri anterioare)`:`(${esc(fMR(cumul))} lei)`)+
        ` depășește creditele bugetare ale anului ${esc(an)} (${esc(fMR(buget))} lei) cu ${esc(fMR(dep))} lei. Finalizarea va fi blocată.`;
      warn.style.display='';
    }
  }else if(warn){warn.style.display='none';warn.innerHTML='';}
```
`new_str`:
```js
  if(over){
    _ordAllRows().forEach(tr=>tr.classList.add('ord-buget-over'));
    const dep=cumul-buget;
    // #128o — la mai mulți furnizori, o propoziție în plus care spune că suma e CUMULATĂ pe
    // document. Fără ea, cine citește bannerul în blocul 2 vede o sumă mai mare decât totalul
    // blocului 2 și crede că e greșeală de calcul. La un singur bloc `_multi` e '' ⇒ textul
    // rămâne BYTE-IDENTIC cu cel de dinainte de acest lot.
    const _multi=(typeof blocEls==='function'&&blocEls().length>1)
      ? ' Suma include toate blocurile de furnizor ale acestei ordonanțări, nu doar cel de mai sus.'
      : '';
    const _msg='⛔ Suma ordonanțată '+(arhivat>0?`cumulată în anul ${esc(an)} (${esc(fMR(cumul))} lei, din care ${esc(fMR(arhivat))} lei deja ordonanțați în cicluri anterioare)`:`(${esc(fMR(cumul))} lei)`)+
      ` depășește creditele bugetare ale anului ${esc(an)} (${esc(fMR(buget))} lei) cu ${esc(fMR(dep))} lei.`+_multi+
      ' Finalizarea va fi blocată.';
    warns.forEach(w=>{w.innerHTML=_msg;w.style.display='';});
  }else{_hideAll();}
```

⚠️ Atenție la punctuație: în varianta veche era `… cu ${dep} lei. Finalizarea va fi blocată.`
într-un singur literal. În varianta nouă, primul literal se închide cu `lei.`, iar ultimul
începe cu **un spațiu** înainte de `Finalizarea`. La un singur bloc rezultatul trebuie să fie
caracter cu caracter identic — verifică-l, e ușor de greșit cu un spațiu în plus sau în minus.

### B.4 Momentul apelării

`_checkOrdBuget` e apelat din `upTot()` (`core.js:393`), iar `addBlocOrd` cheamă `upTot()` după
ce a adăugat blocul ⇒ un bloc nou primește bannerul imediat, fără cablare separată.

**Verifică pe cod** că, la redeschiderea unui document (`populateOrd` → `renderOrdBlocuri`),
`upTot()` sau `_loadOrdBuget()` chiar rulează **DUPĂ** ce blocurile 2+ există în DOM. Dacă nu,
blocurile recreate ar rămâne fără banner până la prima tastare. **Dacă găsești că ordinea e
greșită, raportează — nu adăuga apeluri „defensive" împrăștiate.**

---

## 6. Etapa C — teste

Extinde `server/tests/unit/ord-bloc-comportamente-vii.test.mjs` (cazul 10 existent acoperă deja
marcajul pe rânduri; fixtura e la ~37).

⚠️ **Fixtura trebuie actualizată**: `<div id="ord-buget-warn" style="display:none"></div>` din
test devine `<div id="ord-buget-warn" data-role="buget-warn" style="display:none"></div>`,
oglindind `formular.html`. Asta e o corecție legitimă de fixtură, nu o slăbire.
⛔ **NU** rezolva un test picat lărgind selectorul din producție la `[id="ord-buget-warn"], …`
sau scoțând scoparea pe `#form-ordnt`.

Cazuri noi:

1. ⭐ **Bugul raportat**: două blocuri, depășire ⇒ **AMBELE** bannere sunt vizibile și au același
   `innerHTML`. Fără fix, al doilea nici nu există.
2. Revenire sub plafon ⇒ **ambele** ascunse și golite (`innerHTML === ''`).
3. ⭐ **Paritate la un singur bloc**: cu un singur bloc, `innerHTML`-ul bannerului e
   **exact** șirul de azi — fără propoziția „Suma include toate blocurile…". Aserțiune pe
   textul complet, nu pe `toContain`; e singura garanție automată că lotul n-a schimbat
   mesajul existent.
4. Cu două blocuri, mesajul **conține** propoziția suplimentară.
5. `_resetOrdBuget()` golește bannerele **tuturor** blocurilor.
6. Structural: un bloc din `_sablonBloc` are **exact un** `[data-role="buget-warn"]` și
   **zero** atribute `id`.
7. ⭐ **Izolare DF**: un `[data-role="buget-warn"]` prezent în `#form-notafd` NU e atins de
   `_checkOrdBuget` (apără scoparea pe `#form-ordnt`). Dacă fixtura n-are formularul DF,
   adaugă un `<div id="form-notafd">` minimal cu un banner marcat, doar pentru cazul ăsta.

---

## 7. Cache busting

Assete atinse: `formular.html` (nu poartă `?v=`), `core.js`, `doc.js`.
`list.js` și `draft.js` **NU** se ating ⇒ rămân la versiunile lor actuale.

```bash
grep -n "formular/core.js\|formular/doc.js" public/sw.js
# Așteptat: nicio linie ⇒ FĂRĂ bump CACHE_VERSION
```

```bash
sed -i -E "s#(formular/core\.js\?v=)[0-9.]+#\13.9.775#g" public/*.html
sed -i -E "s#(formular/doc\.js\?v=)[0-9.]+#\13.9.775#g" public/*.html
```
⚠️ `\1`, nu `\g<1>`. După fiecare `sed`, `grep` pe linia atinsă — un `?v=` corupt nu pică niciun
test și ajunge direct în producție cu pagina moartă.

---

## 8. Rulare, versionare, push

```bash
npm test
npm run test:db
```
⛔ „Skipped" NU e „passed". Lotul e frontend, dar `test:db` rămâne obligatoriu ca dovadă de
non-regresie (rețeta PG 17 efemer din `CLAUDE.md`; „nu am Docker" nu e motiv de skip).

Bump la `3.9.775`;
`git commit -m "fix(#128o): bannerul de depasire buget in toate blocurile de furnizor"`;
`git push origin develop`.

---

## 9. Verificări de ieșire (verbatim în raport)

```bash
# 1 — nu mai există nicio căutare pe id a bannerului ORD
grep -n "getElementById('ord-buget-warn')" public/js/formular/doc.js
# Așteptat: 0 linii

# 2 — selectorul unic, scopat pe ORD
grep -n "buget-warn" public/js/formular/doc.js public/js/formular/core.js public/formular.html

# 3 — calea DF neatinsă
grep -n "secb-buget-warn" public/js/formular/doc.js
# Așteptat: exact cele 2 linii istorice (getElementById), NESCHIMBATE

# 4 — șablonul n-a căpătat id-uri
grep -c "id=\"" public/js/formular/core.js
# Raportează valoarea și confirmă că e NESCHIMBATĂ față de HEAD

# 5 — zero fișiere de server
git status --short
# Așteptat: doar formular.html, core.js, doc.js, testul, package.json.
# ⚠️ working tree-ul are ~50 de fișiere netrackate din sesiuni vechi — confirmă EXPLICIT
# că ai stage-uit doar căile sarcinii

# 6 — ?v= țintit
grep -on "formular/\(core\|doc\|list\|draft\)\.js?v=[0-9.]*" public/formular.html
```

---

## 10. RAPORT FINAL

- commit hash + push confirmat; versiunea din `package.json`; `git log -1 --pretty=%s`
- `npm test` / `npm run test:db`: **numere REALE**
- ieșirea celor 6 verificări, **verbatim**
- ⭐ rezultatele cazurilor **1, 3 și 7**, menționate separat
- **textul complet** al bannerului la un singur bloc și la două blocuri, copiat din test —
  ca să pot verifica cu ochii paritatea și punctuația
- răspunsul la §5.B.4: la redeschiderea unui document, `upTot()`/`_loadOrdBuget()` rulează
  ÎNAINTE sau DUPĂ ce `renderOrdBlocuri` a creat blocurile 2+? Cu linia din cod
- confirmarea că fixtura din test a fost actualizată cu `data-role`, nu selectorul din producție
  slăbit
- confirmarea că `#secb-buget-warn` (DF) e byte-identic
- **orice abatere.** Dacă găsești o eroare în prompt, **spune-o, nu o repara tăcut**

---

## 11. ⛔ Constrângeri absolute

⛔ Branch `develop`. Fără `main`, fără `--amend`, fără `--force`.
⛔ Zero fișiere de server, zero migrații, zero `CACHE_VERSION`.
⛔ Textul bannerului la UN SINGUR bloc rămâne byte-identic.
⛔ Pragul, toleranța `+0.001` și blocajul de pe server rămân neatinse.
⛔ Calea DF neatinsă.
⛔ Zero refactorizări în trecere. Zero „îmbunătățiri" nemenționate aici.
