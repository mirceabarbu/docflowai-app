---
prompt_id: 133c
titlu: Exportul Excel — numele fișierului fără extensie + butonul aliniat vizual cu Clasa 8
branch: develop
model_suggested: Sonnet 5 (efort low)
versiune_start: v3.9.788
versiune_tinta: v3.9.789
migratii: NU
cache_version_bump: NU (nimic din PRECACHE_ASSETS)
---

# ⚠️ BRANCH: `develop` — EXCLUSIV

⛔ NU `checkout main`, NU `merge` spre `main`, NU `push origin main`.
✅ Ultimul pas: `git push origin develop`.

===============================================================================
## CONTEXTUL — două defecte în seria #133, ambele din specificația mea
===============================================================================

**Defect 1 — fișierul exportat nu are extensie.** În browser apare
`DF__2026-08-20`, 19,9 KB. Două probleme într-un singur nume:

- lipsește `.xlsx` ⇒ Windows nu-l deschide la dublu-click, iar `XLSX.writeFile`
  nu mai poate deduce `bookType` din extensie;
- **underscore dublu**: apelantul trimite `'DF_'`, iar modulul adaugă `_AAAA-LL-ZZ`.

Cauza e regula pe care am scris-o la #133a: *„`filename` primește sufixul
`_AAAA-LL-ZZ` dacă nu îl are deja"* — n-am cerut niciodată extensia și n-am
prevăzut separatorul dublu. Clasa 8 o făcea corect de la început
(`'Clasa8_' + dateStr + '.xlsx'`), dar nu trece prin `DFXlsx.save`, deci nu a
expus lipsa.

**Defect 2 — butonul arată altfel decât cel din Clasa 8.** Referința, în
`public/formular.html`:

```html
<button id="clasa8-btn-export" type="button" class="df-action-btn primary" style="align-self:flex-end">
  <svg class="df-ico"><use href="/icons.svg?v=3.9.693#ico-download"/></svg> Export Excel
</button>
```

Butoanele `#btn-lst-export` (DF/ORD) și `#btn-alop-export` au aceeași iconiță și
același text, dar clasa `df-action-btn` **fără `primary`** ⇒ apar ca butoane
secundare. Clasa `primary` lipsește din specificația mea, nu din implementare.

⚠️ Acest lot e **strict cosmetic + numele fișierului**. ⛔ NU atinge conținutul
foilor, coloanele, `numericCols`, modul `?all=1` sau plafonul de 5000.

===============================================================================
## FIȘIERE ATINSE (exhaustiv)
===============================================================================

1. `public/js/shared/xlsx-export.js` — normalizarea numelui
2. `public/formular.html` — clasa `primary` pe cele două butoane + `?v=`
3. `server/tests/unit/xlsx-export-component.test.mjs` — cazuri ADĂUGATE (existent)
4. `server/tests/unit/xlsx-export-wiring.test.mjs` — cazuri ADĂUGATE (existent)
5. `package.json` — bump versiune

⛔ NU se atinge: `list.js`, `alop.js`, `clasa8.js`, niciun fișier de server.

===============================================================================
## ETAPA 1 — Normalizarea numelui în `DFXlsx.save`
===============================================================================

Înlocuiește logica actuală de compunere a numelui cu una care garantează trei
lucruri, în ordinea asta:

1. **Baza** = `filename` primit, curățat de separatorii de la coadă
   (`_`, `-`, spațiu) și de o eventuală extensie `.xlsx`/`.xls` deja prezentă.
2. **Data** `AAAA-LL-ZZ` se adaugă cu UN singur `_`, doar dacă baza nu se termină
   deja cu exact acea dată (idempotent la re-apel).
3. **Extensia** `.xlsx` se adaugă întotdeauna, exact o dată.

Rezultat așteptat, indiferent dacă apelantul trimite `'DF'`, `'DF_'` sau
`'DF_2026-08-20.xlsx'`: **`DF_2026-08-20.xlsx`**.

Comentariu de pus deasupra funcției de normalizare, fără diacritice:
```
// #133c — numele fisierului: baza curatata de separatori si de extensie, apoi
// _AAAA-LL-ZZ cu UN singur underscore, apoi .xlsx exact o data. Fara extensie,
// Windows nu deschide fisierul la dublu-click si XLSX.writeFile nu mai poate
// deduce bookType. Apelantii trimit 'DF_'/'ORD_'/'ALOP_' si NU se modifica.
```

⚠️ Verifică pe cod cum ajunge numele la SheetJS. Dacă apelul e
`XLSX.writeFile(wb, name)`, extensia e suficientă. Dacă e
`XLSX.write` + `Blob` + `<a download>`, pune EXPLICIT `bookType: 'xlsx'` și
`type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'` pe
Blob — altfel numele s-ar potrivi cu un conținut care nu e xlsx.
**Raportează care dintre cele două căi e cea reală.**

⛔ Zero `innerHTML`, zero `onclick` inline (convenția proiectului).

===============================================================================
## ETAPA 2 — Butoanele
===============================================================================

În `public/formular.html`, adaugă `primary` la clasa celor două butoane:

- `#btn-lst-export` (DF/ORD): `class="df-action-btn"` → `class="df-action-btn primary"`
- `#btn-alop-export`: idem

⛔ NU adăuga `style="align-self:flex-end"` prin analogie — cel de la Clasa 8
există fiindcă stă într-un container flex cu altă aliniere. Verifică vizual
contextul fiecărui buton și, dacă alinierea diferă, **raportează** în loc să
inventezi un stil.

