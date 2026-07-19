# DocFlowAI — 🩹 TRASABILITATE HOTFIX 3: class-based modal display (v3.9.451)

```
═══════════════════════════════════════════════════════════
⚠️  BRANCH: develop ONLY. NU FACE merge / push / checkout pe main.
═══════════════════════════════════════════════════════════
```

> Hotfix peste v3.9.450. Modal-ul NU se deschide deloc deși API răspunde 304
> cu date cached corecte. Cauza: CSS-ul meu original din v3.9.448 folosea
> selector-uri `[style*="display:"]` care nu mai matchează după ce JS face
> `modal.style.display = ''`. Regula CSS base `display: none` rămâne în vigoare.
>
> SOLUȚIE: pattern standard cu class. `.is-open` adăugată la deschidere,
> eliminată la închidere. Zero ambiguitate.

```
DocFlowAI v3.9.450 → v3.9.451 (SW v166 → v167)
Branch: develop  ⚠️ EXCLUSIV develop
Subiect: fix(trasabilitate): class-based modal show/hide + Cache-Control no-store

═══════════════════════════════════════════════════════════
PASUL 1 — Înlocuiește CSS-ul „clever" cu pattern class-based
═══════════════════════════════════════════════════════════

În public/formular.html, secțiunea <style> din modal-ul Trasabilitate.

PASUL 1.1 — Înlocuiește regula buggy cu cea curată:

old_str:
  /* Overlay + container modal */
  #trasabilitate-modal {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.72);
    display: none;
    align-items: flex-start; justify-content: center;
    z-index: 9999; padding: 32px 16px;
    overflow-y: auto;
  }
  #trasabilitate-modal[style*="display: "],
  #trasabilitate-modal[style*="display:"] { display: flex !important; }
  #trasabilitate-modal[style*="display: none"],
  #trasabilitate-modal[style*="display:none"] { display: none !important; }

new_str:
  /* Overlay + container modal — pattern class-based simplu */
  #trasabilitate-modal {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.72);
    display: none;
    align-items: flex-start; justify-content: center;
    z-index: 9999; padding: 32px 16px;
    overflow-y: auto;
  }
  #trasabilitate-modal.is-open { display: flex; }

═══════════════════════════════════════════════════════════
PASUL 2 — Curăță inline style="display:none;" din modal HTML
═══════════════════════════════════════════════════════════

Modal-ul are inline `style="display:none;"` care este redundant acum
(CSS base ascunde modal). Îl scot ca să fie totul curat.

old_str:
<div id="trasabilitate-modal" style="display:none;">

new_str:
<div id="trasabilitate-modal">

═══════════════════════════════════════════════════════════
PASUL 3 — JS: înlocuiește style.display cu classList
═══════════════════════════════════════════════════════════

În public/js/formular/trasabilitate.js:

PASUL 3.1 — În openTrasabilitate, înlocuiește setarea modalului:

old_str:
    const modal = document.getElementById('trasabilitate-modal');
    if (modal) modal.style.display = '';
    document.body.style.overflow = 'hidden';

    _bindDelegation();
    _showLoading();

new_str:
    const modal = document.getElementById('trasabilitate-modal');
    if (modal) modal.classList.add('is-open');
    document.body.style.overflow = 'hidden';

    _bindDelegation();
    _showLoading();

PASUL 3.2 — În closeTrasabilitate:

old_str:
  function closeTrasabilitate() {
    const modal = document.getElementById('trasabilitate-modal');
    if (modal) modal.style.display = 'none';
    document.body.style.overflow = '';
    _state.data = null;
  }

new_str:
  function closeTrasabilitate() {
    const modal = document.getElementById('trasabilitate-modal');
    if (modal) modal.classList.remove('is-open');
    document.body.style.overflow = '';
    _state.data = null;
  }

PASUL 3.3 — În keydown listener pentru ESC:

old_str:
    if (e.key === 'Escape') {
      const modal = document.getElementById('trasabilitate-modal');
      if (modal && modal.style.display !== 'none') closeTrasabilitate();
    }

new_str:
    if (e.key === 'Escape') {
      const modal = document.getElementById('trasabilitate-modal');
      if (modal && modal.classList.contains('is-open')) closeTrasabilitate();
    }

═══════════════════════════════════════════════════════════
PASUL 4 — Backend: Cache-Control no-store pe /api/trasabilitate
═══════════════════════════════════════════════════════════

Railway logs arată 304 (Not Modified) pe cererile /api/trasabilitate —
înseamnă că browser-ul cache-uiește răspunsurile API. Per CLAUDE.md
convention, rutele API trebuie să aibă Cache-Control: no-store.

În server/routes/trasabilitate.mjs, în handler-ul GET /:type/:id:

old_str:
router.get('/:type/:id', requireAuth, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'db_unavailable' });

    const { orgId } = req.actor;
    if (!orgId) return res.status(400).json({ error: 'orgId_missing_in_token' });

new_str:
router.get('/:type/:id', requireAuth, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'db_unavailable' });

    // No-cache pe API per CLAUDE.md convention
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');

    const { orgId } = req.actor;
    if (!orgId) return res.status(400).json({ error: 'orgId_missing_in_token' });

═══════════════════════════════════════════════════════════
PASUL 5 — Cache busting (3.9.450 → 3.9.451, SW v166 → v167)
═══════════════════════════════════════════════════════════

5.1 — package.json:
  old_str:   "version": "3.9.450",
  new_str:   "version": "3.9.451",

5.2 — public/sw.js:
  old_str: const CACHE_VERSION = 'docflowai-v166';
  new_str: const CACHE_VERSION = 'docflowai-v167';

5.3 — Cache busting în 4 HTML-uri (CRITIC — trasabilitate.js și formular.html
       trebuie să fie la versiunea nouă, altfel browser-ul servește cache stale):

  for f in public/formular.html public/refnec-form.html \
           public/notafd-invest-form.html public/admin.html; do
    sed -i 's/v=3\.9\.450/v=3.9.451/g' "$f"
  done

  Verifică:
  for f in public/formular.html public/refnec-form.html \
           public/notafd-invest-form.html public/admin.html; do
    OLD=$(grep -oE "v=3\.9\.4[0-9]{2}" "$f" | grep -v "v=3.9.451" | wc -l)
    NEW=$(grep -c "v=3.9.451" "$f")
    [ "$OLD" -eq 0 ] && [ "$NEW" -gt 0 ] && echo "OK $f ($NEW refs)" || echo "FAIL $f"
  done

═══════════════════════════════════════════════════════════
VERIFICARE OBLIGATORIE
═══════════════════════════════════════════════════════════

1. CSS curat aplicat:
   grep -c 'is-open' public/formular.html
   → ≥ 1 (regula CSS .is-open)
   grep -c '\[style\*=' public/formular.html | head
   → trebuie să fie 0 sau să nu apară pe trasabilitate-modal
   grep -c 'style\*="display' public/formular.html
   → 0 (nu mai folosim selectorul buggy)

2. Modal HTML curat:
   grep 'id="trasabilitate-modal"' public/formular.html
   → trebuie să apară fără 'style="display:none;"'

3. JS folosește classList:
   grep -c "classList.add('is-open')" public/js/formular/trasabilitate.js
   → ≥ 1
   grep -c "classList.remove('is-open')" public/js/formular/trasabilitate.js
   → ≥ 1
   grep -c "classList.contains('is-open')" public/js/formular/trasabilitate.js
   → ≥ 1
   grep -c "modal.style.display" public/js/formular/trasabilitate.js
   → 0 (eliminate complet)

4. Backend Cache-Control:
   grep -c "Cache-Control.*no-store" server/routes/trasabilitate.mjs
   → 1

5. Cache bump consistent:
   grep "trasabilitate.js?v=" public/formular.html
   → v=3.9.451

6. Sintaxă + teste:
   node --check public/js/formular/trasabilitate.js
   node --check server/routes/trasabilitate.mjs
   npm run check
   npm test verde, fără regresii

═══════════════════════════════════════════════════════════
COMMIT pe develop  ⚠️ NU MAIN!
═══════════════════════════════════════════════════════════
git add public/formular.html \
        public/refnec-form.html \
        public/notafd-invest-form.html \
        public/admin.html \
        public/js/formular/trasabilitate.js \
        server/routes/trasabilitate.mjs \
        public/sw.js \
        package.json

git commit -m "fix(trasabilitate): class-based modal show/hide + Cache-Control no-store (v3.9.451)

Bug runtime descoperit pe staging:
  - Backend răspunde 200/304 cu date corecte (Railway logs)
  - JS-ul nou (v3.9.450) se încarcă (Network tab confirmă v=3.9.450)
  - Console curată, ZERO erori
  - DAR: modal nu apare deloc la click 🔗

CAUZA RADICALĂ (introdusă în v3.9.448, expusă acum):
  CSS-ul meu pentru #trasabilitate-modal folosea selector-uri 'clever':
    [style*=\"display: \"], [style*=\"display:\"] { display: flex !important; }
  Ideea era ca modal.style.display = '' să elimine inline display, iar
  selectorul să prindă orice altă valoare. PROBLEMA: după
  modal.style.display = '', atributul style devine '' (gol), deci
  selectorul [style*=\"display:\"] NU mai matchează. Rezultat: regula
  CSS base 'display: none' rămâne în vigoare. Modal ascuns permanent.

  Întrebare retroactivă: 'modal s-a deschis în v3.9.449 testing?'
  Probabil NU — utilizatorul a confirmat doar Pas 4 (no 500), nu Pas 2
  (modal vizibil). Bug-ul exista din v3.9.448 dar a fost mascat de
  500 errors care precedau.

SOLUȚIE: pattern class-based standard.
  CSS:
    #trasabilitate-modal { display: none; ... }
    #trasabilitate-modal.is-open { display: flex; }
  JS:
    modal.classList.add('is-open')      // open
    modal.classList.remove('is-open')   // close
    modal.classList.contains('is-open') // ESC check

  Inline style='display:none;' eliminat din HTML — redundant acum.

BONUS — Cache-Control no-store pe API:
  Railway logs arătau 304 Not Modified pe /api/trasabilitate. Per
  CLAUDE.md convention, rutele API trebuie să aibă no-cache. Adăugat:
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
  Asta previne caching la nivel browser/proxy pe răspunsurile API.

Cache: package 3.9.450 → 3.9.451, SW v166 → v167, 4 HTML-uri bumpate."

git push origin develop  # ⚠️ NU origin main

═══════════════════════════════════════════════════════════
TEST POST-DEPLOY (staging) — minimal smoke test
═══════════════════════════════════════════════════════════

1. Hard refresh (Ctrl+Shift+R) sau în DevTools → Network → bifa
   'Disable cache' → reload — IMPORTANT pentru a forța descărcarea
   noilor formular.html + trasabilitate.js?v=3.9.451.

2. Click 🔗 inline pe orice DF/ORD din lista:
   → Modal trebuie să apară IMEDIAT cu loading spinner
   → După 1-2 sec apare arborele complet

3. Click pe badge revizie / ALOP card / ORD card:
   → Modal se închide, document deschis în tab corect

4. ESC funcționează; click overlay funcționează.

5. Console DevTools: ZERO erori.

STOP dacă:
- Modal tot nu apare → tipărește în Console:
  document.getElementById('trasabilitate-modal').classList.toggle('is-open')
  Dacă cu această comandă apare → problemă în JS la apelare
  classList.add. Dacă NU apare → modal HTML nu există în DOM (n-a
  fost aplicat la v3.9.448 deploy).

- API tot 304 după hard refresh → Cache-Control n-a ajuns; verifică
  în Network → Response Headers la /api/trasabilitate cererea —
  trebuie să apară 'cache-control: no-store'.
```
