---
feat: Adaugă un buton „Print" în modulul de previzualizare partajat (att-preview.js), lângă „Descarcă" și „Închide". Fiind partajat, apare în toate previzualizările: atașamente, PDF semnat, Document de Fundamentare etc.
target_branch: develop
model_suggested: Sonnet 4.6 (Default) — UI generic în modulul de preview; zero backend, zero semnare/ALOP
risk: MIC (adaugă un buton + o funcție de print prin iframe ascuns, cu fallback)
version: 3.9.633 → 3.9.634
---

# ⚠️ BRANCH `develop` EXCLUSIV — NU atinge `main`
TOATE comenzile pe `develop`. NU `checkout` / `merge` / `push` pe `main`. La final: `git push origin develop` și **STOP**.
> Ordine: după 53 (633). Dacă rulezi 54 înaintea lui 53, ajustează versiunile ca să rămână crescătoare.

# Cerință (owner)
În modulul de previzualizare (folosit în mai multe locuri), pe lângă „Descarcă" și „Închide", adaugă un buton „Print".

# Context (confirmat în cod)
`public/js/shared/att-preview.js`, `ensureModal()` (~linia 32-51): footer cu `<a id="att-preview-download" ... href=# download>Descarcă</a>` (href-ul e setat la URL-ul fișierului în `openAttPreview`, ~linia 95) + buton „Închide". PDF-ul e randat cu pdf.js (`renderPdfInto`), NU iframe — deci pentru print folosim un iframe ASCUNS pe URL-ul fișierului + `print()`, cu fallback pe deschidere în tab. `att-preview.js` e PARTAJAT (atașamente, PDF semnat — promptul 46, DF preview), deci butonul apare peste tot dintr-o singură modificare. Icon de printer NU există în icons.svg → folosim SVG inline.

# Etapa 0 — caracterizare
```bash
cd $(git rev-parse --show-toplevel); git branch --show-current   # develop
grep -n 'att-preview-download\|att-preview-close\|Descarcă\|Închide\|ensureModal\|dl.href = url\|closeAttPreview' public/js/shared/att-preview.js | head
```

# Modificare — `public/js/shared/att-preview.js`

## 1. Buton Print în footer (în `ensureModal`, ÎNTRE „Descarcă" și „Închide")
Adaugă, imediat după `<a id="att-preview-download" ...>…Descarcă</a>`:
```js
'<button type="button" id="att-preview-print" class="df-action-btn" onclick="printAttPreview()" title="Printează">' +
  '<svg class="df-ico" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg> Print' +
'</button>' +
```

## 2. Funcția `printAttPreview()` (lângă closeAttPreview, expusă pe window)
```js
function printAttPreview(){
  const dl = document.getElementById('att-preview-download');
  const url = dl && dl.getAttribute('href');
  if (!url || url === '#') return;
  const old = document.getElementById('att-preview-print-frame');
  if (old) old.remove();
  const frame = document.createElement('iframe');
  frame.id = 'att-preview-print-frame';
  frame.setAttribute('aria-hidden','true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  frame.src = url;
  frame.onload = () => {
    try { frame.contentWindow.focus(); frame.contentWindow.print(); }
    catch(e){ window.open(url, '_blank'); }   // fallback (ex. cross-origin/token)
  };
  document.body.appendChild(frame);
}
window.printAttPreview = printAttPreview;
```
> `href`-ul lui `att-preview-download` conține deja URL-ul corect (inclusiv token-ul pentru semnatari, unde e cazul). NU schimba `openAttPreview`, `renderPdfInto`, sau butoanele existente. NU atinge backend-ul.

# Verificare manuală (owner)
1. Previzualizează un atașament PDF → apare butonul „Print" între Descarcă și Închide → click → se deschide dialogul de printare cu documentul.
2. Previzualizează „PDF semnat" (din card/detaliu) → Print funcționează.
3. Previzualizează un Document de Fundamentare → Print funcționează.
4. Ca semnatar prin link cu token → Print merge (token e în URL).
5. Descarcă și Închide funcționează ca înainte.

# Guardrails diff
EXCLUSIV: `public/js/shared/att-preview.js`, `public/*.html` (bump `?v=`), `public/sw.js`, `package.json`.
```bash
git diff --name-only | grep -E "server/|\.mjs$|formular|semdoc|flow/flow\.js" && echo "⛔ STOP: în afara modulului de preview!" || echo "✅ doar att-preview.js (partajat)"
```

# Cache busting + versiune
`package.json` 3.9.633 → 3.9.634. `CACHE_VERSION` în `public/sw.js`. `?v=3.9.634` pe `shared/att-preview.js` în TOATE HTML-urile care îl încarcă (grep `att-preview.js` prin `public/*.html`).

# La final
```bash
git add -A -- public/js/shared/att-preview.js public/*.html public/sw.js package.json
git commit -m "feat(preview): buton Print în modulul de previzualizare partajat (lângă Descarcă/Închide) (v3.9.634)"
git push origin develop
```
**STOP. NU merge/push pe `main`.** Raportează: (1) buton Print adăugat între Descarcă și Închide; (2) `printAttPreview` prin iframe ascuns + fallback tab; (3) apare în toate previzualizările (atașamente/PDF semnat/DF); (4) `?v=` bump pe att-preview.js în toate HTML-urile relevante; (5) `npm test verde, fără regresii`, `npm run check` OK, v3.9.634.