⛔ NU atinge `#clasa8-btn-export` — el e referința.
⛔ NU adăuga `data-df-module` (decizia de la #133b: dacă vezi lista, o poți exporta).

**Verificare Etapele 1-2:**
```bash
grep -c "df-action-btn primary" public/formular.html
# Raportează cifra: trebuie să fie cu 2 mai mare decât înainte de patch (măsoară
# ÎNAINTE și DUPĂ, nu presupune o valoare absolută)
grep -n "btn-lst-export\|btn-alop-export\|clasa8-btn-export" public/formular.html
grep -c "\.xlsx" public/js/shared/xlsx-export.js   # Așteptat: >= 1
```

===============================================================================
## ETAPA 3 — Teste
===============================================================================

În `server/tests/unit/xlsx-export-component.test.mjs` (happy-dom, `window.XLSX`
mock-uit — ⛔ testele nu ating rețeaua), adaugă:

1. `'DF_'` ⇒ `DF_2026-08-20.xlsx` — UN singur underscore, extensie prezentă
2. `'DF'` ⇒ același rezultat
3. `'ALOP_'` și `'ORD_'` ⇒ `ALOP_…xlsx` / `ORD_…xlsx`
4. idempotență: un nume care are deja data ȘI extensia nu le primește a doua oară
5. numele final se termină cu `.xlsx` exact o dată (`/\.xlsx$/` și zero `.xlsx.xlsx`)
6. zero `__` (underscore dublu) în numele final
7. dacă exportul trece prin Blob: `bookType` și tipul MIME sunt cele de xlsx

⚠️ Cazurile 1-4 trebuie să folosească o dată FIXĂ (mock pe `Date`), altfel testul
devine dependent de ziua în care rulează.

În `server/tests/unit/xlsx-export-wiring.test.mjs` (aserțiuni structurale pe sursă):

8. `#btn-lst-export`, `#btn-alop-export` și `#clasa8-btn-export` au TOATE trei
   `df-action-btn primary` — plasa care ține consistența vizuală de acum înainte
9. toate trei folosesc `#ico-download` și textul `Export Excel`

```bash
npm test
npm run test:db     # non-regresie; acest lot nu atinge serverul
```

**Acceptanță manuală (obligatorie, e un bug vizual):** exportă din DF, din ORD,
din ALOP și din Clasa 8. Confirmă că toate patru descarcă un fișier `.xlsx` care
se deschide la dublu-click și că cele patru butoane arată identic.

===============================================================================
## ETAPA 4 — Versionare și commit
===============================================================================

```bash
# package.json 3.9.788 → 3.9.789
sed -i -E "s#(js/shared/xlsx-export\.js\?v=)[0-9.]+#\13.9.789#g" public/formular.html
grep -o 'shared/xlsx-export\.js?v=[0-9.]*' public/formular.html   # Așteptat: 3.9.789
grep -o 'formular/list\.js?v=[0-9.]*'      public/formular.html   # Așteptat: 3.9.784 — NEATINS
grep -o 'formular/alop\.js?v=[0-9.]*'      public/formular.html   # Așteptat: 3.9.785 — NEATINS
grep -o 'formular/clasa8\.js?v=[0-9.]*'    public/formular.html   # Așteptat: 3.9.785 — NEATINS
grep -n 'js/shared/xlsx-export\.js' public/formular.html          # tag <script> INTACT
grep -n "CACHE_VERSION" public/sw.js | head -1                    # NEATINS
```
⚠️ Grupul de captură la `sed` se scrie `\1`, NU `\g<1>`.

```bash
git status --short   # Așteptat: 4 modificate, 0 noi
# ⛔ NU `git add -A` — reorganizarea de documentație stă necomisă în arbore și
# NU aparține acestui commit.
git add public/js/shared/xlsx-export.js public/formular.html \
        server/tests/unit/xlsx-export-component.test.mjs \
        server/tests/unit/xlsx-export-wiring.test.mjs package.json
git commit -m "fix(#133c): exportul Excel primeste extensia .xlsx si un singur underscore; butoanele aliniate cu Clasa 8 (v3.9.789)"
git push origin develop
```

===============================================================================
## RAPORT FINAL (obligatoriu)
===============================================================================

1. **Numele exact produs** pentru fiecare dintre cele trei exporturi (DF, ORD,
   ALOP), înainte și după patch.
2. Care e calea reală spre SheetJS: `XLSX.writeFile` sau `XLSX.write` + Blob?
3. Ieșirea comenzilor de verificare (Etapele 2, 4), cu cifra `df-action-btn primary`
   ÎNAINTE și DUPĂ.
4. `npm test` / `npm run test:db`: fișiere / teste / eșecuri.
5. Cele 9 cazuri, numerotat. Câte teste EXISTENTE au fost atinse și de ce.
6. Rezultatul acceptanței manuale pe toate patru exporturile.
7. Hash-ul commit-ului + confirmarea push-ului.
8. Orice contrazicere între cod și acest prompt — raportează, nu repara tăcut.

===============================================================================
## ⛔ CONSTRÂNGERI ABSOLUTE
===============================================================================

- ⛔ Zero fișiere de server. Zero migrații. Zona NO-TOUCH neatinsă.
- ⛔ NU atinge `list.js`, `alop.js`, `clasa8.js` — apelanții rămân cum sunt;
  normalizarea trăiește ÎN modul, ca orice apelant viitor să beneficieze.
- ⛔ NU schimba conținutul foilor, coloanele, `numericCols`, `?all=1` sau plafonul.
- ⛔ NU atinge `#clasa8-btn-export` și nici raportul lui de execuție.
- ⛔ NU face bulk-sed pe toate `?v=` din HTML.
- ⛔ NU folosi `git add -A`. `main` nu se atinge sub nicio formă.
