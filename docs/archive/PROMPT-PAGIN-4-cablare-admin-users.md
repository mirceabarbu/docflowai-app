---
prompt_id: PAGIN-4
titlu: Cablarea componentei DFPagin pe admin/users.js
model_suggested: Sonnet 4.6 (Default)
branch: develop
version_target: 3.9.718
migratii: NU
cache_version_bump: DA — `/js/admin/users.js` E în PRECACHE_ASSETS
v_param_bump: DA — țintit DOAR pe users.js
---

# ⚠️ BRANCH: develop

`main` = producție, gestionat MANUAL de Mircea. Nu propune și nu executa `checkout/merge/push` pe `main`.

```bash
git branch --show-current   # Așteptat: develop
git log --oneline -1        # Așteptat: 11ccced (PAGIN-3, v3.9.717) sau descendent
git status --porcelain      # docs/archive/*.md netrackuite pot rămâne — NU le include în commit
```

---

# CONTEXT

Al doilea consumator al componentei `window.DFPagin` (livrată în PAGIN-1, primul consumator cablat în PAGIN-2, CSS-ul mutat în `components.css` la PAGIN-3).

⚠️ **Diferență esențială față de PAGIN-2** — citește asta înainte de orice patch:

`admin/flows.js` pagina pe **server** (fetch per pagină). `admin/users.js` paginează pe **client**: încarcă toți utilizatorii o dată în `window._allUsers`, filtrează în `_filteredUsers`, apoi feliază local cu `users.slice(start, start+PAGE_SIZE)`. Butoanele nu declanșează fetch — doar `_currentPage = p; renderPage();`.

Deci `onChange` trebuie să seteze starea locală și să re-randeze, **NU** să cheme un `load…()`. Dacă scrii aici un `loadUsers(p)` prin analogie cu PAGIN-2, rupi pagina.

Stare relevantă (verificată pe cod):
- `PAGE_SIZE = 10` (linia 24), `_currentPage` (linia 25) — ambele module-level
- `renderPage()` (linia 39) feliază și cheamă `renderPagination(total, _currentPage, totalPages)` la final
- containerul `#pgBar` e **creat dinamic** dacă lipsește, atașat la `$('pgBarWrapper') || $('tbl')`

**Ordinea scripturilor e deja corectă** — PAGIN-2 a pus `pagin.js` înaintea lui `users.js` în `admin.html`. Confirmă și nu schimba nimic în ordine:

```bash
grep -n "js/shared/pagin.js\|js/admin/users.js" public/admin.html
# Așteptat: pagin.js pe o linie ANTERIOARĂ lui users.js
```

`PAGE_SIZE` rămâne **10** — 52 de utilizatori înseamnă 6 pagini, rezonabil, iar paginarea fiind client-side dimensiunea e pur cosmetică. Nu o schimba; nu e în scopul acestui prompt.

---

# Pas 1 — `public/js/admin/users.js`: înlocuiește `renderPagination`

`old_str`
```js
  function renderPagination(total, current, totalPages){
    let pg = $('pgBar');
    if(!pg){ pg=document.createElement('div'); pg.id='pgBar'; pg.className='pagination';
      const wrap=$('pgBarWrapper') || $('tbl'); if(wrap) wrap.appendChild(pg); }
    pg.innerHTML='';
    if(totalPages<=1 && total<=PAGE_SIZE){return;}
    const info=document.createElement('span'); info.className='pg-info';
    info.textContent=`${Math.min((current-1)*PAGE_SIZE+1,total)}–${Math.min(current*PAGE_SIZE,total)} din ${total}`;
    const prev=document.createElement('button'); prev.className='pg-btn'; prev.textContent='◀';
    prev.disabled=current<=1; prev.onclick=()=>{_currentPage--;renderPage();};
    pg.appendChild(prev); pg.appendChild(info);
    for(let p=1;p<=totalPages;p++){
      if(totalPages>7&&Math.abs(p-current)>2&&p!==1&&p!==totalPages){
        if(p===2||p===totalPages-1){const d=document.createElement('span');d.className='pg-info';d.textContent='…';pg.appendChild(d);}
        continue;
      }
      const b=document.createElement('button'); b.className='pg-btn'+(p===current?' active':'');
      b.textContent=p; b.onclick=(pp=>()=>{_currentPage=pp;renderPage();})(p);
      pg.appendChild(b);
    }
    const next=document.createElement('button'); next.className='pg-btn'; next.textContent='▶';
    next.disabled=current>=totalPages; next.onclick=()=>{_currentPage++;renderPage();};
    pg.appendChild(next);
  }
```

