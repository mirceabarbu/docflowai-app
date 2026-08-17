---
prompt_id: PAGIN-5
titlu: Cablarea componentei DFPagin pe admin/audit.js (schimbă aspectul, intenționat)
model_suggested: Sonnet 4.6 (Default)
branch: develop
version_target: 3.9.719
migratii: NU
cache_version_bump: DA — `/js/admin/audit.js` E în PRECACHE_ASSETS
v_param_bump: DA — țintit DOAR pe audit.js
---

# ⚠️ BRANCH: develop

`main` = producție, gestionat MANUAL de Mircea. Nu propune și nu executa `checkout/merge/push` pe `main`.

```bash
git branch --show-current   # Așteptat: develop
git log --oneline -1        # Așteptat: c7e8277 (PAGIN-4, v3.9.718) sau descendent
git status --porcelain      # docs/archive/*.md netrackuite pot rămâne — NU le include în commit
```

---

# CONTEXT

Al treilea consumator al componentei `window.DFPagin`.

⚠️ **DIFERENȚĂ FAȚĂ DE PAGIN-2 și PAGIN-4: acesta SCHIMBĂ aspectul, intenționat.**

`admin/flows.js` și `admin/users.js` erau deja în familia „numerotată" (`.pagination`/`.pg-btn`), deci cablarea lor a fost pixel-identică. `admin/audit.js` NU e în acea familie — are propria variantă:

```js
el.innerHTML = `
  <button class="df-action-btn sm" onclick="loadAuditEvents(${page - 1})" ...>‹ Anterior</button>
  <span style="color:var(--muted);">Pagina <strong …>${page}</strong> din <strong …>${pages}</strong> &nbsp;·&nbsp; ${total} înregistrări</span>
  <button class="df-action-btn sm" onclick="loadAuditEvents(${page + 1})" ...>Următor ›</button>
`;
```

După cablare devine `◀ 51–100 din 1053  1 2 3 … 22 ▶` — decizia lui Mircea e paginare numerotată pe toate paginile. **Aceasta e schimbarea așteptată, nu o regresie.**

Câștig secundar: dispar două `onclick` inline construite prin interpolare în `innerHTML` — încalcă regula casei (`CLAUDE.md`: `data-*` + delegare, niciodată `onclick` inline).

Fapte verificate pe cod:
- `loadAuditEvents(page = 1)` (linia 193) paginează pe **server**: `new URLSearchParams({ page, limit: 50 })` (linia 200)
- răspunsul serverului (`server/routes/admin/audit.mjs:101-116`) conține `page`, `total`, `pages`
- `renderAuditPagination(page, pages, total)` e chemată la linia 210
- containerul `#audit-pagination` e **static** în `admin.html:1391`, cu stiluri inline
- ordinea scripturilor e deja corectă (`pagin.js` la ~1619, `audit.js` la ~1622) — **nu o schimba**

---

# Pas 1 — `public/js/admin/audit.js`: constantă unică pentru dimensiunea paginii

Azi `50` e scris literal în cerere, iar randarea primea `pages` de la server. După cablare, componenta are nevoie de `limit` ca să calculeze intervalul `from–to`. Ca să nu ajungem cu două surse de adevăr, extrage constanta.

Adaugă lângă celelalte variabile module-level din capul IIFE-ului (imediat după `let _auditCurrentPage…`; grep-o ca să iei contextul exact):

```js
  const AUDIT_PAGE_SIZE = 50;   // PAGIN-5 — sursă unică: cererea ȘI randarea paginării
```

`old_str`
```js
    const params = new URLSearchParams({ page, limit: 50 });
```

`new_str`
```js
    const params = new URLSearchParams({ page, limit: AUDIT_PAGE_SIZE });
```

---

# Pas 2 — înlocuiește `renderAuditPagination`

`old_str`
```js
  function renderAuditPagination(page, pages, total) {
    const el = $('audit-pagination');
    if (!el) return;
    el.innerHTML = `
      <button class="df-action-btn sm" onclick="loadAuditEvents(${page - 1})" ${page <= 1 ? 'disabled' : ''}>‹ Anterior</button>
      <span style="color:var(--muted);">Pagina <strong style="color:#eaf0ff;">${page}</strong> din <strong style="color:#eaf0ff;">${pages}</strong> &nbsp;·&nbsp; ${total} înregistrări</span>
      <button class="df-action-btn sm" onclick="loadAuditEvents(${page + 1})" ${page >= pages ? 'disabled' : ''}>Următor ›</button>
    `;
  }
```

