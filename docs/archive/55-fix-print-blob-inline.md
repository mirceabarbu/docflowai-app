---
fix: Butonul „Print" din previzualizare descărca fișierul (Adobe) în loc să lanseze printarea. Cauză: iframe-ul de print folosea href-ul de download (Content-Disposition: attachment). Fix: printează dintr-un Blob URL creat din octeții deja aduși de preview (inline, fără disposition). Pur frontend.
target_branch: develop
model_suggested: Sonnet 4.6 (Default) — corecție în modulul de preview partajat; zero backend
risk: MIC (refolosește octeții deja fetch-uiți; blob URL local)
version: 3.9.634 → 3.9.635
---

# ⚠️ BRANCH `develop` EXCLUSIV — NU atinge `main`
TOATE comenzile pe `develop`. NU `checkout` / `merge` / `push` pe `main`. La final: `git push origin develop` și **STOP**.

# Simptom (owner)
Butonul „Print" (adăugat în 54) nu lansează printarea — în schimb descarcă PDF-ul și-l deschide în Adobe.

# Cauză (confirmată în cod)
`public/js/shared/att-preview.js`, `printAttPreview()` pointează un iframe ascuns pe `href`-ul lui `att-preview-download`. Acel URL întoarce `Content-Disposition: attachment` (+ atribut `download`) → iframe-ul respectă disposition-ul și DESCARCĂ fișierul în loc să-l randeze inline pentru print. (Preview-ul în sine merge fiindcă `fetch()` ignoră disposition-ul; iframe-ul nu.)

# Fix (pur frontend) — refolosește octeții deja aduși, ca Blob URL inline
`openAttPreview` deja face `fetch(url) → arrayBuffer()` (ramura PDF, ~linia 103) și `resp.blob()` (ramura imagine). Un **Blob URL** (`URL.createObjectURL`) nu are Content-Disposition → se randează inline în iframe → `print()` funcționează. Fără backend, fără dublă descărcare.

# Etapa 0 — caracterizare
```bash
cd $(git rev-parse --show-toplevel); git branch --show-current   # develop
grep -n 'arrayBuffer()\|resp.blob()\|renderPdfInto\|printAttPreview\|att-preview-print-frame\|closeAttPreview\|createObjectURL' public/js/shared/att-preview.js
```

# Modificare — `public/js/shared/att-preview.js`

## 1. Variabilă de modul pentru ultimul blob previzualizat
Lângă celelalte variabile de modul (sus, la nivel de IIFE/modul), adaugă:
```js
let _lastPreviewBlob = null;
```

## 2. În `openAttPreview` — reset la început + stochează blob-ul
La ÎNCEPUTUL funcției (înainte de fetch): `_lastPreviewBlob = null;`
Ramura PDF — creează blob-ul din `buf` ÎNAINTE de `renderPdfInto` (constructorul Blob copiază octeții, deci rămâne valid chiar dacă pdf.js detașează ArrayBuffer-ul):
```js
const buf = await resp.arrayBuffer();
_lastPreviewBlob = new Blob([buf], { type: 'application/pdf' });   // pentru Print (inline)
// ... apoi renderPdfInto(container, buf) ca acum
```
Ramura imagine — refolosește blob-ul deja obținut:
```js
const blob = await resp.blob();
_lastPreviewBlob = blob;   // pentru Print
// ... restul ramurii imagine ca acum
```

## 3. Rescrie `printAttPreview()` să folosească Blob URL
```js
function printAttPreview(){
  if (!_lastPreviewBlob) {                       // fallback: nimic randat → deschide în tab
    const dl = document.getElementById('att-preview-download');
    const url = dl && dl.getAttribute('href');
    if (url && url !== '#') window.open(url, '_blank');
    return;
  }
  const blobUrl = URL.createObjectURL(_lastPreviewBlob);
  const old = document.getElementById('att-preview-print-frame');
  if (old) old.remove();
  const frame = document.createElement('iframe');
  frame.id = 'att-preview-print-frame';
  frame.setAttribute('aria-hidden','true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  frame.src = blobUrl;
  frame.onload = () => {
    try { frame.contentWindow.focus(); frame.contentWindow.print(); }
    catch(e){ window.open(blobUrl, '_blank'); }
    setTimeout(() => { try { URL.revokeObjectURL(blobUrl); frame.remove(); } catch(_){} }, 60000);
  };
  document.body.appendChild(frame);
}
window.printAttPreview = printAttPreview;
```

## 4. Curățare la închidere (opțional, igienă)
În `closeAttPreview`, adaugă: `_lastPreviewBlob = null;` și, dacă există, `document.getElementById('att-preview-print-frame')?.remove();`

> NU atinge backend-ul, `renderPdfInto`, `openAttPreview` în rest, sau butoanele existente. NU adăuga `?preview=1` / nu schimba rute — Blob URL-ul face inutil orice fix de disposition pe server.

# Verificare manuală (owner)
1. Previzualizează un atașament PDF → „Print" → se deschide dialogul de printare cu documentul randat (NU descărcare Adobe).
2. „PDF semnat" → Print funcționează.
3. Document de Fundamentare → Print funcționează.
4. O imagine (jpg/png) → Print o tipărește.
5. Ca semnatar prin link cu token → Print merge (blob-ul vine din fetch-ul preview-ului, care are deja token în URL).
6. Descarcă și Închide — neschimbate.

# Guardrails diff
EXCLUSIV: `public/js/shared/att-preview.js`, `public/*.html` (bump `?v=`), `public/sw.js`, `package.json`.
```bash
git diff --name-only | grep -E "server/|\.mjs$|renderPdfInto" && echo "⛔ STOP: în afara att-preview.js!" || echo "✅ doar att-preview.js"
git diff public/js/shared/att-preview.js | grep -E "createObjectURL|_lastPreviewBlob" && echo "✅ fix blob aplicat"
```

# Cache busting + versiune
`package.json` 3.9.634 → 3.9.635. `CACHE_VERSION` în `public/sw.js`. `?v=3.9.635` pe `shared/att-preview.js` în TOATE HTML-urile care îl încarcă (grep `att-preview.js` prin `public/*.html`).
> ATENȚIE la bump-ul `?v=`: NU folosi `sed` cu backreference `\1` urmat de cifră (coliziune cunoscută). Verifică `git diff` înainte de commit că liniile `att-preview.js?v=` sunt corecte în toate HTML-urile.

# La final
```bash
git add -A -- public/js/shared/att-preview.js public/*.html public/sw.js package.json
git commit -m "fix(preview): Print randează inline dintr-un Blob URL (nu mai descarcă via attachment) (v3.9.635)"
git push origin develop
```
**STOP. NU merge/push pe `main`.** Raportează: (1) `_lastPreviewBlob` stocat în ambele ramuri (PDF/imagine), reset la început/închidere; (2) `printAttPreview` folosește Blob URL + revoke; (3) verificat că Print randează inline, nu descarcă; (4) `?v=` corect în toate HTML-urile (verificat din diff); (5) `npm test verde, fără regresii`, `npm run check` OK, v3.9.635.
