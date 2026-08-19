---
title: PAGIN-8 — cablare DFPagin pe formular/list.js (lista DF/ORD)
model_suggested: Sonnet 4.6 (Default)   # UX chirurgical, izolat, fără migrație, fără backend
target_version: 3.9.722
branch: develop
migration: NU
cache_version_bump: NU   # nici formular/list.js nici shared/pagin.js nu-s în PRECACHE_ASSETS (verificat)
---

# ⚠️ BRANCH: develop — NU atinge `main` (producție, o gestionează Mircea manual)

Un singur commit, un singur bump (3.9.721 → 3.9.722). Zero backend, zero migrație.

===============================================================================
## CONTEXT
===============================================================================

Al 8-lea consumator din șantierul de paginare. Familia „simple" (`.lst-pagination`).
`formular/list.js` e loaderul PARTAJAT al listei DF/ORD (`_lstState`, un SINGUR
state — mai simplu decât registratura de la PAGIN-7, deci FĂRĂ helper). Paginare pe
SERVER (`?page=&limit=20`, `total` de la server) ⇒ `onChange` refetch-uiește, exact
ca audit.js (PAGIN-5) și registratura (PAGIN-7).

Diferența față de admin: markup-ul barei e STATIC în `formular.html`, cu `onclick`
inline (`changeLstPage(-1)` / `changeLstPage(1)`). Îl curățăm și pe ăsta.

⚠️ TREI capcane (verificate pe cod — respectă-le strict):
1. `formular.html` are DOUĂ bare: `#lst-pagination` (DF/ORD — ASTA o convertim) ȘI
   `#alop-pagination` (ALOP — aia e **PAGIN-9**, prompt separat). ⛔ NU atinge alop.
2. `#lst-count` (contorul „N documente" din header, cu acord gramatical RO) e un
   feature SEPARAT adăugat la #90 — NU e parte din bara de paginare. ⛔ NU-l atinge.
   Rămâne redundant minor cu „1–20 din N" din bară, dar e intenționat (poziționat în
   header). NU e „contor dublu" de eliminat ca la admin.
3. `changeLstPage(dir)` e apelată DOAR de cele două `onclick` inline pe care le
   ștergem (grep confirmat: zero apelanți în alt fișier) ⇒ devine cod MORT. O scoatem
   complet (funcție + export `window.changeLstPage` + mențiunea din comentariul de
   antet), altfel rămâne un global care mută `_lstState.page` fără UI.

CSS: `formular.html` încarcă deja `css/df/components.css?v=3.9.717` (are
`.pagination/.pg-btn/.pg-info` de la PAGIN-3) ⇒ **zero CSS de scris**.

Schimbare de aspect (de anunțat în acceptance): „← Anterior · Pagina X din Y (N
total) · Următor →" devine bara numerotată centrată `◀ · 1–20 din N · 1 2 3 … · ▶`.

===============================================================================
## PAS 0 — PREFLIGHT (read-only)
===============================================================================

```bash
cd <repo>
git checkout develop && git pull --ff-only
git branch --show-current                          # Așteptat: develop
grep '"version"' package.json                      # Așteptat: "3.9.721"
grep -n 'formular/list.js?v=' public/formular.html # citește versiunea reală (NU presupune)
grep -c 'DFPagin.render(' public/js/formular/list.js   # Așteptat: 0 (încă necablat)
grep -rn 'changeLstPage' public/ --include=*.js --include=*.html | grep -v 'formular/list.js\|formular.html'
# ↑ Așteptat: NIMIC. Dacă apare vreun apelant extern → OPREȘTE-TE, raportează
#   (nu mai ștergem changeLstPage, doar rescriem _renderLstPagin).
```

Dacă `version` ≠ 3.9.721 → OPREȘTE-TE și raportează.

===============================================================================
## PAS 1 — formular.html: încarcă pagin.js ÎNAINTEA lui alop.js + list.js + bump list.js
===============================================================================

