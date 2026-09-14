---
prompt: 172b
titlu: "Cursa de inițializare: implicitele nu mai șterg prefill-ul ALOP"
model_suggested: "Sonnet 5, efort high"
branch: develop
versiune_curenta: v3.9.826
versiune_tinta: v3.9.827
migratii: NU
fisiere_din_public: DA  (UN singur fișier JS ⇒ bump `?v=` țintit; CACHE_VERSION — vezi Etapa 0)
zona_no_touch_atinsa: NU
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Pasul final obligatoriu: `git push origin develop`.

---

## Context — defect REPRODUS pe staging (03.09.2026, v3.9.826)

După #172, lansarea unui flux dintr-un dosar ALOP a afișat **cele trei rânduri implicite ale
ecranului** (`ÎNTOCMIT/Inspector`, `VIZAT/Șef structură`, `APROBAT/Conducător`) în loc de cele
6 roluri ale dosarului. Semnătura e inconfundabilă — sunt exact valorile hardcodate din
`setDefaults()` (`public/js/semdoc-initiator/main.js:762-771`).

### Cauza: TREI blocuri scriu în același `tbody`, fără nicio coordonare

| # | loc | când | ce face |
|---|---|---|---|
| 1 | `handleUrlParams()` (~`:2409`) | **sincron**, la load | citește `docflow_prefill_signers`, îl pune în `window._alopPrefillSigners`, îl șterge din sessionStorage |
| 2 | `loadDbUsers()` (~`:1637`) | **async**, după `/users` | **golește `tbody`** și pune rândurile de prefill |
| 3 | „Default load" (~`:1876`) | **async**, după `restoreFormState()` | dacă nu s-a restaurat nimic: `setDefaults()`, care **golește `tbody`** și pune cele 3 implicite |

Blocurile 2 și 3 nu se cunosc între ele. **Cine termină ultimul câștigă.** Când
`restoreFormState()` (IndexedDB, local) se încheie după `/users` (rețea), implicitele șterg
prefill-ul. Asta s-a întâmplat pe staging.

⚠️ **Cursa e PREEXISTENTĂ**, nu introdusă de #172. Înainte prefill-ul aducea un singur rând,
deci diferența dintre cele două rezultate era aproape invizibilă. Cu 6 rânduri se vede imediat.

---

## Decizia de proiectare — de ce NU e destul „sari peste `setDefaults()`"

Varianta evidentă (`if (!_restored && !window._alopPrefillSigners?.length) setDefaults();`)
rezolvă o singură ordine și **introduce un mod de eșec nou**: dacă `/users` eșuează, blocul 2
nu mai rulează niciodată, prefill-ul rămâne neaplicat, iar tabelul rămâne **complet gol** —
mai rău decât bugul reparat.

Soluția: **o singură funcție idempotentă**, `applyAlopPrefill()`, chemată din AMBELE locuri.
Prima care ajunge aplică rândurile și ridică un steag; a doua vede steagul și nu face nimic.
`setDefaults()` rulează doar când nu există nici stare restaurată, nici prefill (nici în
așteptare, nici aplicat deja). Ambele ordini se termină identic, iar dacă `/users` cade,
rândurile există oricum — se populează dropdown-urile mai târziu, la `_refreshDbUsers`.

---

## ⛔ Ce NU se atinge

- **NU** modifica `setDefaults()` însuși — cele 3 rânduri rămân exact cum sunt, pentru calea
  „Flux nou" fără ALOP.
- **NU** atinge `handleUrlParams()` (blocul 1). Citirea și stocarea prefill-ului sunt corecte.
- **NU** atinge `restoreFormState`, `saveFormState`, `refreshAllDropdowns`,
  `updateIntocmitVisibility`, `signerRowTemplate`.
- **NU** atinge `public/js/formular/alop.js` — #172 e corect acolo, defectul e la consumator.
- **NU** atinge nimic pe server. Zero migrații.
- **NU** modifica testul `server/tests/unit/prefill-alop-roluri.test.mjs` creat la #172.

---

## ETAPA 0 — ancore (READ-ONLY)

