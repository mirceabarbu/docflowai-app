---
prompt: 203
titlu: "Selector de an în Clasa 8 — ?an= firmat din rute, an explicit la import, /admin/alop/stats pe an"
model_suggested: "Opus 5"
efort: high
branch: develop
versiune_curenta: v3.9.855
versiune_tinta: v3.9.856
migratii: NU
scrieri_in_baza: NU (doar citiri; importul scria deja, se adaugă doar anul explicit din UI)
fisiere_din_public: DA ⇒ `?v=` ȚINTIT pe fișierele atinse + eventual `CACHE_VERSION`
zona_no_touch_atinsa: NU
tip: rute + servicii + frontend
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Nu propune și nu executa `checkout main`, `merge main`, `push main`, `merge --no-ff`.
Pasul final obligatoriu: **`git push origin develop`**. Te oprești acolo și raportezi.

Nu faci deploy. Nu atingi producția. Nu rulezi SQL pe producție.

---

# CONTEXTUL

#202 (v3.9.855, în producție) a dat bugetului Clasa 8 dimensiunea `an`: coloana există pe
`clasa8_buget` și `clasa8_buget_versions`, cheia e `UNIQUE (org_id, an, cod_ssi)`, iar importul,
`DELETE /buget`, `meta` și `coduri` sunt scopate pe an. Verificat pe producție după deploy:
`2026 | 293` rânduri, o singură constrângere de unicitate, cea nouă.

Ce a rămas: **anul e peste tot implicit (anul curent) și nimeni nu-l poate alege.** Serviciile
`getClasa8Aggregate` / `getBugetDisponibil` acceptă deja un an, dar rutele nu îl trimit, iar
interfața nu are cu ce.

Consecința practică: în ianuarie 2027, după ce se încarcă bugetul pe 2027, centralizatorul sare
pe 2027 și **nu există nicio cale de a te uita la 2026** — deși datele sunt acum acolo. Lotul
ăsta e a doua jumătate a obiectivului „datele pe 2026 rămân vizibile în 2027".

---

# ⛔ CE NU FACE LOTUL ĂSTA — citește înainte de a începe

Există în cod cinci expresii care derivă anul din ceasul serverului. **Doar UNA intră aici.**

| Locație | Ce e | În #203? |
|---|---|---|
| `routes/admin/flows.mjs:93` | filtru de raport read-only (`/admin/alop/stats`) | ✅ **DA** |
| `routes/alop.mjs:~1988` | plafon ordonanțare/plată | ❌ **NU** |
| `routes/alop.mjs:~175` | sumă ordonanțată pe an, intră în plafon | ❌ **NU** |
| `services/formular-shared.mjs:344` | `computeOrdBudgetContext`, context de plafon ORD | ❌ **NU** |
| `routes/alop.mjs:~126` | `sqlBandaRowsPlati`, banda de afișare | ❌ **NU** |

**Motivul, și e categoric:** ultimele patru alimentează **porți de scriere**. Dacă anul devine
parametru de cerere, un client care trimite `an=2025` primește plafonul pe 2025 calculat peste
documente din 2026 — adică **plafonul bugetar devine negociabil din browser**. Nu dă eroare, nu
se loghează, dă doar cifre greșite.

Regula: **anul pe care utilizatorul vrea să-l VADĂ** vine din cerere. **Anul în care sistemul
OPEREAZĂ** vine de la server, niciodată din cerere.

Cele patru se consolidează într-o funcție unică `anExercitiuCurent()` în **#204**, lot separat,
server-only. **Nu le atinge aici. Nici măcar „ca să fie."**

---

# ETAPA 0 — ancore, ÎNAINTE de orice modificare

Rulează și raportează **valorile obținute**, nu cele așteptate.

