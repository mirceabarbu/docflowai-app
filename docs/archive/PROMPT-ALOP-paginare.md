---
id: ALOP-PAGIN
titlu: Paginare listă ALOP — oglindește pattern-ul canonic DF/ORD (cu persistență)
model_suggested: Sonnet 4.6 / Default   # frontend bine delimitat; backendul e deja gata
branch: develop
bump: 3.9.711   # frontend (alop.js + formular.html) → ?v= țintit; CACHE_VERSION doar dacă atingi PRECACHE
---

⚠️⚠️⚠️ BRANCH: **develop** — EXCLUSIV. NU merge/push/checkout pe `main` (= PRODUCȚIE, manual, Mircea).

===============================================================================
CONTEXT (bug producție + diagnostic pe cod v3.9.704 — nu re-investiga)
===============================================================================

BUG: lista ALOP („Formulare oficiale" → tab ALOP) arată doar 20 din 45 de poziții, fără
buton de paginare. Backendul e OK — FRONTENDUL e rupt.

 • Backend `GET /api/alop` (server/routes/alop.mjs:319) are DEJA paginare completă:
   citește `page`/`limit` din query (default limit=20), aplică OFFSET, și întoarce în
   răspuns `{ ..., total, page, pages }`. NIMIC de schimbat pe backend.
 • Frontend `public/js/formular/alop.js:185` cheamă `fetch('/api/alop')` — FĂRĂ `?page`/
   `?limit`, fără să citească `total`/`pages`, fără să randeze controale. → primește prima
   pagină de 20 și atât.

DECIZIA lui Mircea: folosește pattern-ul canonic de paginare din proiect, CU persistența lui.
Pattern-ul canonic = lista DF/ORD din `public/js/formular/list.js` (+ markup în formular.html).
OGLINDEȘTE-l fidel — NU inventa alt mecanism, NU „încarcă mai multe", NU „toate deodată".

PATTERN-UL DE OGLINDIT (din list.js, verificat):
 • Stare: `_lstState = { type, page:1, limit:20 }` (persistă page în stare, resetat la 1 la
   schimbarea filtrului). Persistența = starea `page` se păstrează între reîncărcări ale
   listei (ex. după ștergere/refresh de listă rămâi pe pagina curentă; se resetează la 1
   doar când schimbi filtrul/tab-ul).
 • `loadList()` pune `page=`+`limit=` în query string, citește `j.total`, randează tabelul
   ȘI `_renderLstPagin(total, page, limit)`.
 • `_renderLstPagin(total,page,limit)`: `totalPages=Math.ceil(total/limit)||1`; dacă <=1
   ascunde controalele; altfel afișează „Pagina X din Y (N total)", disable prev la page<=1,
   disable next la page>=totalPages.
 • `changeLstPage(dir)`: `page = Math.max(1, page+dir); loadList();`
 • Markup (formular.html): `<div class="lst-pagination" id="lst-pagination" style="display:none">`
   cu `#lst-prev` (onclick changeLstPage(-1)), `#lst-page-info`, `#lst-next` (onclick changeLstPage(1)).

===============================================================================
PAS 0 — Citește ambele analoage ÎNAINTE de a scrie
===============================================================================
    sed -n '336,340p;503,660p' public/js/formular/list.js      # starea + _renderLstPagin + changeLstPage
    sed -n '260,266p' public/formular.html                     # markup #lst-pagination
    grep -n "async function loadAlop\|renderAlop\|fetch('/api/alop'\|_alopState\|function.*[Aa]lop.*list" public/js/formular/alop.js | head
    # Identifică funcția care încarcă+randează lista ALOP (cea de la linia ~185) și cum e apelată.

===============================================================================
PAS 1 — alop.js: stare de paginare + query + citire total (mirror list.js)
===============================================================================

În `public/js/formular/alop.js`:
 • Adaugă o stare de paginare pentru ALOP, analog `_lstState`:
     let _alopState = { page: 1, limit: 20 };
   (Dacă lista ALOP are deja filtre de status, integrează `page`/`limit` lângă ele; page se
   RESETEAZĂ la 1 când se schimbă filtrul, se PĂSTREAZĂ altfel — exact ca list.js.)
 • În funcția care încarcă lista (linia ~185), schimbă `fetch('/api/alop')` să trimită
   page+limit și să citească total/pages:
     const qs = new URLSearchParams();
     qs.set('page', _alopState.page);
     qs.set('limit', _alopState.limit);
     // (dacă există filtru de status activ, adaugă-l aici: qs.set('status', ...))
     const r = await fetch(`/api/alop?${qs.toString()}`, { credentials:'include' });
     const j = await r.json();
     const rows = j.items || j.alops || j.rows || j;   // verifică cheia REALĂ a listei în răspuns
     // ... randează rows ca acum ...
     _renderAlopPagin(j.total || 0, _alopState.page, _alopState.limit);
   ⚠️ Verifică forma EXACTĂ a răspunsului `/api/alop` (ce cheie poartă array-ul + că `total`
   există) — citește alop.mjs:315-405 și nu presupune numele cheii.

===============================================================================
PAS 2 — alop.js: _renderAlopPagin + changeAlopPage (mirror _renderLstPagin/changeLstPage)
===============================================================================

    function _renderAlopPagin(total, page, limit){
      const pg   = document.getElementById('alop-pagination');
      const info = document.getElementById('alop-page-info');
      const prev = document.getElementById('alop-prev');
      const next = document.getElementById('alop-next');
      if(!pg) return;
      const totalPages = Math.ceil(total/limit) || 1;
      if(totalPages <= 1){ pg.style.display='none'; return; }
      pg.style.display='flex';
      if(info) info.textContent = `Pagina ${page} din ${totalPages} (${total} total)`;
      if(prev) prev.disabled = page <= 1;
      if(next) next.disabled = page >= totalPages;
    }
    function changeAlopPage(dir){
      _alopState.page = Math.max(1, _alopState.page + dir);
      /* apelează funcția existentă de încărcare a listei ALOP (aceeași ca la refresh) */
    }
    // expune changeAlopPage pe window dacă folosești onclick în markup (ca list.js: window.changeLstPage=...)

===============================================================================
PAS 3 — formular.html: markup paginare ALOP (mirror #lst-pagination)
===============================================================================

Găsește containerul listei ALOP (unde se randează cardurile/rândurile — grep după id-ul
folosit de renderer, ex. `alop-list`/`alopBody`/tabelul ALOP) și adaugă IMEDIAT după el,
mirror exact markup-ul DF/ORD:

    <div class="lst-pagination" id="alop-pagination" style="display:none">
      <button class="df-action-btn sm" id="alop-prev" onclick="changeAlopPage(-1)">← Anterior</button>
      <span id="alop-page-info" class="lst-page-info"></span>
      <button class="df-action-btn sm" id="alop-next" onclick="changeAlopPage(1)">Următor →</button>
    </div>

(Reutilizează clasele `.lst-pagination`/`.lst-page-info` existente — fără CSS nou.)

===============================================================================
PAS 4 — Reset page la 1 când se schimbă filtrul de status (persistența corectă)
===============================================================================
Dacă tabul ALOP are filtre (status/căutare), oriunde se schimbă filtrul setează
`_alopState.page = 1` ÎNAINTE de reîncărcare (exact ca list.js:387/671). La navigarea
prev/next și la refresh simplu, page se PĂSTREAZĂ. Asta e „persistența" cerută.

===============================================================================
PAS 5 — Verificare + bump
===============================================================================
    node --check public/js/formular/alop.js
    npm test        # verde, fără regresii

`package.json`: 3.9.710 → 3.9.711.
`?v=` țintit pe alop.js (în formular.html). CACHE_VERSION: verifică dacă alop.js e în
PRECACHE_ASSETS — dacă NU, doar ?v= (formular.html e servit network-first, ca flow.html).
    grep -n "alop.js\|PRECACHE" public/sw.js | head

RAPORT FINAL:
1. Diff alop.js (stare + query page/limit + citire total + _renderAlopPagin + changeAlopPage).
2. Cheia reală a array-ului din răspunsul /api/alop (confirmată, nu presupusă).
3. Markup #alop-pagination adăugat după containerul listei.
4. Reset page=1 la schimbarea filtrului; page păstrat la prev/next/refresh.
5. CACHE_VERSION DA/NU + motiv; ?v= țintit. `npm test` passed/0 fail. `git diff --name-only`.
6. Commit+push develop (`fix(alop): paginare listă ALOP — mirror pattern DF/ORD (v3.9.711)`) + hash.

ACCEPTANCE (manual, Mircea, staging): tabul ALOP cu 45 poziții → apar controalele
„Pagina 1 din 3 (45 total)", Următor duce la pagina 2 (pozițiile 21–40), pagina 3 (41–45),
prev/next se dezactivează la capete. Ca admin, org_admin ȘI user obișnuit deopotrivă.

===============================================================================
CONSTRÂNGERI ABSOLUTE ⛔
===============================================================================
⛔ NU atinge backendul `/api/alop` (paginarea e deja completă acolo).
⛔ OGLINDEȘTE pattern-ul DF/ORD — NU inventa „încarcă mai multe" / „toate deodată" / scroll infinit.
⛔ Reutilizează clasele CSS `.lst-pagination`/`.lst-page-info` — fără CSS nou.
⛔ Verifică cheia reală a array-ului din răspunsul /api/alop — NU presupune `rows`/`items`.
⛔ NU atinge `server/signing/*`. `?v=` țintit, CACHE_VERSION doar dacă alop.js e în PRECACHE.
⛔ Totul pe `develop`. NU merge/push pe `main`. Contrazicere grep vs prompt ⇒ oprește-te și raportează.
