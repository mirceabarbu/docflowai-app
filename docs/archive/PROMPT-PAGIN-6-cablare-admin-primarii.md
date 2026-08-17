---
prompt_id: PAGIN-6
titlu: Cablarea componentei DFPagin pe admin/primarii.js (ultimul consumator din admin)
model_suggested: Sonnet 4.6 (Default)
branch: develop
version_target: 3.9.720
migratii: NU
cache_version_bump: DA — `/js/admin/primarii.js` E în PRECACHE_ASSETS
v_param_bump: DA — țintit DOAR pe primarii.js
---

# ⚠️ BRANCH: develop

`main` = producție, gestionat MANUAL de Mircea. Nu propune și nu executa `checkout/merge/push` pe `main`.

```bash
git branch --show-current   # Așteptat: develop
git log --oneline -1        # Așteptat: fae76f7 (PAGIN-5, v3.9.719) sau descendent
git status --porcelain      # docs/archive/*.md netrackuite pot rămâne — NU le include în commit
```

---

# CONTEXT

Al patrulea și **ultimul consumator din zona admin**. După el, toate cele patru pagini de administrare folosesc aceeași componentă, iar restul (Registratură, formulare) urmează în PAGIN-7…10.

⚠️ **Ca la PAGIN-5, aspectul SE SCHIMBĂ — intenționat.** `admin/primarii.js` are a cincea variantă de paginare din proiect: butoane numerotate, dar cu **stiluri inline** generate de un helper `btnStyle(active)`, `onclick` inline interpolat în `innerHTML`, fereastră `page±2` **fără prima/ultima pagină și fără elipsă**, plus un sufix „N pagini".

Fapte verificate pe cod (`public/js/admin/primarii.js`):
- paginarea NU e într-o funcție separată — e **inline la finalul lui `prLoad(page)`** (liniile ~77–89)
- server-paginat: `…&page=${_prPage}&limit=50` (linia 36)
- răspunsul are `items`, `total`, `page`, `pages`, `judete`
- containerul `#pr-pager` e static în `admin.html:1205`, cu stiluri inline
- ordinea scripturilor e deja corectă (`pagin.js` ~1619, `primarii.js` ~1625) — **nu o schimba**

**Redundanță de eliminat (același tipar ca la PAGIN-2):** pagina afișează AZI trei indicatori pentru aceeași listă —
1. `#pr-badge` → „2.943 instituții" (indicator de card, **rămâne**)
2. `#pr-info` → „Pagina 1 din 59 · 2943 rezultate" (**duplicat** al barei de paginare)
3. sufixul „N pagini" din interiorul pager-ului (**duplicat**, dispare odată cu blocul)

---

# Pas 1 — constantă unică pentru dimensiunea paginii

Adaugă lângă celelalte variabile module-level din capul IIFE-ului (grep `_prPage` pentru contextul exact):

```js
  const PR_PAGE_SIZE = 50;   // PAGIN-6 — sursă unică: cererea ȘI randarea paginării
```

`old_str`
```js
    const url   = `/admin/outreach/primarii?judet=${encodeURIComponent(judet)}&q=${encodeURIComponent(q)}&page=${_prPage}&limit=50`;
```

`new_str`
```js
    const url   = `/admin/outreach/primarii?judet=${encodeURIComponent(judet)}&q=${encodeURIComponent(q)}&page=${_prPage}&limit=${PR_PAGE_SIZE}`;
```

---

# Pas 2 — elimină contorul duplicat `#pr-info`

`old_str`
```js
      $('pr-badge').textContent = `${d.total.toLocaleString('ro-RO')} instituții`;
      $('pr-info').textContent  = `Pagina ${d.page} din ${d.pages} · ${d.total} rezultate`;
```

`new_str`
```js
      $('pr-badge').textContent = `${d.total.toLocaleString('ro-RO')} instituții`;
```

Și scoate elementul rămas gol din `public/admin.html`:

`old_str`
```html
    <div style="font-size:.77rem;color:var(--muted);margin-bottom:8px;" id="pr-info"></div>
```

`new_str`
```html
```

⚠️ Verifică prin grep că `pr-info` nu mai e referit nicăieri după ștergere (`grep -rn "pr-info" public/`). Dacă mai apare, **oprește-te și raportează**.

---

# Pas 3 — înlocuiește blocul de paginare cu `DFPagin.render`