```bash
cd "$(git rev-parse --show-toplevel)"
git branch --show-current                                  # Așteptat: develop
node -e "console.log(require('./package.json').version)"    # Așteptat: 3.9.826

grep -n "_alopPrefillSigners" public/js/semdoc-initiator/main.js
# Așteptat: 4 linii — citirea din handleUrlParams, condiția + forEach + resetul din loadDbUsers

grep -n "setDefaults();" public/js/semdoc-initiator/main.js
# Așteptat: 2 linii (butonul „Renunță" și blocul Default load)

grep -n "semdoc-initiator/main.js?v=" public/*.html      # notează valoarea CURENTĂ
grep -n "js/semdoc-initiator/main.js" public/sw.js       # Așteptat: 0 ⇒ CACHE_VERSION neatins
```

Dacă vreo ancoră nu se potrivește, **OPREȘTE-TE** și raportează.

---

## ETAPA A — funcția idempotentă

Inserează IMEDIAT DUPĂ funcția `setDefaults()`:

`old_str`
```js
        defaults.forEach(d => tbody.appendChild(signerRowTemplate(d)));
      }
```

`new_str`
```js
        defaults.forEach(d => tbody.appendChild(signerRowTemplate(d)));
      }

      // #172b — punct UNIC de aplicare a semnatarilor veniți dintr-un dosar ALOP.
      // Motivul existenței: trei blocuri scriau în același tbody fără să se cunoască —
      // handleUrlParams (sincron) stoca lista, loadDbUsers (după /users) o aplica, iar
      // blocul „Default load" (după restoreFormState) punea implicitele. Ultimul sosit
      // câștiga, deci pe staging implicitele au șters rândurile dosarului.
      // Funcția e IDEMPOTENTĂ: prima chemare aplică și ridică steagul, a doua nu face nimic.
      // Steagul e separat de listă tocmai ca blocul Default load să poată deosebi
      // „nu a existat niciodată prefill" de „a fost aplicat deja".
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

---

## ETAPA B — `loadDbUsers` deleagă în loc să aplice singur

`old_str`
```js
            // ALOP: aplică semnatari pre-configurați dacă există prefill în așteptare
            if (window._alopPrefillSigners?.length) {
              const _alTbody = $("signersTbody");
              if (_alTbody) {
                _alTbody.innerHTML = "";
                window._alopPrefillSigners.forEach(s => _alTbody.appendChild(signerRowTemplate(s)));
                refreshAllDropdowns?.();
              }
              window._alopPrefillSigners = null;
            }
```

`new_str`
```js
            // ALOP: aplică semnatari pre-configurați dacă există prefill în așteptare.
            // #172b — logica s-a mutat în applyAlopPrefill (punct unic, idempotent).
            applyAlopPrefill();
```

---

## ETAPA C — blocul „Default load" nu mai calcă peste prefill

`old_str`
```js
        const _restored = await restoreFormState();
        if (!_restored) {
          setDefaults();
        }
```

`new_str`
```js
        const _restored = await restoreFormState();
        // #172b — implicitele se pun DOAR dacă nu există nici stare restaurată, nici
        // semnatari veniți din dosar. Ordinea față de loadDbUsers e nedeterministă, de
        // aceea încercăm întâi aplicarea (idempotentă): dacă loadDbUsers a apucat deja,
        // steagul oprește o a doua aplicare; dacă /users e lent sau eșuează, rândurile
        // dosarului apar de aici și nu se mai pierd.
        const _prefillPus = applyAlopPrefill();
        if (!_restored && !_prefillPus && !window._alopPrefillApplied) {
          setDefaults();
        }
