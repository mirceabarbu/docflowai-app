---
prompt: 176
titlu: "Dosarul ALOP se află din DOCUMENT, nu din contextul browserului"
model_suggested: "Opus 5, efort high"
branch: develop
versiune_curenta: v3.9.830
versiune_tinta: v3.9.831
migratii: NU
fisiere_din_public: DA  (UN singur fișier JS ⇒ bump `?v=` țintit; CACHE_VERSION — vezi Etapa 0)
zona_no_touch_atinsa: NU
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Pasul final obligatoriu: `git push origin develop`.

---

## Context — de ce #175 încă nu populează tabelul

#175 a mutat DATELE pe server (`GET /api/alop/:id`), dar a lăsat **CHEIA** (`alop_id`) să
circule mai departe prin `window._alopContext`. Iar contextul e `null` ori de câte ori
documentul e deschis din **lista de DF/ORD**, nu din cardul ALOP — se setează doar în
`openAlop`/`alopDeschideDF` și se șterge în `closeAlopDetail` (`alop.js:441`).

Lanțul de pe calea folosită efectiv:

```
buton „Creează flux de semnare" (formular.html:1299, onclick="showFF('notafd')")
  → core.js:936 showFF → mkFlow
  → core.js:954  if (_alopCtx?.alopId && ST.docId?.[ft])  ⇐ FALS când contextul e null
  → URL fără alop_id  →  _alopIdDinUrl() = ""  →  applyAlopPrefill() = false
  → setDefaults()  →  cele 3 rânduri implicite
```

Reprodus pe staging v3.9.830 (confirmat prin `/health`), cu șablonul DF configurat la 5 roluri.

### Ce se schimbă: cheia nu mai e contextul, ci DOCUMENTUL

Fapte VERIFICATE pe codul v3.9.830 și pe producție:

- `formulare_df` și `formulare_ord` au coloana **`source_alop_id`** (migrația din
  `db/index.mjs:1820-1825`, indexată). Măsurat pe producție: **166 din 166 de DF-uri o au
  populată**. Zero excepții.
- `GET /api/formulare-df/:id` și `GET /api/formulare-ord/:id` fac `SELECT fd.*` / `SELECT fo.*`
  ⇒ `source_alop_id` e în răspuns. Expun în plus `alop_id`, derivat prin
  `alop_instances.df_id`/`ord_id`.
