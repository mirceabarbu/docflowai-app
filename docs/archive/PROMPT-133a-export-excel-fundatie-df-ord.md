---
prompt_id: 133a
titlu: Export Excel pe lista FILTRATĂ — fundația (`?all=1`) + modulul partajat DFXlsx + primul consumator (DF/ORD)
branch: develop
model_suggested: Sonnet 5 (efort medium)
versiune_start: v3.9.783
versiune_tinta: v3.9.784
migratii: NU
cache_version_bump: NU (list.js și /js/shared/* nu sunt în PRECACHE_ASSETS)
---

# ⚠️ BRANCH: `develop` — EXCLUSIV

`main` = PRODUCȚIE, gestionat MANUAL de Mircea.
⛔ NU `checkout main`, NU `merge` spre `main`, NU `push origin main`.
✅ Ultimul pas: `git push origin develop`.

===============================================================================
## CONTEXTUL PROBLEMEI
===============================================================================

Cerința: **export în Excel al listelor DF / ORD / ALOP, pe setul FILTRAT**.

Există deja două tipare în proiect, iar diferența dintre ele decide arhitectura:

- **Facturi** (`facturi.js:162`) exportă CSV **din memorie** — poate face asta
  fiindcă încarcă TOATE facturile client-side (`_allFacturi`) și filtrează local.
- **Clasa 8** (`clasa8.js:165-244`) exportă **XLSX real**, cu SheetJS încărcat
  leneș de pe cdnjs, numere formatate `#,##0.00` și lățimi de coloană.

**DF / ORD / ALOP nu seamănă cu niciuna: sunt paginate pe SERVER** (`limit=20`).
Clientul are în mână doar pagina curentă ⇒ un export „pe modelul Facturi" ar
produce un fișier cu 20 de rânduri, tăcut și greșit.

⚠️ **Aceasta e capcana centrală a lotului.** Nu construi exportul din
`document.querySelectorAll('#lst-tbody tr')` și nici din ultimul răspuns
memorat — ambele conțin o singură pagină.

**Soluția, aleasă pentru a NU duplica logica de filtrare/autorizare:** endpointurile
EXISTENTE primesc un mod `?all=1` care sare paginarea (cu plafon). Aceleași `conds`,
aceeași autorizare, aceleași filtre derivate construite la #132a/#132b. Zero
interogare nouă, zero al doilea adevăr despre „ce înseamnă lista filtrată".

Formatul de ieșire: **XLSX real**, pe tiparul Clasa 8 (nu CSV) — sumele trebuie să
ajungă în Excel ca NUMERE, nu ca text cu virgulă.

===============================================================================
## FIȘIERE ATINSE (exhaustiv)
===============================================================================

1. `server/routes/formulare/shared.mjs` — modul `all=1` în `GET /api/formulare/list`
2. `server/routes/alop.mjs` — modul `all=1` în `GET /api/alop` + plafonarea `limit`
3. `public/js/shared/xlsx-export.js` — **FIȘIER NOU** (`window.DFXlsx`)
4. `public/js/formular/list.js` — primul consumator (DF + ORD)
5. `public/formular.html` — butonul de export + `<script>` nou + `?v=` țintit
6. `server/tests/db/formulare-list-export-all.test.mjs` — **FIȘIER NOU**
7. `server/tests/db/alop-list-filtre.test.mjs` — cazuri ADĂUGATE (fișier existent)
8. `server/tests/unit/xlsx-export-component.test.mjs` — **FIȘIER NOU**
9. `package.json` — bump versiune

⛔ NU se atinge `public/js/formular/clasa8.js` (migrarea lui pe `DFXlsx` e un lot
separat) și nici `facturi.js`.

===============================================================================
## ETAPA 1 — Backend: modul `all=1` pe `/api/formulare/list`
===============================================================================

Fișier: `server/routes/formulare/shared.mjs`

`old_str`:
```
  const { type = 'df', status, from, to, comp, init, p2, nr, page = '1', limit = '20' } = req.query;
  const lim  = Math.min(parseInt(limit) || 20, 100);
  const pg   = Math.max(parseInt(page)  || 1,  1);
```

`new_str`:
```
  const { type = 'df', status, from, to, comp, init, p2, nr, page = '1', limit = '20', all } = req.query;
  // #133a — modul EXPORT: aceeași interogare, aceleași `conds`, aceeași autorizare;
  // doar paginarea se dezactivează. Deliberat NU e un endpoint separat: filtrele
  // (inclusiv cele derivate din #132a) trebuie să rămână o singură sursă de adevăr —
  // un al doilea query s-ar desincroniza tăcut la prima schimbare de filtru.
  // Plafonul e o poartă de siguranță, nu o limită de produs (volum real azi: ~180 doc/org).
  const isExport = all === '1';
  const lim  = isExport ? EXPORT_MAX_ROWS : Math.min(parseInt(limit) || 20, 100);
  const pg   = isExport ? 1 : Math.max(parseInt(page) || 1, 1);
```

Adaugă constanta la nivel de MODUL, imediat după blocul de `import`-uri:

```js
// #133a — plafon dur pentru modul de export (?all=1). Peste el, răspunsul rămâne
// valid dar TRUNCHIAT: clientul compară `rows.length` cu `total` și avertizează.
const EXPORT_MAX_ROWS = 5000;
```

⛔ NU schimba forma răspunsului. Rămâne `{ ok, rows, total }`, cu `total` din
`COUNT(*) OVER()` — adică numărul REAL de documente care trec filtrul, chiar și
când `rows` a fost trunchiat de plafon. Exact pe această diferență se sprijină
avertismentul din UI.

⚠️ Blocul ORD (`else`) își recalculează propriile `limIdx`/`offIdx` din ACELEAȘI
`lim`/`pg` declarate mai sus — verifică prin citire că nu există o a doua
declarație locală de `lim` în blocul ORD. Dacă există, raportează; nu o rescrie
fără să spui.

===============================================================================
## ETAPA 2 — Backend: modul `all=1` pe `/api/alop` (+ o gaură latentă)
===============================================================================

Fișier: `server/routes/alop.mjs`

`old_str`:
```
    const { status, q, creat, comp, from, to, page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
```

`new_str`:
```
    const { status, q, creat, comp, from, to, page = 1, limit = 20, all } = req.query;
    // #133a — modul EXPORT (vezi shared.mjs). Filtrul derivat SQL_ALOP_BADGE de la #132b
    // se aplică IDENTIC, deci exportul respectă exact ce vede utilizatorul în listă.
    const isExport = all === '1';
    // ⚠️ Gaură latentă reparată aici: `limit` intra NEPLAFONAT în `LIMIT $n`
    // (spre deosebire de /api/formulare/list, care avea deja Math.min(…, 100)).
    // Un `?limit=999999` întorcea toată organizația într-un singur răspuns.
    const lim    = isExport ? ALOP_EXPORT_MAX_ROWS : Math.min(Number(limit) || 20, 100);
    const offset = isExport ? 0 : (Math.max(Number(page) || 1, 1) - 1) * lim;
```

Constanta, la nivel de MODUL (lângă fragmentele `SQL_ALOP_*` de la #132b):
```js
// #133a — plafon dur pentru modul de export (?all=1). Vezi EXPORT_MAX_ROWS din shared.mjs.
const ALOP_EXPORT_MAX_ROWS = 5000;
```

Apoi înlocuiește cele două utilizări ale valorilor vechi. `old_str`:
```
    `, [...params, Number(limit), offset]);
```
`new_str`:
```
    `, [...params, lim, offset]);
```

`old_str`:
```
      pages: Math.ceil(cnt[0].count / Number(limit)),
```
`new_str`:
```
      pages: Math.ceil(cnt[0].count / lim),
```

⛔ NU atinge `GET /api/alop/stats`.

**Verificare Etapele 1-2:**
```bash
grep -c "isExport" server/routes/formulare/shared.mjs   # Așteptat: 3
grep -c "isExport" server/routes/alop.mjs               # Așteptat: 3
grep -c "Number(limit)" server/routes/alop.mjs          # Așteptat: 1  (doar în Math.min)
node --check server/routes/formulare/shared.mjs && node --check server/routes/alop.mjs
```

===============================================================================
## ETAPA 3 — `public/js/shared/xlsx-export.js` (modul partajat NOU)
===============================================================================

Script CLASIC (⛔ fără `export`/`import` — toate fișierele din `public/js/` se
încarcă prin `<script src>`, nu ca module), care expune `window.DFXlsx`.

Tiparul de urmat: `public/js/shared/pagin.js` (IIFE, `window.DFPagin`).
Încărcarea SheetJS se copiază ca formă din `clasa8.js:165-181` — aceeași
constantă CDN, aceeași promisiune memoizată, aceeași tratare a erorii.
`https://cdnjs.cloudflare.com` e deja în allowlist-ul CSP (`server/index.mjs:561`).

API-ul, exact acesta:

```js
window.DFXlsx = {
  // Promisiune memoizată; respinge cu mesaj clar dacă CDN-ul e inaccesibil.
  load: function(){ … },
  // aoa: array of arrays; prima linie = antet.
  // opts: { sheet, filename, cols:[{wch}], numericCols:[idx,…] }
  // Coloanele din numericCols primesc t:'n' + z:'#,##0.00' (numere REALE în Excel).
  save: async function(aoa, opts){ … }
};
```

Reguli de implementare:

- `save()` aruncă dacă `window.XLSX` lipsește după `load()` — nu eșua tăcut.
- Celulele din `numericCols` se convertesc cu `Number(v)`; dacă rezultatul nu e
  finit, celula rămâne TEXT (⛔ nu scrie `NaN` și nu forța `0` — un zero inventat
  într-o coloană de bani e mai rău decât o celulă goală).
- Prima linie (antetul) NU se tratează niciodată ca numerică.
- `filename` primește sufixul `_AAAA-LL-ZZ` dacă nu îl are deja.
- Zero `innerHTML`, zero `onclick` inline.

Test NOU: `server/tests/unit/xlsx-export-component.test.mjs`, cu
`// @vitest-environment happy-dom`, pe tiparul `pagin-component.test.mjs`.

⚠️ Capcană happy-dom deja plătită o dată în acest proiect (PAGIN-1): `new URL('.',
import.meta.url)` ARUNCĂ sub happy-dom. Folosește
`dirname(fileURLToPath(import.meta.url))`, iar scriptul clasic se încarcă prin
`new Function(src).call(globalThis)`.

Cazuri (minimum 8), cu `window.XLSX` **mock-uit** (⛔ testele nu ating rețeaua):
1. `DFXlsx` expune exact `load` și `save`
2. `save` cheamă `XLSX.utils.aoa_to_sheet` cu matricea primită
3. coloanele din `numericCols` primesc `t:'n'` și `z:'#,##0.00'`
4. o valoare nenumerică într-o coloană numerică rămâne text, fără `NaN`
5. antetul (linia 0) rămâne text chiar dacă indexul e în `numericCols`
6. `cols` ajunge în `ws['!cols']`
7. `filename` primește sufixul de dată o singură dată
8. `save` respinge cu mesaj dacă `window.XLSX` lipsește după `load()`

⛔ **ZERO consumatori în Etapa 3.** Fișierul NU se încarcă din niciun HTML până la
Etapa 4 — aceeași disciplină ca `pagin.js` (PAGIN-1), `concurrency-gate.mjs` (#107)
și `ord-blocuri.mjs` (#128b), ca fundația să poată sta inofensiv în producție.

===============================================================================
## ETAPA 4 — Primul consumator: lista DF / ORD
===============================================================================

### 4.1 — `public/formular.html`

Butonul, în `.lst-tabs-hdr`, imediat DUPĂ `#btn-lst-nou`:
```html
<button id="btn-lst-export" type="button" class="df-action-btn" onclick="exportLista()" title="Exportă în Excel lista filtrată">
  <svg class="df-ico"><use href="/icons.svg?v=3.9.693#ico-download"/></svg> Export Excel
</button>
```

Scriptul, lângă celelalte din `/js/shared/` și **ÎNAINTEA** lui `list.js`
(`defer` execută în ordinea documentului — vezi PAGIN-2):
```html
<script src="/js/shared/xlsx-export.js?v=3.9.784" defer></script>
```

### 4.2 — `public/js/formular/list.js`

Adaugă `exportLista()` și expune-o pe `window` lângă celelalte
(`window.resetFilters = …`, ~linia 873).

Comportament:

1. Reia **exact** query string-ul construit de `loadList()` — ⛔ nu-l rescrie de
   la zero, ai desincroniza filtrele. Extrage construcția lui în helperul
   `_lstQuery({ all })` folosit de AMBELE funcții, apoi cheamă
   `/api/formulare/list?…&all=1` (fără `page`/`limit`).
2. Pe durata cererii: butonul `disabled` + text „⏳ Se pregătește…", restaurat în
   `finally` (tiparul `clasa8.js:184-186,240-243`).
3. Dacă `j.rows.length < j.total` → `alert` explicit:
   `S-au exportat primele N din M documente (plafon de siguranță). Restrângeți filtrele pentru un export complet.`
4. Dacă `j.rows.length === 0` → mesaj „Nu există documente pentru filtrele curente" și
   ⛔ **niciun fișier gol descărcat**.
5. Construiește `aoa` în funcție de `_lstState.type` — coloanele DIFERĂ:

**DF** — `Nr.`, `Titlu`, `Revizie`, `Inițiator`, `Compartiment`, `Responsabil CAB`,
`Status`, `Creat la`, `Actualizat la`, `Actualizat de`
(`revizie` = `'R' + (row.revizie_nr||0)`; fără coloane de bani)

**ORD** — `Nr.`, `Furnizor`, `Inițiator`, `Compartiment`, `Responsabil CAB`,
`Valoare ORD`, `Plată`, `Status`, `Creat la`, `Actualizat la`, `Actualizat de`
(`Valoare ORD` = `ord_valoare`, `Plată` = `plata_suma` — ambele NUMERICE,
indicii lor intră în `numericCols`)

Reguli pentru celule:
- `Responsabil CAB` = `row.p2_compartiment || row.p2 || ''` — aceeași precedență
  ca în `_renderLstTable` (#131a: atribuirea pe compartiment lasă `p2` NULL).
- `Status` = **eticheta în clar**, derivată din `row.badge_status` prin harta
  existentă din `_stBadge`. ⛔ Nu scrie cheia tehnică (`transmis_flux`) în fișier
  și ⛔ nu duplica harta: extrage-o din `_stBadge` într-un `const _ST_LABELS` la
  nivel de fișier, pe care `_stBadge` îl folosește apoi (emoji-urile rămân DOAR
  în badge; exportul ia textul curat, fără emoji).
- Datele: `dd.mm.aaaa, hh:mm` prin `toLocaleString('ro-RO')` — TEXT, nu Date.
- `filename`: `DF_` sau `ORD_` + data.
- `sheet`: `'Documente de Fundamentare'` / `'Ordonanțări de Plată'`.

6. Ramură fail-safe, ca la PAGIN-2: dacă `window.DFXlsx` lipsește →
   `alert('Modulul de export nu s-a încărcat. Reîncărcați pagina.')` +
   `console.error`, ⛔ fără excepție necapturată.

**Verificare Etapa 4:**
```bash
grep -c "exportLista" public/js/formular/list.js      # Așteptat: 2 (definiție + export pe window)
grep -c "_lstQuery" public/js/formular/list.js        # Așteptat: 3 (definiție + loadList + exportLista)
grep -c "_ST_LABELS" public/js/formular/list.js       # Așteptat: 3 (definiție + _stBadge + exportLista)
grep -n "xlsx-export.js" public/formular.html
# Confirmă că indexul liniei e MAI MIC decât al liniei cu formular/list.js
grep -rn "querySelectorAll('#lst-tbody" public/js/formular/list.js   # Așteptat: 0 rezultate
```

===============================================================================
## ETAPA 5 — Teste DB reale
===============================================================================

Fișier NOU: `server/tests/db/formulare-list-export-all.test.mjs`.
Model: `server/tests/db/formulare-list-status-filtre.test.mjs` (#132a).

⚠️ Mock-urile pe `pool.query` confirmă FORMA, nu comportamentul. Rulează pe PG real.

Cazuri obligatorii:
1. **DF, `?all=1` fără filtre** → `rows.length === total` și `total > 20`
   (seedează ≥ 25 DF-uri, ca să dovedești că plafonul de 20 chiar a dispărut)
2. **DF, `?all=1&status=returnat`** → întoarce EXACT documentele `returnat`
   (dovada că exportul respectă filtrul)
3. **DF, `?all=1&status=neaprobat`** → coerent cu #132a, inclusiv cazul derivat
   din flux refuzat
4. **ORD, `?all=1&nr=<fragment furnizor>`** → respectă căutarea pe beneficiar (#121)
5. **`?all=1` NU sare peste autorizare**: un utilizator non-manager, non-CAB,
   dintr-un alt compartiment, primește DOAR documentele proprii — ⛔ acesta e
   cazul care contează cel mai mult; `all=1` nu are voie să devină un canal de
   evadare din `conds`
6. **Alt `org_id`** nu apare niciodată în `?all=1`
7. **Fără `all=1`** comportamentul rămâne neschimbat: `rows.length === 20`,
   `total` = numărul real (non-regresie a paginării)
8. **Fără `all=1`** comportamentul rămâne neschimbat: `rows.length === 20`,
   `total` = numărul real (non-regresie a paginării)

În fișierul EXISTENT `server/tests/db/alop-list-filtre.test.mjs` (⛔ nu șterge și
nu slăbi niciunul dintre cazurile existente — cele 7 de la #121 plus cele 9 de la
#132b), adaugă:

9. **ALOP `?all=1`** întoarce toate dosarele filtrate, iar cu
   `?all=1&status=angajare_flux` respectă filtrul derivat de la #132b
10. **ALOP `?limit=999999`** (fără `all`) întoarce cel mult 100 de rânduri —
    gaura plafonată la Etapa 2

```bash
npm test
npm run test:db
```
Ambele verzi, fără regresii. Absența Docker NU e motiv de skip — rețeta cu
instanță PG 17 efemeră e în `CLAUDE.md`.

===============================================================================
## ETAPA 6 — Versionare și commit
===============================================================================

```bash
# 1. package.json 3.9.783 → 3.9.784
# 2. ?v= ȚINTIT — doar list.js (xlsx-export.js e nou, se scrie direct la 3.9.784)
sed -i -E "s#(js/formular/list\.js\?v=)[0-9.]+#\13.9.784#g" public/formular.html
grep -o 'formular/list\.js?v=[0-9.]*'   public/formular.html   # Așteptat: 3.9.784
grep -o 'formular/alop\.js?v=[0-9.]*'   public/formular.html   # Așteptat: 3.9.783 — NEATINS
grep -o 'shared/pagin\.js?v=[0-9.]*'    public/formular.html   # Așteptat: 3.9.722 — NEATINS
grep -n 'js/formular/list\.js' public/formular.html            # tag <script> INTACT
grep -n "CACHE_VERSION" public/sw.js | head -1                 # NEATINS
```
⚠️ La `sed` pe HTML grupul de captură se scrie `\1`, NU `\g<1>`. Un `?v=` corupt
nu pică niciun test și ar ajunge în producție cu pagina moartă.

```bash
git status --short
# Așteptat: 6 modificate + 2 noi. ⛔ NU folosi `git add -A` — repo-ul are
# ~14 fișiere netrackuite în docs/archive/ care NU aparțin acestui commit.
# Stagiază EXPLICIT doar cele 8 fișiere ale lotului.
git add server/routes/formulare/shared.mjs server/routes/alop.mjs \
        public/js/shared/xlsx-export.js public/js/formular/list.js public/formular.html \
        server/tests/db/formulare-list-export-all.test.mjs \
        server/tests/db/alop-list-filtre.test.mjs \
        server/tests/unit/xlsx-export-component.test.mjs package.json
git commit -m "feat(#133a): export Excel pe lista filtrată — mod ?all=1 pe endpointuri, modul partajat DFXlsx, consumator DF/ORD (v3.9.784)"
git push origin develop
```

===============================================================================
## RAPORT FINAL (obligatoriu)
===============================================================================

1. Ieșirea exactă a fiecărei comenzi de verificare (Etapele 1-4, 6).
2. `npm test` și `npm run test:db`: fișiere / teste / eșecuri; pentru `test:db`,
   confirmarea „PASSED REAL pe PG 17".
3. Rezultatul fiecăruia dintre cele 10 cazuri DB + cele 8 cazuri unitare, numerotat,
   cu accent pe **cazul 5** (autorizarea sub `all=1`).
4. `EXPLAIN ANALYZE` pentru `GET /api/formulare/list?type=df&all=1` pe setul de
   test — raportează timpul total și orice Seq Scan costisitor.
5. Lista EXACTĂ a fișierelor stagiate (dovada că `docs/archive/` a rămas în afară).
6. Hash-ul commit-ului + confirmarea `git push origin develop`.
7. Orice loc în care codul real a CONTRAZIS acest prompt — raportează, nu repara tăcut.

===============================================================================
## ⛔ CONSTRÂNGERI ABSOLUTE
===============================================================================

- ⛔ Zona NO-TOUCH neatinsă: `STSCloudProvider.mjs`, `routes/flows/cloud-signing.mjs`,
  `routes/flows/bulk-signing.mjs`, `signing/pades.mjs`, `signing/java-pades-client.mjs`.
- ⛔ Zero migrații, zero `ALTER TABLE`, zero `UPDATE`.
- ⛔ NU crea un endpoint separat de export și NU duplica construcția `conds` —
  `all=1` trăiește în handlerul existent tocmai ca filtrele să rămână o singură sursă.
- ⛔ NU construi exportul din DOM sau din ultimul răspuns memorat — ar exporta o
  singură pagină.
- ⛔ NU scoate plafonul și NU-l face configurabil din query.
- ⛔ NU atinge `clasa8.js`, `facturi.js`, `alop.js` (ALOP e consumatorul din #133b).
- ⛔ NU bundla vreo bibliotecă XLSX în `package.json` — SheetJS se încarcă leneș
  de pe cdnjs, exact ca în Clasa 8.
- ⛔ NU folosi `git add -A`.
- ⛔ `main` nu se atinge sub nicio formă.
