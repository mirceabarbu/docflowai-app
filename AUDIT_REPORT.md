# DocFlowAI — Audit consistență Etapa 5 (df-shell)

**Data:** 2026-04-19  
**Versiune:** v3.9.270  
**Scope:** 6 pagini migrate (admin, semdoc-initiator, formular, flow, templates, notifications)

---

## 1. CSS links per pagină

| Pagină | tokens.css | shell.css | components.css | admin.css | mobile.css | Ordine | ?v= |
|--------|-----------|-----------|----------------|-----------|-----------|--------|-----|
| admin.html | ✓ L7 | ✓ L8 | ✓ L9 | ✓ L10 | ✓ L12 | ✓ | 3.9.270 |
| semdoc-initiator.html | ✓ L7 | ✓ L8 | ✓ L9 | — | ✓ L232 ⚠️ | ✓ | 3.9.270 |
| formular.html | ✓ L7 | ✓ L8 | ✓ L9 | — | ✓ L13 | ✓ | 3.9.270 |
| flow.html | ✓ L7 | ✓ L8 | ✓ L9 | — | ✓ L252 ⚠️ | ✓ | 3.9.270 |
| templates.html | ✓ L7 | ✓ L8 | ✓ L9 | — | ✓ L138 | ✓ | 3.9.270 |
| notifications.html | ✓ L7 | ✓ L8 | ✓ L9 | — | ✓ L110 | ✓ | 3.9.270 |

**Observații:**
- Toate respectă ordinea corectă `tokens → shell → components`.
- Niciun CSS deprecated (main.css, styles.css, admin-v1 etc.) — **CLEAN**.
- `semdoc-initiator.html` (L232) și `flow.html` (L252): `mobile.css` este încărcat **în body** (după conținut), nu în `<head>`. Risc FOUC pe mobile. Celelalte 4 pagini îl au corect în `<head>`.

---

## 2. Drift de tokens (`:root` local)

| Pagină | :root{} prezent | Variabile locale | Hardcode raw | Verdict |
|--------|-----------------|-----------------|-------------|---------|
| admin.html | ✗ | — | — | ✅ CLEAN |
| semdoc-initiator.html | ✓ L43 | `--bg, --card, --muted, --text, --sub, --line, --accent` | — | ⚠️ DRIFT |
| formular.html | ✓ L15 + L245 | `--app-bg, --app-text, --app-sub, --app-muted, --app-line, --app-v, --app-p1, --app-p1-bdr, --app-p2, --app-p2-bdr` | `rgba(108,79,240,.15)` `rgba(29,200,174,.1)` | ❌ DRIFT MAJOR |
| flow.html | ✓ L13 | `--bg1, --bg2, --stroke, --txt, --sub, --accent` | `--ok:#26d07c` | ⚠️ DRIFT |
| templates.html | ✓ L11 | `--surface, --surface2, --accent, --sub, --muted, --line, --radius, --danger, --bg` | `--accent2:#2dd4bf` | ⚠️ DRIFT |
| notifications.html | ✓ L11 | `--card, --accent, --sub, --muted, --line, --text` | `--accent2:#2dd4bf` | ⚠️ DRIFT |

**Detalii drift:**

**semdoc-initiator.html** (L43–50): layer de aliasuri fără necesar (`--bg`, `--accent` etc. → re-mapate din df-tokens). Codul din body le folosește în loc de `--df-*` direct.

**formular.html** (L15–21 + L245): două blocuri `:root{}`. Al doilea introduce culori RGBA hardcodate pentru `--app-p1/--app-p2` (violet semitransparent, teal semitransparent) — nu există echivalent în `df/tokens.css`.

**flow.html** (L13–17): `--ok:#26d07c` este o culoare de succes hardcodată; ar trebui să fie `var(--df-success)` dacă tokenul există, sau adăugat în tokens.css.

**templates.html / notifications.html**: ambele definesc `--accent2:#2dd4bf` identic (duplicat cross-page) — candidat pentru token global `--df-teal` sau `--df-secondary`.

---

## 3. Clase legacy reziduale

| Pagină | `app-hdr` | `h-brand` | `.tabbtn` | `class="nav-btn"` | Verdict |
|--------|----------|----------|----------|-------------------|---------|
| admin.html | 0 | 0 | 0 | 0 | ✅ CLEAN |
| semdoc-initiator.html | 0 | 0 | 0 | 0 | ✅ CLEAN |
| formular.html | 0 | 0 | 0 | 0 | ✅ CLEAN |
| flow.html | 0 | 0 | 0 | 0 | ✅ CLEAN |
| templates.html | 0 | 0 | 0 | 0 | ✅ CLEAN |
| notifications.html | 0 | 0 | 0 | 0 | ✅ CLEAN |

Toate paginile sunt **complet curate** de clase pre-migrare.

---

## 4. Structura shell

