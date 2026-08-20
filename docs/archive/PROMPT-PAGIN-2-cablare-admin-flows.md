---
prompt_id: PAGIN-2
titlu: Cablarea componentei de paginare pe admin/flows.js + eliminarea contorului dublu
model_suggested: Sonnet 4.6 (Default)
branch: develop
version_target: 3.9.716
migratii: NU
cache_version_bump: DA — `/js/admin/flows.js` E în PRECACHE_ASSETS
v_param_bump: DA — țintit pe flows.js + noul pagin.js
---

# ⚠️ BRANCH: develop

`main` = producție, gestionat MANUAL de Mircea. Nu propune și nu executa `checkout/merge/push` pe `main`.

```bash
git branch --show-current   # Așteptat: develop
git log --oneline -1        # Așteptat: 1c61e58 (PAGIN-1, v3.9.715) sau descendent
git status --porcelain      # .md netracked din docs/archive/ pot rămâne, nu le atinge
```

---

# CONTEXT

PAGIN-1 (v3.9.715) a livrat `public/js/shared/pagin.js` — componenta partajată `window.DFPagin`, cu 21 de teste comportamentale verzi — **deliberat necablată**. Acesta e primul consumator.

Ținta: `public/js/admin/flows.js`, care azi are trei probleme:

1. **Paginare scrisă de mână** (~28 de linii): butoane numerotate cu elipsă, construite inline cu `document.createElement` + `.onclick`.
2. **Contor DUBLU pentru aceeași listă** — o linie inline în `area.innerHTML` („Pagina 2 din 5 · 47 fluxuri total") **și** bara `#flowsListPagination` („11–20 din 47"). Două formate pentru același adevăr.
3. Fallback mort: `resp.limit || 50` deși cererea trimite `limit: 10`. (Serverul echoează `limit`, deci nu produce bug azi — dar dispare odată cu blocul.)

**Echivalență confirmată înainte de scrierea acestui prompt:** `DFPagin.pageWindow(10,20,7)` → `[1,'…',8,9,10,11,12,'…',20]` și `(1,20,7)` → `[1,2,3,'…',20]` — identice cu ce produce bucla actuală (`Math.abs(p-page) > 2`, plus prima și ultima, plus elipse la `p===2` / `p===maxPages-1`). **Cablarea NU trebuie să schimbe nimic vizual.** Dacă observi vreo diferență de randare, oprește-te și raportează.

⚠️ **Premisă de verificat înainte de orice patch:** referințele de cod de mai jos sunt citite dintr-o arhivă la v3.9.711. Commit-urile 712–715 nu au atins `flows.js`, dar confirmă tu:

```bash
grep -n "Paginare fluxuri" public/js/admin/flows.js
grep -n "flux\${total!==1" public/js/admin/flows.js
# Așteptat: câte 1 rezultat fiecare. Dacă old_str nu se potrivește exact, OPREȘTE-TE și raportează.
```

---

# Pas 1 — `public/admin.html`: încarcă componenta ÎNAINTEA consumatorului

`pagin.js` trebuie să existe pe `window` când rulează `flows.js`. Scripturile `defer` se execută **în ordinea din document**, deci tag-ul nou merge înaintea celui de `flows.js`.

Folosește convenția existentă pentru `/js/shared/` (vezi `flow.html:291`, `formular.html:1437`).

`old_str`
```html
<script src="/js/admin/users.js?v=3.9.693" defer></script>
<script src="/js/admin/flows.js?v=3.9.693" defer></script>
```

`new_str`
```html
<script src="/js/shared/pagin.js?v=3.9.716" defer></script>
<script src="/js/admin/users.js?v=3.9.693" defer></script>
<script src="/js/admin/flows.js?v=3.9.716" defer></script>
```

⚠️ **Nu bumpa `?v=` pe `users.js`** și pe niciun alt script — el nu se modifică în acest prompt. Bump-ul `?v=` e ȚINTIT pe assetele schimbate (regula din CLAUDE.md §Cache busting); un sed global ar șterge drift-ul intenționat.

---

# Pas 2 — `public/js/admin/flows.js`: elimină contorul dublu

Linia inline din `area.innerHTML` dispare. Bara `#flowsListPagination` rămâne singura sursă de adevăr pentru „unde sunt / câte sunt".

`old_str`
```js
        </table></div>
        <div style="margin-top:8px;font-size:.76rem;color:var(--muted);">Pagina ${page} din ${pages} · ${total} flux${total!==1?"uri":""} total</div>`;
```

`new_str`
```js
        </table></div>`;
```

ℹ️ Contorul din cardul de sus (`#flowsActiveCount`, populat mai devreme cu `total`) rămâne NEATINS — e alt indicator, nu duplicat.

---

# Pas 3 — `public/js/admin/flows.js`: înlocuiește paginarea scrisă de mână

