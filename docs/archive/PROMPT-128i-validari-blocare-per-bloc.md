# PROMPT #128i — validările și blocarea pe rol se aplică TUTUROR blocurilor

> ## ⚠️ BRANCH: `develop`
> Toate commit-urile pe `develop`. **NU** propune și **NU** executa `checkout main`,
> `merge main`, `push origin main`. Deploy-ul îl face Mircea manual.

**Model recomandat:** Opus · **Target versiune:** `v3.9.769` (de la 3.9.768 — **citește
`package.json`**) · **Migrații:** ZERO · **Fișiere din `server/`:** ZERO

---

## 1. Bugul, raportat de Mircea după testul pe staging

După #128h se pot adăuga furnizori, dar **blocul 2 e o clonă vizuală**: nu validează nimic, nu
verifică CIF-ul la ANAF, nu aplică regulile blocului 1.

Cauza: comportamentul „viu" al formularului e ancorat pe **id-uri**, iar blocurile clonate nu au
id-uri (prin construcție, la #128h — decizie corectă, care ține în viață tot codul nemigrat).

Inventar verificat pe cod:

| Ce lipsește în blocul 2 | Unde e ancorat | Lot |
|---|---|---|
| **Lista de erori dinaintea generării PDF** | `doc.js:1366-1373` — `req('o-benef')`, `req('o-cifb')`, `req('o-iban')`, `req('o-banca')`, `req('o-docsj')`, `req('o-inf1')` | **#128i** |
| „Cel puțin un rând cu suma > 0" | `doc.js:1363` pe `#o-tbody` | **#128i** |
| Blocarea coloanelor de identitate | `lockOrdIdentityCols` pe `#o-tbody` | **#128i** |
| Redeschiderea col.4 pentru P1 / col.2-3 pentru P2 | `doc.js` ~413, ~808, pe `#o-tbody` | **#128i** |
| Autocomplete beneficiar, lookup CIF ANAF, badge stare | handlere inline `oninput=`/`onblur=` pe `#o-benef` / `#o-cifb` | #128j |
| Avertizarea de buget, indicatorul de sume | `#o-tbody` | #128j |
| Atașamente per furnizor | `formulare_atasamente` nu are noțiune de bloc | #128k (cu migrație) |

⛔ Lotul ăsta rezolvă **doar liniile marcate #128i**. Restul e programat separat; nu le începe.

**Nuanță importantă pentru calibrare:** serverul validează CORECT. `validateOrdnt` (#128e)
iterează blocurile și respinge un ORD cu blocul 2 incomplet, cu mesaj prefixat „blocul 2:". Deci
NU intră date proaste în lanțul oficial — utilizatorul află doar târziu și cu un mesaj mai sec
decât marcarea în roșu. E o gaură de UX și de paritate, nu de integritate. ⛔ Nu slăbi nimic pe
server ca să „potrivești" comportamentul.

---

## 2. NO-TOUCH

⛔ `server/**` în întregime — lot strict frontend, zero atingeri
⛔ Handlerele inline `oninput="debouncedBenefSearch()"` și `onblur="_lookupByCif()"` din
   `formular.html` — sunt #128j, unde vor fi înlocuite cu **delegare de evenimente**. ⛔ Nu le
   cabla acum pe blocuri prin altă metodă, ar trebui refăcut peste o săptămână
⛔ Zona de atașamente (`#o-alist`, `#o-ainp`, `#o-adata`) — e #128k
⛔ Capturile — rămân per document (decizie de la #128h)
⛔ `_sablonBloc` — nu adăuga câmpuri noi în șablon
⛔ Nu schimba `valF` din `core.js` decât dacă recon-ul de la §3.0 arată că NU iterează blocurile

---

## 3. Etapa A — validarea dinaintea generării PDF

### 3.0 Recon obligatoriu, înainte de orice patch

Confirmă pe cod și raportează:

1. `valF` (`core.js` ~:463) iterează blocurile după #128f — **da sau nu**, cu linia. Există DOUĂ
   căi de validare (`valF` marchează în roșu; `doc.js` construiește lista de erori cu derulare la
   prima). Dacă `valF` deja iterează, ⛔ nu o atinge.
2. Cum se numește azi funcția care conține blocul `req('o-benef', …)` din `doc.js` și cine o
   apelează.
3. Ce face exact `req(id, label)` — presupun că împinge `{id, label}` în `errs`; confirmă.

### 3.1 Generalizarea

Blocul de `req(...)` pentru câmpurile beneficiarului devine o buclă peste containerele
`[data-bloc]`, în ordinea `data-bloc`:

- pentru fiecare bloc, se validează `beneficiar`, `documente_justificative`, `cif_beneficiar`,
  `iban_beneficiar`, `banca_beneficiar`, `inf_pv_plata` — rezolvate prin `data-fld`, nu prin id;
- `req` primește un **ELEMENT**, nu un id (adaugă o variantă `reqEl(el, label)`; ⛔ păstrează `req`
  neschimbată pentru câmpurile care rămân globale: `o-den`, `o-cif`, și pentru DF);
- ⭐ **eticheta:** cu UN SINGUR bloc, textele rămân **byte-identice** cu azi („Beneficiar",
  „CIF beneficiar", …). Cu mai multe blocuri, fiecare etichetă se prefixează cu
  `` `Furnizor ${i + 1} — ` ``. Ăsta e singurul loc unde mesajele se schimbă, și numai pe o cale
  care azi nu poate fi atinsă;
- `nr_unic_inreg` NU se validează per bloc — e unic pe document (`#o-nrUnic`), citit global.

### 3.2 „Cel puțin un rând cu suma > 0" — devine PER BLOC

Azi: `document.querySelectorAll('#o-tbody input[data-f="suma_ordonantata_plata"]')`, deci doar
blocul 0. Devine: fiecare bloc trebuie să aibă **cel puțin un rând cu valoare > 0** pe coloana 4.
Motiv: un furnizor fără nicio sumă ordonanțată n-are ce căuta în document — și e regula MF
(„cel puțin una din coloanele 2-5 completată", per bloc).

Mesajul păstrează forma actuală la un singur bloc; la mai multe, prefixat cu „Furnizor N —".

### 3.3 Derularea la prima eroare

`_scrollToFirstErr` (`doc.js` ~1376) caută prin `document.getElementById(e.id)`. Pentru erorile
din blocurile 2+ nu există id ⇒ trebuie să poată primi și un ELEMENT. Extinde structura erorii cu
un câmp opțional `el`, folosit când `id` lipsește. ⛔ Nu schimba comportamentul pentru erorile cu
`id` — sunt folosite și de DF.

---

## 4. Etapa B — blocarea coloanelor de identitate și pe rol

### 4.1 `lockOrdIdentityCols`

Azi operează pe `#o-tbody` (implicit primul, deci blocul 0) și dezactivează primul buton `.badd`
din `#form-ordnt`. Generalizează: pentru FIECARE `[data-bloc]`, coloanele `cod_angajament`,
`indicator_angajament`, `program`, `cod_SSI` devin `readOnly` (⛔ **niciodată `disabled`** — ar
scoate valorile din payload; regula e din #100.1) cu `tabIndex = -1`, iar butonul `.badd` al
acelui bloc se dezactivează când ORD-ul e legat de DF (`#o-df-id` completat).

⚠️ La #128h, coloanele de identitate ale blocurilor noi se puneau `readOnly` **la creare**. După
generalizare, verifică să nu existe dublă aplicare contradictorie — și că un bloc creat înainte ca
DF-ul să fie selectat se blochează corect când DF-ul e ales ulterior.

### 4.2 Redeschiderea pe rol

Cele două locuri din `doc.js` (~413 și ~808) care redeschid coloana 4 pentru P1 și coloanele 2-3
pentru P2 selectează pe `#o-tbody`. Generalizează la toate blocurile, **fără să schimbi regula**:
cine ce poate edita rămâne exact cum e azi, se schimbă doar mulțimea de rânduri acoperită.

⚠️ Verifică pe cod TOATE siturile care selectează `#o-tbody input[data-f=...]` și raportează
tabelul: pentru fiecare, dacă l-ai generalizat (și de ce) sau l-ai lăsat (și de ce). Unele țin de
#128j — lasă-le, dar consemnează-le.

---

## 5. Etapa C — teste

`// @vitest-environment happy-dom`, modelul din `pagin-component.test.mjs`; capcana cunoscută:
`dirname(fileURLToPath(import.meta.url))`, NU `new URL('.', import.meta.url)`.

1. ⭐ **NON-REGRESIE:** cu UN SINGUR bloc, lista de erori are exact aceleași etichete ca înainte
   de lot, **fără prefix**. Dacă pică, patch-ul e greșit;
2. ⭐ două blocuri, al doilea cu beneficiarul gol → apare eroarea „Furnizor 2 — Beneficiar",
   iar blocul 1 nu generează nicio eroare;
3. ⭐ două blocuri, al doilea fără niciun rând cu suma > 0 → eroare pe blocul 2, blocul 1 curat;
4. două blocuri, ambele complete → zero erori;
5. derularea la prima eroare funcționează pentru o eroare dintr-un bloc fără id (verifică prin
   spionarea lui `scrollIntoView` pe elementul corect);
6. `lockOrdIdentityCols` cu `#o-df-id` completat → coloanele de identitate `readOnly` (⛔ NU
   `disabled`) în **toate** blocurile, iar butonul `.badd` al fiecăruia dezactivat;
7. un bloc adăugat DUPĂ selectarea DF-ului și unul adăugat ÎNAINTE → amândouă ajung blocate după
   ce se apelează `lockOrdIdentityCols`;
8. redeschiderea pe rol (P1 / P2) atinge rândurile din toate blocurile.

---

## 6. Cache busting

`formular.html`, `core.js`, `doc.js` sunt în `public/`. Verifică pe cod:
`grep -n "formular/core.js\|formular/doc.js" public/sw.js`. La #128h s-a constatat că NU sunt în
`PRECACHE_ASSETS` ⇒ probabil doar `?v=3.9.769` țintit pe fișierele atinse. **Confirmă tu**, nu
presupune, și raportează.

---

## 7. Rulare, versionare, push

```bash
npm test
npm run test:db
```

⛔ „Skipped" NU e „passed".

Bump la `3.9.769`; commit pe `develop` (⚠️ sintaxă **bash**, nu PowerShell):
`fix(#128i): validările și blocarea pe rol se aplică tuturor blocurilor ORD`;
`git push origin develop`. ⛔ Fără `--amend`, fără `--force`.

---

## 8. Verificări de ieșire (verbatim în raport)

```bash
grep -n "'#o-tbody" public/js/formular/doc.js
# Așteptat: DOAR siturile lăsate deliberat (#128j) — fiecare consemnat în tabelul de la §4.2

grep -n "Furnizor \${" public/js/formular/doc.js
# Așteptat: prefixul aplicat DOAR când există mai multe blocuri

grep -n "disabled" public/js/formular/doc.js | grep -i "cod_angajament\|identity\|ident"
# Așteptat: 0 — identitatea se blochează cu readOnly, niciodată disabled

git diff --stat server/
# Așteptat: GOL

grep -n "oninput=\"debouncedBenefSearch\|onblur=\"window._lookupByCif" public/formular.html
# Așteptat: NESCHIMBAT față de înainte — handlerele inline sunt #128j
```

---

## 9. RAPORT FINAL

- commit hash + push; versiunea citită din `package.json`
- `npm test` / `npm run test:db`: numere REALE
- ieșirea celor 5 verificări, verbatim
- **răspunsul la reconul §3.0**: `valF` iterează blocurile da/nu (cu linia), numele funcției de
  validare din `doc.js`, forma exactă a lui `req`
- ⭐ **tabelul de la §4.2**: fiecare sit `#o-tbody` din `doc.js`, generalizat sau lăsat, cu motivul
- ⭐ rezultatele cazurilor **1, 2 și 3** menționate separat
- cazul de cache busting
- orice abatere. Dacă găsești o eroare în prompt, **spune-o, nu o repara tăcut**

> ⚠️ Reamintire din ultimele două loturi: orice câmp sau comportament nou pe formularul ORD are
> **trei** trasee — creare, salvare, **redeschidere** (`populateOrd`). Al treilea a fost cel uitat
> și la #128g (`ctrl_idx`), și la #128h (blocurile). Verifică-l explicit și spune în raport dacă
> lotul ăsta îl atinge sau nu.
