---
prompt: 71
titlu: "refactor(UI) faza 2a: renderFileItem cu Ștergere + migrare upload creare flux (site editabil cu risc mic)"
model_suggested: Sonnet 4.6 (Default)
branch: develop
zona: UX consecvență fișiere · prezentare (wiring delete păstrat)
---

# ⛔ BRANCH DISCIPLINE — pornește sesiunea pe `develop`
> EXCLUSIV pe `develop`. NU merge/push/checkout pe `main`.

---

# ⚠️ REGULĂ: DOAR PREZENTARE. Ștergerea funcționează exact ca înainte.
> Extindem `renderFileItem` cu buton „Șterge" și migrăm **un singur** site editabil (upload la creare flux). Wiring-ul de ștergere (`_removeAttach`) rămâne neatins. Chip-ul DF/ORD vine separat în **faza 2b** — NU-l atinge aici.

---

## 1. Extinde helper-ul — `public/js/shared/file-item.js`
Adaugă suport de ștergere în `renderFileItem` (păstrează preview/download din faza 1):
```js
// opts nou: canDelete (bool), deleteOnclick (string, ex. "_removeAttach(3)")
const del = (o.canDelete && o.deleteOnclick)
  ? `<button type="button" class="df-file-item__btn df-file-item__btn--danger" onclick="${o.deleteOnclick}"><svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg#ico-x"/></svg>Șterge</button>`
  : '';
```
Include `del` în `df-file-item__actions`: `<span class="df-file-item__actions">${preview}${download}${del}</span>`.

## 2. CSS — `public/css/df/components.css`
Adaugă varianta danger:
```css
.df-file-item__btn--danger{color:var(--df-danger);}
.df-file-item__btn--danger:hover{background:var(--df-danger-bg);}
```

## 3. Migrează upload-ul de la creare flux — `public/js/semdoc-initiator/main.js` `_renderAttachList` (~2085)
Înlocuiește markup-ul inline al item-ului cu helper-ul (fără preview/download — fișier ne-încărcat încă; doar Ștergere):
```js
list.innerHTML = _attachFiles.map((af, i) => renderFileItem({
  filename: af.file.name, sizeBytes: af.file.size,
  canPreview: false, downloadHref: null,
  canDelete: true, deleteOnclick: `_removeAttach(${i})`,
})).join('');
```
Păstrează `hint.textContent` (`N fișier(e) selectat(e)`) și `window._removeAttach` **exact** cum sunt.

## Ce NU atingem
- ⛔ Chip-ul DF/ORD (`doc.js`, `core.js`, clasa `.att-chip`, `remAtt`/`remAttServer`) — **faza 2b**.
- ⛔ Modal email (`df-email-modal.js`). ⛔ Site-urile read-only (faza 1, gata). ⛔ Backend, STS/PAdES, `att-preview.js`.

## Cache busting + versiune
- Bump `?v=` la `file-item.js`, `semdoc-initiator/main.js`, `components.css` în paginile care le referă (`file-item.js` e inclus deja din faza 1).
- `sw.js` `CACHE_VERSION` ++. `package.json` următorul patch.

## Guardrails diff
EXCLUSIV: `public/js/shared/file-item.js`, `public/css/df/components.css`, `public/js/semdoc-initiator/main.js`, HTML-uri cu `?v=`, `public/sw.js`, `package.json`.
```bash
git diff --name-only | grep -iE "formular/doc\.js|formular/core\.js|df-email-modal|att-preview\.js|\.mjs$" && echo "⛔ STOP: faza 2b sau backend!" || echo "✅ doar faza 2a"
```

## Verificare (owner, staging)
- La creare flux, „Documente suport": fișierele selectate arată în stilul unificat (SVG paperclip + nume + KB + „Șterge"), iar „Șterge" elimină fișierul exact ca înainte.
- Site-urile din faza 1 neschimbate. `npm test verde`.

## Final
```bash
git add public/js/shared/file-item.js public/css/df/components.css public/js/semdoc-initiator/main.js public/semdoc-initiator.html public/sw.js package.json
git commit -m "refactor(ui) faza2a: renderFileItem cu Șterge + migrare upload creare flux"
git push origin develop
```
**STOP. NU merge/push pe `main`.**