`old_str`
```js
      // Paginare
      const pager = $('pr-pager');
      if (d.pages <= 1) { pager.innerHTML = ''; return; }
      const btnStyle = (active) =>
        `padding:5px 12px;border-radius:7px;border:1px solid rgba(255,255,255,.12);cursor:pointer;font-size:.8rem;font-weight:${active?700:400};background:${active?'rgba(124,92,255,.3)':'rgba(255,255,255,.04)'};color:${active?'#c4b5ff':'var(--muted)'};`;
      let btns = '';
      if (d.page > 1)     btns += `<button onclick="prLoad(${d.page-1})" style="${btnStyle(false)}">‹ Precedent</button>`;
      const start = Math.max(1, d.page-2), end = Math.min(d.pages, d.page+2);
      for (let i = start; i <= end; i++) btns += `<button onclick="prLoad(${i})" style="${btnStyle(i===d.page)}">${i}</button>`;
      if (d.page < d.pages) btns += `<button onclick="prLoad(${d.page+1})" style="${btnStyle(false)}">Următor ›</button>`;
      btns += `<span style="color:var(--muted);font-size:.76rem;align-self:center;">${d.pages} pagini</span>`;
      pager.innerHTML = btns;
```

`new_str`
```js
      // Paginare — componenta partajată DFPagin (PAGIN-6). Server-paginat:
      // onChange refetch-uiește prin prLoad, care resetează și selecția curentă.
      const pager = $('pr-pager');
      if (pager) {
        if (window.DFPagin && typeof window.DFPagin.render === 'function') {
          window.DFPagin.render({
            container: pager,
            total: d.total,
            page: d.page,
            limit: PR_PAGE_SIZE,
            mode: 'numbered',
            onChange: (p) => prLoad(p),
          });
        } else {
          // Fail-safe: componenta nu s-a încărcat — ascunde bara, nu rupe tabelul.
          console.error('DFPagin indisponibil — paginarea primăriilor e ascunsă');
          pager.replaceChildren();
          pager.style.display = 'none';
        }
      }
```

⚠️ **`return`-ul dispare.** Vechiul `if (d.pages <= 1) { … return; }` ieșea din `prLoad` — inofensiv atunci, fiindcă paginarea era ultimul lucru din `try`. DFPagin ascunde singur containerul când e o singură pagină, deci nu mai e nevoie de ieșire timpurie. **Verifică prin citire că după blocul ăsta nu mai urmează cod în `try` care ar fi fost sărit** înainte; dacă urmează, oprește-te și raportează.

ℹ️ `_prSelected.clear()` de la începutul lui `prLoad` rămâne neatins — schimbarea paginii golește selecția, exact ca azi.

---

# Pas 4 — `public/admin.html`: curăță stilurile inline de pe `#pr-pager`

Inline bate clasa, deci stilurile de pe container ar suprascrie parțial `.pagination` (îi lipsește `justify-content:center`, deci bara ar rămâne aliniată la stânga, spre deosebire de celelalte trei pagini de admin).

`old_str`
```html
    <div id="pr-pager" style="display:flex;gap:6px;align-items:center;margin-top:14px;flex-wrap:wrap;"></div>
```

`new_str`
```html
    <div id="pr-pager"></div>
```

⚠️ Verifică prin grep că nu există reguli CSS pe id-ul `#pr-pager` în `public/css/` (`grep -rn "pr-pager" public/css/`). Dacă există, **oprește-te și raportează**.

---

# Pas 5 — cache busting

```bash
grep -n "CACHE_VERSION = " public/sw.js
# Citește valoarea CURENTĂ (era docflowai-v296 după PAGIN-5). Incrementează cu 1.
```

```bash
NEW=3.9.720
sed -i -E "s#(js/admin/primarii\.js\?v=)[0-9.]+#\1$NEW#g" public/*.html
```

⛔ Niciun alt `?v=` nu se mișcă: `pagin.js` 3.9.716, `flows.js` 3.9.717, `users.js` 3.9.718, `audit.js` 3.9.719.

---

# Pas 6 — testul parametrizat

Adaugă o intrare pentru `primarii.js` în tabloul `CONSUMERS` din `server/tests/unit/pagin-wiring.test.mjs`. **Nu crea fișier nou.**

- `mustContain`: `DFPagin.render(`, `window.DFPagin &&`, `PR_PAGE_SIZE`, `onChange: (p) => prLoad(p)`
- `mustNotContain`: `btnStyle`, `onclick="prLoad(`, `‹ Precedent`, `pagini</span>`, `pr-info`

Plus două `it` separate pe `public/admin.html`:
- conține `<div id="pr-pager"></div>` **fără** atribut `style`
- **nu** mai conține `id="pr-info"`

---

# Pas 7 — verificări

