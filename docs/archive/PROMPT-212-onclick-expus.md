---
prompt: 212
titlu: "alopReiaPlata neexpusă la window + gardă statică pentru toate handlerele din onclick"
model_suggested: "Sonnet 5"
efort: medium
branch: develop
versiune_curenta: v3.9.864
versiune_tinta: v3.9.865
migratii: NU
scrieri_in_baza: NU
fisiere_din_public: DA ⇒ `?v=` ȚINTIT + verificare `CACHE_VERSION`
zona_no_touch_atinsa: NU
tip: bugfix (un rând) + plasă statică
---

# ⚠️ BRANCH

**EXCLUSIV `develop`**. Fără `checkout main`, `merge`, `push main`, deploy.
Final: **`git push origin develop`**, apoi **stop** și raportezi.

---

# CONTEXTUL

Butonul „Reia confirmarea plății" apare corect după #211, dar **la clic nu se întâmplă nimic**.

Cauza, verificată pe cod: `alop.js` e modul ES, iar `async function alopReiaPlata(id)`
(`:~1282`) rămâne în scopul modulului. Butonul o cheamă prin `onclick="alopReiaPlata('...')"`,
adică din contextul global, unde nu există. Clic ⇒ `ReferenceError` în consolă ⇒ nimic.

Fișierul are un bloc de export global la `:~1447-1481` cu **toate** funcțiile chemate din
`onclick` — mai puțin asta. Un rând uitat într-o listă de 30.

**Verificat exhaustiv:** dintre cele 14 handlere folosite în `onclick` în `alop.js`
(`alopDeschideDF`, `alopDeschideORD`, `alopEditTitlu`, `alopOrdCompleted`, `alopRefreshCurrent`,
`alopReiaPlata`, `alopRevizuiesteDF`, `alopSaveTitlu`, `cancelAlop`, `openAlop`,
`openAlopConfirmLichidare`, `openAlopConfirmPlata`, `openOpmeLinesForAlop`, `startNouaLichidare`),
**doar `alopReiaPlata`** lipsește din blocul de export.

## De ce lotul are și o a doua parte