`new_str`
```js
  function renderAuditPagination(page, pages, total) {
    // PAGIN-5 — componenta partajată DFPagin (paginare pe SERVER: onChange refetch-uiește).
    // `pages` rămâne în semnătură pentru compatibilitate cu apelantul; DFPagin îl
    // recalculează din total/limit. Zero innerHTML, zero onclick inline (regula casei).
    const el = $('audit-pagination');
    if (!el) return;
    if (window.DFPagin && typeof window.DFPagin.render === 'function') {
      window.DFPagin.render({
        container: el,
        total,
        page,
        limit: AUDIT_PAGE_SIZE,
        mode: 'numbered',
        onChange: (p) => loadAuditEvents(p),
      });
    } else {
      // Fail-safe: componenta nu s-a încărcat — ascunde bara, nu rupe tabelul.
      console.error('DFPagin indisponibil — paginarea auditului e ascunsă');
      el.replaceChildren();
      el.style.display = 'none';
    }
  }
```

⚠️ **Nu șterge `window.loadAuditEvents`** (linia ~304). Chiar dacă `onclick`-urile inline din paginare dispar, exportul e încă folosit din DOUĂ locuri:
- `public/admin.html:1366` — `onclick="loadAuditEvents(1)"` pe butonul „Caută"
- `public/js/admin/admin.js:217` — la comutarea pe tabul audit

Curățarea acelor două e o discuție separată, nu în acest prompt.

---

# Pas 3 — `public/admin.html`: curăță stilurile inline de pe container

Containerul are stiluri inline care ar bate clasa `.pagination` (inline > clasă): `gap:12px` vs `gap:6px`, `margin-top:16px` vs `14px`, plus un `font-size`/`color` care nu-și mai au rostul. Rezultatul ar fi o bară „aproape" corectă, diferită subtil de celelalte trei pagini — exact incoerența pe care o eliminăm.

`old_str`
```html
  <div id="audit-pagination" style="display:flex;align-items:center;gap:12px;margin-top:16px;justify-content:center;font-size:.83rem;color:var(--muted);"></div>
```

`new_str`
```html
  <div id="audit-pagination"></div>
```

ℹ️ `DFPagin.render` pune singur `class="pagination"` pe container, iar regulile au fost mutate în `components.css` la PAGIN-3. Nu e nevoie de nicio clasă în HTML.

⚠️ Verifică prin grep că `#audit-pagination` nu are alte reguli CSS pe id (`grep -rn "audit-pagination" public/css/`). Dacă are, **oprește-te și raportează**.

---

# Pas 4 — cache busting

```bash
grep -n "CACHE_VERSION = " public/sw.js
# Citește valoarea CURENTĂ (era docflowai-v295 după PAGIN-4). Incrementează cu 1.
```

`/js/admin/audit.js` E în `PRECACHE_ASSETS`.

```bash
NEW=3.9.719
sed -i -E "s#(js/admin/audit\.js\?v=)[0-9.]+#\1$NEW#g" public/*.html
```

⛔ Niciun alt `?v=` nu se mișcă. `pagin.js` rămâne 3.9.716, `users.js` 3.9.718, `flows.js` 3.9.717.

---

# Pas 5 — testul parametrizat

Adaugă o intrare pentru `audit.js` în tabloul `CONSUMERS` din `server/tests/unit/pagin-wiring.test.mjs` (creat la PAGIN-4). **Nu crea fișier nou.**

- `mustContain`: `DFPagin.render(`, `window.DFPagin &&`, `AUDIT_PAGE_SIZE`, `onChange: (p) => loadAuditEvents(p)`
- `mustNotContain`: `onclick="loadAuditEvents(`, `‹ Anterior`, `Următor ›`, `limit: 50`

Plus un `it` separat: `public/admin.html` conține `<div id="audit-pagination"></div>` **fără** atribut `style`.

---

# Pas 6 — verificări