```bash
grep -n "_parseAn" server/routes/clasa8.mjs
# Așteptat: definiția + apelurile din import / DELETE / meta / coduri

grep -n "filters.an\|an = Number.isInteger" server/services/clasa8.mjs
# Așteptat: getClasa8Aggregate citește filters.an

grep -n "excludeDfId = null, an" server/services/clasa8.mjs
# Așteptat: semnătura getBugetDisponibil cu al 4-lea parametru

grep -n "getClasa8Aggregate(pool, orgId, filters)\|getBugetDisponibil(pool, orgId" server/routes/clasa8.mjs
# Așteptat: apelurile din rute, care ACUM nu trimit anul

grep -n "clasa8.js?v=" public/formular.html
# Așteptat: 1 linie (v3.9.839)

grep -n "CACHE_VERSION\|PRECACHE_ASSETS" public/sw.js | head
grep -n "clasa8.js" public/sw.js
# Dacă clasa8.js NU e în PRECACHE_ASSETS ⇒ CACHE_VERSION rămâne NEATINS. Raportează care e cazul.
```

⛔ Dacă `_parseAn` sau parametrii din servicii arată altfel decât mai sus, **oprește-te și
raportează** — înseamnă că lucrezi pe alt cod decât cel livrat la #202.

---

# ETAPA A — `_parseAn` strâns

Raportul #202 a semnalat corect: `Number([2026]) === 2026`, deci un array cu un element trece
ca an valid. Benign azi (valoarea e aceeași), dar e o formă laxă exact din categoria pe care o
eliminăm. Se repară acum, fiindcă oricum atingem fișierul.

`old_str`:
```js
  if (raw === undefined || raw === null || raw === '') return new Date().getFullYear();
  const n = Number(raw);
```
`new_str`:
```js
  if (raw === undefined || raw === null || raw === '') return new Date().getFullYear();
  // #203 — doar scalari. Number([2026]) === 2026, deci fără garda asta un array
  // cu un element trecea ca an valid; `?an=` duplicat dădea deja NaN ⇒ 400.
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  const n = Number(raw);
```

---

# ETAPA B — anii disponibili (rută nouă)

Selectorul se populează din **ce există efectiv în bază**, nu dintr-o listă generată. Un an fără
buget încărcat nu are ce căuta în dropdown.

În `server/routes/clasa8.mjs`, lângă `GET /buget/meta`:

```js
// GET /api/clasa8/buget/ani — anii cu buget încărcat, pentru selectorul din UI (#203).
router.get('/buget/ani', requireAuth, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'db_unavailable' });
    const { orgId } = req.actor;
    if (!orgId) return res.status(400).json({ error: 'orgId_missing_in_token' });

    const { rows } = await pool.query(
      `SELECT DISTINCT an FROM clasa8_buget WHERE org_id = $1 ORDER BY an DESC`,
      [orgId]
    );
    return res.json({ ani: rows.map(r => r.an), an_curent: new Date().getFullYear() });
  } catch (e) {
    logger.error({ err: e, requestId: req.requestId }, 'clasa8 buget ani error');
    return res.status(500).json({ error: 'server_error' });
  }
});
```

⚠️ Anul curent poate lipsi din `ani` (niciun buget încărcat pe el) și **trebuie totuși să fie
selectabil** — centralizatorul are sens și fără buget, arată angajamente/ordonanțări/plăți cu
coloana BUGET goală. De asta răspunsul întoarce și `an_curent` separat; frontendul face unirea.

---

# ETAPA C — `?an=` firmat în rutele de raport

## C.1 — `GET /api/clasa8`

`old_str`:
```js
    const filters = {
      ssi:          typeof req.query.ssi === 'string' ? req.query.ssi : '',
      compartiment: typeof req.query.compartiment === 'string' ? req.query.compartiment : '',
      q:            typeof req.query.q === 'string' ? req.query.q : '',
    };
```
`new_str`:
```js
    const an = _parseAn(req.query?.an);
    if (an === null) return res.status(400).json({ error: 'an_invalid' });

    const filters = {
      ssi:          typeof req.query.ssi === 'string' ? req.query.ssi : '',
      compartiment: typeof req.query.compartiment === 'string' ? req.query.compartiment : '',
      q:            typeof req.query.q === 'string' ? req.query.q : '',
      an,
    };
```

Răspunsul include `an` la nivelul de sus, ca UI-ul să poată confirma ce i s-a servit.

## C.2 — `GET /api/clasa8/buget/disponibil`

`_parseAn(req.query?.an)` → 400 la invalid → `getBugetDisponibil(pool, orgId, excludeDf || null, an)`.
Răspunsul include `an`.

## C.3 — `GET /admin/alop/stats` (`server/routes/admin/flows.mjs`)

