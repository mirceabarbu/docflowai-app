---
prompt: 175
titlu: "Prefill-ul ALOP se CERE de la server, nu se cară prin sessionStorage (+ persoanele)"
model_suggested: "Opus 5, efort high"
branch: develop
versiune_curenta: v3.9.829
versiune_tinta: v3.9.830
migratii: NU
fisiere_din_public: DA  (⇒ bump `?v=` ȚINTIT; CACHE_VERSION — vezi Etapa 0)
zona_no_touch_atinsa: NU
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Pasul final obligatoriu: `git push origin develop`.

---

## Context — de ce se ȘTERGE lanțul în loc să se mai repare o verigă

Trei loturi consecutive (#172, #172b, #174) au reparat câte o verigă din lanțul de prefill al
semnatarilor ALOP. Fiecare fix a fost corect și verificat; de fiecare dată a cedat următoarea
verigă. Lanțul are șapte verigi:

`window._alopContext` populat → butonul potrivit apăsat → funcția care scrie →
`sessionStorage` → citirea din `handleUrlParams` → `window._alopPrefillSigners` →
aplicarea, în cursă cu `setDefaults`, `restoreFormState` și `applyTemplate`.

**Măsurat pe staging (03.09.2026, v3.9.829): `window._alopContext` este `null`.** Prima verigă.
`_alopScriePrefill` (#174) întoarce 0, nu se scrie nimic, iar ecranul pune implicitele.

Datele stau în baza de date, iar ecranul primește deja `alop_id` **în URL pe toate trei căile de
lansare** (`core.js:953`, `alop.js` ×2). Deci le poate CERE, în loc să i le care cineva prin
sesiune. `GET /api/alop/:id` face `SELECT a.*` ⇒ întoarce `df_semnatari` și `ord_semnatari`; e
autentificată, org-scoped, cu regulile de vizibilitate existente (verificat pe cod).

### Ce dispare

- dependența de `window._alopContext` (veriga care a cedat);
- `sessionStorage['docflow_prefill_signers']` și tot ce-l scrie/citește;
- `_alopScriePrefill`, `ALOP_ROL` și exportul lor din `alop.js`;
- cursa cu ceilalți scriitori de `tbody` — aplicarea nu mai depinde de ordinea de sosire, ci de
  un `await` explicit.

### Ce se REZOLVĂ în plus

Persoanele. Având `user_id` direct de la server, rândurile pot fi legate de oameni.
`signerRowTemplate` (`main.js:770-778`) **știe deja** să pre-selecteze după `s.email` din
`window._dbUsers` — nu trebuie inventat nimic, doar alimentat corect.

---

## Fapte VERIFICATE pe cod (v3.9.828 pentru `main.js`, care nu s-a atins la #174)

- `applyAlopPrefill()` (`main.js:803-815`) e sincronă, idempotentă, cu steagul
  `window._alopPrefillApplied`. Structura e CORECTĂ și se păstrează — se schimbă doar SURSA
  datelor.
- Cele două locuri de apel: `main.js:1705` (în `loadDbUsers`, după `/users`) și `main.js:1938`
  (blocul „Default load", ca `const _prefillPus = …`). Ambele sunt în contexte `async` ⇒ pot
  primi `await` fără restructurare.
- `refreshAllDropdowns` (`main.js:529-551`) restaurează selecția după **email** — de aceea
  rândurile trebuie să poarte email, nu doar nume.
- `signerRowTemplate` pre-selectează după `s.email` DOAR dacă `window._dbUsers` e deja populat
  (`main.js:771`). ⇒ e nevoie de o legare ulterioară, idempotentă, pentru cazul în care rândurile
  se creează înainte de `/users`.
- `window._dbUsers` se populează în `loadDbUsers` (`main.js:1697`).
- `alop_id` ajunge în URL pe toate căile; `sessionStorage['alop_id_for_flow']` rămâne rezerva
  citită la `main.js:2358`.
- Testul #173 (`server/tests/unit/alop-roluri.test.mjs`, cazul de paritate) asertează pe
  `ALOP_ROL` din `public/js/formular/alop.js`. Mutarea hărții **îl va face să cadă** ⇒ Etapa A îl
  actualizează, cu justificare. E singurul test preexistent pe care ai voie să-l atingi.

---

## ⛔ Ce NU se atinge

- **NU** modifica `GET /api/alop/:id` și nici autorizarea lui. Zero fișiere pe server, în afara
  testului de paritate din Etapa A.
- **NU** atinge `setDefaults`, `restoreFormState`, `applyTemplate`, `updateIntocmitVisibility`,
  `syncIntocmit`, `refreshAllDropdowns`.
- **NU** atinge pașii „Pas 0/1" din `alopLaunchDfFlow`/`alopLaunchOrdFlow` (`genPdf`, `link-df`,
  `link-ord`) și nici parametrii din URL pe care îi construiesc.
- **NU** elimina `sessionStorage['alop_id_for_flow']` — e rezerva pentru `alop_id`.
- **NU** atinge `alop.js:787` (previzualizarea din card).
- Zero migrații.

---

## ETAPA 0 — ancore (READ-ONLY)

```bash
cd "$(git rev-parse --show-toplevel)"
git branch --show-current                                   # Așteptat: develop
node -e "console.log(require('./package.json').version)"     # Așteptat: 3.9.829

grep -c "docflow_prefill_signers" public/js/formular/alop.js public/js/semdoc-initiator/main.js
# Așteptat: 1 și 1

grep -n "function _alopScriePrefill" public/js/formular/alop.js      # Așteptat: 1 linie
grep -n "_alopScriePrefill(alopId,'notafd')" public/js/formular/alop.js
grep -n "_alopScriePrefill(alopId,'ordnt')" public/js/formular/alop.js
grep -c "const ALOP_ROL=" public/js/formular/alop.js                 # Așteptat: 1
grep -n "function applyAlopPrefill" public/js/semdoc-initiator/main.js
grep -n "const _prefillPus = applyAlopPrefill();" public/js/semdoc-initiator/main.js

grep -n "formular/alop.js?v=\|semdoc-initiator/main.js?v=" public/*.html   # notează valorile
grep -n "js/formular/alop.js\|js/semdoc-initiator/main.js\|js/shared/" public/sw.js
# Așteptat: 0 ⇒ CACHE_VERSION neatins
ls public/js/shared/alop-roluri.js 2>/dev/null                       # Așteptat: „No such file"
```

⚠️ Ancorele din `alop.js` provin din lotul #174, nu dintr-o arhivă citită de mine. Dacă vreuna nu
se potrivește **exact**, OPREȘTE-TE și raportează textul real — nu căuta un anchor echivalent.

---

## ETAPA A — harta rol→atribut ca fișier partajat

Creează `public/js/shared/alop-roluri.js` (script CLASIC, IIFE, pe modelul
`public/js/shared/atribute.js` de la #168):

```js
/* DocFlowAI — alop-roluri.js (#175)
 * Harta rol ALOP → atribut de semnătură, partajată între ecrane.
 * Perechea pe server e `server/services/alop-roluri.mjs` (#173); un test de paritate
 * ține cele două în acord și cade dacă diverg.
 * A trăit până acum în `public/js/formular/alop.js`, unde nu putea fi folosită de
 * `semdoc-initiator`, care e cel care construiește efectiv rândurile de semnatari.
 */
(function () {
  'use strict';
  var ROL_ATRIBUT = {
    initiator: 'ÎNTOCMIT',
    sef_compartiment: 'VIZAT',
    responsabil_cab: 'VERIFICAT',
    sef_cab: 'VIZAT',
    director_economic: 'VIZĂ ECONOMICĂ',
    ordonator_credite: 'APROBAT',
    cfp_propriu: 'VIZĂ CFPP'
  };
  window.DFAlopRoluri = {
    ROL_ATRIBUT: ROL_ATRIBUT,
    /** Atributul unui rând de șablon: cel salvat explicit are precădere (rol personalizat). */
    atribut: function (s) {
      if (!s) return 'SEMNAT';
      if (typeof s.atribut === 'string' && s.atribut.trim()) return s.atribut.trim();
      return ROL_ATRIBUT[s.role] || 'SEMNAT';
    }
  };
})();
```

Încarcă-l **fără `defer`**, ÎNAINTE de scripturile care îl folosesc, în:
- `public/semdoc-initiator.html` (înainte de `js/semdoc-initiator/main.js`)
- `public/formular.html` (înainte de `js/formular/alop.js`)

⚠️ Capcana de la #168: `atribute.js` e încărcat cu `defer` în `semdoc-initiator.html` și **fără**
în `templates.html`. Aici scriptul trebuie să ruleze înaintea consumatorilor ⇒ **fără `defer`**
în ambele pagini.

### Actualizarea testului #173 (singurul preexistent atins)

`server/tests/unit/alop-roluri.test.mjs`, cazul de paritate, citește azi `ALOP_ROL` din
`public/js/formular/alop.js`. Sursa se mută ⇒ testul citește acum `ROL_ATRIBUT` din
`public/js/shared/alop-roluri.js`. **Aserțiunea rămâne aceeași** (perechile rol→atribut coincid
cu `ALOP_ROLURI` de pe server); se schimbă doar fișierul din care se parsează. Justifică asta
explicit în raport: nu e o slăbire, e aceeași verificare pe noua locație a sursei.

---

## ETAPA B — `applyAlopPrefill` își ia datele de la server

`old_str`
```js
      function applyAlopPrefill() {
        const lista = window._alopPrefillSigners;
        if (!lista || !lista.length) return false;
        const _alTbody = $("signersTbody");
        if (!_alTbody) return false;
        _alTbody.innerHTML = "";
        lista.forEach(s => _alTbody.appendChild(signerRowTemplate(s)));
        window._alopPrefillSigners = null;
        window._alopPrefillApplied = true;
        refreshAllDropdowns?.();
        validateForm();
        return true;
      }
```

`new_str`
```js
      // #175 — SURSA datelor s-a schimbat: nu mai vin cărate prin sessionStorage de pe
      // pagina de formular, ci se CER de la server pe baza lui `alop_id` din URL.
      // Lanțul vechi avea șapte verigi (context global, buton, scriitor, sesiune, citire,
      // variabilă globală, aplicare în cursă cu alți trei scriitori de tbody) și a cedat pe
      // rând la #172, #172b și #174; măsurat pe staging, `window._alopContext` era null.
      // Aici rămâne o singură dependență: parametrul din URL, prezent pe toate căile.
      // Structura idempotentă de la #172b se păstrează — steagul separat de date, ca blocul
      // „Default load" să deosebească „n-a existat prefill" de „s-a aplicat deja".
      function _alopIdDinUrl() {
        const p = new URLSearchParams(location.search).get("alop_id");
        if (p) return p;
        const s = sessionStorage.getItem("alop_id_for_flow");
        return s ? s.split("|")[0] : "";
      }

      // Leagă persoanele de rândurile deja randate, după ce `_dbUsers` e disponibil.
      // Idempotentă: un rând legat nu se mai atinge. Necesară fiindcă rândurile se pot crea
      // ÎNAINTE ca /users să răspundă, iar `refreshAllDropdowns` restaurează după email.
      function _alopLeagaPersoane() {
        const users = window._dbUsers || [];
        if (!users.length) return;
        tbody.querySelectorAll("tr[data-want-email]").forEach(tr => {
          const email = tr.getAttribute("data-want-email");
          const sel = tr.querySelector(".name-select");
          if (!email || !sel || sel.value) return;
          const u = users.find(x => x.email === email);
          if (!u) return;
          sel.value = u.nume || "";
          if (sel.value) tr.removeAttribute("data-want-email");
        });
        validateForm();
      }

      async function applyAlopPrefill() {
        if (window._alopPrefillApplied) return false;
        const alopId = _alopIdDinUrl();
        if (!alopId) return false;                      // flux normal, fără ALOP — no-op
        const _alTbody = $("signersTbody");
        if (!_alTbody) return false;
        const ft = new URLSearchParams(location.search).get("alop_doc_type")
          || (sessionStorage.getItem("alop_id_for_flow") || "").split("|")[1]
          || "notafd";
        let dosar = null;
        try {
          const r = await _apiFetch(`/api/alop/${encodeURIComponent(alopId)}`, { method: "GET" });
          if (!r.ok) { console.warn("ALOP prefill: dosarul nu a putut fi citit", r.status); return false; }
          dosar = await r.json();
        } catch (e) { console.warn("ALOP prefill: eroare la citirea dosarului", e); return false; }
        const sablon = (ft === "ordnt" ? dosar?.ord_semnatari : dosar?.df_semnatari) || [];
        if (!Array.isArray(sablon) || !sablon.length) return false;
        const users = window._dbUsers || [];
        const initiator = sablon.find(s => s && s.role === "initiator");
        const randuri = sablon.map(s => {
          const uid = s && s.same_as_initiator ? (initiator && initiator.user_id) : (s && s.user_id);
          const u = uid ? users.find(x => String(x.id) === String(uid)) : null;
          return {
            _uid: uid || "",
            name: u ? (u.nume || "") : (s && s.same_as_initiator ? (initiator?.name || "") : (s?.name || "")),
            email: u ? (u.email || "") : "",
            rol: (window.DFAlopRoluri ? window.DFAlopRoluri.atribut(s) : "SEMNAT"),
            functie: (s && s.functie) || (u && u.functie) || ""
          };
        });
        _alTbody.innerHTML = "";
        randuri.forEach(r => {
          const tr = signerRowTemplate(r);
          // Emailul dorit rămâne pe rând până când există un utilizator de legat de el.
          if (r.email) tr.setAttribute("data-want-email", r.email);
          _alTbody.appendChild(tr);
        });
        window._alopPrefillApplied = true;
        refreshAllDropdowns?.();
        _alopLeagaPersoane();
        validateForm();
        return true;
      }
```

⚠️ Dacă `_apiFetch` nu e disponibil în domeniul lexical al lui `main.js`, verifică cum sunt
făcute celelalte apeluri din fișier și folosește ACELAȘI mecanism. **Nu introduce un `fetch`
brut fără credențiale** — ruta cere sesiune.

### B.2 — cele două locuri de apel primesc `await`

`old_str`
```js
            // ALOP: aplică semnatari pre-configurați dacă există prefill în așteptare.
            // #172b — logica s-a mutat în applyAlopPrefill (punct unic, idempotent).
            applyAlopPrefill();
```

`new_str`
```js
            // ALOP: aplică semnatari pre-configurați dacă există prefill în așteptare.
            // #172b — logica s-a mutat în applyAlopPrefill (punct unic, idempotent).
            // #175 — acum e asincronă (citește dosarul de la server); aici e locul PREFERAT,
            // fiindcă `_dbUsers` tocmai s-a populat, deci persoanele se pot lega direct.
            await applyAlopPrefill();
            _alopLeagaPersoane();
```

`old_str`
```js
        const _prefillPus = applyAlopPrefill();
```

`new_str`
```js
        const _prefillPus = await applyAlopPrefill();
```

⚠️ Ordinea de la `main.js:1938-1941` rămâne NESCHIMBATĂ: dacă citirea dosarului eșuează,
`applyAlopPrefill` întoarce `false` și `setDefaults()` rulează ca înainte. **Nicio cale nu
trebuie să lase tabelul gol.** Verifică asta cu un caz de test.

---

## ETAPA C — se scoate citirea din sessionStorage

`old_str`
```js
          // ALOP: stochează semnatari pentru aplicare după _dbUsers se încarcă
          const _alopPS = sessionStorage.getItem("docflow_prefill_signers");
          if (_alopPS) {
            try { window._alopPrefillSigners = JSON.parse(_alopPS); } catch(_) {}
            sessionStorage.removeItem("docflow_prefill_signers");
          }
```

`new_str`
```js
          // #175 — semnatarii nu mai vin prin sesiune; se citesc de la server în
          // applyAlopPrefill, pe baza lui `alop_id` din URL. Curățăm o eventuală cheie
          // rămasă din sesiuni vechi, ca să nu ținem date moarte în browserul nimănui.
          sessionStorage.removeItem("docflow_prefill_signers");
```

---

## ETAPA D — se șterge lanțul din `alop.js`

Elimină, în ordine:

1. Blocul `const ALOP_ROL={…}` + `function _alopScriePrefill(alopId,ft){…}` introdus la #174
   (secțiunea „Acțiuni ALOP"), inclusiv comentariul lui.
2. Linia `_alopScriePrefill(alopId,'notafd');` și comentariul „Pas 2 (#174)" din
   `alopLaunchDfFlow` — renumerotează înapoi comentariul următor din „Pas 3" în „Pas 2".
3. Idem pentru `'ordnt'` în `alopLaunchOrdFlow`.
4. Linia de export `window._alopScriePrefill = _alopScriePrefill;`.
5. În patch-ul `mkFlow`, linia
   `if(typeof window._alopScriePrefill==='function')window._alopScriePrefill(alopId,ft);`
   și comentariul ei — se păstrează `sessionStorage.setItem('alop_id_for_flow',…)`, care rămâne
   rezerva pentru `alop_id`.

Rezultat așteptat: `grep -c "docflow_prefill_signers" public/js/formular/alop.js` → **0**;
`grep -c "_alopScriePrefill" public/js/formular/alop.js` → **0**;
`grep -c "const ALOP_ROL=" public/js/formular/alop.js` → **0**.

⚠️ Testul `server/tests/unit/alop-prefill-cale-unica.test.mjs` (#174) asertează pe exact aceste
tipare și **VA CĂDEA**. Nu-l „repara" ștergându-l: rescrie-i aserțiunile ca invariant al noii
arhitecturi — `alop.js` NU mai scrie prefill deloc (cele trei contoare de mai sus = 0), iar
`docflow_prefill_signers` nu mai apare în tot `public/js` (0 apariții). Motivul e legitim și
trebuie scris în raport: lotul înlocuiește mecanismul pe care testul îl păzea.

---

## ETAPA E — teste

Fișier NOU: `server/tests/unit/alop-prefill-server.test.mjs` (analiză statică).
⚠️ Elimină liniile de comentariu înainte de aserțiuni (lecția de la #124i, #172, #172b, #173).

1. ⭐ `docflow_prefill_signers` apare în `public/js` DOAR ca `removeItem` (curățarea din
   Etapa C) — zero `setItem`, zero `getItem`.
2. ⭐ `applyAlopPrefill` e `async` și conține `/api/alop/`.
3. ⭐ Ambele locuri de apel folosesc `await applyAlopPrefill()`.
4. `applyAlopPrefill` întoarce `false` devreme când nu există `alop_id` — calea „Flux nou"
   normală nu face niciun apel de rețea.
5. `public/js/formular/alop.js` nu mai conține `_alopScriePrefill`, `const ALOP_ROL=` sau
   `docflow_prefill_signers`.
6. `semdoc-initiator.html` și `formular.html` încarcă `shared/alop-roluri.js` **fără `defer`**,
   înaintea consumatorului.
7. `_alopLeagaPersoane` e apelată din cel puțin două locuri și e gardată pe `sel.value` gol
   (idempotență).
8. Blocul „Default load" păstrează `setDefaults()` sub garda `!_restored && !_prefillPus &&
   !window._alopPrefillApplied` — un dosar necitibil nu lasă tabelul gol.

```bash
node --check public/js/shared/alop-roluri.js
node --check public/js/semdoc-initiator/main.js
node --check public/js/formular/alop.js
npx vitest run server/tests/unit/alop-prefill-server.test.mjs
npx vitest run server/tests/unit/alop-roluri.test.mjs server/tests/unit/alop-prefill-cale-unica.test.mjs
npx vitest run server/tests/unit/prefill-alop-roluri.test.mjs server/tests/unit/prefill-alop-cursa.test.mjs
npm test
npm run test:db
```

⚠️ `prefill-alop-roluri.test.mjs` (#172) asertează absența filtrului vechi și prezența lui
`:787` în `alop.js`. Ambele trebuie să treacă NEMODIFICATE. Dacă vreuna cade, oprește-te și
raportează.

---

## ETAPA F — versiune, cache busting, commit

1. `package.json`: `3.9.829` → `3.9.830`.
2. `CACHE_VERSION` **NEATINS** (confirmat în Etapa 0).
3. Bump `?v=` țintit pe assetele atinse; fișierul nou se scrie direct la `3.9.830`:

```bash
NEW=3.9.830
sed -i -E "s#(js/formular/alop\.js\?v=)[0-9.]+#\1$NEW#g" public/*.html
sed -i -E "s#(js/semdoc-initiator/main\.js\?v=)[0-9.]+#\1$NEW#g" public/*.html
grep -n "formular/alop.js?v=\|semdoc-initiator/main.js?v=\|shared/alop-roluri.js?v=" public/*.html
grep -c "<script" public/formular.html public/semdoc-initiator.html
```

⛔ `\1`, nu `\g<1>`. ⛔ Fără bulk-sed pe alte `?v=`.

4. `git add` explicit pe căile sarcinii. **Niciodată `git add -A`.**
5. Commit:
   ```
   refactor(#175): prefill-ul ALOP se citeste de la server — v3.9.830

   Lantul de sapte verigi (context global -> buton -> scriitor -> sessionStorage
   -> citire -> variabila globala -> aplicare in cursa) a cedat pe rand la #172,
   #172b si #174; masurat pe staging, window._alopContext era null. Ecranul de
   flux primeste deja alop_id in URL pe toate caile, iar GET /api/alop/:id
   intoarce df_semnatari/ord_semnatari => datele se cer, nu se mai cara.
   Dispar _alopScriePrefill, ALOP_ROL din alop.js si cheia de sesiune.
   In plus, persoanele configurate in sablon se leaga acum de randuri
   (user_id -> email -> optiune), ultimul element ramas din serie.
   ```
6. `git push origin develop`

---

## RAPORT FINAL — obligatoriu

1. Ancorele din Etapa 0, cu valorile OBȚINUTE. Dacă vreuna din `alop.js` a diferit de ce am
   scris eu, CARE și cum arăta textul real.
2. Etapa A: cum ai încărcat scriptul în cele două pagini; ce ai schimbat exact în testul #173.
3. Etapa B: ai folosit `_apiFetch` sau altceva, și de ce.
4. Etapa D: cele trei contoare (`docflow_prefill_signers`, `_alopScriePrefill`, `const ALOP_ROL=`)
   în `alop.js` — valorile finale; cum ai rescris testul de la #174.
5. Rezultatul fiecărui caz din Etapa E, cu accent pe 1, 3 și 8.
6. Numerele reale `npm test` / `npm run test:db`; dacă `test:db` a rulat REAL.
7. Ieșirea `grep` de după `sed`.
8. Teste preexistente atinse: care, de ce, de ce nu e o slăbire. (Așteptat: DOUĂ —
   `alop-roluri.test.mjs` și `alop-prefill-cale-unica.test.mjs`, ambele fiindcă lotul mută
   sursa pe care o păzeau.)
9. Divergențe prompt↔cod — raportate, NU reparate tăcut.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Zero fișiere pe server în afara celor două teste.
- Zero migrații, `CACHE_VERSION` neatins.
- `prefill-alop-roluri.test.mjs` și `prefill-alop-cursa.test.mjs` NEMODIFICATE.
- Nicio cale nu lasă tabelul de semnatari gol dacă citirea dosarului eșuează.
- `git add` explicit.
- `old_str` care nu se potrivește exact ⇒ **OPREȘTE-TE și raportează**.
