---
prompt: 218
titlu: "Listele DF/ORD — schimbarea unui filtru readuce lista la pagina 1 (filtrul părea „stricat")"
model_suggested: "Sonnet 5"
efort: medium
branch: develop
versiune_curenta: "cea din package.json (v3.9.870 în producție)"
versiune_tinta: "următorul patch după versiunea curentă din package.json"
migratii: NU
scrieri_in_baza: NU
fisiere_din_public: DA — `formular.html` + `js/formular/list.js` ⇒ `?v=` ȚINTIT pe list.js, `CACHE_VERSION` doar dacă vreunul e în PRECACHE
zona_no_touch_atinsa: NU
tip: bugfix frontend + teste happy-dom
---

# ⚠️ BRANCH

**EXCLUSIV `develop`**. Fără `checkout main`, `merge`, `push main`, deploy.
Final: **`git push origin develop`**, apoi **stop** și raportezi.

---

# CONTEXTUL

Mircea (17.09.2026): în lista „Document de Fundamentare", filtrul Status = „La Responsabil CAB" a
arătat **„0 documente — Nu există documente care să corespundă filtrelor"**, deși în producție există
18 DF-uri `pending_p2` (numărate cu SQL-ul exact al filtrului). Puțin mai târziu, același filtru a
funcționat. Serverul e corect: am reprodus pe Postgres real, iar condiția SQL întoarce rândurile.

## Cauza, verificată pe cod

**Schimbarea unui filtru nu readuce lista la pagina 1.**

- `formular.html`: `flt-status` și `flt-comp` au `onchange="loadList()"`; `flt-from` / `flt-to` au
  `onDatePickerChange(...);loadList();`. `flt-nr`, `flt-init`, `flt-p2` au `debouncedLoadList()`,
  care cheamă tot `loadList()`.
- `list.js`: `_lstState.page` se resetează doar la schimbarea tab-ului (`:672`) și la „Resetează
  filtrele" (`:1038`). Paginarea îl setează la pagina aleasă (`:993`).

Scenariul: utilizatorul e pe pagina 3 din „Toate" (227 documente), alege „La Responsabil CAB" (18
documente, o singură pagină). Cererea pleacă cu `page=3` ⇒ `OFFSET 40` ⇒ zero rânduri. Totalul vine
din `COUNT(*) OVER()`, care nu produce nimic pe zero rânduri ⇒ interfața afișează **„0 documente"**,
ca și cum filtrul n-ar găsi nimic.

⭐ Lista ALOP are deja rezolvarea corectă (`alop.js:211-222`): `debouncedLoadAlop` și
`_alopFilterChanged` pun `_alopState.page=1` înainte de încărcare. Lista DF/ORD n-a primit-o. Lotul
oglindește tiparul existent.

---

# ETAPA 0 — ancore (READ-ONLY)

```bash
git branch --show-current
grep '"version"' package.json
grep -n 'onchange="loadList()"\|loadList();"' public/formular.html
grep -n 'debouncedLoadList' public/formular.html
grep -n "_lstState.page\s*=" public/js/formular/list.js
grep -n "function debouncedLoadList" -A4 public/js/formular/list.js
grep -n "_alopFilterChanged\|debouncedLoadAlop" -A3 public/js/formular/alop.js | head -12
grep -rn "loadList(" public/js --include=*.js | grep -v "public/js/formular/list.js"
grep -n "formular.html\|js/formular/list.js" public/sw.js
grep -n "js/formular/list.js?v=" public/formular.html
```

⭐ Raportează orice alt apelant al `loadList()` din afara `list.js`: acelea (întoarcerea din document,
după salvare) **trebuie să păstreze pagina** — nu le atinge.

---

# ⭐ ETAPA T — testele ÎNTÂI, pe codul NEREPARAT

`server/tests/unit/lista-filtre-pagina.test.mjs` (nou), `// @vitest-environment happy-dom`, cu
convenția din `ord-list-valoare-plata-frontend.test.mjs` (`new Function(listSrc).call(globalThis)`).