```

---

## ETAPA D — teste

Fișier NOU: `server/tests/unit/prefill-alop-cursa.test.mjs` (nu atinge fișierul de la #172),
pe modelul testelor de analiză statică din `server/tests/unit/reopen-button-render.test.mjs`.

⚠️ Filtrează liniile de comentariu înainte de aserțiuni — comentariile dictate mai sus conțin
intenționat numele funcțiilor și ar auto-potrivi numărătorile (lecția de la #124i și #172).

Cazuri obligatorii, pe sursa `public/js/semdoc-initiator/main.js`:

1. `function applyAlopPrefill()` — definită **exact o dată**.
2. ⭐ `applyAlopPrefill()` **apelată exact de două ori** în codul funcțional (o dată în
   `loadDbUsers`, o dată în blocul Default load).
3. ⭐ `setDefaults();` din blocul Default load e precedat, în aceeași instrucțiune `if`, de
   `!_prefillPus` **și** `!window._alopPrefillApplied` — garda nu poate fi înjumătățită.
4. `loadDbUsers` NU mai conține `_alTbody.innerHTML = ""` (aplicarea inline a dispărut);
   `innerHTML = ""` pe tbody rămâne în **exact două** locuri funcționale: `setDefaults` și
   `applyAlopPrefill`.
5. `window._alopPrefillApplied = true` apare exact o dată, în interiorul `applyAlopPrefill`.
6. `applyAlopPrefill` conține `validateForm()` — butonul se reevaluează după înlocuirea
   rândurilor (altfel garda de la #172 rămâne pe starea veche).
7. Regresie #172: `setDefaults` conține în continuare cele trei roluri
   (`ÎNTOCMIT`, `VIZAT`, `APROBAT`) — calea „Flux nou" fără ALOP e neatinsă.

```bash
node --check public/js/semdoc-initiator/main.js
npx vitest run server/tests/unit/prefill-alop-cursa.test.mjs
npx vitest run server/tests/unit/prefill-alop-roluri.test.mjs   # #172 trebuie să rămână verde
npm test
npm run test:db
```

---

## ETAPA E — versiune și cache busting

1. `package.json`: `3.9.826` → `3.9.827`.
2. `CACHE_VERSION` din `public/sw.js` **NU se atinge** (fișierul nu e în `PRECACHE_ASSETS`).
3. Bump `?v=` **doar pe assetul atins**:

```bash
NEW=3.9.827
sed -i -E "s#(js/semdoc-initiator/main\.js\?v=)[0-9.]+#\1$NEW#g" public/*.html
grep -n "semdoc-initiator/main.js?v=" public/*.html
grep -c "<script" public/semdoc-initiator.html
```

⛔ `\1`, nu `\g<1>`. ⛔ Fără bulk-sed pe alte `?v=`.

4. `git add` explicit: `public/js/semdoc-initiator/main.js`, `public/semdoc-initiator.html`,
   testul nou, `package.json`. **Niciodată `git add -A`.**
5. Commit:
   ```
   fix(#172b): implicitele nu mai sterg prefill-ul ALOP — v3.9.827

   Trei blocuri scriau in acelasi tbody fara coordonare: handleUrlParams
   stoca lista, loadDbUsers o aplica dupa /users, iar Default load punea
   implicitele dupa restoreFormState. Ultimul sosit castiga, deci pe
   staging cele 3 randuri implicite stergeau cele 6 roluri ale dosarului.
   Aplicarea devine un punct unic idempotent, chemat din ambele locuri;
   setDefaults ruleaza doar cand nu exista nici stare restaurata, nici
   prefill (in asteptare sau deja aplicat). Cursa era preexistenta.
   ```
6. `git push origin develop`

---

## RAPORT FINAL — obligatoriu

1. Ancorele din Etapa 0, cu valorile OBȚINUTE (inclusiv `?v=` vechi).
2. Numărul de linii `_alopPrefillSigners` înainte și după.
3. Rezultatul fiecărui caz de test, cu accent pe 2, 3 și 4.
4. Confirmă explicit: `setDefaults()` mai apare de câte ori în cod funcțional și în ce contexte.
5. Numerele reale de la `npm test` și `npm run test:db`; dacă `test:db` a rulat REAL.
6. Ieșirea `grep` de după `sed` — integritatea liniilor `<script>`.
7. Orice test preexistent atins: care și de ce. (Așteptat: NICIUNUL.)
8. Divergențe prompt↔cod — raportate, nu reparate tăcut.
9. Constatări colaterale — consemnate, nereparate.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. `main` nu se atinge.
- UN SINGUR fișier de producție atins: `public/js/semdoc-initiator/main.js`.
- Zero server, zero migrații, `CACHE_VERSION` neatins.
- Testul de la #172 rămâne NEMODIFICAT.
- `old_str` care nu se potrivește exact ⇒ **OPREȘTE-TE și raportează**.
