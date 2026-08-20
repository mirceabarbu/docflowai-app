# PROMPT #128f — formularul ORD rezolvă câmpurile PE BLOC (fără să apară încă al doilea bloc)

> ## ⚠️ BRANCH: `develop`
> Toate commit-urile pe `develop`. **NU** propune și **NU** executa `checkout main`,
> `merge main`, `push origin main`. Deploy-ul îl face Mircea manual.

**Model recomandat:** Sonnet 4.6 · **Target versiune:** `v3.9.766` (de la 3.9.765 — **citește
`package.json`**) · **Migrații:** ZERO

---

## 1. Ce face și, mai ales, ce NU face

Backendul e complet pregătit (#128b…#128e): scrierea, potrivirea plăților OPME, exportul XML,
PDF-ul și validarea știu toate de blocuri. Frontendul e ultima piesă — și e cea mai mare din
serie: **119 referințe la id-uri unice `o-*`**, în 6 fișiere.

⛔ **Nu le rescriem pe toate acum.** Lotul ăsta face DOAR atât: `colO()` și `valF()` încetează să
caute câmpurile beneficiarului după id global și le caută **în interiorul unui container de bloc**.
Formularul continuă să afișeze **exact un bloc**. Zero funcționalitate nouă, zero schimbare
vizuală.

Butonul de adăugare/ștergere bloc, numerotarea, `draft.js` — **#128g**.

**De ce separat:** dacă am face refactorul și logica de adăugare împreună și ceva s-ar strica,
n-am ști dacă vina e la rescrierea referințelor sau la clonare. Aici, criteriul de acceptanță e
verificabil pe documente REALE existente: un ORD se deschide, se salvează și își păstrează toate
câmpurile.

---

## 2. Designul — citește-l înainte de a scrie o linie

**Id-urile existente NU se șterg.** Rămân exact cum sunt, pe câmpurile blocului 0. Motivul:
`doc.js`, `list.js`, `draft.js`, `lockOrdIdentityCols` și încă vreo sută de locuri le folosesc, iar
migrarea lor e treabă pentru loturi ulterioare. Dacă le ștergi acum, rupi tot formularul.

În schimb:

1. În `public/formular.html`, câmpurile blocului beneficiar (`o-nrUnic`, `o-benef`, `o-docsj`,
   `o-iban`, `o-cifb`, `o-banca`, `o-inf1`, `o-inf2`) plus tabelul (`o-tbody`) se **înfășoară**
   într-un container existent sau nou, marcat `data-bloc="0"`.
   ⚠️ Dacă structura HTML actuală nu permite un singur container fără să muți elemente, **NU muta
   nimic** — pune atributul pe cel mai apropiat strămoș comun și raportează structura găsită.
2. Fiecare dintre acele câmpuri primește, **pe lângă** `id`, un atribut nou `data-fld="…"` cu
   numele CANONIC al cheii din bloc: `nr_unic_inreg`, `beneficiar`, `documente_justificative`,
   `iban_beneficiar`, `cif_beneficiar`, `banca_beneficiar`, `inf_pv_plata`, `inf_pv_plata1`.
   ⛔ Nu inventa alte nume — sunt exact cheile folosite de `ord-blocuri.mjs` și de `ordRowToXsd`.
3. În `core.js`, un rezolvator nou:
   ```js
   const blocEl = (i) => document.querySelector(`[data-bloc="${i}"]`);
   const bg = (i, fld) => (blocEl(i)?.querySelector(`[data-fld="${fld}"]`)?.value || '').trim();
   ```
4. `colO()` construiește `docFd` ca **ARRAY**, iterând peste containerele `[data-bloc]` în ordinea
   din DOM. Azi există unul singur ⇒ array cu un element.
   `rowTfd` al blocului *i* = rândurile din `#o-tbody` ale acelui container (azi, toate).

⚠️ **Contractul cu backendul:** `POST`/`PUT /api/formulare-ord` (din #128c) acceptă `blocuri` ca
array de anteturi de bloc, iar `rows` rămâne o listă PLATĂ cu `bloc_idx` pe rând. Verifică pe cod
ce trimite azi `collectOrdDb` (`doc.js:80`) și **aliniază-l**: trimite `blocuri` derivat din
aceleași containere, iar fiecare rând primește `bloc_idx`. ⛔ Nu schimba forma lui `docFd` din
payload-ul de **generare PDF** fără să verifici că `buildOrdnt` (#128e) o normalizează — o face,
dar confirmă pe cod.

---

## 3. NO-TOUCH

⛔ `server/**` în întregime — backendul e gata, lotul ăsta e strict frontend
⛔ `public/js/formular/doc.js` **cu excepția** lui `collectOrdDb` (§2, punctul de contract)
⛔ `public/js/formular/list.js`, `draft.js`, `alop.js` — migrarea lor e #128g și mai departe
⛔ `lockOrdIdentityCols` — rămâne pe id-uri, funcționează pe blocul 0
⛔ Nu șterge niciun `id` existent. Nu redenumi nimic. Nu schimba CSS-ul.
⛔ Nu adăuga butonul de bloc nou, nu adăuga numerotare vizuală — e #128g

---

## 4. Criteriul de acceptanță

**Un ORD existent din producție trebuie să se deschidă, să se salveze și să-și păstreze TOATE
câmpurile, iar payload-ul trimis la server să conțină aceleași valori ca înainte.** Nicio
schimbare vizuală. Dacă ceva arată sau se comportă diferit, patch-ul e greșit.

`valF` trebuie să marcheze în roșu exact aceleași câmpuri ca înainte — deci `markE(id, bad)`
devine capabil să primească un ELEMENT, nu doar un id (adaugă `markEl(el, bad)` și lasă `markE`
neschimbat pentru restul apelanților, care sunt pe DF).

---

## 5. Teste

Convenția existentă pentru teste de frontend cu DOM real e `// @vitest-environment happy-dom` +
încărcarea scriptului clasic prin `new Function(src).call(globalThis)` — vezi
`server/tests/unit/pagin-component.test.mjs`, care e modelul. ⛔ Nu cădea înapoi pe `readFileSync`
+ regex: analiza statică nu dovedește comportamentul.

⚠️ Capcană cunoscută (din PAGIN-1): sub happy-dom, `new URL('.', import.meta.url)` ARUNCĂ
`TypeError` — folosește `dirname(fileURLToPath(import.meta.url))`.

Fișier nou `server/tests/unit/ord-blocuri-frontend.test.mjs`:

1. ⭐ **NON-REGRESIE:** un DOM cu un singur container `[data-bloc="0"]` completat → `colO()`
   întoarce `docFd` cu **un** element, având exact aceleași 8 valori pe care le-ar fi produs
   versiunea pe id-uri (compară cheie cu cheie);
2. `colO()` cu DOUĂ containere în DOM (construite manual în test, deși UI-ul nu le produce încă) →
   `docFd` cu 2 elemente, fiecare cu valorile lui;
3. `rowTfd` al fiecărui bloc conține doar rândurile din containerul lui;
4. `valF('ordnt')` pe un bloc incomplet → întoarce `false` și marchează exact câmpurile lipsă;
5. `valF('ordnt')` cu două blocuri, al doilea incomplet → `false`, și marcarea cade pe câmpul din
   blocul 2, nu pe omologul lui din blocul 1. Ăsta e testul care dovedește că rezolvarea e
   scopată, nu globală;
6. `colO()` fără niciun `[data-bloc]` în DOM (regresie de markup) → nu aruncă; raportează în test
   ce întoarce, ca să fie o decizie conștientă, nu un accident.

---

## 6. Cache busting

`public/js/formular/core.js` și `public/formular.html` sunt fișiere din `public/`. Verifică pe
cod, ⛔ nu presupune:

```bash
grep -n "formular/core.js\|formular.html" public/sw.js
```

- în `PRECACHE_ASSETS` ⇒ **bump obligatoriu `CACHE_VERSION`** (citește valoarea curentă din fișier);
- altfel ⇒ `?v=3.9.766` țintit pe referințele din `formular.html`.

Raportează care caz e și ce ai făcut.

---

## 7. Rulare, versionare, push

```bash
npm test
npm run test:db
```

⛔ „Skipped" NU e „passed".

Bump la `3.9.766`; commit pe `develop`:
`refactor(#128f): colO/valF rezolvă câmpurile ORD pe bloc (data-bloc + data-fld), un singur bloc`;
`git push origin develop`. ⛔ Fără `--amend`, fără `--force`.

---

## 8. Verificări de ieșire (verbatim în raport)

```bash
grep -c 'data-fld=' public/formular.html
# Așteptat: 8 (cele opt câmpuri ale blocului)

grep -n 'data-bloc' public/formular.html
# Așteptat: 1 container, cu data-bloc="0"

grep -n "docFd:" public/js/formular/core.js
# Așteptat: docFd construit ca ARRAY

grep -rn "getElementById('o-benef')\|g('o-benef')" public/js/formular/core.js
# Așteptat: 0 rezultate — colO/valF nu mai citesc beneficiarul după id global

git diff --stat public/js/formular/list.js public/js/formular/draft.js public/js/formular/alop.js
# Așteptat: GOL — migrarea lor e #128g

git status --short
# ⚠️ 7 fișiere .md netrackate preexistente în docs/archive — ignoră-le și confirmă ce ai stage-uit
```

---

## 9. RAPORT FINAL

- commit hash + push; versiunea citită din `package.json`
- `npm test` / `npm run test:db`: numere REALE
- ieșirea celor 6 verificări, verbatim
- ⭐ rezultatele cazurilor **1 și 5** menționate separat — non-regresia pe un bloc și dovada că
  rezolvarea e scopată
- **structura HTML găsită**: unde ai pus `data-bloc="0"` și dacă a fost nevoie să muți vreun
  element (nu ar trebui)
- ce trimite acum `collectOrdDb` (`blocuri` + `bloc_idx` pe rânduri) și cum ai confirmat că se
  aliniază cu ce așteaptă `POST/PUT /api/formulare-ord` din #128c
- cazul de cache busting
- orice abatere. Dacă găsești o eroare în prompt, **spune-o, nu o repara tăcut**