| Pagină | `df-sidebar` | `df-page` | `df-page-header` | `df-page-body` | Tag body element | Verdict |
|--------|-------------|----------|-----------------|---------------|-----------------|---------|
| admin.html | ✓ L51 | ✓ L126 | ✓ L127 | ✓ L164 | `<div>` ⚠️ | ⚠️ |
| semdoc-initiator.html | ✓ L263 | ✓ L337 | ✓ L339 | ✓ L387 | `<main>` ✓ | ✅ |
| formular.html | ✓ L356 | ✓ L430 | ✓ L432 | ✓ L473 | `<main>` ✓ | ✅ |
| flow.html | ✓ L257 | ✓ L331 | ✓ L332 | ✓ L374 | `<main>` ✓ | ✅ |
| templates.html | ✓ L145 | ✓ L222 | ✓ L223 | ✓ L264 | `<main>` ✓ | ✅ |
| notifications.html | ✓ L117 | ✓ L194 | ✓ L195 | ✓ L241 | `<main>` ✓ | ✅ |

**Observație critică:** `admin.html` folosește `<div class="df-page-body">` în loc de `<main class="df-page-body">`. Celelalte 5 pagini folosesc `<main>` — inconsistență semantică HTML5. Nu afectează stilizarea (class-ul e identic), dar admin.html ar trebui aliniat.

---

## 5. Consistență sidebar

**Structură secțiuni per pagină:**

| Pagină | Navigare app | Administrare | Organizație | Comunicare | Active item corect |
|--------|-------------|-------------|------------|-----------|-------------------|
| admin.html | ✓ | ✓ | ✓ | ✓ | ✓ (button data-tab) |
| semdoc-initiator.html | ✓ | ✓ | ✓ | ✓ | ✓ (JS setează) |
| formular.html | ✓ | ✓ | ✓ | ✓ | ✓ L375 active |
| flow.html | ✓ | ✓ | ✓ | ✓ | ✓ L268 active |
| templates.html | ✓ | ✓ | ✓ | ✓ | ✓ L160 active |
| notifications.html | ✓ | ✓ | ✓ | ✓ | ✓ L184 active |

**Observații:**
- Toate 6 paginile au **4 secțiuni identice**: Navigare app / Administrare / Organizație / Comunicare — **UNIFORM** ✓.
- Iconițe: **exclusiv SVG** (`ico-*` sprite) pe toate paginile — **niciun emoji** ✓.
- `admin.html` sidebar: itemele din "Administrare" și "Organizație" sunt `<button>` cu `onclick=switchTab(...)` (SPA în-pagină), celelalte pagini folosesc `<a href>` — comportament diferit dar intenționat.
- Nicio secțiune "Document" dedicată pe flow.html / formular.html (menționată în spec audit ca opțională — absența e acceptabilă; paginile se identifică prin `active` pe link-ul corespunzător din "Navigare app").
- Toate link-urile din sidebar (`/`, `/?tab=flows`, `/templates`, `/formular.html`, `/admin#*`, `/notifications`) există efectiv în aplicație — **niciun link rupt detectat**.

---

## 6. Max-width & anomalii de width

**Regula din `shell.css`:**
- `.df-page-header`: `max-width:1600px; margin:0 auto`
- `.df-page-body`: `max-width:1600px; margin:0 auto`

**Overrides inline detectate:**

| Pagină | Linie | Override | Impact | Verdict |
|--------|-------|----------|--------|---------|
| semdoc-initiator.html | L16 | `main { max-width:1200px; margin:0 auto }` | Layout la 1200px vs 1600px din shell.css | ⚠️ DRIFT |
| formular.html | L33 | `.tabs { width:fit-content }` | Widget tabs intern, nu layout global | ✅ OK |
| formular.html | L64,229 | `@media(max-width:580px/720px)` | Breakpoints responsive interne | ✅ OK |
| admin.html | Multiple | `max-width` pe `<div>` de modale | Containere modale, nu layout global | ✅ OK |
| flow.html | L1355 | `max-width:520px` pe div modal | Container modal | ✅ OK |
| templates.html | L116 | `max-width:933px` în `<style>` | Container modal | ✅ OK |

**Detaliu semdoc-initiator.html:** `main { max-width: 1200px }` este declarat la L16 în `<style>`, dar `main.df-page-body { max-width: 1600px }` din shell.css are specificitate mai mare (class + element > element singur), deci shell.css câștigă. Override-ul este **cod mort** dar poate genera confuzie — ar trebui eliminat la viitoarea curățare inline CSS.

---

## 7. ?v= uniformitate

| Pagină | Versiuni ?v= distincte | Aliniat cu package.json (3.9.270) |
|--------|----------------------|----------------------------------|
| admin.html | `3.9.270` | ✅ |
| semdoc-initiator.html | `3.9.270` | ✅ |
| formular.html | `3.9.270` | ✅ |
| flow.html | `3.9.270` | ✅ |
| templates.html | `3.9.270` | ✅ |
| notifications.html | `3.9.270` | ✅ |

**Cache busting: UNIFORM ✓** — toate paginile și toate SVG sprite-urile folosesc exclusiv `?v=3.9.270`, aliniat cu `package.json`.

---

## 8. CSS inline (dimensiune `<style>`)