Singura dintre cele cinci expresii de ceas care intră în lot. Azi:

```js
    const curYear  = 'EXTRACT(YEAR FROM NOW())::int';
    const anCurent = `COALESCE(df.an_referinta, ${curYear}) = ${curYear}`;
```

Devine: anul vine din `?an=`, implicit anul curent, **ca parametru legat, NU interpolat în
string-ul SQL**. `params` e `[orgFilter]` sau `[]`, deci indicele diferă după cum există sau nu
filtru de org — folosește `params.push(an)` și ia indicele din valoarea de retur, exact ca la
#202 în `getClasa8Aggregate`:

```js
    const anIdx    = params.push(an); // push() întoarce noua lungime = indicele $N
    const anCurent = `COALESCE(df.an_referinta, $${anIdx}) = $${anIdx}`;
```

⛔ **NU interpola `an` direct în SQL**, chiar dacă e validat ca întreg. Fișierul construiește
SQL prin concatenare de string-uri; e singurul loc din lot unde asta se întâmplă și e exact
locul unde disciplina contează.

Validarea: `admin/flows.mjs` nu are `_parseAn`. **Nu-l copia** — exportă-l din
`server/routes/clasa8.mjs` și importă-l. O a doua copie a unei funcții de validare e fix
tiparul pe care îl demontăm în tot proiectul.

⚠️ `requireAuth` în `admin/flows.mjs` e apelat ca funcție (`const actor = requireAuth(req, res)`),
nu ca middleware — alt tipar decât în `clasa8.mjs`. **Respectă tiparul local al fișierului**, nu-l
uniformiza.

---

# ETAPA D — frontend (`public/js/formular/clasa8.js` + `public/formular.html`)

## D.1 — starea

`_state.filters` devine `{ ssi: '', compartiment: '', q: '', an: null }`. `null` = „încă nu știm",
se completează la init din `/buget/ani` (`an_curent`).

## D.2 — selectorul în HTML

În `public/formular.html`, în `.lst-filter-row`, **înaintea** grupului „🔎 Filtrare Cod SSI**":

```html
      <div class="flt-grp" style="flex:0 0 130px;">
        <label class="flt-lbl">📅 An exercițiu</label>
        <select id="clasa8-filter-an" class="flt-inp"></select>
      </div>
```

Populat din `/api/clasa8/buget/ani`: reuniunea `ani` ∪ `{an_curent}`, sortată descrescător,
cu `an_curent` preselectat.

## D.3 — `_fetch()`

Adaugă `params.set('an', _state.filters.an)` când `_state.filters.an` e setat. **Fără debounce**
pe schimbarea anului — e un `<select>`, nu un input; se refetchează imediat.

## D.4 — `_onResetFilters()`

⚠️ Resetul golește azi toate filtrele. **Anul NU e un filtru de căutare, e contextul raportului.**
Reset trebuie să lase anul selectat neschimbat:

`old_str`:
```js
    _state.filters = { ssi: '', compartiment: '', q: '' };
```
`new_str`:
```js
    // #203 — anul NU se resetează: e contextul raportului, nu un filtru de căutare.
    _state.filters = { ssi: '', compartiment: '', q: '', an: _state.filters.an };
```

## D.5 — `_refreshBugetMeta()`

Trimite `?an=` din starea curentă. Textul „Buget activ: v6" devine „Buget 2026: v6" — altfel, cu
doi ani în bază, utilizatorul nu are cum să știe la ce se uită.

Când `j.active` e `null` pentru anul selectat, mesajul gol trebuie să spună **care** an:
„Niciun buget importat pentru 2027." Mesajul actual („Niciun buget importat încă") ar minți.

## D.6 — importul (`_doImport`)

Corpul include `an: _state.filters.an`. Modalul de import trebuie să arate clar pentru ce an se
importă, iar confirmarea de după să spună `'Buget 2027 importat ca v3 (293 coduri)'`.

## D.7 — ⭐ ștergerea (`_clearBuget`) — cel mai periculos punct din lot

Azi textul e:

> „Vrei să ștergi bugetul activ? Versiunile anterioare rămân în istoric."

Cu anii în joc, asta e **înșelător**: utilizatorul crede că șterge „bugetul", nu bugetul unui an.
Textul devine explicit:

