---
prompt: 90
titlu: "Contor de documente în antetul listei DF / ORD"
branch: develop
model_suggested: "Sonnet 4.6 (Default) — pur frontend, 2 fișiere, zero server"
depinde_de: prompt 89 (v3.9.674, commit 4900b37, CI verde)
fisiere_atinse:
  - public/formular.html
  - public/css/formular/formular.css
  - public/js/formular/list.js
  - public/sw.js                    (DOAR dacă list.js e în PRECACHE_ASSETS)
  - package.json
  - package-lock.json
versiune: 3.9.674 → 3.9.675
---

# ⚠️ BRANCH: `develop` — EXCLUSIV. `main` = PRODUCȚIE, manual, doar Mircea.

=====================================================================
## CONTEXT
=====================================================================

Listele DF și ORD nu arată nicăieri **câte documente sunt în listă**. Adăugăm un contor discret
în antetul listei.

### ⭐ DF și ORD folosesc ACEEAȘI listă

`loadList()` (`public/js/formular/list.js:442`) construiește `/api/formulare/list?type=` +
`_lstState.type`, iar `switchListTab()` doar schimbă tipul. **Un singur `#lst-tbody`, un singur
`lst-tabs-hdr`, un singur renderer.** ⇒ **un singur contor acoperă automat ambele.** Nu duplica nimic.

### Datele există deja — zero cod pe server

```js
const j     = await r.json();
const rows  = j.rows  || [];
const total = j.total || 0;          // ← deja aici, folosit doar pentru paginare
_renderLstPagin(total, _lstState.page, _lstState.limit);
```

`total` respectă deja semantica de vizibilitate: `user` primește totalul documentelor **lui**
(filtrate pe implicare + compartiment), `org_admin` pe cel al **organizației**, `admin` pe **tot
sistemul**. **Nu afișăm „X din Y"** — doar câte sunt în listă. *(Decizie de produs, luată. Un „X din
Y" i-ar dezvălui unui `user` câte documente există la care NU are acces.)*

### ⛔ `total`, NU `rows.length`

`rows` e **doar pagina curentă** (`limit` elemente). Cu 83 de documente și limita 20,
`rows.length` = 20 — contorul ar minți. **Folosește `j.total`.**

=====================================================================
## PAS 0 — Precondiții
=====================================================================

```bash
git status --short
git switch develop
git pull --ff-only origin develop
test "$(node -p "require('./package.json').version")" = "3.9.674" || { echo "STOP"; exit 1; }
git log --oneline -1                       # Așteptat: 4900b37
grep -n "CACHE_VERSION = " public/sw.js    # Așteptat: 'docflowai-v286'
```

=====================================================================
## PAS 1 — `public/formular.html`: elementul din antet
=====================================================================

`.lst-tabs-hdr` (linia ~169) are deja
`display:flex; align-items:flex-end; justify-content:space-between` (`formular.css:187`) și conține
**un singur copil**: butonul `#btn-lst-nou`, care e **permanent ascuns**
(`style="display:none !important"` inline, fără niciun JS care să-l reactiveze).

⛔ **NU șterge butonul `#btn-lst-nou`.** E cod mort, dar ștergerea lui nu aduce nimic și amestecă
o curățenie într-un prompt de feature. **Lasă-l exact cum e.** `newDocFromList()` rămâne folosită
programatic din `alop.js` (5 apelanți) — nu o atinge.

`old_str`:
```html
  <div class="lst-tabs-hdr">
    <!-- df-subtabs mutat în banda unică sus (HOTFIX 3.2.1) -->
    <button id="btn-lst-nou" class="df-action-btn primary" style="display:none !important" onclick="newDocFromList()"><svg class="df-ic"><use href="/icons.svg?v=3.9.539#ico-plus"/></svg>Document nou</button>
  </div>
```

`new_str`:
```html
  <div class="lst-tabs-hdr">
    <!-- df-subtabs mutat în banda unică sus (HOTFIX 3.2.1) -->
    <!-- Contor documente — același element pentru DF și ORD (partajează loadList/_lstState.type) -->
    <div class="lst-count" id="lst-count" hidden>
      <span class="lst-count-n" id="lst-count-n"></span><span class="lst-count-w" id="lst-count-w"></span>
    </div>
    <button id="btn-lst-nou" class="df-action-btn primary" style="display:none !important" onclick="newDocFromList()"><svg class="df-ic"><use href="/icons.svg?v=3.9.539#ico-plus"/></svg>Document nou</button>
  </div>
```

⚠️ Cele două `<span>`-uri sunt lipite (fără spațiu între tag-uri) — spațierea o dă CSS-ul (`gap`),
nu un caracter în HTML.

=====================================================================
## PAS 2 — `public/css/formular/formular.css`: stilul
=====================================================================

Inserează **imediat după** regula `.lst-tabs-hdr` (linia ~187):