| Pagină | Linii `<style>` | Total linii | % | Verdict |
|--------|----------------|------------|---|---------|
| admin.html | 0 | 1.351 | 0% | ✅ CLEAN (mutat în admin.css) |
| semdoc-initiator.html | 161 | 2.703 | 6% | ⚠️ Acceptabil dar cu drift tokens |
| formular.html | 336 | 4.366 | 8% | ❌ DRIFT — candidat prioritar extragere |
| flow.html | 220 | 1.499 | 15% | ❌ DRIFT — raport ridicat |
| templates.html | 115 | 797 | 14% | ⚠️ Raport ridicat, volum moderat |
| notifications.html | 81 | 501 | 16% | ⚠️ Raport cel mai ridicat (16%) |

**Paginile cu `<style>` > 200 linii:** `formular.html` (336) și `flow.html` (220) sunt candidații principali pentru extragere în `df/components.css` sau fișiere CSS dedicate (`formular.css`, `flow.css`).

**Notă:** `admin.html` este modelul de urmat — 0 linii inline, tot stilul în `admin/admin.css`. Migrarea celorlalte pagini spre fișiere CSS dedicate ar reduce drastic dimensiunea HTML și ar simplifica auditurile viitoare.

---

## 9. Precache (sw.js)

**CACHE_VERSION:** `docflowai-v16`

**PRECACHE_ASSETS curent:**
```
/login.html, /flow.html, /Logo.png, /icon-192.png, /icon-72.png,
/mobile.css, /notif-widget.js, /offline.html
```

**Status pagini din scope:**

| Pagină | În PRECACHE_ASSETS | Observație |
|--------|-------------------|-----------|
| admin.html | ❌ absent | Admin necesită auth — offline caching nerelevant |
| semdoc-initiator.html | ❌ absent | Necesită auth + DB — offline nerelevant |
| formular.html | ❌ absent | Necesită auth + DB — offline nerelevant |
| flow.html | ✅ prezent | Corect — pagina de status e utilă offline (ETag cache) |
| templates.html | ❌ absent | Necesită auth + DB — offline nerelevant |
| notifications.html | ❌ absent | Necesită auth + DB — offline nerelevant |

**Verdict:** Absența paginilor autentificate din PRECACHE_ASSETS este **intenționată și corectă**. Singura pagină cu sens offline este `flow.html` (vizualizare status flux read-only cu ETag). Nu sunt necesare modificări.

**Observație:** `df/tokens.css`, `df/shell.css`, `df/components.css` nu sunt în PRECACHE_ASSETS — aceste CSS-uri sunt servite cu `Cache-Control` HTTP, nu prin SW cache. Dacă se dorește offline-first complet pentru `flow.html`, aceste assets ar trebui adăugate (task separat, nu în scope etapei curente).

---

## TOP recomandări cleanup (prioritizate)

### P1 — DRIFT TOKENS (impact direct pe coerență vizuală)

**1. Elimina toate blocurile `:root{}` inline din cele 5 pagini** și înlocuiește referințele cu `var(--df-*)` direct:
   - `semdoc-initiator.html`: `--bg/--card/--muted/--text/--sub/--line/--accent` → înlocuire directă (1:1 cu df-tokens)
   - `flow.html`: `--bg1/--bg2/--stroke/--txt/--sub/--accent` → înlocuire directă; `--ok:#26d07c` → verifică dacă `--df-success` există în tokens.css, dacă nu — adaugă
   - `templates.html` + `notifications.html`: au `--accent2:#2dd4bf` identic → adaugă `--df-teal: #2dd4bf` în tokens.css, referențiază de acolo
   - `formular.html`: `--app-*` aliases → înlocuire directă; `--app-p1/--app-p2` (RGBA hardcodate) → adaugă tokeni semantici în tokens.css (ex: `--df-primary-alpha-15`, `--df-teal-alpha-10`)

### P2 — CSS INLINE MAJOR (calitatea codului, maintainability)

**2. Extrage inline `<style>` din formular.html (336 linii) în `public/css/formular/formular.css`** — prioritar fiindcă are și DRIFT tokens major. Modelul: admin.html → admin.css.

**3. Extrage inline `<style>` din flow.html (220 linii, 15%) în `public/css/flow/flow.css`** — raport ridicat față de dimensiunea paginii.

### P3 — ANOMALII STRUCTURALE

**4. Corectează tag semantic în admin.html:** schimbă `<div class="df-page-body">` → `<main class="df-page-body">` pentru aliniare cu celelalte 5 pagini.

**5. Mută `mobile.css` în `<head>` pentru semdoc-initiator.html (L232) și flow.html (L252)** — previne FOUC pe dispozitive mobile (linkul CSS trebuie să fie în `<head>`, nu în body).

### P4 — CLEANUP MINOR (cod mort)

**6. Elimină `main { max-width: 1200px }` din semdoc-initiator.html L16** — override fără efect (specificitate mai mică decât `.df-page-body` din shell.css), dar creează confuzie la mentenanță.

---

*Raport generat read-only — zero modificări de fișiere. Branch: develop.*