```js
if (!confirm(`Vrei să ștergi bugetul pe ${an}? Bugetele pe ceilalți ani NU sunt afectate.`)) return;
```

și apelul devine `DFApi.fetch('/api/clasa8/buget?an=' + an, { method: 'DELETE' })`.

## D.8 — export XLSX

Numele fișierului și antetul includ anul. Un export fără an, cu doi ani în bază, e un fișier
care nu se poate interpreta peste șase luni.

## ⛔ D.9 — ce NU se atinge în frontend

**`window.loadBugetCodes()`** (datalistul de coduri SSI din formularul DF) rămâne **exact cum e**,
fără `?an=`. Motivul: formularul DF are propriul an (`an_referinta`), care e un concept diferit
de anul selectat în centralizator. Legarea celor două e o schimbare de comportament pe care n-am
gândit-o și nu intră aici. Ruta îi servește implicit anul curent, adică exact ce primea și
înainte de #202. Scrie asta în commit.

De asemenea neatinse: `cod-ssi-validate.mjs` (decizia Etapa D din #202 — validarea traversează
deliberat anii), orice fișier din zona NO-TOUCH, cele patru expresii de ceas din tabelul de la
început.

---

# ETAPA E — teste

## E.1 — `server/tests/db/clasa8-an-selector.test.mjs` (nou)

Seed pe **doi** ani (`Y` și `Y-1`), cu sume diferite și cel puțin un `cod_ssi` comun.

1. `GET /api/clasa8` fără `?an=` ⇒ totalurile anului curent. **Identic cu v3.9.855.**
2. `GET /api/clasa8?an=Y-1` ⇒ totalurile lui `Y-1`, **diferite** de 1.
3. `?an=abc`, `?an=1999`, `?an=2101`, `?an=2026.5`, `?an=[2026]` ⇒ **400 `an_invalid`** toate.
4. `GET /buget/ani` ⇒ `[Y, Y-1]` descrescător, plus `an_curent`.
5. `GET /buget/ani` pe un org **fără** buget ⇒ `ani: []` dar `an_curent` prezent.
6. `/buget/disponibil?an=Y-1` ⇒ plafonul lui `Y-1`.
7. ⭐ `DELETE /buget?an=Y` lasă `Y-1` **intact** (număr și sume).
8. `/admin/alop/stats?an=Y-1` ⇒ cifre diferite de implicit; `?an=abc` ⇒ 400.
9. ⭐ **Neregresie**: cu date DOAR pe anul curent, toate răspunsurile sunt identice cu cele de
   dinainte de lot. Aceeași proprietate care a ancorat #202.

## E.2 — ⭐ `server/tests/unit/an-nu-din-cerere.test.mjs` (nou) — poarta pentru #204

Testul care apără decizia din tabelul de la început. Fără el, un lot viitor „completează"
parametrizarea și deschide gaura de plafon fără să pice nimic.

Verifică prin citirea sursei că **niciunul** dintre `routes/alop.mjs` și
`services/formular-shared.mjs` nu citește un an din `req.query` / `req.body` / `req.params`.
Mesajul de eșec trebuie să explice **de ce**, nu doar că a picat:

> „Anul de exercițiu al porților de scriere (plafon ordonanțare/plată) nu are voie să vină din
> cerere — un client ar putea trimite an=2025 și ar primi alt plafon. Vezi #203 Etapa 0 și #204."

## E.3

```bash
npm test
npm run test:db
```

⚠️ **Secvențial, niciodată în paralel.**

⚠️ **`test:db` se citește DOAR în prim-plan.** Sumarele de fundal au livrat de trei ori cifre
fantomă la #202. Un sumar de fundal **nu e dovadă de trecere**, oricât de plauzibil arată. Dacă
raportezi „verde" pe baza unui sumar de fundal, îl tratez ca nerulat.

`skipped` nu e `passed`. Test preexistent care pică ⇒ **raportează ÎNAINTE de a-l atinge.**

---

# ETAPA F — versiune, cache, commit

```bash
npm version 3.9.856 --no-git-tag-version
npm install --package-lock-only
git status --short
```

