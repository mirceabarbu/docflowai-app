---
prompt_id: PAGIN-3
titlu: CSS de paginare mutat în components.css (deblocare) + limit 50 la Administrare fluxuri
model_suggested: Sonnet 4.6 (Default)
branch: develop
version_target: 3.9.717
migratii: NU
cache_version_bump: DA — `/js/admin/flows.js` E în PRECACHE_ASSETS
v_param_bump: DA — țintit pe components.css, admin.css, flows.js
---

# ⚠️ BRANCH: develop

`main` = producție, gestionat MANUAL de Mircea. Nu propune și nu executa `checkout/merge/push` pe `main`.

```bash
git branch --show-current   # Așteptat: develop
git log --oneline -1        # Așteptat: abae12d (PAGIN-2) sau descendent
git status --porcelain      # Așteptat: curat (CLAUDE.md a fost comis la deploy-ul 716)
```

---

# CONTEXT

Decizia lui Mircea: **paginare numerotată pe TOATE paginile** (azi doar admin o are; formularele și Registratura au variante prev/next diferite).

**Blocaj descoperit înainte de a scrie acest prompt:** clasele `.pagination` / `.pg-btn` / `.pg-info` sunt definite EXCLUSIV în `public/css/admin/admin.css` (liniile 17–22), iar `admin.css` e încărcat DOAR de `admin.html`. `formular.html` și `registratura.html` nu îl încarcă deloc. Dacă am cabla acum ALOP sau DF/ORD pe `mode:'numbered'`, componenta ar randa markup corect dar **complet nestilizat** — butoane albe de browser pe fundal întunecat.

Deci acest prompt e **deblocarea** pentru PAGIN-4…PAGIN-10. Nu cablează niciun consumator nou.

Destinația e `public/css/df/components.css` — încărcată de toate cele 15 pagini HTML și care găzduiește **deja exact acest tipar**: stilurile pentru helperul partajat `public/js/shared/file-item.js` stau la finalul ei (vezi comentariul de la linia ~567). Precedentul e identic; urmează-l.

**Bundling deliberat:** promptul conține DOUĂ schimbări (mutarea CSS + limitul de la fluxuri). Ambele aparțin aceluiași șantier de paginare, ambele sunt de câteva linii, iar bump-ul de `CACHE_VERSION` e oricum necesar pentru `flows.js`. Nu e amestec de preocupări — dar ține pașii separați în diff.

---

# Pas 1 — mută cele 6 reguli în `components.css`

Adaugă la **finalul** fișierului `public/css/df/components.css`, după blocul `.df-file-item*`, respectând convenția de acolo (fără indentare, cu antet de secțiune):

```css
/* ── Paginare partajată — helper window.DFPagin (public/js/shared/pagin.js) ──
   Mutate din admin/admin.css (PAGIN-3): componenta e folosită și de paginile
   care NU încarcă admin.css (formular.html, registratura.html). Aspectul
   rămâne bit-identic cu cel din admin — doar locul definiției se schimbă. */
.pagination{display:flex;align-items:center;justify-content:center;gap:6px;margin-top:14px;flex-wrap:wrap;}
.pg-btn{padding:5px 12px;border-radius:7px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:var(--sub);font-size:.82rem;cursor:pointer;}
.pg-btn:hover{background:var(--df-primary-bg);border-color:var(--df-primary-bd);}
.pg-btn.active{background:var(--df-primary);color:#fff;border-color:var(--df-primary);font-weight:600;}
.pg-btn:disabled{opacity:.35;cursor:default;}
.pg-info{font-size:.8rem;color:var(--muted);margin:0 6px;}
```

⚠️ **Copiere byte-cu-byte a valorilor.** Nu „îmbunătăți" nimic — nici culori, nici spațieri, nici ordinea proprietăților. Scopul e mutare, nu redesign. Orice diferență de valoare devine o regresie vizuală pe patru pagini de admin aflate deja în producție.

⚠️ Verifică înainte că variabilele folosite (`--sub`, `--muted`, `--df-primary`, `--df-primary-bg`, `--df-primary-bd`) sunt disponibile în contextul `components.css` — sunt definite în `tokens.css`, încărcată ÎNAINTEA lui `components.css` pe toate paginile. Confirmă prin grep; dacă vreuna lipsește, **oprește-te și raportează**.

---

# Pas 2 — șterge-le din `admin.css`