E al patrulea lucru la rând care „nu apare / nu funcționează" pe același flux introdus la #209:
`can_accept` fără admin (#210), poarta rutei fără admin (#210), `can_reia_plata` fără admin
(#211), iar acum funcția neexpusă. **Toate tăcute. Niciuna prinsă de cele 1251 de teste db.**

Motivul e structural: suita testează serverul, nu legarea butoanelor. Nu construim testare de
browser aici — dar un test **static**, care citește sursa, ar fi prins exact bugul ăsta în
milisecunde.

---

# ETAPA 0 — ancore

```bash
grep -n "alopReiaPlata" public/js/formular/alop.js
# Așteptat: 2 apariții — definiția (~1282) și onclick-ul din HTML (~793). Niciun window.

grep -n "window.openOpmeLinesForAlop" public/js/formular/alop.js
# Ultima linie din blocul de export global — ancora pentru inserare.

grep -n "alop.js?v=" public/formular.html
grep -c "formular/alop.js" public/sw.js
# ⚠️ La #207 presupunerea că fișierele nu sunt în PRECACHE s-a dovedit GREȘITĂ.
#    Verifică prin grep, raportează dovada.
```

---

# ETAPA A — reparația (un rând)

În blocul de export global, **lângă celelalte**, păstrând alinierea coloanelor:

`old_str`:
```js
  window.openOpmeLinesForAlop       = openOpmeLinesForAlop;
```
`new_str`:
```js
  window.openOpmeLinesForAlop       = openOpmeLinesForAlop;
  window.alopReiaPlata              = alopReiaPlata;
```

⚠️ Dacă `old_str` nu e unic, lărgește cu linia dinainte. **Nu muta și nu reordona** restul
blocului — un diff de 30 de linii ar ascunde singura schimbare reală.

⛔ Nu atinge corpul funcției, `onclick`-ul, sau vreo altă funcție.

---

# ⭐ ETAPA B — plasa statică

`server/tests/unit/onclick-handlers-expuse.test.mjs` (nou). Test pur static: citește fișierele
sursă din `public/js/`, nu pornește browser, nu execută JS.

**Ce face:**

1. Pentru fiecare fișier din `public/js/` (recursiv), extrage numele de funcții invocate din
   atribute `onclick=`, `onchange=`, `oninput=`, `onsubmit=`, `onkeyup=`, `onkeydown=`,
   `onblur=`, `onfocus=` — atât în HTML-ul generat prin template string, cât și în `public/*.html`.
2. Pentru fiecare nume găsit, verifică să existe **fie** `window.<nume> =` **fie**
   `window.<nume>=` în vreun fișier din `public/js/`, **fie** ca proprietate a unui obiect deja
   global (ex. `DFOpmeReportDrawer.open` — vezi punctul 4).
3. ⭐ Eșuează cu lista completă a celor negăsite, grupate pe fișier, cu mesaj explicativ:
   „Handler chemat din `onclick` dar neexpus la `window`. În module ES, funcțiile rămân în scopul
   modulului; clicul dă `ReferenceError` tăcut. Vezi #212."

**Reguli de construcție — citește-le, altfel testul e inutil sau enervant:**

⚠️ **Extrage doar numele funcției, nu expresia.** `onclick="alopReiaPlata('${id}')"` ⇒
`alopReiaPlata`. Expresii ca `onclick="event.stopPropagation()"`,
`onclick="this.classList.toggle('x')"`, `onclick="return false"` sau apelurile pe obiect
(`onclick="DFPagin.go(2)"`) **nu** sunt nume simple de funcție globală — le ignori sau, pentru
cele pe obiect, verifici doar rădăcina (`DFPagin`).

⚠️ **Ignoră apelurile inline fără identificator** și cuvintele-cheie (`return`, `this`, `event`,
`window`, `document`, `alert`, `confirm`, `console`).

⚠️ ⭐ **Rulează testul pe codul ACTUAL înainte de reparația din Etapa A** (stash) și vezi câte
eșecuri dă. Așteptat: **exact unul** — `alopReiaPlata`. Dacă dă mai multe, **oprește-te și
raportează lista** — sunt alte bug-uri de aceeași natură, pe alte ecrane, și le tratăm separat,
nu le repari aici.

⚠️ Dacă apar **fals-pozitive** (handlere expuse altfel decât prin `window.X =`, sau definite în
HTML inline), **nu slăbi testul cu o listă de excepții lungă** — raportează-le și decidem
împreună. O gardă cu douăzeci de excepții nu mai apără nimic.

4. Dacă un handler e expus prin altă formă (`Object.assign(window, {...})`, `globalThis.X`),
   testul trebuie s-o recunoască. Verifică ce forme există efectiv în `public/js/` înainte de a
   scrie regexul.

---

# ETAPA C — verificare manuală cerută în raport

După reparație, confirmă prin citirea codului (nu presupunere):

5. Blocul de export global conține acum **toate** cele 14 handlere din `onclick` din `alop.js`.
6. Testul din Etapa B **trece** pe codul reparat și **pică** pe cel nereparat, cu exact un eșec.

---

# ETAPA D — teste

```bash
npm test
npm run test:db
```

⚠️ **Secvențial.** Verdictul din **output real**, niciodată dintr-un sumar de fundal.
`skipped` ≠ `passed`.

⛔ Test preexistent care pică ⇒ **raportează ÎNAINTE de a-l atinge.** (Așteptat: niciunul —
lotul adaugă un rând și un fișier de test.)

---

# ETAPA E — versiune, cache, commit

```bash
npm version 3.9.865 --no-git-tag-version
npm install --package-lock-only
git status --short
```

**`?v=` ȚINTIT** pe `formular/alop.js` în `public/formular.html`. ⛔ Fără `sed` în masă.
**`CACHE_VERSION`** doar dacă `alop.js` e în `PRECACHE_ASSETS` — ancora din Etapa 0 îți spune.
Raportează decizia **și dovada prin grep**.

`git add` explicit. Arhivează promptul în `docs/archive/`, în același commit.

⭐ Dacă `docs/plati-transe-conturi-diferite.md` a apărut în repo, adaugă-l. Dacă tot lipsește,
spune-o în raport — e a treia oară când se semnalează.

```
fix(#212): alopReiaPlata expusa la window + garda statica pentru handlerele onclick — v3.9.865

Butonul „Reia confirmarea platii" aparea dupa #211 dar la clic nu se intampla
nimic: alop.js e modul ES, functia ramanea in scopul modulului, iar
onclick="alopReiaPlata(...)" o cauta pe window. ReferenceError tacut.

Blocul de export global avea toate cele 14 handlere din onclick, mai putin
acesta. Un rand uitat.

Al patrulea esec tacut la rand pe fluxul introdus la #209 (can_accept fara
admin, poarta rutei fara admin, can_reia_plata fara admin, functia neexpusa),
si niciunul prins de cele 1251 de teste db — suita testeaza serverul, nu
legarea butoanelor. De aceea lotul adauga un test STATIC care citeste sursa si
verifica pentru fiecare handler chemat din onclick ca exista window.<nume> =.
Pe codul nereparat, testul pica exact o data.
```

```bash
git push origin develop
```

**Stop.**

---

# RAPORT FINAL

1. Ancorele Etapa 0, cu valorile **OBȚINUTE**.
2. ⭐ Câte eșecuri dă testul din Etapa B pe codul **nereparat**. (Așteptat: exact 1. Dacă sunt mai
   multe, **lista completă**, fără să le repari.)
3. Ce forme de expunere globală recunoaște testul și cum le-ai determinat.
4. Fals-pozitive întâlnite și cum le-ai tratat. (Excepții multe ⇒ raportează, nu le adăuga.)
5. Confirmarea de la Etapa C, punctele 5 și 6.
6. Decizia `CACHE_VERSION` + dovada prin grep + lista `?v=`.
7. Numere reale, secvențial, cu sursa verdictului declarată.
8. Teste preexistente atinse. (Așteptat: niciunul.)
9. Dacă documentul din `docs/` era prezent.
10. Divergențe prompt ↔ cod — **raportate, NU reparate tăcut**.
11. Colaterale.

---

# ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Fără `main`, merge, deploy.
- Etapa A e **un singur rând adăugat**. Fără reordonări, fără curățenie în blocul de export.
- Testul din Etapa B **nu** primește o listă lungă de excepții. Dacă are nevoie de ele,
  **raportează** în loc să o scrii.
- Alte handlere neexpuse găsite de test: **raportate, NU reparate** în lotul ăsta.
- `?v=` țintit pe `alop.js`. Fără `sed` în masă.
- `git add` explicit. `git push origin develop`, apoi **stop**.
- `old_str` care nu se potrivește exact o dată ⇒ **OPREȘTE-TE și raportează**.