**`?v=` ȚINTIT**, doar pe fișierele efectiv modificate:
- `public/formular.html` → `clasa8.js?v=3.9.839` devine `?v=3.9.856`

⛔ **Niciun `sed` în masă** peste `?v=`. Fișier cu fișier, doar cele atinse.

**`CACHE_VERSION`**: se bumpează **doar dacă** un fișier din `PRECACHE_ASSETS` s-a schimbat.
Ancora din Etapa 0 îți spune dacă e cazul. Raportează decizia și motivul.

`git add` **explicit**, pe fișiere numite. **Niciodată `git add -A`.**

Arhivează și promptul: `docs/archive/PROMPT-203-selector-an-clasa8.md`, plus
`PROMPT-202-buget-an-exercitiu.md` care a rămas netracked în rădăcină — **în același commit cu
codul**, ca să nu se strângă iar în rădăcină.

```
feat(#203): selector de an in Clasa 8 — ?an= firmat din rute pana in UI — v3.9.856

#202 a dat bugetului dimensiunea `an`; rutele insa nu trimiteau anul mai
departe si UI-ul nu avea cu ce sa-l aleaga. In ianuarie 2027 centralizatorul
ar fi sarit pe 2027 fara nicio cale inapoi la 2026.

Rute noi/modificate: GET /buget/ani; ?an= pe /api/clasa8, /buget/disponibil,
/buget/meta, /buget/coduri si /admin/alop/stats. `an` explicit la import si la
DELETE /buget, cu text de confirmare care spune ANUL.

_parseAn accepta acum doar scalari (Number([2026]) === 2026 trecea inainte).

DELIBERAT NEATINSE: cele patru expresii de an care alimenteaza PORTILE DE
SCRIERE (plafon ordonantare/plata) — alop.mjs si formular-shared.mjs. Anul lor
vine de la server, niciodata din cerere: un client care trimite an=2025 ar
primi alt plafon. Se consolideaza in anExercitiuCurent() la #204. Testul
unit/an-nu-din-cerere apara decizia.

loadBugetCodes() ramane fara ?an= — datalistul DF are alt an (an_referinta).
```

```bash
git push origin develop
```

**Oprește-te aici.** Fără `main`, fără merge, fără deploy.

---

# RAPORT FINAL — obligatoriu

1. Ancorele din Etapa 0, cu valorile **OBȚINUTE**.
2. Decizia `CACHE_VERSION` (bumpat / nu) și **motivul**, cu dovada din `PRECACHE_ASSETS`.
3. Lista exactă a `?v=` modificate. (Așteptat: **unul singur**.)
4. Cum ai obținut indicele parametrului `an` în `/admin/alop/stats` și confirmarea că e **legat,
   nu interpolat**.
5. Confirmarea că `_parseAn` e **importat** în `admin/flows.mjs`, nu copiat.
6. Rezultatul fiecărui test din E.1, **în special 7 și 9**.
7. ⭐ Că E.2 există, trece, și ce anume verifică.
8. Numere reale `npm test` / `npm run test:db`, **secvențial, citite în prim-plan**. Spune
   explicit că nu ai folosit un sumar de fundal.
9. Teste preexistente atinse. (Așteptat: **NICIUNUL**.)
10. Confirmarea că cele patru expresii de ceas din tabelul de la început sunt **neatinse**
    (`git diff` pe `alop.mjs` și `formular-shared.mjs` — așteptat: **gol**).
11. Divergențe prompt ↔ cod — **raportate, NU reparate tăcut**.
12. Colaterale.

---

# ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Fără `checkout main`, `merge`, `push main`, deploy.
- Cele patru expresii de ceas din tabelul de la început: **NEATINSE**. `git diff` gol pe
  `alop.mjs` și `formular-shared.mjs`.
- `an` **legat ca parametru**, niciodată interpolat în SQL.
- `_parseAn` **importat**, niciodată copiat.
- `loadBugetCodes()` și `cod-ssi-validate.mjs`: **neatinse**.
- Resetul de filtre **nu** resetează anul.
- `?v=` țintit, fișier cu fișier. Fără `sed` în masă.
- `git add` explicit. `git push origin develop` ca pas final, apoi **stop**.
- `old_str` care nu se potrivește exact o dată ⇒ **OPREȘTE-TE și raportează**.