pagin.js îl punem înaintea lui `alop.js` (nu doar list.js), ca să pre-poziționăm și
PAGIN-9. Ambele `defer` ⇒ ordinea documentului = ordinea de execuție.

### 1a — inserează pagin.js înaintea alop.js
**old_str**
```html
<script src="/js/formular/alop.js?v=3.9.711" defer></script>
```
**new_str**
```html
<script src="/js/shared/pagin.js?v=3.9.722" defer></script>
<script src="/js/formular/alop.js?v=3.9.711" defer></script>
```

### 1b — bump ?v= DOAR pe list.js (asset schimbat)
**old_str**
```html
<script src="/js/formular/list.js?v=3.9.693" defer></script>
```
**new_str**
```html
<script src="/js/formular/list.js?v=3.9.722" defer></script>
```

> ⚠️ NU bump `?v=` pe alop.js (rămâne 3.9.711 — se schimbă la PAGIN-9) și pe niciun
> alt script/CSS. Doar list.js (+ pagin.js nou). Regula CLAUDE.md §Cache busting.

===============================================================================
## PAS 2 — formular.html: bara #lst-pagination → container gol
===============================================================================

⛔ ANCORĂ EXACTĂ (NU confunda cu `#alop-pagination` de mai jos, cu alte id-uri).

**old_str**
```html
  <div class="lst-pagination" id="lst-pagination" style="display:none">
    <button class="df-action-btn sm" id="lst-prev" onclick="changeLstPage(-1)">← Anterior</button>
    <span id="lst-page-info" class="lst-page-info"></span>
    <button class="df-action-btn sm" id="lst-next" onclick="changeLstPage(1)">Următor →</button>
  </div>
```
**new_str**
```html
  <div id="lst-pagination"></div>
```

===============================================================================
## PAS 3 — list.js: _renderLstPagin → DFPagin numerotat + ȘTERGE changeLstPage mort
===============================================================================

Un singur str_replace acoperă ambele funcții adiacente (rescrie prima, elimină a doua).

**old_str**
```javascript
function _renderLstPagin(total,page,limit){
  const pg=document.getElementById('lst-pagination');
  const info=document.getElementById('lst-page-info');
  const prev=document.getElementById('lst-prev');
  const next=document.getElementById('lst-next');
  if(!pg)return;
  const totalPages=Math.ceil(total/limit)||1;
  if(totalPages<=1){pg.style.display='none';return;}
  pg.style.display='flex';
  if(info)info.textContent=`Pagina ${page} din ${totalPages} (${total} total)`;
  if(prev)prev.disabled=page<=1;
  if(next)next.disabled=page>=totalPages;
}
function changeLstPage(dir){
  _lstState.page=Math.max(1,_lstState.page+dir);
  loadList();
}
```
**new_str**
```javascript
function _renderLstPagin(total,page,limit){
  // PAGIN-8 — componentă partajată DFPagin (paginare pe SERVER: onChange refetch).
  const pg=document.getElementById('lst-pagination');
  if(!pg)return;
  if(window.DFPagin && typeof window.DFPagin.render==='function'){
    window.DFPagin.render({
      container:pg,
      total,
      page,
      limit,
      mode:'numbered',
      onChange:(p)=>{_lstState.page=p;loadList();},
    });
  }else{
    console.error('DFPagin indisponibil — paginarea listei DF/ORD e ascunsă');
    pg.replaceChildren();
    pg.style.display='none';
  }
}
```

===============================================================================
## PAS 4 — list.js: scoate exportul mort window.changeLstPage
===============================================================================

**old_str**
```javascript
  window.stergeDoc              = stergeDoc;
  window.changeLstPage          = changeLstPage;
  window.debouncedLoadList      = debouncedLoadList;
```
**new_str**
```javascript
  window.stergeDoc              = stergeDoc;
  window.debouncedLoadList      = debouncedLoadList;
```