Pregătire: elementele DOM folosite de `loadList` (`lst-tbody`, `lst-empty`, `lst-loading`,
`lst-pagination`, `flt-status`, `flt-comp`, `flt-from`, `flt-to`, `flt-nr`, `flt-init`, `flt-p2`),
un `window.DFApi.fetch` mock care **reține URL-urile** și întoarce răspunsuri configurabile, un
`window.DFPagin.render` mock care **reține `onChange`**. Dacă `_setLstCount` sau alte funcții cer
elemente suplimentare, adaugă-le și raportează.

1. ⭐⭐ Pe pagina 1 cu 40 de rezultate, apelezi `onChange(2)` reținut din `DFPagin` ⇒ cererea are
   `page=2`. Apoi schimbi `flt-status` și apelezi handler-ul de filtru ⇒ **următoarea cerere are
   `page=1`**.
2. ⭐ Același lucru pentru căutarea cu debounce (`debouncedLoadList`, cu timere false vitest) ⇒ `page=1`.
3. ⭐ Autovindecare: pe pagina 2, serverul întoarce `rows: []` ⇒ `loadList` face **o singură** cerere
   suplimentară cu `page=1`; dacă și aceea e goală ⇒ se oprește (fără buclă), afișează golul.
4. Neregresie: `onChange(3)` din paginare ⇒ `page=3` (paginarea NU e resetată de modificare).
5. Static: în `formular.html`, handler-ele `flt-status`, `flt-comp`, `flt-from`, `flt-to` nu mai conțin
   `loadList()` direct, ci `_lstFilterChanged()`.

Rulează pe codul nereparat și **raportează roșiile ÎNAINTE de patch**. Așteptat roșii: 1, 2, 3, 5.
Verde: 4.

---

# ETAPA A — `list.js`

**A.1 — funcția de filtru**, imediat înainte de `function debouncedLoadList(){`:

```js
// #218 — orice schimbare de FILTRU readuce lista la pagina 1 (tiparul din alop.js,
// `_alopFilterChanged`). Fără asta, de pe pagina 3 din „Toate", un filtru cu o singură pagină
// de rezultate cerea OFFSET 40 ⇒ zero rânduri ⇒ „0 documente", ca și cum filtrul n-ar găsi nimic.
// ⛔ NU se folosește la întoarcerea din document / după salvare: acolo pagina se păstrează.
function _lstFilterChanged(){ _lstState.page=1; loadList(); }
```

**A.2 — debounce.** `old_str`:
```js
  _lstDebTimer=setTimeout(()=>loadList(),400);
```
`new_str`:
```js
  _lstDebTimer=setTimeout(()=>_lstFilterChanged(),400);   // #218 — căutare = filtru ⇒ pagina 1
```

**A.3 — autovindecare**, pentru orice altă cale care ajunge pe o pagină dincolo de ultima (ex. un
document șters care micșorează lista). `old_str`:
```js
    if(!rows.length){if(em)em.style.display='';}
```
`new_str`:
```js
    // #218 — pagină dincolo de ultima (listă micșorată între timp): o singură reîncercare pe
    // pagina 1. Garda `page>1` oprește orice buclă: a doua cerere are deja page=1.
    if(!rows.length&&_lstState.page>1){_lstState.page=1;return loadList();}
    if(!rows.length){if(em)em.style.display='';}
```

**A.4 — expunerea**, pentru handler-ele din HTML. `old_str`:
```js
  window.debouncedLoadList      = debouncedLoadList;
```
`new_str`:
```js
  window.debouncedLoadList      = debouncedLoadList;
  window._lstFilterChanged      = _lstFilterChanged;
```

⚠️ Confirmă că `_lstState` și `loadList` sunt în scope-ul lui `_lstFilterChanged` (același fișier,
același nivel) și că blocul de expunere de la `:1121+` rulează. Raportează.

---

# ETAPA B — `formular.html`

Patru înlocuiri, fiecare `old_str` unic:

| `old_str` | `new_str` |
|---|---|
| `<select id="flt-comp" class="flt-sel" onchange="loadList()">` | `<select id="flt-comp" class="flt-sel" onchange="_lstFilterChanged()">` |
| `<select id="flt-status" class="flt-sel" onchange="loadList()">` | `<select id="flt-status" class="flt-sel" onchange="_lstFilterChanged()">` |
| `onchange="onDatePickerChange(this,'flt-from-display');loadList();"` | `onchange="onDatePickerChange(this,'flt-from-display');_lstFilterChanged();"` |
| `onchange="onDatePickerChange(this,'flt-to-display');loadList();"` | `onchange="onDatePickerChange(this,'flt-to-display');_lstFilterChanged();"` |

⚠️ Tastarea datei în câmpul text (`onDateTextInput`, `draft.js`) declanșează `change` pe inputul
ascuns ⇒ trece prin aceleași două handler-e de dată. Confirmă și raportează.

⭐ Garda statică de la #212 (`onclick-handlers-expuse` sau echivalentul) verifică handler-ele inline
contra `window`. Dacă acoperă și `onchange`, `_lstFilterChanged` trebuie să fie expusă (A.4). Rulează-o
explicit și raportează.

---

# ETAPA C — suitele

```bash
npx vitest run server/tests/unit/lista-filtre-pagina.test.mjs
npm test
```

`test:db` nu e necesar (zero modificări pe server); dacă îl rulezi, **complet**.
⛔ Test preexistent care pică ⇒ raportează ÎNAINTE de a-l atinge. Neregresie citată:
`pagin-wiring`, `xlsx-export-wiring`, `ord-list-valoare-plata-frontend`, `p2-compartiment-frontend`,
garda statică de handler-e.

---

# ETAPA D — versiune, cache, commit

```bash
npm version <TINTA> --no-git-tag-version
npm install --package-lock-only
NEW=<TINTA>
sed -i -E "s#(js/formular/list\.js\?v=)[0-9.]+#\1${NEW}#g" public/formular.html
grep -n "js/formular/list.js?v=" public/formular.html   # linia <script> întreagă
```
`CACHE_VERSION` doar dacă `formular.html` sau `js/formular/list.js` sunt în `PRECACHE_ASSETS` — dovada
prin grep. ⚠️ Dacă `formular.html` e în PRECACHE, handler-ele noi nu ajung la utilizatori fără bump.

`git add` explicit. Arhivează ca `docs/archive/PROMPT-218-filtre-pagina.md`.

```
fix(#218): listele DF/ORD — schimbarea unui filtru readuce lista la pagina 1 — v<TINTA>

De pe pagina 3 din „Toate", alegerea unui status cu o singura pagina de
rezultate cerea OFFSET 40 si intorcea zero randuri; totalul (COUNT OVER) lipsea,
deci lista arata „0 documente" ca si cum filtrul n-ar gasi nimic (raportat pe
„La Responsabil CAB", 18 documente in productie).

Oglindeste tiparul existent din lista ALOP (_alopFilterChanged): toate
filtrele trec prin _lstFilterChanged, care pune pagina 1. In plus, o pagina
dincolo de ultima declanseaza o singura reincercare pe pagina 1. Paginarea si
intoarcerea din document pastreaza pagina.
```

```bash
git push origin develop
```

**Stop.**

---

# RAPORT FINAL
1. Ancore obținute, inclusiv apelanții `loadList()` din afara `list.js` și prezența în PRECACHE.
2. ⭐ Roșiile pe codul nereparat.
3. Rezultatul testelor noi; garda statică de handler-e.
4. Teste preexistente atinse (așteptat: niciunul).
5. `npm test` real.
6. `?v=` / `CACHE_VERSION` cu dovadă.
7. Divergențe și colaterale — raportate, nereparate.

# ⛔ CONSTRÂNGERI ABSOLUTE
- `develop` ONLY, apoi stop. Zero modificări pe server, zero migrații.
- Paginarea și întoarcerea din document păstrează pagina.
- Nicio buclă: autovindecarea face cel mult o reîncercare.
- ⛔ Lista ALOP, Clasa 8, Facturi — neatinse.
- `?v=` țintit, `git add` explicit, `old_str` unic sau STOP.