`old_str`
```js
      // Paginare fluxuri — același stil cu paginarea utilizatorilor
      const pg = document.getElementById("flowsListPagination");
      if (pg) {
        pg.style.display = pages > 1 ? "" : "none";
        pg.innerHTML = "";
        if (pages > 1) {
          pg.className = "pagination";
          const info = document.createElement("span"); info.className = "pg-info";
          const from = (page - 1) * (resp.limit || 50) + 1;
          const to = Math.min(page * (resp.limit || 50), total);
          info.textContent = `${from}–${to} din ${total}`;
          const prev = document.createElement("button"); prev.className = "pg-btn"; prev.textContent = "◀";
          prev.disabled = page <= 1; prev.onclick = () => loadFlowsList(false, page - 1);
          pg.appendChild(prev); pg.appendChild(info);
          const maxPages = pages;
          for (let p = 1; p <= maxPages; p++) {
            if (maxPages > 7 && Math.abs(p - page) > 2 && p !== 1 && p !== maxPages) {
              if (p === 2 || p === maxPages - 1) { const d = document.createElement("span"); d.className = "pg-info"; d.textContent = "…"; pg.appendChild(d); }
              continue;
            }
            const b = document.createElement("button"); b.className = "pg-btn" + (p === page ? " active" : "");
            b.textContent = p; b.onclick = (pp => () => loadFlowsList(false, pp))(p);
            pg.appendChild(b);
          }
          const next = document.createElement("button"); next.className = "pg-btn"; next.textContent = "▶";
          next.disabled = page >= pages; next.onclick = () => loadFlowsList(false, page + 1);
          pg.appendChild(next);
        }
      }
```

`new_str`
```js
      // Paginare fluxuri — componenta partajată DFPagin (PAGIN-2).
      // `limit` vine din răspunsul serverului (/admin/flows/list îl echoează);
      // fallback la cele 10 trimise în cerere, NU la o valoare inventată.
      const pg = document.getElementById("flowsListPagination");
      if (pg) {
        if (window.DFPagin && typeof window.DFPagin.render === "function") {
          window.DFPagin.render({
            container: pg,
            total,
            page,
            limit: resp.limit || 10,
            mode: "numbered",
            onChange: (p) => loadFlowsList(false, p),
          });
        } else {
          // Fail-safe: componenta nu s-a încărcat — ascunde bara în loc să crape lista.
          console.error("DFPagin indisponibil — paginarea fluxurilor e ascunsă");
          pg.style.display = "none";
        }
      }
```

⚠️ `onChange` primește **numărul paginii țintă**, nu o direcție — de aceea `loadFlowsList(false, p)` direct, fără `page - 1` / `page + 1`.

---

# Pas 4 — cache busting

`/js/admin/flows.js` **E în `PRECACHE_ASSETS`** (`public/sw.js`). Fără bump de `CACHE_VERSION`, service workerul le-ar servi utilizatorilor versiunea veche a lui `flows.js` — care ar apela o componentă inexistentă și ar ateriza direct în ramura fail-safe (bară de paginare dispărută).

```bash
grep -n "CACHE_VERSION = " public/sw.js
# Citește valoarea CURENTĂ din fișier (NU presupune — ultimul bump a fost pe logo).
# Incrementează cu 1: docflowai-v<N> → docflowai-v<N+1>
```

`pagin.js` **NU** se adaugă în `PRECACHE_ASSETS`: `admin.html` nu e precacheuit (doar `/login.html` și `/flow.html` sunt), deci scenariul offline nu apare, iar lista de precache nu trebuie umflată fără motiv.

---

# Pas 5 — test de structură

Comportamentul componentei e deja acoperit de cele 21 de cazuri din PAGIN-1. Aici testăm **cablarea**, ceea ce e o invariantă structurală — deci analiza pe sursă e potrivită (spre deosebire de PAGIN-1, unde ar fi fost prea slabă).

Creează `server/tests/unit/pagin-wiring-admin-flows.test.mjs`:

1. `public/js/admin/flows.js` conține `DFPagin.render` exact o dată.
2. `flows.js` **nu** mai conține `pg-btn`, `Math.abs(p - page)`, `resp.limit || 50` — paginarea manuală a dispărut complet.
3. `flows.js` **nu** mai conține șirul `flux${total!==1` — contorul dublu a dispărut.
4. `public/admin.html` conține `/js/shared/pagin.js`.
5. **Ordinea de încărcare**: în `admin.html`, indexul lui `js/shared/pagin.js` e MAI MIC decât indexul lui `js/admin/flows.js`. (Asta e aserțiunea care contează — `defer` execută în ordinea documentului.)
6. `flows.js` păstrează ramura fail-safe: sursa conține `window.DFPagin &&`.

---

# Pas 6 — verificări