===============================================================================
## PAS 5 — list.js: curăță mențiunea din comentariul de antet
===============================================================================

**old_str**
```javascript
//   - loadList, openDocFromList, stergeDoc, changeLstPage, debouncedLoadList, resetFilters
```
**new_str**
```javascript
//   - loadList, openDocFromList, stergeDoc, debouncedLoadList, resetFilters
```

===============================================================================
## PAS 6 — test de wiring: intrarea PAGIN-8 (NU fișier nou)
===============================================================================

Fișier: `server/tests/unit/pagin-wiring.test.mjs`

### 6a — sursă HTML pentru formular
**old_str**
```javascript
const registraturaHtmlSrc = readPublic('registratura.html');
```
**new_str**
```javascript
const registraturaHtmlSrc = readPublic('registratura.html');
const formularHtmlSrc = readPublic('formular.html');
```

### 6b — intrarea PAGIN-8 în CONSUMERS (după PAGIN-7, înainte de `];`)
**old_str**
```javascript
    mustContain: ['DFPagin.render(', 'window.DFPagin &&', "mode: 'numbered'", 'renderPag('],
    mustNotContain: ["$('reg-prev')", "$('reg-next')", "$('regin-prev')", "$('regin-next')", 'Pagina ${stateOut.page}', 'Pagina ${stateIn.page}'],
  },
];
```
**new_str**
```javascript
    mustContain: ['DFPagin.render(', 'window.DFPagin &&', "mode: 'numbered'", 'renderPag('],
    mustNotContain: ["$('reg-prev')", "$('reg-next')", "$('regin-prev')", "$('regin-next')", 'Pagina ${stateOut.page}', 'Pagina ${stateIn.page}'],
  },
  {
    label: 'PAGIN-8 — formular/list.js',
    jsPath: 'js/formular/list.js',
    htmlPath: 'formular.html',
    htmlSrc: formularHtmlSrc,
    mustContain: ['DFPagin.render(', 'window.DFPagin &&', "mode: 'numbered'"],
    mustNotContain: ['lst-page-info', 'lst-prev', 'lst-next', 'changeLstPage'],
  },
];
```

### 6c — describe specific PAGIN-8 (la finalul fișierului, după blocul PAGIN-7)
**old_str**
```javascript
  it('nu mai conține butoanele statice reg-prev/regin-prev', () => {
    expect(registraturaHtmlSrc).not.toContain('id="reg-prev"');
    expect(registraturaHtmlSrc).not.toContain('id="regin-prev"');
  });
});
```
**new_str**
```javascript
  it('nu mai conține butoanele statice reg-prev/regin-prev', () => {
    expect(registraturaHtmlSrc).not.toContain('id="reg-prev"');
    expect(registraturaHtmlSrc).not.toContain('id="regin-prev"');
  });
});

describe('PAGIN-8 — formular.html #lst-pagination fără prev/next static', () => {
  it('conține <div id="lst-pagination"></div>', () => {
    expect(formularHtmlSrc).toContain('<div id="lst-pagination"></div>');
  });
  it('nu mai conține butoanele statice lst-prev/lst-next + onclick changeLstPage', () => {
    expect(formularHtmlSrc).not.toContain('id="lst-prev"');
    expect(formularHtmlSrc).not.toContain('id="lst-next"');
    expect(formularHtmlSrc).not.toContain('onclick="changeLstPage(');
  });
  it('NU atinge #alop-pagination (rămâne pentru PAGIN-9)', () => {
    expect(formularHtmlSrc).toContain('id="alop-pagination"');
  });
  it('NU atinge contorul #lst-count (feature #90)', () => {
    expect(formularHtmlSrc).toContain('id="lst-count"');
  });
});
```

===============================================================================
## PAS 7 — bump versiune
===============================================================================

**old_str**
```json
  "version": "3.9.721",
```
**new_str**
```json
  "version": "3.9.722",
```