`old_str`:
```css
    .lst-tabs-hdr{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px}
```
`new_str`:
```css
    .lst-tabs-hdr{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px}
    /* Contor documente (DF + ORD) — reflectă `total` din răspunsul serverului, deci filtrele active */
    .lst-count{display:flex;align-items:baseline;gap:5px;font-size:13px;color:var(--df-text-3)}
    .lst-count[hidden]{display:none}
    .lst-count-n{color:var(--df-text);font-weight:600}
```

⚠️ `.lst-count[hidden]{display:none}` e **obligatoriu**: `display:flex` ar învinge atributul
`hidden`, iar contorul ar rămâne vizibil când n-ar trebui.

⚠️ Verifică în `public/css/df/tokens.css` că `--df-text` și `--df-text-3` există (ar trebui:
`#e8eeff` și `#8d9cc7`). Dacă nu, folosește tokenii reali și **raportează**.

=====================================================================
## PAS 3 — `public/js/formular/list.js`: setarea contorului
=====================================================================

### 3a. Helper — acordul numeralului în română

Adaugă **înaintea** lui `loadList()`:

```js
// Acordul numeralului în română: numeralele ≥ 20 cer „de", cu excepția celor ale căror
// ultime două cifre sunt între 1 și 19.
//   0  → „0 documente"      1   → „1 document"       19 → „19 documente"
//   20 → „20 de documente"  83  → „83 de documente"  100 → „100 de documente"
//   101 → „101 documente"   112 → „112 documente"    120 → „120 de documente"
function _lstCountLabel(n){
  if(n === 1) return ' document';
  const lastTwo = n % 100;
  const needsDe = n >= 20 && !(lastTwo >= 1 && lastTwo <= 19);
  return needsDe ? ' de documente' : ' documente';
}

// Afișează/ascunde contorul din antetul listei. `total` vine de la server (nu rows.length —
// acela e doar pagina curentă) și reflectă automat filtrele active.
function _setLstCount(total){
  const box = document.getElementById('lst-count');
  const nEl = document.getElementById('lst-count-n');
  const wEl = document.getElementById('lst-count-w');
  if(!box || !nEl || !wEl) return;
  if(total === null || total === undefined){ box.hidden = true; return; }
  const n = Number(total) || 0;
  nEl.textContent = String(n);
  wEl.textContent = _lstCountLabel(n);
  box.hidden = false;
}
```

⛔ **Doar `textContent`. Niciun `innerHTML`.**

### 3b. `loadList()` — setează contorul pe TOATE ramurile

Sunt **patru** ieșiri din `loadList()`. Contorul trebuie tratat în fiecare, altfel rămâne agățat
cu valoarea de la filtrarea precedentă.

**(1) La început — ascunde-l cât se încarcă:**

`old_str`:
```js
  if(tb)tb.innerHTML='';
  if(em)em.style.display='none';
  if(ld)ld.style.display='';
  if(pg)pg.style.display='none';
```
`new_str`:
```js
  if(tb)tb.innerHTML='';
  if(em)em.style.display='none';
  if(ld)ld.style.display='';
  if(pg)pg.style.display='none';
  _setLstCount(null);   // ascuns cât se încarcă — nu lăsăm o cifră veche peste o listă nouă
```

**(2) Eroare HTTP, (3) listă goală, (4) succes:**

`old_str`:
```js
    if(!r.ok){if(em){em.textContent='Eroare la încărcarea listei.';em.style.display='';}return;}
    const j=await r.json();
    const rows=j.rows||[];
    const total=j.total||0;
    if(!rows.length){if(em)em.style.display='';}
    else{_renderLstTable(rows,_lstState.type);_renderLstPagin(total,_lstState.page,_lstState.limit);}
  }catch(e){if(ld)ld.style.display='none';if(em){em.textContent='Eroare la încărcarea listei.';em.style.display='';}}
```
`new_str`:
```js
    if(!r.ok){if(em){em.textContent='Eroare la încărcarea listei.';em.style.display='';}_setLstCount(null);return;}
    const j=await r.json();
    const rows=j.rows||[];
    const total=j.total||0;
    _setLstCount(total);   // și pe ramura goală: „0 documente" e exact confirmarea de care are nevoie
    if(!rows.length){if(em)em.style.display='';}
    else{_renderLstTable(rows,_lstState.type);_renderLstPagin(total,_lstState.page,_lstState.limit);}
  }catch(e){if(ld)ld.style.display='none';if(em){em.textContent='Eroare la încărcarea listei.';em.style.display='';}_setLstCount(null);}
```

⚠️ **Adaptează la fișierul real.** Dacă `old_str` nu se potrivește exact, **fișierul e sursa de
adevăr, nu promptul** — găsește cele patru ieșiri și tratează-le pe toate. **Raportează** dacă ai
găsit mai multe.

=====================================================================
## PAS 4 — Cache busting
=====================================================================

