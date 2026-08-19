---
title: PAGIN-10 — cablare DFPagin pe semdoc-initiator/main.js (Fluxurile mele) — ULTIMUL
model_suggested: Sonnet 4.6 (Default)   # UX chirurgical, izolat, fără migrație, fără backend
target_version: 3.9.724
branch: develop
migration: NU
cache_version_bump: NU   # semdoc-initiator/main.js NU e în PRECACHE_ASSETS (verificat)
---

# ⚠️ BRANCH: develop — NU atinge `main` (producție, o gestionează Mircea manual)

Un singur commit, un singur bump (3.9.723 → 3.9.724). Zero backend, zero migrație.
ULTIMUL consumator ⇒ după el șantierul de paginare e COMPLET (7/7 „reali").

===============================================================================
## CONTEXT
===============================================================================

`semdoc-initiator/main.js` = lista „Fluxurile mele" (`loadMyFlows(page)`), pe pagina
`semdoc-initiator.html`. E cel mai complex consumator, cu DOUĂ moduri:
  - **normal** (fără căutare): SERVER-paginat, `limit:50`, `resp.total`/`resp.pages`.
    Bara prev/next e vizibilă.
  - **căutare** (`isClientSearch = !!search`): fetch `limit:200`, filtrare CLIENT-side
    (`flowMatchesSearch`), `total=flows.length`, `pages=1`. Bara e ASCUNSĂ (toate
    rezultatele-s deja pe o pagină).

Convertim bara la DFPagin numerotat, păstrând comportamentul: în mod căutare bara se
ascunde. Trucul: `total: isClientSearch ? 0 : total` — cu total 0, DFPagin calculează
`totalPages<=1` și ascunde singur containerul. Numărul din mod căutare rămâne vizibil
în contorul separat `#fluxCounter`.

⚠️ Capcane verificate pe cod (respectă-le):
1. `#fluxCounter` (contorul din header „N fluxuri · filtru") e feature SEPARAT de bară,
   actualizat în `loadMyFlows`. ⛔ NU-l atinge (ca `#lst-count` la PAGIN-8).
2. `loadMyFlows` e apelată de ÎNCĂ două `onclick`/`onchange` inline care RĂMÂN:
   `#btnRefreshFluxuri` (`loadMyFlows(1)`, linia 321) și `#fluxStatusFilter`
   (`onchange="loadMyFlows(1)"`, linia 348). ⛔ NU le atinge — `loadMyFlows` trebuie
   să rămână binding global (declarație de funcție top-level, NU o muta/înfășura).
   Doar cele DOUĂ onclick din bara `#fluxPagination` (prev/next, liniile 363/365,
   care folosesc `_fluxPage`) se elimină.
3. Ramura „zero rezultate" din `loadMyFlows` face `$("fluxPagination").style.display="none"`
   ȘI update pe `#fluxCounter` — o LĂSĂM neatinsă (containerul `#fluxPagination` există
   în continuare ca div gol).
4. `pagin.js` NU e încă pe pagină ⇒ îl INSERĂM înaintea main.js (ca la PAGIN-7).
   `semdoc-initiator.html` încarcă deja `components.css?v=3.9.717` ⇒ zero CSS.

Convenție canonică: `mode: 'numbered'` CU spațiu (cod ȘI test).

Notă: după conversie, `const pages` din `loadMyFlows` rămâne nefolosit — inofensiv
(node --check trece, npm test nu are linter strict). ⛔ NU-l elimina (ar fi scope creep).

===============================================================================
## PAS 0 — PREFLIGHT (read-only)
===============================================================================

```bash
cd <repo>
git checkout develop && git pull --ff-only
git branch --show-current                                  # Așteptat: develop
grep '"version"' package.json                              # Așteptat: "3.9.723"
grep -n 'semdoc-initiator/main.js?v=' public/semdoc-initiator.html   # citește versiunea reală
grep -c 'shared/pagin.js' public/semdoc-initiator.html     # Așteptat: 0 (îl adăugăm noi)
grep -c 'components.css' public/semdoc-initiator.html      # Așteptat: ≥1 (CSS-ul de paginare există)
grep -c 'DFPagin.render(' public/js/semdoc-initiator/main.js   # Așteptat: 0
grep -n 'loadMyFlows' public/semdoc-initiator.html
# ↑ Așteptat: 4 linii — 321 (refresh), 348 (filtru), 363/365 (prev/next). Doar 363/365 se elimină.
```

Dacă `version` ≠ 3.9.723 → OPREȘTE-TE și raportează.

===============================================================================
## PAS 1 — semdoc-initiator.html: încarcă pagin.js ÎNAINTEA main.js + bump main.js
===============================================================================

**old_str**
```html
    <script src="/js/semdoc-initiator/main.js?v=3.9.710" defer></script>
```
**new_str**
```html
    <script src="/js/shared/pagin.js?v=3.9.724" defer></script>
    <script src="/js/semdoc-initiator/main.js?v=3.9.724" defer></script>
```

> ⚠️ Bump `?v=` țintit DOAR pe main.js (+ pagin.js nou). NU atinge celelalte scripturi
> (att-preview, file-item, notif-widget) și niciun CSS.

===============================================================================
## PAS 2 — semdoc-initiator.html: bara #fluxPagination → container gol
===============================================================================

Păstrează comentariul `<!-- Paginare -->`. ⛔ NU atinge `#fluxCounter` (alt element, linia 317).

**old_str**
```html
          <!-- Paginare -->
          <div id="fluxPagination" style="display:none;justify-content:space-between;align-items:center;margin-top:16px;flex-wrap:wrap;gap:8px;">
            <button id="fluxPrevBtn" class="df-action-btn sm" onclick="loadMyFlows(_fluxPage - 1)"><svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg?v=3.9.693#ico-arrow-left"/></svg>Anterior</button>
            <span id="fluxPageInfo" style="color:var(--muted);font-size:.85rem;"></span>
            <button id="fluxNextBtn" class="df-action-btn sm" onclick="loadMyFlows(_fluxPage + 1)">Următor<svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg?v=3.9.693#ico-arrow-right"/></svg></button>
          </div>
```
**new_str**
```html
          <!-- Paginare -->
          <div id="fluxPagination"></div>
```

===============================================================================
## PAS 3 — main.js: blocul de randare a paginării → DFPagin numerotat
===============================================================================

⛔ NU atinge ramura „zero rezultate" de mai sus (cea cu `Niciun flux găsit` +
`$("fluxPagination")...display="none"` + update pe `#fluxCounter`). Doar blocul
`// Actualizeaza paginarea` de mai jos.

**old_str**
```javascript
          // Actualizeaza paginarea
          const pg = $("fluxPagination");
          if (pg) {
            pg.style.display = (!isClientSearch && pages > 1) ? "flex" : "none";
            const info = $("fluxPageInfo");
            if (info) info.textContent = isClientSearch
              ? (total + " fluxuri găsite")
              : ("Pagina " + page + " din " + pages + " (" + total + " fluxuri)");
            const prev = $("fluxPrevBtn"); if (prev) prev.disabled = isClientSearch || page <= 1;
            const next = $("fluxNextBtn"); if (next) next.disabled = isClientSearch || page >= pages;
          }
```
**new_str**
```javascript
          // Actualizeaza paginarea — DFPagin numerotat. În mod căutare (isClientSearch)
          // bara se ascunde: rezultatele filtrate client-side sunt deja toate pe o
          // pagină, iar numărul apare în contorul #fluxCounter.
          if (window.DFPagin && typeof window.DFPagin.render === 'function') {
            window.DFPagin.render({
              container: 'fluxPagination',
              total: isClientSearch ? 0 : total,
              page,
              limit: 50,
              mode: 'numbered',
              onChange: (p) => loadMyFlows(p),
            });
          }
```

===============================================================================
## PAS 4 — test de wiring: intrarea PAGIN-10
===============================================================================

Fișier: `server/tests/unit/pagin-wiring.test.mjs`

### 4a — sursă HTML pentru semdoc (formularHtmlSrc există deja din PAGIN-8)
**old_str**
```javascript
const formularHtmlSrc = readPublic('formular.html');
```
**new_str**
```javascript
const formularHtmlSrc = readPublic('formular.html');
const semdocHtmlSrc = readPublic('semdoc-initiator.html');
```

### 4b — intrarea PAGIN-10 în CONSUMERS (după PAGIN-9, înainte de `];`)
**old_str**
```javascript
    mustContain: ['DFPagin.render(', 'window.DFPagin &&', "mode: 'numbered'"],
    mustNotContain: ['alop-page-info', 'alop-prev', 'alop-next', 'changeAlopPage'],
  },
];
```
**new_str**
```javascript
    mustContain: ['DFPagin.render(', 'window.DFPagin &&', "mode: 'numbered'"],
    mustNotContain: ['alop-page-info', 'alop-prev', 'alop-next', 'changeAlopPage'],
  },
  {
    label: 'PAGIN-10 — semdoc-initiator/main.js',
    jsPath: 'js/semdoc-initiator/main.js',
    htmlPath: 'semdoc-initiator.html',
    htmlSrc: semdocHtmlSrc,
    mustContain: ['DFPagin.render(', 'window.DFPagin &&', "mode: 'numbered'"],
    mustNotContain: ['fluxPageInfo', 'fluxPrevBtn', 'fluxNextBtn'],
  },
];
```

### 4c — describe specific PAGIN-10 (la finalul fișierului, după blocul PAGIN-9)
**old_str**
```javascript
  it('#lst-pagination (PAGIN-8) rămâne container gol', () => {
    expect(formularHtmlSrc).toContain('<div id="lst-pagination"></div>');
  });
});
```
**new_str**
```javascript
  it('#lst-pagination (PAGIN-8) rămâne container gol', () => {
    expect(formularHtmlSrc).toContain('<div id="lst-pagination"></div>');
  });
});

describe('PAGIN-10 — semdoc-initiator.html #fluxPagination fără prev/next static', () => {
  it('conține <div id="fluxPagination"></div>', () => {
    expect(semdocHtmlSrc).toContain('<div id="fluxPagination"></div>');
  });
  it('nu mai conține butoanele statice fluxPrevBtn/fluxNextBtn/fluxPageInfo', () => {
    expect(semdocHtmlSrc).not.toContain('id="fluxPrevBtn"');
    expect(semdocHtmlSrc).not.toContain('id="fluxNextBtn"');
    expect(semdocHtmlSrc).not.toContain('id="fluxPageInfo"');
  });
  it('NU atinge contorul #fluxCounter', () => {
    expect(semdocHtmlSrc).toContain('id="fluxCounter"');
  });
  it('semdoc-initiator.html încarcă /js/shared/pagin.js ÎNAINTEA main.js', () => {
    const paginIdx = semdocHtmlSrc.indexOf('js/shared/pagin.js');
    const mainIdx = semdocHtmlSrc.indexOf('js/semdoc-initiator/main.js');
    expect(paginIdx).toBeGreaterThan(-1);
    expect(mainIdx).toBeGreaterThan(-1);
    expect(paginIdx).toBeLessThan(mainIdx);
  });
});
```

===============================================================================
## PAS 5 — bump versiune
===============================================================================

**old_str**
```json
  "version": "3.9.723",
```
**new_str**
```json
  "version": "3.9.724",
```

> ⛔ NU bump `CACHE_VERSION` din `public/sw.js` — lasă `docflowai-v297`.

===============================================================================
## PAS 6 — VERIFICARE
===============================================================================

```bash
node --check public/js/semdoc-initiator/main.js    # Așteptat: fără erori

grep -c 'DFPagin.render(' public/js/semdoc-initiator/main.js   # Așteptat: 1
grep -n 'fluxPrevBtn\|fluxNextBtn\|fluxPageInfo' public/js/semdoc-initiator/main.js public/semdoc-initiator.html   # Așteptat: NIMIC

grep -n 'fluxPagination\|fluxCounter' public/semdoc-initiator.html
# Așteptat: <div id="fluxPagination"></div> gol; #fluxCounter NEATINS

grep -n 'loadMyFlows' public/semdoc-initiator.html
# Așteptat: 2 linii rămase (btnRefreshFluxuri:loadMyFlows(1) + fluxStatusFilter onchange)

grep -n 'shared/pagin.js\|semdoc-initiator/main.js' public/semdoc-initiator.html
# Așteptat: pagin.js?v=3.9.724 ÎNAINTEA main.js?v=3.9.724

npm test                    # Așteptat: verde, CONSUMERS=8 în pagin-wiring
git status --short          # Așteptat: semdoc-initiator.html, main.js, pagin-wiring.test.mjs, package.json = 4
```

Dacă orice „Așteptat: NIMIC" întoarce ceva, `DFPagin.render(` ≠ 1, `#fluxCounter`
dispărut, sau au rămas ≠ 2 `loadMyFlows` în HTML → OPREȘTE-TE, raportează, NU comita.

===============================================================================
## PAS 7 — COMMIT (doar develop)
===============================================================================

```bash
git add public/semdoc-initiator.html public/js/semdoc-initiator/main.js \
        server/tests/unit/pagin-wiring.test.mjs package.json
git status --short
git commit -m "PAGIN-10: cablare DFPagin numerotat pe Fluxurile mele (semdoc) v3.9.724 — șantier complet"
git push origin develop
```

===============================================================================
## RAPORT FINAL (completează după rulare)
===============================================================================

- [ ] Versiune: 3.9.723 → 3.9.724
- [ ] `DFPagin.render(` = 1 în semdoc main.js; fluxPrevBtn/fluxNextBtn/fluxPageInfo = 0
- [ ] `<div id="fluxPagination"></div>` gol; `#fluxCounter` NEATINS; 2 `loadMyFlows` rămase în HTML
- [ ] pagin.js?v=3.9.724 înaintea main.js?v=3.9.724; restul `?v=` neatinse
- [ ] `CACHE_VERSION` NEATINS (docflowai-v297)
- [ ] `npm test` verde, CONSUMERS=8 (șantier COMPLET, 7/7 consumatori reali)
- [ ] git status curat înainte de commit; commit + push pe develop
- [ ] Commit hash: __________
- [ ] Observații / abateri: __________

===============================================================================
## ⛔ CONSTRÂNGERI ABSOLUTE
===============================================================================

- ⛔ Doar `develop`. Zero `main`.
- ⛔ NU atinge `#fluxCounter` (contor header, feature separat) și ramura „zero rezultate".
- ⛔ NU atinge cele două `loadMyFlows` inline care rămân (refresh 321, filtru 348) —
     `loadMyFlows` trebuie să rămână binding global top-level.
- ⛔ NU elimina `const pages` (nefolosit după conversie, dar inofensiv).
- ⛔ Zero backend, zero migrație, zero `.sql`. NU bump `CACHE_VERSION`.
- ⛔ NU bulk-sed pe `?v=` — doar main.js (+ pagin.js nou).
- ⛔ NU modifica `shared/pagin.js`.
- ⛔ Scrie `mode: 'numbered'` CU spațiu (cod ȘI test).
- ⛔ old_str negăsit / versiune ≠ 723 → oprește-te și raportează.
