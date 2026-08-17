---
title: PAGIN-9 — cablare DFPagin pe formular/alop.js (lista ALOP)
model_suggested: Sonnet 4.6 (Default)   # UX chirurgical, izolat, fără migrație, fără backend
target_version: 3.9.723
branch: develop
migration: NU
cache_version_bump: NU   # formular/alop.js NU e în PRECACHE_ASSETS (verificat)
---

# ⚠️ BRANCH: develop — NU atinge `main` (producție, o gestionează Mircea manual)

Un singur commit, un singur bump (3.9.722 → 3.9.723). Zero backend, zero migrație.

===============================================================================
## CONTEXT
===============================================================================

Al 9-lea consumator. `formular/alop.js` (lista ALOP) oglindește 1:1 `list.js`
(comentariul din alop.js:25 zice explicit „mirror _lstState din list.js"). Deci
PAGIN-9 = geamănul lui PAGIN-8, cu trei simplificări:
  - `pagin.js` e DEJA încărcat înaintea lui alop.js (l-am pus acolo la PAGIN-8) ⇒
    NU inserăm niciun `<script>`, doar bump-uim `?v=` pe alop.js.
  - NU există comentariu-antet care listează `changeAlopPage` (spre deosebire de
    list.js) ⇒ doar 2 atingeri în alop.js (rescrie render + scoate export).
  - Subview-ul ALOP NU are contor separat gen `#lst-count` (ăla era DF/ORD, #90) ⇒
    nicio grijă de contor.

`_alopState = {page:1, limit:20}`, SERVER-paginat (trimite `?page=&limit=`, `total`
de la server) ⇒ `onChange` refetch-uiește prin `loadAlop()`.

`changeAlopPage(dir)` e apelată DOAR de cele două `onclick` inline din
`#alop-pagination` pe care le ștergem (grep confirmat: zero apelanți externi) ⇒ cod
mort după conversie, îl scoatem complet (funcție + export `window.changeAlopPage`).

CSS: `formular.html` are deja `components.css` ⇒ **zero CSS**.
Convenție canonică (lecția PAGIN-8): scrie **`mode: 'numbered'` CU spațiu** —
identic în cod și în aserția testului.

===============================================================================
## PAS 0 — PREFLIGHT (read-only)
===============================================================================

```bash
cd <repo>
git checkout develop && git pull --ff-only
git branch --show-current                          # Așteptat: develop
grep '"version"' package.json                      # Așteptat: "3.9.722"
grep -n 'formular/alop.js?v=' public/formular.html # citește versiunea reală
grep -n 'shared/pagin.js\|formular/alop.js' public/formular.html
# ↑ Așteptat: pagin.js?v=3.9.722 ÎNAINTEA alop.js (rămășiță PAGIN-8). Dacă pagin.js
#   NU e înaintea alop.js → OPREȘTE-TE, raportează (premisa PAGIN-9 e ruptă).
grep -c 'DFPagin.render(' public/js/formular/alop.js   # Așteptat: 0
grep -rn 'changeAlopPage' public/ --include=*.js --include=*.html | grep -v 'formular/alop.js\|formular.html'
# ↑ Așteptat: NIMIC (zero apelanți externi). Dacă apare ceva → NU șterge changeAlopPage.
```

Dacă `version` ≠ 3.9.722 → OPREȘTE-TE și raportează.

===============================================================================
## PAS 1 — formular.html: bump ?v= DOAR pe alop.js
===============================================================================

⚠️ NU atinge linia `pagin.js?v=3.9.722` (conținutul componentei e neschimbat).

**old_str**
```html
<script src="/js/formular/alop.js?v=3.9.711" defer></script>
```
**new_str**
```html
<script src="/js/formular/alop.js?v=3.9.723" defer></script>
```

===============================================================================
## PAS 2 — formular.html: bara #alop-pagination → container gol
===============================================================================

**old_str**
```html
    <div class="lst-pagination" id="alop-pagination" style="display:none">
      <button class="df-action-btn sm" id="alop-prev" onclick="changeAlopPage(-1)">← Anterior</button>
      <span id="alop-page-info" class="lst-page-info"></span>
      <button class="df-action-btn sm" id="alop-next" onclick="changeAlopPage(1)">Următor →</button>
    </div>
```
**new_str**
```html
    <div id="alop-pagination"></div>
```

===============================================================================
## PAS 3 — alop.js: _renderAlopPagin → DFPagin numerotat + ȘTERGE changeAlopPage mort
===============================================================================

Un singur str_replace acoperă ambele funcții adiacente.

**old_str**
```javascript
function _renderAlopPagin(total,page,limit){
  const pg=document.getElementById('alop-pagination');
  const info=document.getElementById('alop-page-info');
  const prev=document.getElementById('alop-prev');
  const next=document.getElementById('alop-next');
  if(!pg)return;
  const totalPages=Math.ceil(total/limit)||1;
  if(totalPages<=1){pg.style.display='none';return;}
  pg.style.display='flex';
  if(info)info.textContent=`Pagina ${page} din ${totalPages} (${total} total)`;
  if(prev)prev.disabled=page<=1;
  if(next)next.disabled=page>=totalPages;
}
function changeAlopPage(dir){
  _alopState.page=Math.max(1,_alopState.page+dir);
  loadAlop();
}
```
**new_str**
```javascript
function _renderAlopPagin(total,page,limit){
  // PAGIN-9 — componentă partajată DFPagin (paginare pe SERVER: onChange refetch).
  const pg=document.getElementById('alop-pagination');
  if(!pg)return;
  if(window.DFPagin && typeof window.DFPagin.render==='function'){
    window.DFPagin.render({
      container:pg,
      total,
      page,
      limit,
      mode: 'numbered',
      onChange:(p)=>{_alopState.page=p;loadAlop();},
    });
  }else{
    console.error('DFPagin indisponibil — paginarea listei ALOP e ascunsă');
    pg.replaceChildren();
    pg.style.display='none';
  }
}
```

===============================================================================
## PAS 4 — alop.js: scoate exportul mort window.changeAlopPage
===============================================================================

**old_str**
```javascript
  window.loadAlop                   = loadAlop;
  window.changeAlopPage             = changeAlopPage;
  window.openAlopModal              = openAlopModal;
```
**new_str**
```javascript
  window.loadAlop                   = loadAlop;
  window.openAlopModal              = openAlopModal;
```

===============================================================================
## PAS 5 — test de wiring: intrarea PAGIN-9 (formularHtmlSrc există deja din PAGIN-8)
===============================================================================

Fișier: `server/tests/unit/pagin-wiring.test.mjs`

### 5a — intrarea PAGIN-9 în CONSUMERS (după PAGIN-8, înainte de `];`)
**old_str**
```javascript
    mustContain: ['DFPagin.render(', 'window.DFPagin &&', "mode: 'numbered'"],
    mustNotContain: ['lst-page-info', 'lst-prev', 'lst-next', 'changeLstPage'],
  },
];
```
**new_str**
```javascript
    mustContain: ['DFPagin.render(', 'window.DFPagin &&', "mode: 'numbered'"],
    mustNotContain: ['lst-page-info', 'lst-prev', 'lst-next', 'changeLstPage'],
  },
  {
    label: 'PAGIN-9 — formular/alop.js',
    jsPath: 'js/formular/alop.js',
    htmlPath: 'formular.html',
    htmlSrc: formularHtmlSrc,
    mustContain: ['DFPagin.render(', 'window.DFPagin &&', "mode: 'numbered'"],
    mustNotContain: ['alop-page-info', 'alop-prev', 'alop-next', 'changeAlopPage'],
  },
];
```

### 5b — describe specific PAGIN-9 (la finalul fișierului, după blocul PAGIN-8)
**old_str**
```javascript
  it('NU atinge contorul #lst-count (feature #90)', () => {
    expect(formularHtmlSrc).toContain('id="lst-count"');
  });
});
```
**new_str**
```javascript
  it('NU atinge contorul #lst-count (feature #90)', () => {
    expect(formularHtmlSrc).toContain('id="lst-count"');
  });
});

describe('PAGIN-9 — formular.html #alop-pagination fără prev/next static', () => {
  it('conține <div id="alop-pagination"></div>', () => {
    expect(formularHtmlSrc).toContain('<div id="alop-pagination"></div>');
  });
  it('nu mai conține butoanele statice alop-prev/alop-next + onclick changeAlopPage', () => {
    expect(formularHtmlSrc).not.toContain('id="alop-prev"');
    expect(formularHtmlSrc).not.toContain('id="alop-next"');
    expect(formularHtmlSrc).not.toContain('onclick="changeAlopPage(');
  });
  it('#lst-pagination (PAGIN-8) rămâne container gol', () => {
    expect(formularHtmlSrc).toContain('<div id="lst-pagination"></div>');
  });
});
```

===============================================================================
## PAS 6 — bump versiune
===============================================================================

**old_str**
```json
  "version": "3.9.722",
```
**new_str**
```json
  "version": "3.9.723",
```

> ⛔ NU bump `CACHE_VERSION` din `public/sw.js` — lasă `docflowai-v297`.

===============================================================================
## PAS 7 — VERIFICARE
===============================================================================

```bash
node --check public/js/formular/alop.js            # Așteptat: fără erori

grep -c 'DFPagin.render(' public/js/formular/alop.js   # Așteptat: 1
grep -n 'changeAlopPage' public/js/formular/alop.js public/formular.html   # Așteptat: NIMIC
grep -n 'alop-prev\|alop-next\|alop-page-info' public/js/formular/alop.js public/formular.html   # Așteptat: NIMIC

grep -n 'alop-pagination\|lst-pagination\|lst-count' public/formular.html
# Așteptat: <div id="alop-pagination"></div> gol; #lst-pagination gol (PAGIN-8); #lst-count neatins

grep -n 'shared/pagin.js\|formular/alop.js' public/formular.html
# Așteptat: pagin.js?v=3.9.722 (neatins) ÎNAINTEA alop.js?v=3.9.723

npm test                    # Așteptat: verde, CONSUMERS=7 în pagin-wiring
git status --short          # Așteptat: formular.html, alop.js, pagin-wiring.test.mjs, package.json = 4
```

Dacă orice „Așteptat: NIMIC" întoarce ceva, sau `DFPagin.render(` ≠ 1, sau
`#lst-count`/`#lst-pagination` s-au stricat → OPREȘTE-TE, raportează, NU comita.

===============================================================================
## PAS 8 — COMMIT (doar develop)
===============================================================================

```bash
git add public/formular.html public/js/formular/alop.js \
        server/tests/unit/pagin-wiring.test.mjs package.json
git status --short
git commit -m "PAGIN-9: cablare DFPagin numerotat pe lista ALOP (alop.js) v3.9.723"
git push origin develop
```

===============================================================================
## RAPORT FINAL (completează după rulare)
===============================================================================

- [ ] Versiune: 3.9.722 → 3.9.723
- [ ] `DFPagin.render(` = 1 în alop.js; `changeAlopPage` = 0 (funcție + export)
- [ ] `<div id="alop-pagination"></div>` gol; `#lst-pagination` și `#lst-count` neatinse
- [ ] pagin.js?v=3.9.722 neatins, înaintea alop.js?v=3.9.723; restul `?v=` neatinse
- [ ] `CACHE_VERSION` NEATINS (docflowai-v297)
- [ ] `npm test` verde, CONSUMERS=7
- [ ] git status curat înainte de commit; commit + push pe develop
- [ ] Commit hash: __________
- [ ] Observații / abateri: __________

===============================================================================
## ⛔ CONSTRÂNGERI ABSOLUTE
===============================================================================

- ⛔ Doar `develop`. Zero `main`.
- ⛔ NU atinge `#lst-pagination` / `list.js` (PAGIN-8, deja livrat) și `#lst-count` (#90).
- ⛔ NU insera un nou `<script>` pagin.js — e deja acolo din PAGIN-8; NU-i bump `?v=`.
- ⛔ Zero backend, zero migrație, zero `.sql`. NU bump `CACHE_VERSION`.
- ⛔ NU bulk-sed pe `?v=` — doar alop.js.
- ⛔ NU modifica `shared/pagin.js`.
- ⛔ NU curăța celelalte `onclick` inline din alop.js (openAlop, cancelAlop,
     alopDeschideDF, startNouaLichidare etc.) — în afara scopului.
- ⛔ Scrie `mode: 'numbered'` CU spațiu (cod ȘI test), consecvent cu PAGIN-7/8.
- ⛔ Dacă `changeAlopPage` are apelant extern (PAS 0) → NU-l șterge, doar rescrie
     `_renderAlopPagin` și raportează.
- ⛔ old_str negăsit / versiune ≠ 722 / pagin.js nu-i înaintea alop.js → oprește-te.
