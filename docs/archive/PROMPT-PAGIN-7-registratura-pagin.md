---
title: PAGIN-7 — cablare DFPagin pe registratura/main.js (DOUĂ state-uri)
model_suggested: Sonnet 4.6 (Default)   # UX chirurgical, izolat, fără migrație, fără backend
target_version: 3.9.721
branch: develop
migration: NU
cache_version_bump: NU   # nici registratura/main.js nici shared/pagin.js nu sunt în PRECACHE_ASSETS (verificat)
---

# ⚠️ BRANCH: develop — NU atinge `main` (producție, o gestionează Mircea manual)

Toate comenzile rulează pe `develop`. NU face `checkout`/`merge`/`push` spre `main`.
Un singur commit, un singur bump de versiune (3.9.720 → 3.9.721).

===============================================================================
## CONTEXT
===============================================================================

Al 7-lea consumator din șantierul de paginare. Componenta partajată
`public/js/shared/pagin.js` (`window.DFPagin.render`) e deja live și cablată pe
toată zona admin (PAGIN-2…6). Acum o cablăm pe **Registratură**.

Particularitatea lui PAGIN-7 (de aceea e cel mai delicat):
`public/js/registratura/main.js` are **DOUĂ** state-uri de paginare simetrice —
`stateOut` (Ieșiri, Faza 1) și `stateIn` (Intrări, Faza 2). Ambele sunt
**server-paginate** (trimit `?page=&limit=`, primesc `total` de la server), exact
ca `admin/audit.js` (PAGIN-5). Deci `onChange` **refetch-uiește** (nu re-randează
client-side ca `users.js`).

⚠️ Testul de wiring impune „`DFPagin.render(` apare **exact o dată**" per
consumator. Ca să respectăm asta cu două state-uri, introducem un **singur helper**
`renderPag(el, st, load)` care conține unicul apel `DFPagin.render`, apelat de
`renderPagOut` și `renderPagIn`. Mai curat (DRY) și păstrează invarianta.

