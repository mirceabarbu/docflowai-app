---
prompt: 172
titlu: "Prefill ALOP: setul complet de roluri + butonul de lansare gardat pe semnatari completați"
model_suggested: "Sonnet 5, efort high"
branch: develop
versiune_curenta: v3.9.825
versiune_tinta: v3.9.826
migratii: NU
fisiere_din_public: DA  (⇒ bump `?v=` ȚINTIT pe cele două assete atinse; CACHE_VERSION — vezi Etapa 0)
zona_no_touch_atinsa: NU
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Nu propune și nu executa `checkout`/`merge`/`push` pe `main`.
Pasul final obligatoriu: `git push origin develop`.

---

## Context — două defecte care se compun

### Defectul 1: prefill-ul ALOP ȘTERGE rândurile, nu le completează

Când utilizatorul lansează un flux dintr-un dosar ALOP („Completează DF" / „Generează PDF +
Lansează flux ORD"), `formular/alop.js:1428` construiește lista de prefill așa:

```js
const prefillSigners=(semnatari||[])
  .filter(s=>s.user_id||s.same_as_initiator)
  .map(s=>({ name:…, rol:ALOP_ROL[s.role]||'SEMNAT', functie:… }));
```

iar `semdoc-initiator/main.js:1650` o aplică prin:

```js
_alTbody.innerHTML = "";
window._alopPrefillSigners.forEach(s => _alTbody.appendChild(signerRowTemplate(s)));
```

**Măsurat pe producție (03.09.2026): toate cele 150 de dosare active au EXACT 1 semnatar cu
`user_id` din 6 roluri.** Cauza: `alop_sabloane` e GOL, deci dosarul se creează din
`DF_DEFAULT_SEMNATARI` (6 roluri, toate cu `user_id: null`), iar `alop.mjs:557` ștampilează
`user_id` doar pe rândul `initiator`, din actorul autentificat.

Consecință: filtrul lasă un singur rând, iar aplicarea **golește tabelul** și pune acel rând.
Prefill-ul nu completează nimic — șterge rolurile implicite și lasă doar ÎNTOCMIT.

### Defectul 2: butonul de lansare NU verifică semnatarii

`validateForm()` (`semdoc-initiator/main.js:149-170`) verifică exact două condiții:

```js
const valid = hasPdf && hasProvider;
```

Rândurile de semnatari nu intră deloc în ea. Utilizatorul apasă, iar SERVERUL respinge
(`crud.mjs:84-88`, `signer_name_required` / `signer_email_invalid` cu un index). Deci eroarea
apare abia la clic, ca un cod cu un număr, nu ca un indiciu despre ce rând lipsește.

Cele două împreună explică fluxurile pornite cu un singur semnatar.

## Decizia de produs (Mircea, 03.09.2026)

1. Prefill-ul trimite **setul COMPLET de roluri** din șablonul dosarului (6 la DF, 4 la ORD),
   cu numele gol acolo unde nu se știe cine e.
2. Butonul de lansare se dezactivează cât timp există rânduri fără persoană, cu un `title`
   care spune **care rând** și **ce atribut**.
3. Rândurile pot fi șterse dacă un rol nu se aplică documentului curent.

---

## Fapte VERIFICATE pe cod — folosește-le, nu le redescoperi

- ✅ **Punctul 3 e deja implementat.** `signerRowTemplate` (`main.js:630`) pune pe FIECARE rând
  `<button class="df-action-btn danger sm btnDel">Șterge</button>`, cu handler la `:649`
  (`tr.remove(); refreshAllDropdowns?.()`). Rândurile din prefill trec prin aceeași funcție,
  deci sunt ștergibile. **NU adăuga nimic pentru punctul 3** — doar confirmă în raport că ai
  verificat, și acoperă-l cu un caz de test.
- ✅ Toate cele 6 atribute produse de `ALOP_ROL` (`ÎNTOCMIT`, `VIZAT`, `VERIFICAT`,
  `VIZĂ ECONOMICĂ`, `APROBAT`, `VIZĂ CFPP`) EXISTĂ în `window.DFAtribute.LIST`
  (`public/js/shared/atribute.js`, #168). Deci `tr.querySelector(".rol").value = s.rol` se
  aplică corect pentru toate. Nu e nevoie de nicio extindere a listei de atribute.
- ⚠️ **`MutationObserver` NU vede schimbarea unui `<select>`.** Cel de la `main.js:869`
  observă `{ childList: true, subtree: true }` — se declanșează la adăugarea/ștergerea de
  rânduri, **nu** când utilizatorul alege o persoană din dropdown. Fără Etapa C, butonul ar
  rămâne dezactivat după ce omul completează tabelul ⇒ blocaj total. **Etapa C nu e opțională.**
- ⚠️ `refreshAllDropdowns` (`main.js:507-529`) restaurează selecția după **email**
  (`currentOpt.dataset.email`), nu după nume. Un rând de prefill are în `.name-select` doar
  opțiunea placeholder în momentul creării, deci `sel.value = s.name` nu prinde. **De aceea
  acest lot NU încearcă să aducă PERSOANA din șablon** — doar rolurile. Aducerea persoanei
  cere rezolvarea `user_id → email` din `window._dbUsers` și selecție după email; e sarcina
  lotului #173, când șabloanele devin configurabile. Scrie asta în comentariu, ca următoarea
  sesiune să nu creadă că e o scăpare.
- ℹ️ Rândul ÎNTOCMIT se auto-completează din câmpurile inițiatorului (`syncIntocmit`,
  `main.js:651`) și e forțat pe actorul autentificat de server (v3.9.609). Deci ÎNTOCMIT rămâne
  completat și după schimbarea de la Etapa A.

---

## ⛔ Ce NU se atinge

- **NU** atinge `alop.js:787` (`const items=list.filter(u=>u.user_id||u.same_as_initiator)`).
  Filtrul e identic ca text, dar e alt scop: previzualizarea „semnatari configurați" din cardul
  ALOP, unde e CORECT să arăți doar cine e chiar configurat.
- **NU** schimba `ALOP_ROL`, `DF_DEFAULT_SEMNATARI`, `ORD_DEFAULT_SEMNATARI` sau validarea
  „6 roluri / 4 roluri" din `alop.mjs`. Configurarea șabloanelor e lotul #173.
- **NU** atinge nimic pe server. Acest lot e strict frontend.
- **NU** slăbi validările din `crud.mjs:84-88` — garda de client se ADAUGĂ peste ele, nu le
  înlocuiește.
- **NU** atinge `updateIntocmitVisibility` și nici `syncIntocmit`.

---

## ETAPA 0 — ancore (READ-ONLY)

```bash
cd "$(git rev-parse --show-toplevel)"
git branch --show-current                                   # Așteptat: develop
node -e "console.log(require('./package.json').version)"     # Așteptat: 3.9.825

grep -c "filter(s=>s.user_id||s.same_as_initiator)" public/js/formular/alop.js
# Așteptat: 1   (cel din mkFlow; cel de la :787 are alt text — `u`, nu `s`)

grep -n "const valid = hasPdf && hasProvider;" public/js/semdoc-initiator/main.js
# Așteptat: 1 linie

grep -n "formular/alop.js?v=" public/*.html
grep -n "semdoc-initiator/main.js?v=" public/*.html
# Notează valorile CURENTE — NU le presupune din package.json (driftul e intenționat)

grep -n "js/formular/alop.js\|js/semdoc-initiator/main.js" public/sw.js
# Așteptat: 0 linii ⇒ niciunul nu e în PRECACHE_ASSETS ⇒ CACHE_VERSION NU se atinge
```

Dacă vreo ancoră nu se potrivește, **OPREȘTE-TE** și raportează.

---

## ETAPA A — prefill-ul trimite toate rolurile (`public/js/formular/alop.js`)

`old_str`
```js
        const prefillSigners=(semnatari||[])
          .filter(s=>s.user_id||s.same_as_initiator)
          .map(s=>({
            name:s.same_as_initiator?initiatorName:(s.name||''),
            rol:ALOP_ROL[s.role]||'SEMNAT',
            functie:s.functie||''
          }));
```

`new_str`
```js
        // #172 — SETUL COMPLET de roluri, nu doar cele cu persoană atribuită.
        // Înainte exista `.filter(s=>s.user_id||s.same_as_initiator)`. Cum `alop_sabloane`
        // e gol, iar `alop.mjs` ștampilează `user_id` DOAR pe rândul `initiator`, filtrul
        // lăsa un singur rând — iar aplicarea din semdoc-initiator GOLEȘTE tabelul înainte
        // să-l pună. Rezultat: prefill-ul ștergea rolurile implicite în loc să le completeze.
        // Acum trimitem toate rolurile șablonului, cu numele gol unde nu se știe cine e;
        // utilizatorul completează persoanele, iar rândurile care nu se aplică documentului
        // se șterg cu butonul „Șterge" al rândului.
        // ⛔ NU aduce PERSOANA din șablon aici: `refreshAllDropdowns` restaurează selecția
        //    după EMAIL, iar șablonul ține `user_id`+`name`. Aducerea persoanei cere
        //    rezolvarea user_id→email din `_dbUsers` și selecție după email — lotul #173.
        const prefillSigners=(semnatari||[])
          .map(s=>({
            name:s.same_as_initiator?initiatorName:(s.name||''),
            rol:ALOP_ROL[s.role]||'SEMNAT',
            functie:s.functie||''
          }));
```

---

## ETAPA B — butonul de lansare vede semnatarii (`public/js/semdoc-initiator/main.js`)

`old_str`
```js
        const hasProvider = !!_selectedProvider;
        const valid = hasPdf && hasProvider;
        btn.disabled = !valid;
        btn.style.opacity = valid ? "1" : "0.4";
        if (!hasPdf)           btn.title = "Încarcă mai întâi PDF-ul";
        else if (!hasProvider) btn.title = "Alege metoda de semnare";
        else                   btn.title = "";
```

`new_str`
```js
        const hasProvider = !!_selectedProvider;
        // #172 — al treilea criteriu: fiecare rând de semnatar trebuie să aibă o persoană.
        // Înainte butonul era activ cu rânduri goale, iar refuzul venea de la SERVER
        // (`crud.mjs`, `signer_name_required` cu un index) abia după clic. Cu prefill-ul
        // care aduce acum setul complet de roluri, rândurile necompletate sunt REGULA la
        // pornirea unui flux din ALOP ⇒ garda trebuie să fie vizibilă înainte de clic.
        // ⛔ Aceasta e o gardă de UX. Validările din `crud.mjs` rămân sursa de adevăr.
        const _randuri = [...tbody.querySelectorAll("tr")];
        const _incomplet = _randuri.find(tr => {
          const _sel = tr.querySelector(".name-select");
          const _nume = (_sel ? _sel.value : tr.querySelector(".name")?.value) || "";
          return !_nume.trim();
        });
        const hasSigners = _randuri.length > 0 && !_incomplet;
        const valid = hasPdf && hasProvider && hasSigners;
        btn.disabled = !valid;
        btn.style.opacity = valid ? "1" : "0.4";
        if (!hasPdf)           btn.title = "Încarcă mai întâi PDF-ul";
        else if (!hasProvider) btn.title = "Alege metoda de semnare";
        else if (!_randuri.length) btn.title = "Adaugă cel puțin un semnatar";
        else if (_incomplet) {
          const _poz = _randuri.indexOf(_incomplet) + 1;
          const _rolSel = _incomplet.querySelector(".rol");
          const _rol = (_rolSel && _rolSel.value === "__alt__")
            ? (_incomplet.querySelector(".rolCustom")?.value || "").trim()
            : (_rolSel ? _rolSel.value : "");
          btn.title = `Rândul ${_poz}${_rol ? " (" + _rol + ")" : ""}: alege persoana sau șterge rândul`;
        }
        else                   btn.title = "";
```

⚠️ Verifică în Etapa 0 că `tbody` e vizibil în domeniul lexical al lui `validateForm`
(`main.js:149`). Dacă NU e, oprește-te și raportează — nu introduce un `document.getElementById`
nou fără să spui.

---

## ETAPA C — `validateForm` se reevaluează la alegerea persoanei

`MutationObserver`-ul de la `main.js:869` NU vede schimbarea valorii unui `<select>`.
Fără această etapă, butonul rămâne blocat după ce utilizatorul completează tabelul.

Adaugă IMEDIAT DUPĂ linia observatorului existent:

`old_str`
```js
      // Watch for DOM changes in tbody
      new MutationObserver(() => { updateIntocmitVisibility(); validateForm(); }).observe(tbody, { childList: true, subtree: true });
```

`new_str`
```js
      // Watch for DOM changes in tbody
      new MutationObserver(() => { updateIntocmitVisibility(); validateForm(); }).observe(tbody, { childList: true, subtree: true });

      // #172 — MutationObserver-ul de mai sus vede DOAR adăugarea/ștergerea de rânduri.
      // Alegerea unei persoane într-un `<select>` NU e o mutație DOM ⇒ fără delegarea de mai
      // jos, garda de la `validateForm` ar rămâne blocată după ce utilizatorul completează
      // tabelul. Delegare pe tbody (nu pe fiecare rând), ca rândurile create ulterior să fie
      // acoperite automat.
      tbody.addEventListener("change", (e) => {
        if (e.target && e.target.closest("tr")) validateForm();
      });
      tbody.addEventListener("input", (e) => {
        if (e.target && e.target.classList && e.target.classList.contains("rolCustom")) validateForm();
      });
```

---

## ETAPA D — teste

Fișier nou: `server/tests/unit/prefill-alop-roluri.test.mjs`, pe modelul testelor de analiză
statică existente (ex. `server/tests/unit/reopen-button-render.test.mjs`), care citesc sursa
din `public/js` și asertează pe formă.

Cazuri obligatorii:

1. ⭐ `public/js/formular/alop.js` NU mai conține `filter(s=>s.user_id||s.same_as_initiator)`
   (aserțiunea se scrie pe forma cu `s`, ca să nu se auto-potrivească pe cea cu `u` de la
   `:787`, care trebuie să RĂMÂNĂ — al doilea caz de test verifică prezența ei).
2. `alop.js:787` (`filter(u=>u.user_id||u.same_as_initiator)`) există în continuare — exact 1
   apariție. Previzualizarea din cardul ALOP nu s-a atins.
3. Toate valorile din `ALOP_ROL` sunt incluse în `DFAtribute.LIST` din
   `public/js/shared/atribute.js` (parsare a ambelor fișiere; test de acord între vocabulare,
   care va cădea dacă cineva adaugă în viitor un rol fără atribut corespondent).
4. ⭐ `validateForm` conține `hasSigners` în expresia lui `valid` — garda nu poate fi scoasă
   tăcut la un refactor.
5. `main.js` conține delegarea `tbody.addEventListener("change"` — Etapa C nu poate fi omisă.
6. `signerRowTemplate` conține în continuare `btnDel` și `tr.remove()` — rândurile rămân
   ștergibile (punctul 3 al deciziei, verificat ca invariant, nu implementat).

```bash
node --check public/js/formular/alop.js
node --check public/js/semdoc-initiator/main.js
npx vitest run server/tests/unit/prefill-alop-roluri.test.mjs
npm test
npm run test:db
```

`npm test` și `npm run test:db` verzi, fără regresii. Raportează numerele obținute.

⚠️ Rulează și `grep -c "validateForm()" public/js/semdoc-initiator/main.js` ÎNAINTE și DUPĂ,
și raportează ambele valori — nu asertez o cifră aici tocmai fiindcă apelurile existente sunt
multe și numărul se schimbă cu Etapa C.

---

## ETAPA E — versiune și cache busting

1. `package.json`: `3.9.825` → `3.9.826`.
2. `CACHE_VERSION` din `public/sw.js` **NU se atinge** — niciunul dintre cele două fișiere nu
   e în `PRECACHE_ASSETS` (confirmat în Etapa 0).
3. Bump `?v=` **ȚINTIT, pe cele două assete atinse**, folosind valorile CITITE în Etapa 0 ca
   punct de plecare (⛔ nu presupune valoarea veche din `package.json` — driftul e intenționat):

```bash
NEW=3.9.826
sed -i -E "s#(js/formular/alop\.js\?v=)[0-9.]+#\1$NEW#g" public/*.html
sed -i -E "s#(js/semdoc-initiator/main\.js\?v=)[0-9.]+#\1$NEW#g" public/*.html

# Verificare OBLIGATORIE după sed (un `?v=` corupt nu pică niciun test și ajunge în producție):
grep -n "formular/alop.js?v=\|semdoc-initiator/main.js?v=" public/*.html
grep -c "<script" public/formular.html public/semdoc-initiator.html
```

⛔ Grupul de captură se referă cu `\1`, NU `\g<1>` (sed nu cunoaște sintaxa Python — a corupt
o linie `<script>` la PAGIN-6). ⛔ NU face bulk-sed pe toate `?v=`.

4. `git add` explicit: cele două fișiere JS, cele două HTML, testul nou, `package.json`.
   **Niciodată `git add -A`.**
5. Commit:
   ```
   fix(#172): prefill ALOP trimite setul complet de roluri + garda pe semnatari — v3.9.826

   Filtrul pe user_id lasa un singur rand (sablonul e gol, doar initiator
   primeste user_id la creare), iar aplicarea goleste tbody-ul inainte sa-l
   puna => prefill-ul stergea rolurile implicite in loc sa le completeze.
   Acum trimite toate rolurile sablonului, cu numele gol unde nu se stie.
   In plus, butonul de lansare se dezactiveaza cat timp un rand nu are
   persoana, cu title care numeste randul si atributul (inainte refuzul
   venea de la server, dupa clic, ca un cod cu index).
   ```
6. `git push origin develop`

---

## RAPORT FINAL — obligatoriu

1. Ancorele din Etapa 0, cu valorile OBȚINUTE (inclusiv `?v=` vechi pentru ambele assete).
2. A fost `tbody` vizibil în domeniul lui `validateForm`? Dacă nu, ce ai făcut.
3. Rezultatul fiecărui caz de test, cu accent pe 1, 2 și 4.
4. `grep -c "validateForm()"` înainte și după.
5. Numerele reale de la `npm test` și `npm run test:db`, plus dacă `test:db` a rulat REAL.
6. Ieșirea verificării `grep` de după `sed` — integritatea liniilor `<script>`.
7. Orice test preexistent atins: care, de ce, de ce nu e o slăbire.
8. Orice divergență prompt↔cod. Nu o repara tăcut.
9. Constatări colaterale — doar consemnate, NU reparate.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. `main` nu se atinge.
- Zero fișiere pe server. Zero migrații.
- `CACHE_VERSION` neatins. `?v=` bump ȚINTIT pe cele două assete.
- `alop.js:787` rămâne NESCHIMBAT.
- `git add` explicit pe căile sarcinii.
- `old_str` care nu se potrivește exact ⇒ **OPREȘTE-TE și raportează**.