`old_str`
```css
    .tbl-wrap{overflow-x:auto; padding-bottom:8px; margin-bottom:0;}
    .pagination{display:flex;align-items:center;justify-content:center;gap:6px;margin-top:14px;flex-wrap:wrap;}
    .pg-btn{padding:5px 12px;border-radius:7px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:var(--sub);font-size:.82rem;cursor:pointer;}
    .pg-btn:hover{background:var(--df-primary-bg);border-color:var(--df-primary-bd);}
    .pg-btn.active{background:var(--df-primary);color:#fff;border-color:var(--df-primary);font-weight:600;}
    .pg-btn:disabled{opacity:.35;cursor:default;}
    .pg-info{font-size:.8rem;color:var(--muted);margin:0 6px;}
    table{width:100%;border-collapse:collapse;font-size:.82rem;}
```

`new_str`
```css
    .tbl-wrap{overflow-x:auto; padding-bottom:8px; margin-bottom:0;}
    /* .pagination, .pg-btn, .pg-info → df/components.css (PAGIN-3, helper DFPagin) */
    table{width:100%;border-collapse:collapse;font-size:.82rem;}
```

ℹ️ Comentariul-indicator urmează convenția deja existentă în fișier (vezi linia 14: `/* .grid*, .frow, label, … → df/components.css (BLOC 5) */`).

⚠️ **Nu lăsa regulile duplicate în ambele fișiere.** Două definiții ale aceleiași clase = drift garantat la prima modificare viitoare. `admin.html` încarcă `components.css` (linia 9) ÎNAINTEA lui `admin.css` (linia 11), deci adminul rămâne stilizat corect după mutare.

---

# Pas 3 — limit 10 → 50 la Administrare fluxuri

Cu 1069 de fluxuri în producție, `limit: 10` produce **107 pagini**. Toate celelalte liste de admin (`audit.js`, `primarii.js`) și Registratura folosesc 50, iar 50 e și implicitul serverului. Fluxurile sunt singura excepție.

`old_str`
```js
    const params = new URLSearchParams({ page, limit: 10, status: statusParam });
```

`new_str`
```js
    const params = new URLSearchParams({ page, limit: 50, status: statusParam });
```

Aliniază și fallback-ul din apelul componentei (introdus în PAGIN-2), ca să nu rămână o valoare divergentă:

`old_str`
```js
            limit: resp.limit || 10,
```

`new_str`
```js
            limit: resp.limit || 50,
```

⚠️ Serverul (`/admin/flows/list`) plafonează `limit` la 200 și echoează valoarea în răspuns — 50 e acceptat. Confirmă prin grep pe `server/routes/admin/flows.mjs`; dacă plafonul e mai mic de 50, **oprește-te și raportează**.

---

# Pas 4 — cache busting

`/js/admin/flows.js` E în `PRECACHE_ASSETS`:

```bash
grep -n "CACHE_VERSION = " public/sw.js
# Citește valoarea CURENTĂ (era docflowai-v293 după PAGIN-2). Incrementează cu 1.
```

`?v=` **țintit per asset schimbat** (regula din CLAUDE.md §Cache busting — niciodată sed global peste toate assetele):

```bash
NEW=3.9.717
sed -i -E "s#(css/df/components\.css\?v=)[0-9.]+#\1$NEW#g" public/*.html
sed -i -E "s#(css/admin/admin\.css\?v=)[0-9.]+#\1$NEW#g"   public/*.html
sed -i -E "s#(js/admin/flows\.js\?v=)[0-9.]+#\1$NEW#g"     public/*.html
```

⚠️ `components.css` e referită în **15** fișiere HTML — de aceea sed-ul rulează peste `public/*.html`, dar **doar pentru acel asset**. Niciun alt `?v=` nu are voie să se miște. Fișierele CSS nu sunt în `PRECACHE_ASSETS`, deci `?v=` e suficient pentru ele; bump-ul de `CACHE_VERSION` e strict pentru `flows.js`.

---

# Pas 5 — test de structură

Adaugă în `server/tests/unit/pagin-wiring-admin-flows.test.mjs` (fișierul din PAGIN-2) trei cazuri noi:

1. `public/css/df/components.css` conține `.pg-btn{` și `.pagination{` și `.pg-info{`.
2. `public/css/admin/admin.css` **nu** mai conține `.pg-btn{` — regulile nu sunt duplicate.
3. `public/js/admin/flows.js` conține `limit: 50` și **nu** mai conține `limit: 10` sau `resp.limit || 10`.

