---
prompt: 72
titlu: "refactor(UI) faza 2a — completare: migrează cutia „Vor fi preluate din formular" (atașamente purtate din DF/ORD) la renderFileItem"
model_suggested: Sonnet 4.6 (Default)
branch: develop
zona: UX consecvență fișiere · prezentare (wiring păstrat)
---

# ⛔ BRANCH DISCIPLINE — pornește sesiunea pe `develop`
> EXCLUSIV pe `develop`. NU merge/push/checkout pe `main`.

---

# Context
Faza 2a (#71) a migrat DOAR staging-ul manual (`_renderAttachList`) la `renderFileItem`. A rămas nemigrată a doua listă de la creare flux: **`_renderFormAttachments`** (cutia „Vor fi preluate din formular — N fișier(e)"), care afișează atașamentele purtate din DF/ORD în stilul vechi (📄 emoji + butoane `df-action-btn sm`). La creare din DF/ORD apar deci două stiluri diferite. Acest prompt completează faza 2a. **Nu re-atinge ce e deja migrat.**

# ⚠️ DOAR PREZENTARE. Preview (delegat CSP-safe pe `data-att-id`) + Download rămân identice.

## 1. `public/js/shared/file-item.js` — adaugă suport `previewAttId`
Helper-ul are deja `previewUrl`, `previewOnclick`, `canDelete/deleteOnclick` (din #71). Adaugă în plus o ramură de preview `previewAttId` (pentru lista purtată, CSP-safe, fără date de utilizator în onclick). În logica de construire a butonului de preview, între `previewUrl` și `previewOnclick`, inserează:
```js
} else if (o.canPreview && o.previewAttId) {
  preview = `<button type="button" class="df-file-item__btn" data-att-action="preview" data-att-id="${esc(o.previewAttId)}"><svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg#ico-search"/></svg>Previzualizează</button>`;
}
```
(Nu modifica ramurile existente `previewUrl`/`previewOnclick`/`download`/`del`.)

## 2. `public/js/semdoc-initiator/main.js` — migrează `_renderFormAttachments` (~2160, blocul `items.map(a => ...)`)
Înlocuiește markup-ul inline al item-urilor cu helper-ul (read-only: preview via `previewAttId` + download, fără ștergere):
```js
items.map(a => renderFileItem({
  filename: a.filename, sizeBytes: a.size_bytes, mimeType: a.mime_type,
  canPreview: true, previewAttId: a.id,
  downloadHref: `/api/formulare-atasamente/${ft}/${encodeURIComponent(_docId)}/${encodeURIComponent(a.id)}`,
  downloadName: a.filename, canDelete: false,
})).join('')
```
**Păstrează neatins:**
- header-ul cutiei („Vor fi preluate din formular — N fișier(e), automat la lansare");
- listener-ul delegat `box.addEventListener('click', ...)` pe `data-att-action="preview"` / `data-att-id` (rezolvă `_formAttById` → `openAttPreview`). Helper-ul emite exact aceleași atribute, deci listener-ul funcționează 1:1.

## Ce NU atingem
- ⛔ `_renderAttachList` (deja migrat în #71). ⛔ `doc.js`/`core.js`/`.att-chip` (faza 2b). ⛔ `df-email-modal.js`. ⛔ Backend, STS/PAdES, `att-preview.js`.

## Cache busting + versiune
- Bump `?v=` la `file-item.js` și `semdoc-initiator/main.js` în paginile care le referă.
- `sw.js` `CACHE_VERSION` ++. `package.json` următorul patch.

## Guardrails diff
EXCLUSIV: `public/js/shared/file-item.js`, `public/js/semdoc-initiator/main.js`, `public/semdoc-initiator.html`, `public/sw.js`, `package.json`.
```bash
git diff --name-only | grep -iE "formular/doc\.js|formular/core\.js|df-email-modal|att-preview\.js|components\.css|\.mjs$" && echo "⛔ STOP: în afara completării 2a!" || echo "✅ doar completare 2a"
```
(components.css NU trebuie atins — clasele danger există deja din #71.)

## Verificare (owner, staging)
- Creare flux din DF/ORD: cutia „Vor fi preluate din formular" arată acum **identic** cu restul (SVG paperclip + nume + KB + Previzualizează + Descarcă), consecvent cu staging-ul manual.
- Preview + Descarcă funcționează pe atașamentele purtate.
- `npm test verde, fără regresii`.

## Final
```bash
git add public/js/shared/file-item.js public/js/semdoc-initiator/main.js public/semdoc-initiator.html public/sw.js package.json
git commit -m "refactor(ui) faza2a-completare: migrare cutie atasamente purtate din DF/ORD (previewAttId)"
git push origin develop
```
**STOP. NU merge/push pe `main`.**