> ⛔ NU bump `CACHE_VERSION` din `public/sw.js` — lasă `docflowai-v297`.

===============================================================================
## PAS 8 — VERIFICARE
===============================================================================

```bash
node --check public/js/formular/list.js            # Așteptat: fără erori

grep -c 'DFPagin.render(' public/js/formular/list.js   # Așteptat: 1
grep -n 'changeLstPage' public/js/formular/list.js public/formular.html   # Așteptat: NIMIC
grep -n 'lst-prev\|lst-next\|lst-page-info' public/js/formular/list.js public/formular.html   # Așteptat: NIMIC

grep -n 'lst-pagination\|alop-pagination\|lst-count' public/formular.html
# Așteptat: <div id="lst-pagination"></div> gol; #alop-pagination ȘI #lst-count NEATINSE

grep -n 'shared/pagin.js\|formular/alop.js\|formular/list.js' public/formular.html
# Așteptat: pagin.js?v=3.9.722 ÎNAINTEA alop.js (3.9.711, neatins) și list.js (3.9.722)

npm test                    # Așteptat: verde, CONSUMERS=6 în pagin-wiring
git status --short          # Așteptat: 3 M (formular.html, list.js, pagin-wiring.test.mjs) + package.json = 4
```

Dacă orice „Așteptat: NIMIC" întoarce ceva, sau `DFPagin.render(` ≠ 1, sau
`#alop-pagination`/`#lst-count` au dispărut → OPREȘTE-TE, raportează, NU comita.

===============================================================================
## PAS 9 — COMMIT (doar develop)
===============================================================================

```bash
git add public/formular.html public/js/formular/list.js \
        server/tests/unit/pagin-wiring.test.mjs package.json
git status --short
git commit -m "PAGIN-8: cablare DFPagin numerotat pe lista DF/ORD (list.js) v3.9.722"
git push origin develop
```

===============================================================================
## RAPORT FINAL (completează după rulare)
===============================================================================

- [ ] Versiune: 3.9.721 → 3.9.722
- [ ] `DFPagin.render(` = 1 în list.js; `changeLstPage` = 0 (funcție + export + comentariu)
- [ ] `<div id="lst-pagination"></div>` gol; `#alop-pagination` ȘI `#lst-count` NEATINSE
- [ ] pagin.js?v=3.9.722 înaintea alop.js (3.9.711 neatins) și list.js (3.9.722); restul `?v=` neatinse
- [ ] `CACHE_VERSION` NEATINS (docflowai-v297)
- [ ] `npm test` verde, CONSUMERS=6
- [ ] git status curat înainte de commit; commit + push pe develop
- [ ] Commit hash: __________
- [ ] Observații / abateri: __________

===============================================================================
## ⛔ CONSTRÂNGERI ABSOLUTE
===============================================================================

- ⛔ Doar `develop`. Zero `main`.
- ⛔ NU atinge `#alop-pagination` / `alop.js` — acela e PAGIN-9.
- ⛔ NU atinge `#lst-count` / `_setLstCount` / `_lstCountLabel` — feature #90.
- ⛔ Zero backend, zero migrație, zero `.sql`. NU bump `CACHE_VERSION`.
- ⛔ NU bulk-sed pe `?v=` — doar list.js (+ pagin.js nou). alop.js rămâne 3.9.711.
- ⛔ NU modifica `shared/pagin.js` (stabilă din PAGIN-1).
- ⛔ NU curăța celelalte `onclick` inline din rândurile tabelului (openDocFromList,
     stergeDoc, openFormAudit etc.) — sunt în afara scopului acestui prompt.
- ⛔ Dacă `changeLstPage` are apelant extern (PAS 0) → NU-l șterge, doar rescrie
     `_renderLstPagin` și raportează abaterea.
- ⛔ old_str negăsit / versiune ≠ 721 / grep neackerat → oprește-te și raportează.