Asta e o invariantă structurală (unde stă o definiție), deci analiza pe sursă e potrivită aici.

---

# Pas 6 — verificări

```bash
grep -c "\.pg-btn{" public/css/df/components.css
# Așteptat: 1

grep -c "\.pg-btn{" public/css/admin/admin.css
# Așteptat: 0

grep -n "limit: 10\|resp.limit || 10" public/js/admin/flows.js
# Așteptat: niciun rezultat

grep -c "components.css?v=3.9.717" public/*.html | grep -v ":0" | wc -l
# Așteptat: 15 (toate paginile care o încarcă)

grep -rn "?v=3.9.693" public/admin.html | head
# Așteptat: celelalte assete NEATINSE își păstrează versiunile vechi

grep -n "CACHE_VERSION = " public/sw.js
# Așteptat: incrementat cu exact 1

node --check public/js/admin/flows.js
npx vitest run server/tests/unit/pagin-wiring-admin-flows.test.mjs
# Așteptat: 9 cazuri verzi (6 din PAGIN-2 + 3 noi)

npm test
# Așteptat: verde, fără regresii

npm run test:db
# Așteptat: PASSED. PG 17 local:
#   TEST_DATABASE_URL=postgres://postgres:test@localhost:5432/docflow_test
# ⛔ Docker absent NU e motiv de skip.

git diff --stat
# Așteptat: components.css, admin.css, flows.js, sw.js, testul, package.json/-lock
#           + fișierele HTML atinse DOAR de cele trei sed-uri țintite
```

```bash
npm version 3.9.717 --no-git-tag-version
git add -A
git commit -m "refactor(ui): CSS paginare mutat în components.css + limit 50 la fluxuri (PAGIN-3, v3.9.717)"
git push origin develop
```

---

# ACCEPTANCE MANUAL (Mircea, pe staging, cu `Ctrl+Shift+R`)

- [ ] Admin → Fluxuri: bara arată **identic** cu înainte (◀ 1–50 din 1069, numere, ▶) — doar numărul de pagini scade de la 107 la 22
- [ ] Admin → Utilizatori / Audit / Organizații: paginarea arată **neschimbată** (dovada că mutarea CSS n-a rupt nimic)
- [ ] Tabelul de fluxuri afișează 50 de rânduri pe pagină, scroll-ul funcționează
- [ ] Filtrele resetează la pagina 1 și recalculează corect numărul de pagini

---

# RAPORT FINAL

1. Diff pe fiecare fișier, cu pașii separați (CSS vs limit).
2. Confirmarea că valorile CSS mutate sunt **byte-identice** cu originalele (arată un diff sau un `grep` comparativ).
3. Variabilele CSS (`--sub`, `--muted`, `--df-primary*`) — confirmate ca disponibile în contextul `components.css`?
4. Plafonul de `limit` din `server/routes/admin/flows.mjs` — care e, și acceptă 50?
5. `CACHE_VERSION` înainte / după (citit din fișier).
6. Câte fișiere HTML au fost atinse de fiecare din cele trei sed-uri; confirmă că niciun alt `?v=` nu s-a mișcat.
7. Cele 9 cazuri de test — verzi?
8. `npm test` și `npm run test:db` — **PASSED sau SKIPPED?**
9. Commit hash + confirmare `develop`.
10. Orice abatere, cu motivul.

---

# ⛔ CONSTRÂNGERI

- ⛔ **Zero consumatori noi.** Nu atinge `admin/users.js`, `admin/audit.js`, `admin/primarii.js`, `formular/list.js`, `formular/alop.js`, `registratura/main.js`, `semdoc-initiator/main.js`. Cablarea lor vine în PAGIN-4…PAGIN-10.
- ⛔ **Nu modifica `public/js/shared/pagin.js`.**
- ⛔ **Mutare, nu redesign.** Valorile CSS se copiază exact. Nicio proprietate adăugată, scoasă sau „ordonată frumos".
- ⛔ **Fără reguli duplicate** — după mutare, `.pagination`/`.pg-btn`/`.pg-info` există într-un SINGUR fișier.
- ⛔ **`?v=` țintit pe cele trei assete.** Un sed global peste toate assetele ar șterge drift-ul intenționat dintre `package.json` și `?v=`.
- ⛔ Zero atingeri în `server/` în afara fișierului de test.
- ⛔ Fără migrații.
- ⛔ Dacă vreun `old_str` nu se potrivește exact, **OPREȘTE-TE și raportează** cu contextul real. Nu improviza.