- ⚠️ Forma răspunsului e **`{ ok: true, document: doc }`** (`df.mjs:213`, `ord.mjs:198`) —
  NU obiectul brut. (Aceeași clasă de capcană ca la `{ alop }` de la #175, prinsă acolo de tine.)
- `prefill_doc_id` e în URL pe cele două căi din cardul ALOP (`alop.js:1126`, `:1155`).
  Pe calea `mkFlow` e în URL doar când există context, **DAR** `core.js:948` scrie
  `docflow_prefill_doc_id` în `sessionStorage` **necondiționat**, iar ștergerea lui se face abia
  DUPĂ crearea fluxului (`main.js:2422`). ⇒ id-ul documentului e disponibil pe toate trei căile,
  la momentul în care rulează `applyAlopPrefill`.
- `prefill_doc_type` are aceleași două valori peste tot: `'notafd'` / `'ordnt'`.

**Preferă `source_alop_id`** față de `alop_id`: primul e pe document și e populat 166/166; al
doilea e derivat prin pointerul `alop_instances.df_id`, care poate arăta spre altă revizie.

---

## ⛔ Ce NU se atinge

- **NU** atinge `public/js/formular/core.js` și nici `public/js/formular/alop.js`. Condiția
  `if (_alopCtx?.alopId && ST.docId?.[ft])` din `mkFlow` rămâne exact cum e — nu mai contează.
- **NU** atinge `setDefaults`, `restoreFormState`, `applyTemplate`, `refreshAllDropdowns`,
  `signerRowTemplate`, `updateIntocmitVisibility`, `syncIntocmit`.
- **NU** șterge `docflow_prefill_doc_id`/`_type` mai devreme decât se șterg azi (`main.js:2422`,
  după crearea fluxului) — sunt folosite la `link-flow` și la calculul lui `meta`.
- **NU** modifica nimic pe server. Zero migrații.
- **NU** schimba structura idempotentă de la #172b (steagul `_alopPrefillApplied`) și nici
  garda `!_restored && !_prefillPus && !window._alopPrefillApplied` de la „Default load".

---

## ETAPA 0 — ancore (READ-ONLY)

```bash
cd "$(git rev-parse --show-toplevel)"
git branch --show-current                                   # Așteptat: develop
node -e "console.log(require('./package.json').version)"     # Așteptat: 3.9.830

grep -n "function _alopIdDinUrl" public/js/semdoc-initiator/main.js       # Așteptat: 1 (:811)
grep -n "const alopId = _alopIdDinUrl();" public/js/semdoc-initiator/main.js
grep -c "await applyAlopPrefill()" public/js/semdoc-initiator/main.js     # Așteptat: 2
grep -n "semdoc-initiator/main.js?v=" public/*.html                       # notează valoarea
grep -n "js/semdoc-initiator/main.js" public/sw.js                        # Așteptat: 0
```

Dacă vreo ancoră nu se potrivește, **OPREȘTE-TE** și raportează.

---

## ETAPA A — rezolvarea dosarului din document

`old_str`
```js
      function _alopIdDinUrl() {
        const p = new URLSearchParams(location.search).get("alop_id");
        if (p) return p;
        const s = sessionStorage.getItem("alop_id_for_flow");
        return s ? s.split("|")[0] : "";
      }
```

`new_str`
```js
      // #176 — CHEIA nu mai vine din contextul browserului, ci din DOCUMENT.
      // #175 a mutat datele pe server, dar `alop_id` ajungea în URL doar dacă
      // `window._alopContext` era populat (core.js:954) — iar el e null ori de câte ori
      // documentul e deschis din lista de DF/ORD în loc de cardul ALOP. Documentul însă
      // își știe dosarul: coloana `source_alop_id`, populată pe 166 din 166 de DF-uri în
      // producție. Iar id-ul documentului e prezent pe TOATE căile de lansare (în URL pe
      // cele două din card, în sessionStorage pe calea mkFlow, scris necondiționat).
      // Ordinea: cheia directă, dacă există (un apel de rețea economisit), altfel documentul.
      function _alopDirect() {
        const up = new URLSearchParams(location.search);
        const id = up.get("alop_id")
          || (sessionStorage.getItem("alop_id_for_flow") || "").split("|")[0];
        if (!id) return null;
        const ft = up.get("alop_doc_type")
          || (sessionStorage.getItem("alop_id_for_flow") || "").split("|")[1]
          || up.get("prefill_doc_type")
          || sessionStorage.getItem("docflow_prefill_doc_type")
          || "notafd";
        return { alopId: id, ft: ft === "ordnt" ? "ordnt" : "notafd" };
      }

      async function _alopDinDocument() {
        const up = new URLSearchParams(location.search);
        const docId = up.get("prefill_doc_id")
          || sessionStorage.getItem("docflow_prefill_doc_id");
        const dtype = up.get("prefill_doc_type")
          || sessionStorage.getItem("docflow_prefill_doc_type");
        if (!docId || !dtype) return null;
        const ft = dtype === "ordnt" ? "ordnt" : "notafd";
        const api = ft === "ordnt" ? "/api/formulare-ord" : "/api/formulare-df";
        try {
          const r = await _apiFetch(`${api}/${encodeURIComponent(docId)}`, { method: "GET" });
          if (!r.ok) { console.warn("ALOP prefill: documentul nu a putut fi citit", r.status); return null; }
          const _j = await r.json();
          // Ruta întoarce `{ ok, document }`; fallback pe obiectul brut dacă învelitoarea
          // se schimbă vreodată.
          const doc = (_j && _j.document) ? _j.document : _j;
          // `source_alop_id` e pe document și e populat integral; `alop_id` e derivat prin
          // pointerul dosarului și poate arăta spre altă revizie ⇒ al doilea e doar rezervă.
          const alopId = (doc && (doc.source_alop_id || doc.alop_id)) || "";
          return alopId ? { alopId, ft } : null;
        } catch (e) { console.warn("ALOP prefill: eroare la citirea documentului", e); return null; }
      }

      async function _alopPentruPrefill() {
        return _alopDirect() || await _alopDinDocument();
      }
```

---

## ETAPA B — `applyAlopPrefill` folosește rezolvarea nouă

`old_str`
```js
        const alopId = _alopIdDinUrl();
        if (!alopId) return false;                      // flux normal, fără ALOP — no-op
        const _alTbody = $("signersTbody");
        if (!_alTbody) return false;
        const ft = new URLSearchParams(location.search).get("alop_doc_type")
          || (sessionStorage.getItem("alop_id_for_flow") || "").split("|")[1]
          || "notafd";
```

`new_str`
```js
        const _sursa = await _alopPentruPrefill();
        if (!_sursa) return false;                      // flux normal, fără ALOP — no-op
        const { alopId, ft } = _sursa;
        const _alTbody = $("signersTbody");
        if (!_alTbody) return false;
```

⚠️ `_alTbody` se citește ACUM după rezolvare. Verifică să nu fi rămas nicio referință la `ft`
sau `alopId` înaintea acestei linii în corpul funcției.

---

## ETAPA C — o urmă de diagnostic, una singură

La finalul lui `applyAlopPrefill`, imediat înainte de `return true;`:

`old_str`
```js
        window._alopPrefillApplied = true;
        refreshAllDropdowns?.();
        _alopLeagaPersoane();
        validateForm();
        return true;
```

`new_str`
```js
        window._alopPrefillApplied = true;
        refreshAllDropdowns?.();
        _alopLeagaPersoane();
        validateForm();
        // #176 — urmă de diagnostic: patru loturi au eșuat fiindcă nu se putea vedea din
        // afară CE a găsit funcția. O singură linie, doar pe calea care chiar a aplicat.
        console.info("[ALOP prefill]", { alopId, ft, roluri: randuri.length,
          cuPersoana: randuri.filter(r => r.email).length });
        return true;
```

---

## ETAPA D — teste

Fișier NOU: `server/tests/unit/alop-prefill-din-document.test.mjs` (analiză statică).
⚠️ Elimină liniile de comentariu înainte de aserțiuni (lecția de la #124i, #172, #172b, #173,
#175).

1. ⭐ `_alopDinDocument` citește `prefill_doc_id` din URL **și** din `sessionStorage` (ambele
   surse prezente în corpul funcției) — altfel calea `mkFlow` fără context rămâne moartă.
2. ⭐ Dezambalarea răspunsului: funcția conține `_j.document` — nu presupune obiectul brut.
3. ⭐ `source_alop_id` are precădere față de `alop_id` (compară pozițiile în text).
4. `_alopPentruPrefill` încearcă întâi `_alopDirect()` și abia apoi `_alopDinDocument()`
   (poziții în text), ca fluxurile cu `alop_id` în URL să nu facă un apel de rețea în plus.
5. `applyAlopPrefill` nu mai conține `_alopIdDinUrl` (identificatorul a dispărut complet din
   fișier — inclusiv definiția).
6. Ruta apelată e `/api/formulare-ord` pentru `ordnt` și `/api/formulare-df` altfel.
7. Regresie #172b: garda `!_restored && !_prefillPus && !window._alopPrefillApplied` e
   neschimbată, iar `setDefaults()` rămâne sub ea — un document fără dosar nu lasă tabelul gol.
8. Regresie #175: `docflow_prefill_signers` apare în tot `public/js` exact o dată, ca
   `removeItem`.
9. `docflow_prefill_doc_id` NU se șterge din `applyAlopPrefill` — ștergerea rămâne doar la
   locul ei de după crearea fluxului.

```bash
node --check public/js/semdoc-initiator/main.js
npx vitest run server/tests/unit/alop-prefill-din-document.test.mjs
npx vitest run server/tests/unit/alop-prefill-server.test.mjs server/tests/unit/prefill-alop-cursa.test.mjs server/tests/unit/prefill-alop-roluri.test.mjs
npm test
npm run test:db
```

⚠️ Dacă vreun test preexistent cade, **OPREȘTE-TE și raportează** înainte de a-l atinge. Lotul
ăsta nu mută niciun simbol între fișiere, deci nu ar trebui să rupă nimic — dacă rupe, e semn că
a schimbat comportament, și vreau să știu.

---

## ETAPA E — versiune, cache busting, commit

1. `package.json`: `3.9.830` → `3.9.831`.
2. `CACHE_VERSION` **NEATINS**.
3. Bump `?v=` doar pe `semdoc-initiator/main.js`:

```bash
NEW=3.9.831
sed -i -E "s#(js/semdoc-initiator/main\.js\?v=)[0-9.]+#\1$NEW#g" public/*.html
grep -n "semdoc-initiator/main.js?v=" public/*.html
grep -c "<script" public/semdoc-initiator.html
```

⛔ `\1`, nu `\g<1>`. ⛔ Fără bulk-sed.

4. `git add` explicit: `public/js/semdoc-initiator/main.js`, `public/semdoc-initiator.html`,
   testul nou, `package.json`. **Niciodată `git add -A`.**
5. Commit:
   ```
   fix(#176): dosarul ALOP se afla din document, nu din contextul browserului — v3.9.831

   #175 a mutat datele pe server, dar cheia (alop_id) circula tot prin
   window._alopContext, care e null cand documentul e deschis din lista in
   loc de cardul ALOP => URL fara alop_id => prefill no-op => randurile
   implicite. Documentul isi stie dosarul prin source_alop_id (166/166 in
   productie), iar id-ul documentului e prezent pe toate caile. Rezolvarea
   incearca intai cheia directa, apoi documentul. O linie de diagnostic
   spune ce s-a gasit.
   ```
6. `git push origin develop`

---

## RAPORT FINAL — obligatoriu

1. Ancorele din Etapa 0, cu valorile OBȚINUTE.
2. Rezultatul fiecărui caz din Etapa D, cu accent pe 1, 2, 3 și 7.
3. Confirmă că `_alopIdDinUrl` a dispărut complet din fișier (contor 0).
4. Numerele reale `npm test` / `npm run test:db`; dacă `test:db` a rulat REAL.
5. Ieșirea `grep` de după `sed`.
6. Teste preexistente atinse. (Așteptat: NICIUNUL.)
7. Divergențe prompt↔cod — raportate, NU reparate tăcut. În special: dacă forma răspunsului
   rutelor de document NU e `{ ok, document }`, spune-mi ce e.
8. Constatări colaterale — consemnate, nereparate.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. UN SINGUR fișier de producție: `public/js/semdoc-initiator/main.js`.
- Zero server, zero migrații, `CACHE_VERSION` neatins.
- `core.js` și `formular/alop.js` NEATINSE.
- Nicio cale nu lasă tabelul de semnatari gol.
- `git add` explicit.
- `old_str` care nu se potrivește exact ⇒ **OPREȘTE-TE și raportează**.