`new_str`
```js
  function renderPagination(total, current, totalPages){
    // PAGIN-4 — componenta partajată DFPagin. Paginare CLIENT-SIDE: onChange
    // setează starea locală și re-randează, fără fetch (spre deosebire de
    // admin/flows.js, care paginează pe server).
    let pg = $('pgBar');
    if(!pg){ pg=document.createElement('div'); pg.id='pgBar'; pg.className='pagination';
      const wrap=$('pgBarWrapper') || $('tbl'); if(wrap) wrap.appendChild(pg); }
    if(!pg) return;
    if(window.DFPagin && typeof window.DFPagin.render === 'function'){
      window.DFPagin.render({
        container: pg,
        total,
        page: current,
        limit: PAGE_SIZE,
        mode: 'numbered',
        onChange: (p)=>{ _currentPage = p; renderPage(); },
      });
    } else {
      // Fail-safe: componenta nu s-a încărcat — ascunde bara, nu rupe tabelul.
      console.error('DFPagin indisponibil — paginarea utilizatorilor e ascunsă');
      pg.innerHTML='';
      pg.style.display='none';
    }
  }
```

⚠️ Parametrul `totalPages` rămâne în semnătură deși nu-l mai folosim — DFPagin îl recalculează din `total/limit`. **Nu schimba semnătura** și nu atinge apelantul (`renderPage`, linia 102, și `renderPagination(0,1,1)` din ramura „Niciun rezultat", linia ~107). Modificarea apelanților ar lărgi inutil suprafața de regresie.

ℹ️ Echivalență de comportament confirmată înainte de scrierea promptului:
- vechiul `if(totalPages<=1 && total<=PAGE_SIZE) return;` (după `innerHTML=''`) ⇔ DFPagin ascunde containerul când `totalPages<=1`. `totalPages = ceil(total/PAGE_SIZE)`, deci a doua condiție e implicată de prima — echivalente.
- fereastra de pagini: vechiul `Math.abs(p-current)>2 … p===2||p===totalPages-1` ⇔ `DFPagin.pageWindow(page, totalPages, 7)`, verificat la PAGIN-1 (`pageWindow(10,20,7)` → `[1,'…',8,9,10,11,12,'…',20]`).
- eticheta `from–to din total` e identică; DFPagin nu clamează `from`, dar cazul `total=0` e deja prins de ascundere.

**Nu trebuie să existe nicio diferență vizuală.** Dacă observi vreuna, oprește-te și raportează.

---

# Pas 2 — cache busting

```bash
grep -n "CACHE_VERSION = " public/sw.js
# Citește valoarea CURENTĂ (era docflowai-v294 după PAGIN-3). Incrementează cu 1.
```

`/js/admin/users.js` E în `PRECACHE_ASSETS` — fără bump, service workerul ar servi versiunea veche a lui `users.js`, care ar cădea în ramura fail-safe (bară de paginare dispărută).

`?v=` **țintit doar pe users.js** (e la `3.9.693`; nu presupune valoarea, grep-o):

```bash
NEW=3.9.718
sed -i -E "s#(js/admin/users\.js\?v=)[0-9.]+#\1$NEW#g" public/*.html
```

⛔ Niciun alt `?v=` nu are voie să se miște. `pagin.js` rămâne la `3.9.716` — nu se modifică.

---

# Pas 3 — testul de cablare devine parametrizat

Vor mai urma **șase** consumatori (PAGIN-5…10). Un fișier de test per consumator ar însemna șapte fișiere aproape identice.

1. Redenumește `server/tests/unit/pagin-wiring-admin-flows.test.mjs` → `server/tests/unit/pagin-wiring.test.mjs` (folosește `git mv`, ca istoricul să se păstreze).
2. Restructurează-l în jurul unui tablou `CONSUMERS`, fiecare intrare cu: calea fișierului, `mustContain`, `mustNotContain`. Rulează aserțiunile cu `describe.each` / `it.each`.
3. Păstrează **toate** aserțiunile existente pentru `flows.js` și cele trei din PAGIN-3 (CSS mutat, `limit: 50`) — dacă vreuna nu se încadrează în tiparul parametrizat, las-o ca `it` separat. **Nu pierde acoperire.**
4. Adaugă intrarea pentru `users.js`:
   - `mustContain`: `DFPagin.render(`, `window.DFPagin &&`, `onChange`, `_currentPage = p`
   - `mustNotContain`: `pg-btn`, `Math.abs(p-current)`, `prev.onclick`
5. Adaugă un comentariu în capul fișierului: consumatorii următori se adaugă în `CONSUMERS`, nu într-un fișier nou.

---

# Pas 4 — verificări

```bash
node --check public/js/admin/users.js
# Așteptat: fără output

grep -c "pg-btn\|Math.abs(p-current)" public/js/admin/users.js
# Așteptat: 0

grep -n "onChange" public/js/admin/users.js
# Așteptat: 1 rezultat, cu `_currentPage = p; renderPage();` — NU un apel de fetch

grep -n "js/admin/users.js?v=" public/admin.html
# Așteptat: ?v=3.9.718

grep -n "js/shared/pagin.js?v=" public/admin.html
# Așteptat: ?v=3.9.716 NEATINS

grep -n "CACHE_VERSION = " public/sw.js
# Așteptat: incrementat cu exact 1

npx vitest run server/tests/unit/pagin-wiring.test.mjs
# Așteptat: toate verzi, inclusiv cele migrate din fișierul vechi

ls server/tests/unit/pagin-wiring-admin-flows.test.mjs 2>/dev/null && echo "EROARE: fișierul vechi nu a fost redenumit"
# Așteptat: mesaj „No such file"

npm test
# Așteptat: verde, fără regresii

npm run test:db
# Așteptat: PASSED, nu SKIPPED.
# ⚠️ Credențialul din CLAUDE.md (postgres:test@localhost:5432) a EȘUAT cu auth failure
#    la PAGIN-3. Folosește rețeta care a funcționat: instanță PG 17 EFEMERĂ proprie
#    (initdb + pg_ctl pe un port liber, ex. 55432), rulezi, apoi oprești și cureți.
# ⛔ Docker absent NU e motiv de skip.

git diff --stat
# Așteptat: users.js, admin.html, sw.js, package.json/-lock + redenumirea testului.
# ZERO atingeri în alte module admin, în formular/, sau în public/js/shared/pagin.js
```

```bash
npm version 3.9.718 --no-git-tag-version
git add -A
git commit -m "refactor(ui): admin/users.js folosește componenta DFPagin (PAGIN-4, v3.9.718)"
git push origin develop
```

---

# ACCEPTANCE MANUAL (Mircea, pe staging, `Ctrl+Shift+R`)

- [ ] Admin → Utilizatori: bara arată **identic** cu înainte (◀ 1–10 din 52, numerele 1…6, ▶)
- [ ] Click pe un număr → sare la pagina aia, fără reîncărcarea listei (e client-side, trebuie să fie instantaneu)
- [ ] Pagina curentă evidențiată; `◀` dezactivat pe 1, `▶` dezactivat pe ultima
- [ ] Filtrele (căutare / rol / status) resetează la pagina 1 și recalculează numărul de pagini
- [ ] Un filtru care nu întoarce nimic → „Niciun rezultat", fără bară de paginare
- [ ] Admin → Fluxuri: **neschimbat** față de ieri (dovada că n-am atins nimic din PAGIN-2/3)

---

# RAPORT FINAL

1. Diff pe fiecare fișier.
2. Confirmă că `onChange` NU face fetch — arată linia exactă.
3. `CACHE_VERSION` înainte / după (citit din fișier).
4. `?v=` — ce s-a mișcat, ce a rămas pe loc.
5. Testul parametrizat: câte aserțiuni erau în fișierul vechi, câte sunt acum? Confirmă că **nu s-a pierdut niciuna**.
6. `npm test` și `npm run test:db` — **PASSED sau SKIPPED?** Ce rețetă ai folosit pentru Postgres?
7. Ai observat vreo diferență de randare față de comportamentul anterior? (Așteptat: NU.)
8. Commit hash + confirmare `develop`.
9. Orice abatere, cu motivul.

**Bonus, dacă îl ai la îndemână:** comenzile EXACTE pentru instanța Postgres efemeră (initdb, pg_ctl, createdb, `TEST_DATABASE_URL`, oprire + curățare), ca text copiabil — vreau să le pun în CLAUDE.md ca rețetă locală oficială, fiindcă credențialul documentat acum e greșit.

---

# ⛔ CONSTRÂNGERI

- ⛔ **Un singur consumator.** Nu atinge `admin/audit.js`, `admin/primarii.js`, `admin/flows.js`, `formular/*`, `registratura/main.js`, `semdoc-initiator/main.js`.
- ⛔ **Nu modifica `public/js/shared/pagin.js`.** Dacă îți lipsește ceva din API, oprește-te și raportează.
- ⛔ **Nu schimba `PAGE_SIZE`** și nu transforma paginarea în server-side. Rămâne client-side, exact ca acum.
- ⛔ **Nu schimba semnătura lui `renderPagination`** și nu atinge apelanții ei.
- ⛔ **Nu modifica CSS.** Clasele au fost mutate în `components.css` la PAGIN-3 și sunt deja disponibile.
- ⛔ **`?v=` țintit doar pe users.js.**
- ⛔ **Nu include `docs/archive/*.md` netrackuite în commit** — se comit separat, doc-only.
- ⛔ Zero atingeri în `server/` în afara fișierului de test.
- ⛔ Fără migrații.
- ⛔ Dacă `old_str` nu se potrivește exact, **OPREȘTE-TE și raportează** cu contextul real. Nu improviza.