Schimbare de aspect (de anunțat în acceptance): barele „‹ Anterior · Pagina X / Y ·
Următor ›" + contorul separat „N înregistrări" devin **bara numerotată centrată**
(`◀ · 1–50 din N · 1 2 3 … · ▶`). „N înregistrări" dispare ca element separat —
informația e acum în `pg-info` („1–50 din N"). Identic cu restul admin-ului.

CSS: `registratura.html` încarcă deja `css/df/components.css` (unde stau
`.pagination/.pg-btn/.pg-info`, mutate acolo la PAGIN-3) → **zero CSS de scris**.

===============================================================================
## PAS 0 — PREFLIGHT (read-only)
===============================================================================

```bash
cd <repo>
git checkout develop && git pull --ff-only
git branch --show-current          # Așteptat: develop
grep '"version"' package.json      # Așteptat: "3.9.720"
grep -n 'registratura/main.js?v=' public/registratura.html   # Așteptat: ?v=3.9.693 (NU presupune — citește)
grep -c 'DFPagin.render(' public/js/registratura/main.js     # Așteptat: 0 (încă necablat)
```

Dacă `version` ≠ 3.9.720, OPREȘTE-TE și raportează (arhiva era pe 720).

===============================================================================
## PAS 1 — registratura.html: încarcă pagin.js ÎNAINTEA lui main.js + bump ?v=
===============================================================================

Ambele au `defer` → se execută în ordinea documentului după parse; pagin.js fiind
mai sus în sursă, `window.DFPagin` e definit înainte să ruleze main.js. (Formă
identică cu admin.html.)

**old_str**
```html
  <script src="/js/registratura/main.js?v=3.9.693" defer></script>
```
**new_str**
```html
  <script src="/js/shared/pagin.js?v=3.9.721" defer></script>
  <script src="/js/registratura/main.js?v=3.9.721" defer></script>
```

> ⚠️ Bump `?v=` **țintit** DOAR pe main.js (+ pagin.js nou). NU atinge celelalte
> `?v=` din pagină (df-utils, df-shell, components.css etc.) — regula din
> CLAUDE.md §Cache busting (`?v=` driftează intenționat de package.json).

Verificare:
```bash
grep -n 'shared/pagin.js\|registratura/main.js' public/registratura.html
# Așteptat: pagin.js?v=3.9.721 pe linia DINAINTEA lui main.js?v=3.9.721
```

===============================================================================
## PAS 2 — registratura.html: bara IEȘIRI → container unic #reg-pagination
===============================================================================

**old_str**
```html
          <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 4px;font-size:.84rem;color:var(--df-text-3);">
            <span id="reg-total">—</span>
            <div style="display:flex;gap:8px;align-items:center;">
              <button class="df-action-btn" id="reg-prev" type="button" disabled>‹ Anterior</button>
              <span id="reg-page">1</span>
              <button class="df-action-btn" id="reg-next" type="button" disabled>Următor ›</button>
            </div>
          </div>
```
**new_str**
```html
          <div id="reg-pagination"></div>
```

===============================================================================
## PAS 3 — registratura.html: bara INTRĂRI → container unic #regin-pagination
===============================================================================

**old_str**
```html
          <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 4px;font-size:.84rem;color:var(--df-text-3);">
            <span id="regin-total">—</span>
            <div style="display:flex;gap:8px;align-items:center;">
              <button class="df-action-btn" id="regin-prev" type="button" disabled>‹ Anterior</button>
              <span id="regin-page">1</span>
              <button class="df-action-btn" id="regin-next" type="button" disabled>Următor ›</button>
            </div>
          </div>
```
**new_str**
```html
          <div id="regin-pagination"></div>
```

===============================================================================
## PAS 4 — main.js: helper unic renderPag (paginare pe SERVER, un singur render)
===============================================================================

Inserează helperul între finalul lui `populateYears` și comentariul secțiunii IEȘIRI.

**old_str**
```javascript
    sel.innerHTML = opts.join('');
  }

  // ───── IEȘIRI (Faza 1) ────────────────────────────────────────────────────
```
**new_str**
```javascript
    sel.innerHTML = opts.join('');
  }

  // ───── Paginare (componentă partajată DFPagin) ────────────────────────────
  // PAGIN-7 — un SINGUR apel DFPagin.render, refolosit de renderPagOut/renderPagIn
  // (invarianta „exact o dată" din testul de wiring se păstrează). Paginare pe
  // SERVER: onChange schimbă pagina în state și refetch-uiește lista.
  function renderPag(el, st, load) {
    if (!el) return;
    if (window.DFPagin && typeof window.DFPagin.render === 'function') {
      window.DFPagin.render({
        container: el,
        total: st.total,
        page: st.page,
        limit: st.limit,
        mode: 'numbered',
        onChange: (p) => { st.page = p; load(); },
      });
    } else {
      // Fail-safe: componenta nu s-a încărcat — ascunde bara, nu rupe tabelul.
      console.error('DFPagin indisponibil — paginarea registraturii e ascunsă');
      el.replaceChildren();
      el.style.display = 'none';
    }
  }

  // ───── IEȘIRI (Faza 1) ────────────────────────────────────────────────────
```

===============================================================================
## PAS 5 — main.js: renderPagOut → delegă la renderPag
===============================================================================

**old_str**
```javascript
  function renderPagOut() {
    const totalPages = Math.max(1, Math.ceil(stateOut.total / stateOut.limit));
    const totalEl = $('reg-total');
    const pageEl = $('reg-page');
    const prev = $('reg-prev');
    const next = $('reg-next');
    if (totalEl) totalEl.textContent = `${stateOut.total} înregistrări`;
    if (pageEl)  pageEl.textContent  = `Pagina ${stateOut.page} / ${totalPages}`;
    if (prev) prev.disabled = stateOut.page <= 1;
    if (next) next.disabled = stateOut.page >= totalPages;
  }
```
**new_str**
```javascript
  function renderPagOut() {
    renderPag($('reg-pagination'), stateOut, loadOut);
  }
```

===============================================================================
## PAS 6 — main.js: renderPagIn → delegă la renderPag
===============================================================================

**old_str**
```javascript
  function renderPagIn() {
    const totalPages = Math.max(1, Math.ceil(stateIn.total / stateIn.limit));
    const totalEl = $('regin-total');
    const pageEl = $('regin-page');
    const prev = $('regin-prev');
    const next = $('regin-next');
    if (totalEl) totalEl.textContent = `${stateIn.total} înregistrări`;
    if (pageEl)  pageEl.textContent  = `Pagina ${stateIn.page} / ${totalPages}`;
    if (prev) prev.disabled = stateIn.page <= 1;
    if (next) next.disabled = stateIn.page >= totalPages;
  }
```
**new_str**
```javascript
  function renderPagIn() {
    renderPag($('regin-pagination'), stateIn, loadIn);
  }
```

===============================================================================
## PAS 7 — main.js: scoate listenerele prev/next moarte din wireOut
===============================================================================

⚠️ OBLIGATORIU: `#reg-prev`/`#reg-next` nu mai există în DOM → `$('reg-prev')`
întoarce `null` → `null.addEventListener` ar arunca și ar rupe tot `wireOut()`
(deci și `init`). Trebuie eliminate.

**old_str**
```javascript
    $('reg-refresh').addEventListener('click', () => loadOut());
    $('reg-prev').addEventListener('click', () => { if (stateOut.page > 1) { stateOut.page--; loadOut(); } });
    $('reg-next').addEventListener('click', () => { stateOut.page++; loadOut(); });
    $('reg-export').addEventListener('click', () => {
```
**new_str**
```javascript
    $('reg-refresh').addEventListener('click', () => loadOut());
    $('reg-export').addEventListener('click', () => {
```

===============================================================================
## PAS 8 — main.js: scoate listenerele prev/next moarte din wireIn
===============================================================================

**old_str**
```javascript
    $('regin-refresh').addEventListener('click', () => loadIn());
    $('regin-prev').addEventListener('click', () => { if (stateIn.page > 1) { stateIn.page--; loadIn(); } });
    $('regin-next').addEventListener('click', () => { stateIn.page++; loadIn(); });
    $('regin-new').addEventListener('click', openModal);
```
**new_str**
```javascript
    $('regin-refresh').addEventListener('click', () => loadIn());
    $('regin-new').addEventListener('click', openModal);
```

===============================================================================
## PAS 9 — test de wiring: adaugă PAGIN-7 în tabloul CONSUMERS (NU fișier nou)
===============================================================================

Fișier: `server/tests/unit/pagin-wiring.test.mjs`

### 9a — sursă HTML pentru registratura
**old_str**
```javascript
const adminCssSrc = readPublic('css/admin/admin.css');
```
**new_str**
```javascript
const adminCssSrc = readPublic('css/admin/admin.css');
const registraturaHtmlSrc = readPublic('registratura.html');
```

### 9b — intrarea PAGIN-7 în CONSUMERS (înainte de `];`)
**old_str**
```javascript
    mustContain: ['DFPagin.render(', 'window.DFPagin &&', 'PR_PAGE_SIZE', 'onChange: (p) => prLoad(p)'],
    mustNotContain: ['btnStyle', 'onclick="prLoad(', '‹ Precedent', 'pagini</span>', 'pr-info'],
  },
];
```
**new_str**
```javascript
    mustContain: ['DFPagin.render(', 'window.DFPagin &&', 'PR_PAGE_SIZE', 'onChange: (p) => prLoad(p)'],
    mustNotContain: ['btnStyle', 'onclick="prLoad(', '‹ Precedent', 'pagini</span>', 'pr-info'],
  },
  {
    label: 'PAGIN-7 — registratura/main.js',
    jsPath: 'js/registratura/main.js',
    htmlPath: 'registratura.html',
    htmlSrc: registraturaHtmlSrc,
    mustContain: ['DFPagin.render(', 'window.DFPagin &&', "mode: 'numbered'", 'renderPag('],
    mustNotContain: ["$('reg-prev')", "$('reg-next')", "$('regin-prev')", "$('regin-next')", 'Pagina ${stateOut.page}', 'Pagina ${stateIn.page}'],
  },
];
```

### 9c — describe specific PAGIN-7 (la finalul fișierului, după blocul PAGIN-6)
**old_str**
```javascript
  it('nu mai conține id="pr-info"', () => {
    expect(adminHtmlSrc).not.toContain('id="pr-info"');
  });
});
```
**new_str**
```javascript
  it('nu mai conține id="pr-info"', () => {
    expect(adminHtmlSrc).not.toContain('id="pr-info"');
  });
});

describe('PAGIN-7 — registratura.html containere fără prev/next static', () => {
  it('conține <div id="reg-pagination"></div> și <div id="regin-pagination"></div>', () => {
    expect(registraturaHtmlSrc).toContain('<div id="reg-pagination"></div>');
    expect(registraturaHtmlSrc).toContain('<div id="regin-pagination"></div>');
  });

  it('nu mai conține butoanele statice reg-prev/regin-prev', () => {
    expect(registraturaHtmlSrc).not.toContain('id="reg-prev"');
    expect(registraturaHtmlSrc).not.toContain('id="regin-prev"');
  });
});
```

===============================================================================
## PAS 10 — bump versiune
===============================================================================

**old_str**
```json
  "version": "3.9.720",
```
**new_str**
```json
  "version": "3.9.721",
```

> ⛔ NU bump `CACHE_VERSION` din `public/sw.js` — nici `registratura/main.js`,
> nici `shared/pagin.js` nu sunt în `PRECACHE_ASSETS`. Lasă `docflowai-v297`.

===============================================================================
## PAS 11 — VERIFICARE
===============================================================================

```bash
node --check public/js/registratura/main.js        # Așteptat: fără erori

grep -c 'DFPagin.render(' public/js/registratura/main.js   # Așteptat: 1 (doar în helper)
grep -c 'renderPag(' public/js/registratura/main.js        # Așteptat: 3 (def + 2 apeluri)

# elementele statice au dispărut complet din JS și HTML:
grep -n "reg-prev\|reg-next\|regin-prev\|regin-next\|reg-total\|regin-total\|reg-page\|regin-page" \
  public/js/registratura/main.js public/registratura.html   # Așteptat: NIMIC

grep -n 'reg-pagination\|regin-pagination' public/registratura.html   # Așteptat: cele 2 containere

# ordinea de script (pagin ÎNAINTEA main):
grep -n 'shared/pagin.js\|registratura/main.js' public/registratura.html

npm test                    # Așteptat: verde, fără regresii (inclusiv PAGIN-7 din pagin-wiring)
git status --short          # Așteptat: exact 3 fișiere M (registratura.html, main.js, pagin-wiring.test.mjs, package.json = 4)
```

> Notă: `test:db` nu e necesar aici (zero backend, zero migrație). `npm test`
> (unit) e suficient pentru acest prompt.

Dacă orice `grep` „Așteptat: NIMIC" întoarce ceva, sau `DFPagin.render(` ≠ 1 →
OPREȘTE-TE și raportează înainte de commit.

===============================================================================
## PAS 12 — COMMIT (doar develop)
===============================================================================

```bash
git add public/registratura.html public/js/registratura/main.js \
        server/tests/unit/pagin-wiring.test.mjs package.json
git status --short          # confirmă că s-a adăugat exact ce trebuie
git commit -m "PAGIN-7: cablare DFPagin numerotat pe registratura (2 state-uri) v3.9.721"
git push origin develop
```

===============================================================================
## RAPORT FINAL (completează după rulare)
===============================================================================

- [ ] Versiune: 3.9.720 → 3.9.721 (confirmat în package.json)
- [ ] `DFPagin.render(` = 1 în main.js; `renderPag(` = 3
- [ ] `reg-pagination` + `regin-pagination` în HTML; zero referințe prev/next/total/page
- [ ] pagin.js?v=3.9.721 încărcat ÎNAINTEA main.js?v=3.9.721 (restul `?v=` neatinse)
- [ ] `CACHE_VERSION` NEATINS (docflowai-v297)
- [ ] `npm test` verde, PAGIN-7 prezent în pagin-wiring (CONSUMERS = 5 acum)
- [ ] `git status --short` curat înainte de commit; commit + push pe develop
- [ ] Commit hash: __________
- [ ] Observații / abateri: __________

===============================================================================
## ⛔ CONSTRÂNGERI ABSOLUTE
===============================================================================

- ⛔ Doar `develop`. Zero atingere `main`.
- ⛔ Zero backend, zero migrație, zero fișier `.sql`.
- ⛔ NU bump `CACHE_VERSION` (fișierele nu-s în PRECACHE).
- ⛔ NU bulk-sed pe `?v=` — doar main.js (+ pagin.js nou); restul rămân la versiunile lor.
- ⛔ NU atinge alți consumatori de paginare (list.js/alop.js/semdoc/admin) — ăștia
     sunt PAGIN-8/9/10, prompturi separate.
- ⛔ NU modifica `shared/pagin.js` (componenta e stabilă din PAGIN-1).
- ⛔ NU schimba logica de filtre/căutare/export/CSV din wireOut/wireIn — doar
     listenerele prev/next se scot.
- ⛔ Dacă ceva nu se potrivește (old_str negăsit, versiune ≠ 720, grep neașteptat)
     → oprește-te și raportează, nu improviza.
