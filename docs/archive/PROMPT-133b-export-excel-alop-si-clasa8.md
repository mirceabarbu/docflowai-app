---
prompt_id: 133b
titlu: Export Excel — al doilea consumator (ALOP) + eliminarea copiei de încărcător SheetJS din Clasa 8
branch: develop
model_suggested: Sonnet 5 (efort medium)
versiune_start: v3.9.784 (după #133a)
versiune_tinta: v3.9.785
migratii: NU
cache_version_bump: NU (alop.js și clasa8.js nu sunt în PRECACHE_ASSETS)
---

# ⚠️ BRANCH: `develop` — EXCLUSIV

`main` = PRODUCȚIE, gestionat MANUAL de Mircea.
⛔ NU `checkout main`, NU `merge` spre `main`, NU `push origin main`.
✅ Ultimul pas: `git push origin develop`.

===============================================================================
## CONTEXTUL
===============================================================================

#133a a livrat modul `?all=1` pe AMBELE endpointuri (inclusiv `GET /api/alop`),
modulul partajat `window.DFXlsx` și primul consumator (lista DF/ORD).

Acest lot adaugă **al doilea consumator — lista ALOP** — și, în același șantier,
**mută Clasa 8 pe modulul partajat**, ca să nu rămână o a doua copie a
încărcătorului SheetJS în proiect. (Disciplina PAGIN: componentă întâi, apoi câte
un consumator pe prompt; aici al doilea consumator și migrarea celui preexistent
merg împreună fiindcă a doua e strict o ștergere de duplicat.)

⚠️ **Backendul e DEJA gata.** ⛔ Nu atinge `server/routes/alop.mjs` în acest lot —
`?all=1`, plafonul și filtrul derivat `SQL_ALOP_BADGE` (#132b) au aterizat la
#133a. Dacă găsești ceva de reparat acolo, RAPORTEAZĂ, nu repara aici.

===============================================================================
## FIȘIERE ATINSE (exhaustiv)
===============================================================================

1. `public/js/formular/alop.js` — `exportAlop()`
2. `public/js/formular/clasa8.js` — `_loadSheetJs` local ȘTERS, `_exportXLSX` trece pe `DFXlsx`
3. `public/formular.html` — butonul ALOP + `?v=` țintit pe alop.js și clasa8.js
4. `server/tests/unit/xlsx-export-wiring.test.mjs` — **FIȘIER NOU** (parametrizat)
5. `package.json` — bump versiune

⛔ Zero fișiere de server. Zero migrații.

===============================================================================
## ETAPA 1 — Butonul, în antetul ALOP
===============================================================================

Fișier: `public/formular.html`

`old_str`:
```
      <button class="df-action-btn" id="btn-opme-import" data-df-module="alop" style="display:none" onclick="openOpmeImport()"><svg class="df-ico"><use href="/icons.svg?v=3.9.693#ico-upload-cloud"/></svg> Import OPME (F1129)</button>
```
`new_str`:
```
      <button class="df-action-btn" id="btn-opme-import" data-df-module="alop" style="display:none" onclick="openOpmeImport()"><svg class="df-ico"><use href="/icons.svg?v=3.9.693#ico-upload-cloud"/></svg> Import OPME (F1129)</button>
      <button class="df-action-btn" id="btn-alop-export" type="button" onclick="exportAlop()" title="Exportă în Excel lista filtrată"><svg class="df-ico"><use href="/icons.svg?v=3.9.693#ico-download"/></svg> Export Excel</button>
```

⚠️ Butonul de export NU primește `data-df-module="alop"`: acela e gata de
entitlements (gating pe module), iar exportul nu e o funcționalitate separat
licențiată — dacă utilizatorul vede lista, poate exporta lista. Dacă la testare
constată că e ascuns/afișat greșit, raportează în loc să adaugi atributul.

Scriptul `/js/shared/xlsx-export.js` e deja încărcat din #133a — verifică prin
`grep` că indexul liniei lui e MAI MIC decât al liniei cu `formular/alop.js`
(`defer` execută în ordinea documentului). Dacă nu e, MUTĂ tag-ul, nu-l duplica.

===============================================================================
## ETAPA 2 — `exportAlop()` în `public/js/formular/alop.js`
===============================================================================

Oglindește fidel `exportLista()` din `list.js` (#133a) — aceeași structură,
aceleași gărzi. Expune `window.exportAlop = exportAlop;` lângă celelalte
exporturi de la finalul fișierului.

1. Reia **exact** query string-ul construit de `loadAlop()` — ⛔ nu-l rescrie de
   la zero. Extrage construcția în helperul `_alopQuery({ all })` folosit de
   AMBELE funcții, apoi cheamă `/api/alop?…&all=1` (fără `page`/`limit`).
   Filtrele ALOP live azi: `q`, `creat`, `comp`, `status`, `from`, `to`.
2. ⚠️ Cheia răspunsului la ALOP este **`data.alop`**, nu `data.rows` (asimetrie
   față de `/api/formulare/list`, verificată la ALOP-PAGIN). Totalul e `data.total`.
3. Buton `disabled` + „⏳ Se pregătește…" pe durata cererii, restaurat în `finally`.
4. `alop.length < total` → `alert` cu plafonul, ca la #133a.
   `alop.length === 0` → mesaj și ⛔ NICIUN fișier gol descărcat.
5. `window.DFXlsx` absent → `alert` + `console.error`, fără excepție necapturată.

Coloanele exportate:

`Titlu`, `Compartiment`, `Creat de`, `Status`, `Fază`, `Valoare totală`,
`Valoare DF`, `Valoare ORD (toate ciclurile)`, `Total plătit`, `Creat la`,
`Actualizat la`

Reguli pentru celule:

- **`Status` = eticheta în clar, derivată din `a.badge_status`** (câmpul
  server-side introdus la #132b), prin harta `m` deja existentă în
  `_alopStatusBadge`. ⛔ Nu scrie cheia tehnică (`angajare_flux`) în fișier și
  ⛔ nu duplica harta: mut-o într-un `const _ALOP_ST_LABELS` la nivel de fișier,
  pe care `_alopStatusBadge` îl folosește apoi. Exportul ia DOAR textul
  (`.text`), fără iconițe.
- `Fază` = `_alopFazaLabel(a.status)` — deliberat pe statusul BRUT, ca în coloana
  omonimă din listă. Cele două coloane pot să difere legitim („Pe flux — semnare"
  vs „Faza 1: Angajare"); nu le alinia.
- Cele patru coloane de bani sunt NUMERICE (`numericCols`), cu aceleași expresii
  ca în randare, ca fișierul să nu contrazică ecranul:
  `valoare_totala` · `df_valoare` · `total_ord_valoare || ord_valoare || 0` ·
  `total_platit || op_valoare || 0`
- Datele: `dd.mm.aaaa` prin `toLocaleDateString('ro-RO')` — TEXT.
- `filename: 'ALOP_'`, `sheet: 'ALOP'`.

**Verificare Etapa 2:**
```bash
grep -c "exportAlop" public/js/formular/alop.js        # Așteptat: 2
grep -c "_alopQuery" public/js/formular/alop.js        # Așteptat: 3
grep -c "_ALOP_ST_LABELS" public/js/formular/alop.js   # Așteptat: 3
grep -c "data.rows" public/js/formular/alop.js         # Așteptat: 0 (cheia e `alop`)
```

===============================================================================
## ETAPA 3 — Clasa 8 trece pe modulul partajat
===============================================================================

Fișier: `public/js/formular/clasa8.js`

Șterge blocul local `SHEETJS_CDN` / `_sheetJsLoading` / `_loadSheetJs`
(~liniile 165-181) și înlocuiește în `_exportXLSX` apelul `await _loadSheetJs()`
cu `await window.DFXlsx.load()`.

⚠️ **Cât se păstrează neatins, deliberat:** restul lui `_exportXLSX` rămâne EXACT
cum e — antetul de 7 coloane (`Cod SSI`, `BUGET`, `Angajamente bugetare`, `Rămâne
din buget`, `Ordonanțări`, `Rămâne din angajamente`, `Plăți`), bucla pe
`_state.items`, rândul gol separator (`aoa.push([])`), **linia de TOTAL** din
`_state.totals`, formatarea `#,##0.00` pe coloanele B-G, `!cols`, numele foii
`'Clasa 8'` și numele fișierului `Clasa8_AAAA-LL-ZZ.xlsx`. Acest lot elimină
duplicarea ÎNCĂRCĂTORULUI, nu rescrie exportul Clasa 8 pe `DFXlsx.save()` —
acela e un RAPORT DE EXECUȚIE (cu linie de total și matrice proprie de formatare)
pe care API-ul partajat nu-l acoperă azi. ⛔ Nu extinde `DFXlsx` ca să încapă.

⚠️ Clasa 8 NU are nevoie de `?all=1`: spre deosebire de DF/ORD/ALOP, `_fetch()`
trimite filtrul la server și primește ÎNTREGUL set (`j.items` + `j.totals`), fără
paginare. Exportul lui era deja complet și deja pe setul filtrat. ⛔ Nu-i adăuga
`all=1` și nu-i atinge `_fetch()`.

Adaugă o gardă: dacă `window.DFXlsx` lipsește, `_exportXLSX` afișează același
`alert` ca ceilalți doi consumatori și iese — Clasa 8 nu are voie să crape
fiindcă un `<script>` partajat n-a ajuns.

`clasa8.js` este încărcat din `formular.html`? Verifică ordinea față de
`/js/shared/xlsx-export.js` și, dacă e mai devreme, MUTĂ tag-ul partajat mai sus.

**Verificare Etapa 3:**
```bash
grep -c "SHEETJS_CDN\|_sheetJsLoading\|_loadSheetJs" public/js/formular/clasa8.js
# Așteptat: 0
grep -rn "cdnjs.cloudflare.com" public/js/
# Așteptat: EXACT o apariție, în public/js/shared/xlsx-export.js
grep -c "XLSX.writeFile\|XLSX.utils" public/js/formular/clasa8.js
# Raportează cifra — apelurile de construcție a foii rămân DELIBERAT în clasa8.js
```

===============================================================================
## ETAPA 4 — Test de cablare, parametrizat
===============================================================================

Fișier NOU: `server/tests/unit/xlsx-export-wiring.test.mjs`.
Model: `server/tests/unit/pagin-wiring.test.mjs` — tablou `CONSUMERS` +
`describe.each`, aserțiuni STRUCTURALE pe sursă (comportamentul modulului e deja
acoperit de cele 8 cazuri unitare de la #133a).

`CONSUMERS = [list.js (DF/ORD), alop.js, clasa8.js]`, fiecare cu `mustContain` /
`mustNotContain`. Aserțiuni obligatorii:

1. Fiecare consumator referă `window.DFXlsx` (`load` sau `save`)
2. NICIUN consumator nu mai conține `cdnjs.cloudflare.com`
3. `list.js` și `alop.js` cheamă endpointul cu `all=1`
4. NICIUN consumator nu citește rândurile din DOM
   (⛔ `querySelectorAll('#lst-tbody`, `querySelectorAll('#alop-tbody`)
5. `alop.js` folosește `data.alop`, NU `data.rows`
6. `alop.js` derivă statusul din `badge_status`, nu recalculează `df_flow_active`
   în funcția de export
7. În `formular.html`, indexul liniei `/js/shared/xlsx-export.js` e mai mic decât
   al fiecărui consumator (`list.js`, `alop.js`, `clasa8.js`)
8. `formular.html` conține exact două butoane noi de export (`#btn-lst-export`,
   `#btn-alop-export`) — `#clasa8-btn-export` exista deja
9. **Non-regresie raportul Clasa 8:** `clasa8.js` conține în continuare antetul de
   7 coloane, `aoa.push([])`, linia `'TOTAL'`, `_state.totals`, `z: '#,##0.00'`,
   `'Clasa 8'` și `'Clasa8_'` — dovada că s-a schimbat DOAR încărcătorul

```bash
npm test
npm run test:db     # non-regresie: acest lot nu atinge serverul, dar rulează-l
```

===============================================================================
## ETAPA 5 — Versionare și commit
===============================================================================

```bash
# 1. package.json 3.9.784 → 3.9.785
sed -i -E "s#(js/formular/alop\.js\?v=)[0-9.]+#\13.9.785#g"   public/formular.html
sed -i -E "s#(js/formular/clasa8\.js\?v=)[0-9.]+#\13.9.785#g" public/formular.html
grep -o 'formular/alop\.js?v=[0-9.]*'    public/formular.html   # Așteptat: 3.9.785
grep -o 'formular/clasa8\.js?v=[0-9.]*'  public/formular.html   # Așteptat: 3.9.785
grep -o 'formular/list\.js?v=[0-9.]*'    public/formular.html   # Așteptat: 3.9.784 — NEATINS
grep -o 'shared/xlsx-export\.js?v=[0-9.]*' public/formular.html # Așteptat: 3.9.784 — NEATINS
grep -n "CACHE_VERSION" public/sw.js | head -1                  # NEATINS
```
⚠️ Grupul de captură la `sed` se scrie `\1`, NU `\g<1>`. Verifică vizual că
tag-urile `<script>` atinse au rămas intacte.

```bash
git status --short   # Așteptat: 4 modificate + 1 nou
# ⛔ NU `git add -A` — cele ~14 fișiere netrackuite din docs/archive/ nu aparțin aici.
git add public/js/formular/alop.js public/js/formular/clasa8.js public/formular.html \
        server/tests/unit/xlsx-export-wiring.test.mjs package.json
git commit -m "feat(#133b): export Excel pe lista ALOP filtrată; Clasa 8 trece pe încărcătorul partajat DFXlsx (v3.9.785)"
git push origin develop
```

===============================================================================
## RAPORT FINAL (obligatoriu)
===============================================================================

1. Ieșirea exactă a fiecărei comenzi de verificare (Etapele 2, 3, 5).
2. `npm test` și `npm run test:db`: fișiere / teste / eșecuri.
3. Rezultatul fiecăreia dintre cele 9 aserțiuni de cablare, numerotat, cu accent
   pe **cazul 9** (raportul Clasa 8 nemodificat).
3-bis. Acceptanță manuală: rulează exportul Clasa 8 ÎNAINTE și DUPĂ patch și
   confirmă că fișierul are aceleași coloane, același rând gol separator, aceeași
   linie de TOTAL și același nume.
4. Confirmarea explicită că `server/routes/alop.mjs` NU a fost atins
   (`git diff --stat` peste `server/`, așteptat gol).
5. Lista EXACTĂ a fișierelor stagiate.
6. Hash-ul commit-ului + confirmarea `git push origin develop`.
7. Orice loc în care codul real a CONTRAZIS acest prompt — raportează, nu repara tăcut.

===============================================================================
## ⛔ CONSTRÂNGERI ABSOLUTE
===============================================================================

- ⛔ Zero fișiere de server atinse. Zero migrații. Zona NO-TOUCH neatinsă.
- ⛔ NU rescrie `_exportXLSX` din Clasa 8 pe `DFXlsx.save()` și NU extinde API-ul
  partajat ca să încapă linia de TOTAL — scopul e ștergerea încărcătorului duplicat.
- ⛔ NU atinge `_fetch()`, filtrele sau `_state.totals` din Clasa 8, și NU-i adăuga
  `?all=1` — modulul nu e paginat, exportul lui era deja complet și filtrat.
- ⛔ NU construi exportul ALOP din DOM sau din pagina memorată.
- ⛔ NU recalcula pe client starea afișată — vine ca `badge_status` de la #132b.
- ⛔ NU adăuga `data-df-module` pe butonul de export.
- ⛔ NU face bulk-sed pe toate `?v=` din HTML.
- ⛔ NU folosi `git add -A`.
- ⛔ `main` nu se atinge sub nicio formă.