```bash
node --check public/js/admin/primarii.js
# Așteptat: fără output

grep -c "btnStyle\|onclick=\"prLoad(" public/js/admin/primarii.js
# Așteptat: 0

grep -rn "pr-info" public/
# Așteptat: niciun rezultat

grep -n "window.prLoad" public/js/admin/primarii.js
# Așteptat: 1 — exportul PĂSTRAT (folosit din admin.html:1161 onchange="prLoad(1)"
#            și din public/js/admin/outreach.js:103)

grep -n "PR_PAGE_SIZE" public/js/admin/primarii.js
# Așteptat: 3 (declarația + URL + randarea)

grep -n "pr-pager" public/admin.html
# Așteptat: <div id="pr-pager"></div>, fără style=

grep -n "js/admin/primarii.js?v=\|js/admin/audit.js?v=\|js/admin/users.js?v=\|js/admin/flows.js?v=\|js/shared/pagin.js?v=" public/admin.html
# Așteptat: 3.9.720 / 3.9.719 / 3.9.718 / 3.9.717 / 3.9.716

npx vitest run server/tests/unit/pagin-wiring.test.mjs
# Așteptat: toate verzi, CONSUMERS are 4 intrări

npm test
# Așteptat: verde, fără regresii

npm run test:db
# Așteptat: PASSED. Rețeta PG 17 efemer (port 55432) din PAGIN-4/5.
# ⛔ Docker absent NU e motiv de skip.

git diff --stat
# Așteptat: primarii.js, admin.html, sw.js, pagin-wiring.test.mjs, package.json/-lock.
# ZERO atingeri în flows.js, users.js, audit.js, outreach.js, pagin.js, formular/, registratura/
```

```bash
npm version 3.9.720 --no-git-tag-version
git add -A
git status --short          # OBLIGATORIU înainte de commit (lecția PAGIN-4)
git commit -m "refactor(ui): admin/primarii.js folosește componenta DFPagin (PAGIN-6, v3.9.720)"
git push origin develop
```

---

# ACCEPTANCE MANUAL (Mircea, pe staging, `Ctrl+Shift+R`)

⚠️ Aspectul **se schimbă** — asta e ținta.

- [ ] Admin → Outreach → Primării: bara arată `◀ 1–50 din 2943  1 2 3 … 59 ▶`, centrată
- [ ] Aspectul e **identic** cu barele de la Fluxuri / Utilizatori / Audit
- [ ] Apar acum prima și ultima pagină + elipsă (înainte era doar fereastra `page±2`)
- [ ] **Nu mai apare** linia „Pagina X din Y · N rezultate" de deasupra tabelului
- [ ] Badge-ul „2.943 instituții" e neschimbat
- [ ] Filtrul pe județ și căutarea resetează la pagina 1
- [ ] Selecția de căsuțe se golește la schimbarea paginii (comportament vechi, păstrat)
- [ ] Adăugarea în campanie / import / editare rând funcționează ca înainte
- [ ] Fluxuri, Utilizatori, Audit: **neschimbate**

---

# RAPORT FINAL

1. Diff pe fiecare fișier.
2. Confirmă că după blocul de paginare NU mai urma cod în `try` care era sărit de vechiul `return` — arată ce urmează.
3. `window.prLoad` — păstrat? De ce e încă necesar?
4. Reguli CSS pe `#pr-pager` sau `#pr-info` în `public/css/`? Care?
5. `CACHE_VERSION` înainte / după.
6. `?v=` — listează toate cele cinci valori după modificare.
7. `CONSUMERS` — câte intrări, câte teste în suită?
8. `npm test` și `npm run test:db` — **PASSED sau SKIPPED?**
9. `git status --short` dinaintea commit-ului.
10. Commit hash + confirmare `develop`.
11. Orice abatere, cu motivul.

---

# ⛔ CONSTRÂNGERI

- ⛔ **Un singur consumator.** Nu atinge `admin/flows.js`, `admin/users.js`, `admin/audit.js`, `admin/outreach.js`, `formular/*`, `registratura/main.js`, `semdoc-initiator/main.js`.
- ⛔ **Nu modifica `public/js/shared/pagin.js`.**
- ⛔ **Nu șterge `window.prLoad`** și nu atinge `admin.html:1161` sau `outreach.js:103`.
- ⛔ **Nu atinge `#pr-badge`** — e alt indicator, ca `#flowsActiveCount`.
- ⛔ **Nu atinge `_prSelected`**, `prToggle`, `prSelectAll`, `prDeselectAll` sau logica de campanie.
- ⛔ **Nu curăța celelalte `onclick` inline din `primarii.js`** (`prToggle`, `prEditRow`, `prDeleteRow` din rândurile tabelului). Sunt datorie reală, dar altă discuție — nu o amesteca aici.
- ⛔ **Nu schimba `PR_PAGE_SIZE`** de la 50.
- ⛔ **Nu modifica CSS.**
- ⛔ **`?v=` țintit doar pe primarii.js.**
- ⛔ Zero atingeri în `server/` în afara fișierului de test.
- ⛔ Fără migrații.
- ⛔ Dacă `old_str` nu se potrivește exact, **OPREȘTE-TE și raportează** cu contextul real. Nu improviza.