```bash
node --check public/js/admin/flows.js
node --check public/js/shared/pagin.js
# Așteptat: fără output

grep -c "pg-btn\|Math.abs(p - page)\|resp.limit || 50" public/js/admin/flows.js
# Așteptat: 0

grep -n "js/shared/pagin.js\|js/admin/flows.js" public/admin.html
# Așteptat: pagin.js pe o linie ANTERIOARĂ lui flows.js, ambele cu ?v=3.9.716

grep -n "?v=3.9.693" public/admin.html | grep -c "users.js"
# Așteptat: 1 — users.js NU a fost bumpat

grep -n "CACHE_VERSION = " public/sw.js
# Așteptat: valoarea incrementată cu exact 1 față de cea dinaintea acestui prompt

npx vitest run server/tests/unit/pagin-wiring-admin-flows.test.mjs
# Așteptat: 6 cazuri verzi

npm test
# Așteptat: verde, fără regresii (inclusiv cele 21 de teste PAGIN-1, neatinse)

npm run test:db
# Așteptat: PASSED. Postgres 17 e instalat local (serviciu Windows, port 5432, baza docflow_test):
#   TEST_DATABASE_URL=postgres://postgres:test@localhost:5432/docflow_test
# ⛔ Absența Docker-ului NU e motiv de skip — folosește PG-ul local de mai sus.
#    Raportează „skipped" doar dacă și acesta e indisponibil, și spune explicit că nu e o dovadă.

git diff --stat
# Așteptat: 4 fișiere modificate (admin.html, admin/flows.js, sw.js, package.json/-lock)
#           + 1 fișier nou (testul). ZERO atingeri în public/js/formular/ sau alte module admin.
```

```bash
npm version 3.9.716 --no-git-tag-version
git add -A
git commit -m "refactor(ui): admin/flows.js folosește componenta DFPagin + contor dublu eliminat (PAGIN-2, v3.9.716)"
git push origin develop
```

---

# ACCEPTANCE MANUAL (pentru Mircea, pe staging)

Se face cu **hard refresh** (`Ctrl+Shift+R`), altfel vezi SW-ul vechi:

- [ ] Admin → Fluxuri: bara de paginare arată `◀ 11–20 din 47 1 2 3 … ▶` (același aspect ca înainte)
- [ ] Click pe un număr → sare la pagina aia; pagina curentă e evidențiată (`active`)
- [ ] `◀` dezactivat pe pagina 1, `▶` dezactivat pe ultima
- [ ] **Nu mai apare** linia „Pagina X din Y · N fluxuri total" de sub tabel
- [ ] Contorul din cardul de sus (număr total fluxuri) e neschimbat
- [ ] Cu ≤ 1 pagină de rezultate, bara e ascunsă complet
- [ ] Filtrele (căutare, status, instituție, compartiment, dată) resetează corect la pagina 1

---

# RAPORT FINAL

1. Diff pe fiecare fișier.
2. Confirmarea că cele două `grep` de premisă de la început au dat câte 1 rezultat înainte de patch.
3. Valoarea `CACHE_VERSION` ÎNAINTE și DUPĂ (citită din fișier, nu presupusă).
4. `?v=` — ce assete ai bumpat și care le-ai lăsat neatinse, cu justificare.
5. Cele 6 cazuri de structură: verzi?
6. `npm test` și `npm run test:db` — **PASSED sau SKIPPED?** Dacă e skipped, ai încercat PG-ul local înainte?
7. Confirmă explicit: ai observat vreo diferență de randare față de comportamentul anterior? (Așteptat: NU.)
8. Commit hash + confirmare `develop`.
9. Orice abatere, cu motivul.

---

# ⛔ CONSTRÂNGERI

- ⛔ **Un singur consumator.** Nu atinge `admin/users.js`, `admin/audit.js`, `admin/primarii.js`, `formular/list.js`, `formular/alop.js`, `registratura/main.js`, `semdoc-initiator/main.js`. Vor veni la rând, câte unul per prompt.
- ⛔ **Nu modifica `public/js/shared/pagin.js`.** A aterizat testat în PAGIN-1. Dacă îți lipsește ceva din API, **oprește-te și raportează** — schimbarea componentei sub patru consumatori viitori e o decizie, nu un detaliu de cablare.
- ⛔ **Nu modifica CSS.** Clasele `.pagination` / `.pg-btn` / `.pg-info` rămân exact cum sunt.
- ⛔ **`?v=` țintit, nu bulk.** Doar `flows.js` și `pagin.js`.
- ⛔ **CACHE_VERSION citit din fișier**, incrementat cu 1. Nu-l alinia la versiunea din `package.json` — sunt două numerotări diferite.
- ⛔ Zero atingeri în `server/` în afara fișierului nou de test.
- ⛔ Fără migrații.
- ⛔ Dacă vreun `old_str` nu se potrivește exact, **OPREȘTE-TE și raportează** cu contextul real. Nu improviza patch-ul.
