# PROMPT #128j — comportamentele „vii" pe toate blocurile (delegare de evenimente)

> ## ⚠️ BRANCH: `develop`
> Toate commit-urile pe `develop`. **NU** propune și **NU** executa `checkout main`,
> `merge main`, `push origin main`. Deploy-ul îl face Mircea manual.

**Model recomandat:** Opus — atinge verificarea beneficiarului la ANAF, dinaintea plății
**Target versiune:** `v3.9.770` (de la 3.9.769 — **citește `package.json`**)
**Migrații:** ZERO · **Fișiere din `server/`:** ZERO

> ⚠️ **Mesajul de commit se dă cu `git commit -m "subiect"`, pe o singură linie, sintaxă bash.**
> ⛔ Fără here-string (`@'…'@` e PowerShell și a lăsat caractere `@` parazite în mesajele de la
> #128g, #128h și #128i — trei loturi la rând).

---

## 1. Ce lipsește, verificat pe cod

După #128h se pot adăuga furnizori, iar #128i a rezolvat validările și blocarea. Rămân
comportamentele „vii", toate ancorate pe **id-uri**, deci active doar pe blocul 0:

| Comportament | Ancorare azi |
|---|---|
| Autocomplete beneficiar | `oninput="debouncedBenefSearch()"` inline pe `#o-benef`; `_searchBenef` citește `#o-benef`, scrie în `#o-benef-drop` (`list.js:198`) |
| Alegerea din dropdown | `selectBenef()` scrie în 4 id-uri (`list.js:216`) |
| Lookup CIF (local → ANAF) + auto-fill | `onblur="window._lookupByCif&&…"` inline pe `#o-cifb`; spinner `#o-cifb-spin` (`list.js:244`) |
| Badge stare ANAF (radiat / inactiv / TVA anulat) | `renderBenefStatusBadge` scrie în `#o-benef-status` (`list.js:223`) |
| Închiderea dropdown-ului la click în afară | handler global pe `#o-benef-drop` (`list.js:313`) |
| Salvarea beneficiarului nou la „Trimite P2" | `_saveBeneficiarIfNew` citește cele 4 id-uri (`list.js:318`) |
| Avertizarea de buget | `doc.js:364, 382, 388, 394` pe `#o-tbody` |

---

## 2. Abordarea: DELEGARE, nu cablare per clonă

⛔ **Nu adăuga handlere pe fiecare bloc la creare.** Un bloc nou ar trebui cablat la creare, la
restaurarea din draft și la redeschiderea documentului — trei locuri de ținut sincronizate, exact
tiparul care a produs gaura de la `populateOrd` de două ori.

**Soluția:** un singur set de handlere delegate pe containerul `#ord-blocuri` (creat la #128h),
care rezolvă blocul prin `event.target.closest('[data-bloc]')`. Orice bloc — existent, clonat,
restaurat din draft sau recreat de `renderOrdBlocuri` — e acoperit automat, fără nicio cablare.

Handlerele inline din `formular.html` (`oninput=`, `onblur=`) se **ȘTERG** și se înlocuiesc cu
delegarea. ⛔ Nu le lăsa pe amândouă — s-ar declanșa de două ori.

### 2.1 Elemente auxiliare per bloc

`#o-benef-drop`, `#o-benef-status` și `#o-cifb-spin` există doar în blocul 0, prin id. Fiecare
primește **și** un atribut `data-role` (`benef-drop`, `benef-status`, `cifb-spin`), iar
`_sablonBloc` (`core.js`, din #128h) le emite pentru blocurile noi **doar cu `data-role`, fără
niciun `id`** — regula din #128h se păstrează.

Rezolvarea se face prin `blocEl.querySelector('[data-role="…"]')`. ⛔ Nu introduce id-uri
sufixate (`o-benef-drop-1`); ar reînvia problema pe care #128h a evitat-o.

### 2.2 ⭐ Alegerea din dropdown — repară și un bug preexistent

`_searchBenef` generează azi:

```js
onclick="selectBenef(${b.id},'${esc(b.denumire)}','${esc(b.cif||'')}',…)"
```

Adică date de beneficiar interpolate într-un **șir JavaScript, în interiorul unui atribut HTML**.
`esc()` e escape HTML, nu escape pentru context JS ⇒ un beneficiar cu apostrof în denumire
(„Ferma L'Aurora SRL") rupe atributul și opțiunea devine inertă sau aruncă în consolă. Nu e o
regresie a lotului, e o slăbiciune existentă.

**Înlocuiește cu delegare + `dataset`:** opțiunile poartă `data-ben-id`, `data-ben-den`,
`data-ben-cif`, `data-ben-iban`, `data-ben-banca`, iar un handler delegat pe `.ac-opt` citește
valorile din `dataset` și completează câmpurile **blocului din care provine clicul**.
⛔ `selectBenef(...)` rămâne exportată pe `window` cu semnătura actuală (poate avea apelanți în
afara fișierului) — verifică cu grep și raportează; dacă nu are, spune-o, dar tot n-o șterge în
lotul ăsta.

---

## 3. Ce se generalizează, punct cu punct

Toate funcțiile de mai jos primesc un **bloc-țintă** (elementul `[data-bloc]`), cu default
blocul 0 când nu li se dă nimic — ca apelanții existenți să funcționeze neschimbat:

1. **`_searchBenef(blocEl)`** — citește `[data-fld="beneficiar"]` din bloc, scrie în
   `[data-role="benef-drop"]` al aceluiași bloc. Debounce-ul rămâne 400 ms, dar trebuie ținut
   **per bloc** (un `Map` bloc→timer, nu un `_benefTimer` global — altfel tastarea în blocul 2
   anulează căutarea din blocul 1).
2. **`_lookupByCif(blocEl)`** — citește `[data-fld="cif_beneficiar"]`, folosește
   `[data-role="cifb-spin"]` și completează `beneficiar` / `iban_beneficiar` / `banca_beneficiar`
   **din același bloc**. ⚠️ Păstrează neatinsă logica: normalizarea `RO`, regex-ul `^\d{2,10}$`,
   întâi local apoi ANAF, verificarea non-blocantă a stării la potrivirea locală, și **garda de
   cursă** (`_cifSnapshot` — răspunsul se ignoră dacă valoarea câmpului s-a schimbat între timp).
   Garda trebuie să compare cu câmpul **blocului**, nu cu `#o-cifb`.
3. **`renderBenefStatusBadge(d, blocEl)`** — scrie în `[data-role="benef-status"]` al blocului.
4. **Închiderea la click în afară** — închide dropdown-urile **tuturor** blocurilor, mai puțin cel
   care conține ținta clicului.
5. **`_saveBeneficiarIfNew()`** — iterează blocurile și salvează beneficiarul **fiecăruia** (sare
   peste cele cu denumirea goală). Azi salvează unul singur.
6. **Avertizarea de buget** (`doc.js:364, 382, 388, 394`) — folosește `_ordAllRowInputs` /
   `_ordAllRows`, helperii introduși la #128i. Suma comparată cu bugetul DF-ului rămâne
   **totalul pe TOATE blocurile** (ORD-ul e un singur document, cu un singur DF), iar clasa
   `ord-buget-over` se aplică rândurilor din toate blocurile. ⛔ Nu calcula buget per bloc.

---

## 4. NO-TOUCH

⛔ `server/**` — lot strict frontend
⛔ Rutele `/api/beneficiari` și `/api/verify/cui` — nu se ating, nu se schimbă forma cererilor
⛔ Zona de atașamente și capturile — sunt #128k (împreună cu `bloc_idx` pe binare)
⛔ `_validateOrd`, `valF`, `lockOrdIdentityCols` — gata din #128i
⛔ Nu adăuga id-uri în `_sablonBloc`
⛔ Nu schimba textele badge-ului ANAF, culorile sau pragurile — doar destinația scrierii

---

## 5. Teste

`// @vitest-environment happy-dom`, modelul din `pagin-component.test.mjs`; capcana cunoscută:
`dirname(fileURLToPath(import.meta.url))`, NU `new URL('.', import.meta.url)`.
`fetch` se mock-uiește (nu se lovește ANAF-ul real).

1. ⭐ **NON-REGRESIE:** cu un singur bloc, autocomplete-ul, lookup-ul CIF și badge-ul se comportă
   exact ca azi și scriu în aceleași elemente (`#o-benef-drop`, `#o-benef-status`, `#o-cifb-spin`);
2. ⭐ tastare în `beneficiar` din **blocul 2** → dropdown-ul apare în blocul 2, iar cel din blocul
   1 rămâne închis;
3. ⭐ `blur` pe `cif_beneficiar` din blocul 2 → auto-fill în blocul 2, badge în blocul 2, blocul 1
   **complet neatins**;
4. debounce per bloc: tastare rapidă în blocul 1 apoi în blocul 2 → **ambele** căutări pleacă
   (nu se anulează reciproc);
5. alegerea unei opțiuni din dropdown-ul blocului 2 completează câmpurile blocului 2;
6. ⭐ **beneficiar cu apostrof** în denumire („Ferma L'Aurora SRL") → opțiunea se randează, se
   poate selecta, iar valoarea ajunge intactă în câmp (bugul preexistent, reparat);
7. garda de cursă: răspunsul ANAF întârziat se ignoră dacă CIF-ul blocului s-a schimbat între timp;
8. click în afară închide dropdown-urile tuturor blocurilor;
9. `_saveBeneficiarIfNew` cu două blocuri completate → **două** POST-uri pe `/api/beneficiari`;
   cu al doilea bloc gol → un singur POST;
10. avertizarea de buget marchează rândurile din ambele blocuri când totalul depășește.

---

## 6. Cache busting

`formular.html`, `list.js`, `core.js`, `doc.js` — verifică pe cod
(`grep -n "formular/list.js\|formular/core.js\|formular/doc.js" public/sw.js`). La #128h și #128i
s-a constatat că NU sunt în `PRECACHE_ASSETS` ⇒ probabil doar `?v=3.9.770` țintit pe fișierele
efectiv atinse. **Confirmă**, nu presupune, și raportează.

---

## 7. Rulare, versionare, push

```bash
npm test
npm run test:db
```

⛔ „Skipped" NU e „passed".

Bump la `3.9.770`; `git commit -m "fix(#128j): autocomplete, lookup ANAF si avertizarea de buget pe toate blocurile ORD"`;
`git push origin develop`. ⛔ Fără `--amend`, fără `--force`.

---

## 8. Verificări de ieșire (verbatim în raport)

```bash
grep -n 'oninput="debouncedBenefSearch\|onblur="window._lookupByCif' public/formular.html
# Așteptat: 0 rezultate — handlerele inline au fost înlocuite cu delegare

grep -n 'data-role=' public/formular.html
# Așteptat: benef-drop, benef-status, cifb-spin pe elementele blocului 0 (pe lângă id-urile lor)

grep -n "getElementById('o-benef')\|getElementById('o-cifb')\|getElementById('o-benef-status')" public/js/formular/list.js
# Așteptat: 0 rezultate în funcțiile generalizate; dacă rămâne vreuna, explică de ce

grep -n "onclick=\\\\\"selectBenef" public/js/formular/list.js
# Așteptat: 0 rezultate — opțiunile folosesc dataset + delegare

git diff --stat server/
# Așteptat: GOL
```

---

## 9. RAPORT FINAL

- commit hash + push; versiunea citită din `package.json`; **mesajul de commit fără caractere
  parazite** (confirmă cu `git log -1 --pretty=%s`)
- `npm test` / `npm run test:db`: numere REALE
- ieșirea celor 5 verificări, verbatim
- ⭐ rezultatele cazurilor **1, 2, 3 și 6** menționate separat
- dacă `selectBenef` mai are apelanți în afara `list.js` — cu grep-ul care o dovedește
- cazul de cache busting
- **al treilea traseu:** lotul atinge sau nu `populateOrd` / `renderOrdBlocuri` / `draft.js`?
  Delegarea ar trebui să-l facă inutil — confirmă explicit că blocurile restaurate din draft și
  cele recreate la redeschidere primesc comportamentul FĂRĂ nicio cablare suplimentară, și pune
  un caz de test pe asta
- orice abatere. Dacă găsești o eroare în prompt, **spune-o, nu o repara tăcut**