```bash
node --check public/js/admin/audit.js
# Așteptat: fără output

grep -c "onclick=\"loadAuditEvents" public/js/admin/audit.js
# Așteptat: 0

grep -n "window.loadAuditEvents" public/js/admin/audit.js
# Așteptat: 1 — exportul PĂSTRAT

grep -n "AUDIT_PAGE_SIZE" public/js/admin/audit.js
# Așteptat: 3 (declarația + cererea + randarea)

grep -n "audit-pagination" public/admin.html
# Așteptat: <div id="audit-pagination"></div>, fără style=

grep -n "js/admin/audit.js?v=" public/admin.html
# Așteptat: 3.9.719

grep -n "js/shared/pagin.js?v=\|js/admin/users.js?v=\|js/admin/flows.js?v=" public/admin.html
# Așteptat: 3.9.716 / 3.9.718 / 3.9.717 — NEATINSE

npx vitest run server/tests/unit/pagin-wiring.test.mjs
# Așteptat: toate verzi, inclusiv intrările flows + users

npm test
# Așteptat: verde, fără regresii

npm run test:db
# Așteptat: PASSED. Rețeta care funcționează (PG 17 efemer, port 55432) e cea din
# raportul PAGIN-4 — NU credențialul de pe 5432, care dă auth failure.
# ⛔ Docker absent NU e motiv de skip.

git diff --stat
# Așteptat: audit.js, admin.html, sw.js, pagin-wiring.test.mjs, package.json/-lock.
# ZERO atingeri în flows.js, users.js, primarii.js, pagin.js, formular/, registratura/
```

```bash
npm version 3.9.719 --no-git-tag-version
git add -A
git status --short          # verifică staging-ul ÎNAINTE de commit (lecția de la PAGIN-4)
git commit -m "refactor(ui): admin/audit.js folosește componenta DFPagin (PAGIN-5, v3.9.719)"
git push origin develop
```

ℹ️ La PAGIN-4 un `git add` cu pathspec invalid a eșuat tăcut și a produs un commit incomplet. De aceea `git status --short` înainte de commit e acum pas obligatoriu.

---

# ACCEPTANCE MANUAL (Mircea, pe staging, `Ctrl+Shift+R`)

⚠️ Aici aspectul **se schimbă** — asta e ținta, nu un bug.

- [ ] Admin → Audit: bara arată acum `◀ 1–50 din N  1 2 3 … ▶`, în locul lui „‹ Anterior · Pagina 1 din 22 · N înregistrări · Următor ›"
- [ ] Aspectul e **identic** cu bara de la Fluxuri și Utilizatori (aceleași dimensiuni, spațiere, culori)
- [ ] Click pe un număr → încarcă pagina respectivă de la server
- [ ] Filtrele de audit + butonul „Caută" resetează la pagina 1
- [ ] Export CSV funcționează în continuare (folosește alt `limit`, nu trebuie afectat)
- [ ] Fluxuri și Utilizatori: **neschimbate**

---

# RAPORT FINAL

1. Diff pe fiecare fișier.
2. Confirmă că `window.loadAuditEvents` a rămas exportat și explică de ce e încă necesar.
3. Ai găsit reguli CSS pe `#audit-pagination` în `public/css/`? Dacă da, care?
4. `CACHE_VERSION` înainte / după.
5. `?v=` — ce s-a mișcat, ce a rămas pe loc (listează toate cele patru).
6. Testul: câte intrări are acum `CONSUMERS`, câte teste rulează în total?
7. `npm test` și `npm run test:db` — **PASSED sau SKIPPED?**
8. Output-ul lui `git status --short` dinaintea commit-ului.
9. Commit hash + confirmare `develop`.
10. Orice abatere, cu motivul.

---

# ⛔ CONSTRÂNGERI

- ⛔ **Un singur consumator.** Nu atinge `admin/primarii.js` (vine la PAGIN-6), `admin/flows.js`, `admin/users.js`, `formular/*`, `registratura/main.js`, `semdoc-initiator/main.js`.
- ⛔ **Nu modifica `public/js/shared/pagin.js`.**
- ⛔ **Nu șterge `window.loadAuditEvents`** și nu atinge `admin.html:1366` sau `admin/admin.js:217`.
- ⛔ **Nu schimba `AUDIT_PAGE_SIZE`** de la 50.
- ⛔ **Nu modifica CSS.** Clasele sunt deja în `components.css` din PAGIN-3.
- ⛔ **Nu atinge `downloadAuditCsv`** — folosește `limit: 10000`, e alt scop.
- ⛔ **`?v=` țintit doar pe audit.js.**
- ⛔ Zero atingeri în `server/` în afara fișierului de test.
- ⛔ Fără migrații.
- ⛔ Dacă `old_str` nu se potrivește exact, **OPREȘTE-TE și raportează** cu contextul real. Nu improviza.
