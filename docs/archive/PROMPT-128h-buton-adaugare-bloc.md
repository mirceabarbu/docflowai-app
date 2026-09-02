# PROMPT #128h — butonul de adăugare/ștergere bloc (ULTIMUL din seria #128)

> ## ⚠️ BRANCH: `develop`
> Toate commit-urile pe `develop`. **NU** propune și **NU** executa `checkout main`,
> `merge main`, `push origin main`. Deploy-ul îl face Mircea manual.

**Model recomandat:** Opus — e cel mai mare din serie și primul cu efect vizibil
**Target versiune:** `v3.9.768` (de la 3.9.767 — **citește `package.json`**) · **Migrații:** ZERO

---

## 1. Unde suntem

Tot lanțul din spate e livrat și verde pe staging: coloana `blocuri` (#128b), scrierea cu oglindă
pe coloanele plate (#128c), matcher-ul OPME per bloc (#128d), exportul XML / PDF / validarea pe N
blocuri (#128e), rezolvarea câmpurilor pe bloc în frontend (#128f) și derivarea identității prin
`ctrl_idx` (#128g).

Lotul ăsta adaugă **singurul lucru care lipsește: posibilitatea de a crea al doilea bloc.**
După el, un ORD poate avea mai mulți furnizori.

---

## 2. Structura HTML reală (verificată pe cod) și decupajul impus de ea

```
#form-ordnt (776)                      ← poartă azi data-bloc="0", pus la #128f
  div.df-block (789)                   ← Identificare ORD: o-nrUnic (hidden, 822), o-cif, o-den
  div.df-block.df-block-p1#bloc-ord-p1 (829)   ← beneficiar, CIF, IBAN, bancă, documente, inf
  div.df-block.df-block-p2#bloc-ord-p2 (891)   ← tabelul (#o-tbody, tfoot cu #o-t-*) ȘI CAPTURILE
  … rezultat PDF / flux …
```

Trei consecințe, toate obligatorii:

**(a) `data-bloc="0"` trebuie MUTAT de pe `#form-ordnt`.** Dacă rămâne acolo și blocurile noi se
adaugă înăuntru, ele devin DESCENDENȚI ai blocului 0 ⇒ `blocEl(0).querySelectorAll('tr')` ar
înghiți și rândurile blocului 1. Bug tăcut pe bani.
**Soluția:** un container nou `<div class="ord-bloc" data-bloc="0">` care înfășoară EXACT
`#bloc-ord-p1` + `#bloc-ord-p2`. ⛔ Nu muta niciun alt element, nu schimba nicio clasă existentă,
nu atinge blocul de identificare (789) și nici zona de rezultat/flux.

**(b) CAPTURILE RĂMÂN PER DOCUMENT, nu per bloc.** În formularul MF `SubformCaptura` e în
interiorul blocului repetat, dar modelul nostru de date nu are așa ceva: `blocuri` are exact 8
chei, iar `captureImageBase64` / `captureImageBase64_2` sunt câmpuri unice la nivel de document.
⇒ blocurile clonate **NU** conțin secțiunea de captură. E o divergență deliberată față de MF, de
consemnat în raport; alinierea ar cere schemă nouă și e altă discuție.

**(c) Blocurile noi NU se fac cu `cloneNode` din blocul 0** — ar duplica id-urile și capturile.
Se construiesc dintr-o funcție de șablon scrisă explicit, care emite **doar** `data-fld` și
`data-f`, **zero atribute `id`**. Asta e și plasa care ține restul codului nemigrat în viață:
`doc.js`, `list.js`, `lockOrdIdentityCols` caută după `id` ⇒ continuă să vadă exact blocul 0,
adică exact comportamentul de azi.

---

## 3. NO-TOUCH

⛔ `server/**` în întregime — backendul e complet, lotul e strict frontend
⛔ `lockOrdIdentityCols` și `lockAll` — vezi §7, gap-ul de rol e PARCAT deliberat
⛔ Nu șterge niciun `id` existent, nu redenumi nimic din blocul 0
⛔ Nu atinge secțiunea de captură, blocul de identificare (789) sau zona de flux
⛔ Nu schimba `colO`/`valF` din #128f decât dacă o cere strict iterarea peste mai multe blocuri —
   și atunci raportează exact ce ai schimbat

---

## 4. Etapa A — markup + șablon

1. În `public/formular.html`: containerul `<div class="ord-bloc" data-bloc="0">` în jurul lui
   `#bloc-ord-p1` + `#bloc-ord-p2`; `data-bloc` **șters** de pe `#form-ordnt`.
2. Un container gazdă `<div id="ord-blocuri"></div>` care conține blocul 0 și primește blocurile
   noi ca FRAȚI (nu descendenți).
3. Sub el, butonul `<button id="btn-add-bloc" class="df-action-btn">+ Adaugă furnizor</button>`.
4. În `public/js/formular/core.js` (sau un fișier nou `public/js/formular/ord-bloc.js` încărcat
   ÎNAINTEA lui `doc.js` — alege și motivează), o funcție `_sablonBloc(idx)` care produce:
   - câmpurile beneficiarului cu `data-fld` (`beneficiar`, `documente_justificative`,
     `iban_beneficiar`, `cif_beneficiar`, `banca_beneficiar`, `inf_pv_plata`, `inf_pv_plata1`) —
     ⛔ **fără `nr_unic_inreg`**: e unic pe document (un singur DF per ORD), se citește din
     `#o-nrUnic` pentru toate blocurile. Verifică pe cod cum îl ia `colO` după #128f și
     păstrează acel comportament;
   - un titlu vizibil `Furnizor N` și un buton „Șterge blocul";
   - tabelul cu `<tbody>` propriu și `<tfoot>` cu celulele de total marcate prin `data-tot`
     (`rec`, `plati`, `suma`, `neplat`) — ⛔ nu prin `id`, ar duplica `#o-t-rec`;
   - butonul „+" de adăugare rând.

---

## 5. Etapa B — comportamentul

**Adăugare.** `btn-add-bloc` creează un bloc nou cu `data-bloc` = numărul de blocuri existente.
Rândurile lui se pre-populează din ACELAȘI DF ca blocul 0 (`rows_ctrl`), fiecare rând purtând
`dataset.ctrlIdx` — reutilizează logica din `onDfSelect` (`list.js:177`), ⛔ nu o duplica: extrage-o
într-o funcție refolosibilă dacă e nevoie, și spune în raport ce ai extras.
Coloanele de identitate ale rândurilor noi se pun `readOnly` la creare (blocul e legat de DF).

**Ștergere.** Butonul cere confirmare (`confirm()`, tiparul din proiect). ⛔ Blocul 0 NU poate fi
șters — ascunde-i butonul. După ștergere, `data-bloc` se **renumerotează contiguu** (0,1,2,…) pe
blocurile rămase, în ordinea din DOM.

**Totaluri.** `upTot()` (`core.js:323`) calculează azi pe `#o-tbody` și scrie în `#o-t-*`.
Generalizeaz-o: pentru fiecare `[data-bloc]`, sumă pe rândurile lui, scrisă în celulele lui
`[data-tot]`. Blocul 0 trebuie să continue să scrie ȘI în `#o-t-*` (ele rămân în markup) — cel mai
simplu e ca celulele blocului 0 să poarte AMBELE (`id` existent + `data-tot` nou).

**Adăugare rând.** `addOR()` primește blocul-țintă (element sau index) și adaugă în tbody-ul lui.
⛔ Semnătura veche `addOR()` fără argument trebuie să continue să funcționeze, țintind blocul 0 —
e apelată din markup prin `onclick` și din `onDfSelect`.

**`bloc_idx`.** La colectare, rândurile fiecărui bloc primesc `bloc_idx` = `data-bloc` al blocului
lor. Verifică pe cod ce face azi `collectOrdDb` (`doc.js:80`, modificat la #128f — pune `bloc_idx:0`
fix) și generalizeaz-o.

⚠️ **Ordinea rândurilor:** lista plată trimisă la server trebuie să fie blocurile concatenate în
ordinea `bloc_idx`. Nu e o cerință de corectitudine a identității (o rezolvă `ctrl_idx` din #128g),
dar e cerința ca PDF-ul și XML-ul să randeze blocurile în ordinea din ecran.

---

## 6. Etapa C — `draft.js`

`draft.js` salvează SINCRON în localStorage la fiecare 2 secunde și restaurează la deschidere.
Verifică pe cod ce serializează azi pentru ORD și extinde-l ca să acopere blocurile: la restaurare,
blocurile 1..N trebuie RECREATE din șablon înainte de a li se pune valorile.

⚠️ Compatibilitate: un draft SALVAT ÎNAINTE de acest lot nu are blocuri. Restaurarea lui trebuie
să funcționeze exact ca azi (un singur bloc), fără excepții în consolă. Caz de test obligatoriu.

---

## 7. PARCAT deliberat — de consemnat în raport, ⛔ NU rezolva aici

`lockOrdIdentityCols` și `lockAll` operează pe `id`-uri ⇒ **nu ating blocurile clonate**.
Consecință: blocarea pe rol P1/P2 (cine poate edita coloanele 2-3 față de 4) NU se aplică
blocurilor 2+. Coloanele de identitate le punem `readOnly` la creare (§5), deci partea legată de
DF e acoperită, dar separarea P1/P2 nu.

E o limitare reală, nu una teoretică — dar generalizarea celor 11 situri `lockAll` e un lot propriu
(**#128i**). ⛔ Nu o începe aici; raportează dacă găsești alte locuri cu aceeași problemă.

---

## 8. Teste

`// @vitest-environment happy-dom`, modelul din `pagin-component.test.mjs`. Capcana cunoscută:
`dirname(fileURLToPath(import.meta.url))`, NU `new URL('.', import.meta.url)`.

1. ⭐ **NON-REGRESIE:** cu un singur bloc, `colO()` și `collectOrdDb()` produc exact același
   payload ca înainte de lot (`blocuri` cu un element, toate rândurile cu `bloc_idx: 0`);
2. ⭐ adăugarea unui bloc → `colO().docFd` are 2 elemente, cu valori independente;
3. ⭐ rândurile: fiecare bloc are propriile rânduri; lista plată e concatenată în ordinea
   `bloc_idx`; **niciun rând al blocului 1 nu apare în blocul 0** (regresia de la §2.a);
4. ștergerea blocului 1 din trei blocuri → renumerotare contiguă 0,1 și `bloc_idx` actualizat pe
   rânduri;
5. blocul 0 nu poate fi șters;
6. totalurile se calculează per bloc, iar blocul 0 scrie în continuare în `#o-t-*`;
7. `addOR()` fără argument adaugă în blocul 0;
8. rândurile unui bloc nou poartă `ctrl_idx` (deci derivarea din #128g funcționează pe ele);
9. ⭐ **draft:** un draft vechi (fără blocuri) se restaurează ca un singur bloc, fără excepții;
10. un draft cu 2 blocuri se restaurează cu 2 blocuri și valorile corecte.

---

## 9. Cache busting

`formular.html`, `core.js`, `doc.js`, `list.js` (+ eventual fișierul nou) sunt în `public/`.
Verifică pe cod, ⛔ nu presupune: `grep -n "formular/core.js\|formular/doc.js\|formular/list.js" public/sw.js`.
În `PRECACHE_ASSETS` ⇒ bump `CACHE_VERSION` (citit din fișier); altfel `?v=3.9.768` țintit pe TOATE
fișierele atinse. Dacă adaugi un fișier nou, adaugă-i referința în `formular.html` în ordinea
corectă (`defer` execută în ordinea documentului).

---

## 10. Rulare, versionare, push

```bash
npm test
npm run test:db
```

⛔ „Skipped" NU e „passed".

Bump la `3.9.768`; commit pe `develop`:
`feat(#128h): ORD cu mai mulți furnizori — adăugare/ștergere bloc în formular`;
`git push origin develop`. ⛔ Fără `--amend`, fără `--force`.
⚠️ Mesajul de commit se scrie cu sintaxă **bash**, nu PowerShell (`@'…'@` a lăsat caractere
parazite la #128g).

---

## 11. Verificări de ieșire (verbatim în raport)

```bash
grep -n 'data-bloc' public/formular.html
# Așteptat: 1 singur container ord-bloc cu data-bloc="0"; #form-ordnt NU mai are data-bloc

grep -n 'id="o-t-rec"\|data-tot' public/formular.html
# Așteptat: celulele blocului 0 poartă AMBELE

grep -c 'id=' public/js/formular/ord-bloc.js 2>/dev/null || grep -n "_sablonBloc" -A 40 public/js/formular/core.js | grep -c "id="
# Așteptat: 0 — șablonul nu emite niciun id

git diff --stat server/
# Așteptat: GOL — lot strict frontend

git status --short
```

---

## 12. RAPORT FINAL

- commit hash + push; versiunea citită din `package.json`
- `npm test` / `npm run test:db`: numere REALE
- ieșirea celor 5 verificări, verbatim
- ⭐ rezultatele cazurilor **1, 2, 3 și 9** menționate separat
- **unde ai pus șablonul** (fișier nou sau `core.js`) și de ce
- **ce ai extras din `onDfSelect`** ca să pre-populezi rândurile blocului nou fără duplicare
- confirmarea că blocurile clonate **nu emit niciun `id`** și **nu conțin captură**
- confirmarea că gap-ul de la §7 (lock pe rol) e PARCAT, plus orice alt loc cu aceeași problemă
- cazul de cache busting
- orice abatere. Dacă găsești o eroare în prompt, **spune-o, nu o repara tăcut**