```bash
grep -n "PRECACHE_ASSETS" -A25 public/sw.js | grep -n "formular/list.js\|formular.css"
```
- Dacă **NU** sunt în `PRECACHE_ASSETS` ⇒ doar `?v=3.9.675` pe `list.js` și `formular.css` în
  `formular.html`. **Fără** bump de `CACHE_VERSION`.
- Dacă **sunt** ⇒ bump `CACHE_VERSION` `'docflowai-v286'` → `'docflowai-v287'`.

⛔ **NU** face bulk-replace pe `?v=`. Doar fișierele modificate.

> ℹ️ `sw-no-auth-cache.test.mjs` a fost reparat la #89 să verifice **formatul** lui `CACHE_VERSION`,
> nu valoarea ⇒ un bump **nu-l mai sparge**. Nu-l atinge.

=====================================================================
## PAS 5 — Verificare
=====================================================================

```bash
grep -n "lst-count" public/formular.html public/css/formular/formular.css public/js/formular/list.js
# Așteptat: elementul, cele 3 reguli CSS, helperii și cele 4 apeluri _setLstCount

grep -n "_setLstCount" public/js/formular/list.js
# Așteptat: definiția + 4 apeluri (încărcare, eroare HTTP, rezultat, catch)

grep -n "rows.length" public/js/formular/list.js | grep -i count
# Așteptat: NICIUN rezultat (contorul folosește `total`, nu `rows.length`)

grep -n "innerHTML" public/js/formular/list.js | grep -i "lst-count"
# Așteptat: NICIUN rezultat

grep -n "btn-lst-nou" public/formular.html
# Așteptat: 1 rezultat — butonul NEATINS

git diff --name-only server/
# Așteptat: NICIUN rezultat (prompt pur frontend)

npm run check && npm test && npm run test:db
git diff --check
```

### Verificare manuală pe staging

- [ ] **DF**, fără filtre ⇒ contorul arată numărul corect, cu acordul potrivit („83 **de** documente").
- [ ] **ORD** ⇒ același contor, actualizat automat la schimbarea tabului.
- [ ] **Filtrezi pe „Draft"** ⇒ contorul scade și reflectă filtrul.
- [ ] **Filtru fără rezultate** ⇒ **„0 documente"** + mesajul de listă goală. *(Contorul NU dispare — ăsta e cazul în care e cel mai util.)*
- [ ] **Paginare:** cu >20 documente, contorul arată **totalul**, nu 20. La pagina 2, **rămâne același**.
- [ ] Un `user` obișnuit vede **doar numărul lui**; un `org_admin` pe cel al organizației.

=====================================================================
## PAS 6 — Commit
=====================================================================

```bash
npm version 3.9.675 --no-git-tag-version
git status --short
git add -- public/formular.html public/css/formular/formular.css public/js/formular/list.js \
           package.json package-lock.json
# + public/sw.js DOAR dacă a fost nevoie de bump (PAS 4)
# ⛔ NICIODATĂ `git add .`
git diff --cached --name-only
git commit -m "feat(lista): contor documente in antetul listei DF/ORD — foloseste `total` de la server (nu pagina curenta), acord corect al numeralului, vizibil si la 0 rezultate (v3.9.675)"
git push origin develop
```

=====================================================================
## RAPORT FINAL
=====================================================================

1. Cele patru ieșiri din `loadList()` — le-ai găsit pe toate? Ai găsit mai multe?
2. `--df-text` / `--df-text-3` există în `tokens.css`? Dacă nu, ce ai folosit?
3. `list.js` / `formular.css` sunt în `PRECACHE_ASSETS`? Ai bump-at `CACHE_VERSION`?
4. Output-ul complet al **PAS 5**, inclusiv `git diff --name-only server/` (așteptat: **gol**).
5. Confirmă că **`#btn-lst-nou` e NEATINS** și că `newDocFromList()` nu a fost modificată.
6. `npm run check`, `npm test`, `npm run test:db`: rezultate + numere (baseline DB: 368).
7. Versiune + hash commit + CI.
8. Confirmarea că **NU** ai atins `main`, `server/`, sau NO-TOUCH ZONE.

## ⛔ CONSTRÂNGERI

- ⛔ **NU** modifica nimic din `server/`. Datele există deja (`j.total`).
- ⛔ **NU** folosi `rows.length` pentru contor. **`j.total`.**
- ⛔ **NU** șterge `#btn-lst-nou` și **NU** atinge `newDocFromList()`.
- ⛔ **NU** folosi `innerHTML`. Doar `textContent`.
- ⛔ **NU** duplica contorul pentru ORD — DF și ORD partajează `loadList()` și antetul.
- ⛔ **NU** afișa „X din Y". Decizie de produs: doar câte sunt în listă.
- ⛔ **NU** face bulk-replace pe `?v=`.
- ⛔ **NU** atinge `sw-no-auth-cache.test.mjs`.
- ⛔ `develop` exclusiv. Fără `git add .`, `stash`, `reset`, `clean`, `revert`, `force-push`.
- ⛔ Fără migrări DB. Fără pachete npm noi.
