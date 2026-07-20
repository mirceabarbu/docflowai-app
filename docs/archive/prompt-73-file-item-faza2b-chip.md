---
prompt: 73
titlu: "refactor(UI) faza 2b: chip-ul de atașamente DF/ORD → renderFileItem (.att-chip retras), cu Ștergere/Preview/Download/eroare — DOAR prezentare"
model_suggested: Opus 4.8
branch: develop
zona: UX consecvență fișiere · formular DF/ORD (suprafață critică)
---

# ⛔ BRANCH DISCIPLINE — pornește sesiunea pe `develop`
> EXCLUSIV pe `develop`. NU merge/push/checkout pe `main`.

---

# ⚠️ SUPRAFAȚĂ CRITICĂ + DOAR PREZENTARE
> Formularul DF/ORD cu autosave. Preview (`previewAttFromChip`), download, ștergere (`remAtt`/`remAttServer`) și autosave-ul trebuie să funcționeze **exact ca înainte**. Se schimbă doar prezentarea (chip `.att-chip` → `.df-file-item`). Backend, `att-preview.js`, STS/PAdES — neatinse.

---

## Context (confirmat în cod)
- `renderAttachments(ft, slot)` (`doc.js:1119`) randează chip-urile: variantă **saved** (`item.id && docId` → preview+download+ștergere-server) și **unsaved** (fără id → doar ștergere-client).
- `remAttServer` (`doc.js:1157`) **re-randează** (`renderAttachments(ft)`) — NU depinde de `closest`. **Nu-l atinge.**
- `remAtt` (`core.js:118`) e **singurul** `closest('.att-chip')` din proiect → trebuie mutat pe `.df-file-item`.
- Stare de eroare: per-item (`item._err` → `att-chip-err` + title) și fallback de listă (`doc.js:1107`).
- `renderAttachments` e global (`window.renderAttachments`). `formular.html` **NU** include `file-item.js` — trebuie adăugat.

## 1. Helper `public/js/shared/file-item.js` — adaugă stare de eroare
Wrapper-ul suportă acum eroare (clasă + title). La construirea `return`-ului:
```js
const wrapCls = 'df-file-item' + (o.isError ? ' df-file-item--err' : '');
const wrapTitle = (o.isError && o.errorTitle) ? ` title="${esc(o.errorTitle)}"` : '';
return `<div class="${wrapCls}"${wrapTitle}> ... </div>`;
```
(Nu modifica ramurile preview/download/delete existente.)

## 2. CSS `public/css/df/components.css` — varianta eroare
```css
.df-file-item--err{background:var(--df-danger-bg);border-color:var(--df-danger-bd);}
```

## 3. `public/formular.html` — include helper-ul
Adaugă lângă `att-preview.js` (linia ~1320), cu `defer`:
```html
<script src="/js/shared/file-item.js?v=<versiune>" defer></script>
```

## 4. `public/js/formular/doc.js` — `renderAttachments` (1119-1143)
Înlocuiește `cur.forEach(... createElement('span') ... appendChild)` cu maparea prin helper:
```js
list.innerHTML = cur.map((item, idx) => {
  const name = item.filename || item.name || 'fișier';
  const errTitle = item._err ? ('Upload eșuat: ' + item._err + ' — se reîncearcă la următoarea salvare') : '';
  if (item.id && docId) {
    const url = `/api/formulare-atasamente/${ftType(ft)}/${docId}/${encodeURIComponent(item.id)}`;
    return renderFileItem({
      filename: name, sizeBytes: item.size_bytes, mimeType: item.mime_type,
      canPreview: true, previewOnclick: `previewAttFromChip('${ft}',${slot},${idx});return false;`,
      downloadHref: url, downloadName: name,
      canDelete: true, deleteOnclick: `remAttServer(${idx},'${lid}','${did}','${item.id}',this)`,
      isError: !!item._err, errorTitle: errTitle,
    });
  }
  return renderFileItem({
    filename: name, sizeBytes: item.size_bytes,
    canPreview: false, downloadHref: null,
    canDelete: true, deleteOnclick: `remAtt(${idx},'${lid}','${did}',this)`,
    isError: !!item._err, errorTitle: errTitle,
  });
}).join('');
```
P�strează `list.innerHTML=''` de la început (sau lasă maparea să-l suprascrie), `_attIds`, `docId`, restul funcției.

## 5. `public/js/formular/doc.js` — fallback de eroare de listă (1107)
```js
if (listEl) listEl.innerHTML = `<div class="df-file-item df-file-item--err" title="${df.esc(jErr?.error || ('HTTP ' + r.status))}">⚠ atașamentele nu au putut fi încărcate</div>`;
```

## 6. `public/js/formular/core.js`
### 6a. `remAtt` (118) — mută selectorul
```js
btn.closest('.df-file-item')?.remove();
```
### 6b. chip-ul creat imediat la adăugare (~108-112) — folosește helper-ul
Înlocuiește crearea manuală a `span.att-chip` cu:
```js
const holder = document.createElement('div');
holder.innerHTML = renderFileItem({ filename: f.name, canPreview:false, downloadHref:null, canDelete:true, deleteOnclick:`remAtt(${idx},'${lid}','${did}',this)` });
list.appendChild(holder.firstElementChild);
```
P�strează `window._scheduleAutoSaveDb?.(...)` **exact** (autosave neatins).

## Ce NU atingem
- ⛔ `remAttServer` (logica de ștergere-server + re-render rămâne). ⛔ `previewAttFromChip`. ⛔ `att-preview.js`. ⛔ Backend, STS/PAdES.
- Clasa `.att-chip` din `formular.css` devine moartă — **las-o** (fără risc), NU o șterge acum.

## Cache busting + versiune
- Bump `?v=` la `doc.js`, `core.js`, `file-item.js`, `components.css` în `formular.html` (+ include nou pentru `file-item.js`).
- `sw.js` `CACHE_VERSION` ++. `package.json` următorul patch.

## Guardrails diff
EXCLUSIV: `public/js/shared/file-item.js`, `public/css/df/components.css`, `public/formular.html`, `public/js/formular/doc.js`, `public/js/formular/core.js`, `public/sw.js`, `package.json`.
```bash
git diff --name-only | grep -iE "\.mjs$|att-preview\.js|pades|signing|STSCloud|semdoc-" && echo "⛔ STOP: backend/altă zonă!" || echo "✅ doar faza 2b"
git diff public/js/formular/doc.js | grep -iE "remAttServer\s*\(|async function remAttServer" && echo "⚠️ verifică: NU schimba logica remAttServer" || echo "✅ remAttServer neatins"
```

## Verificare (owner, staging) — atenție la suprafața critică
- DF/ORD, secțiunea cu atașamente:
  - Adaugi fișier → chip unificat apare imediat; **autosave** pornește (navighezi fără alt edit → fișierul rămâne).
  - După salvare/refresh: chip cu Previzualizează + Descarcă + Șterge, stil unificat.
  - **Previzualizează** → modalul se deschide (`previewAttFromChip`).
  - **Descarcă** → descarcă.
  - **Șterge** pe fișier salvat → DELETE server + re-render (dacă „document complet" → alertă „nu poate fi șters").
  - **Șterge** pe fișier nesalvat → dispare, JSON actualizat.
  - Stare de eroare (upload eșuat) → chip cu fundal danger + tooltip.
- `npm test verde, fără regresii`. `npm run check` OK.

## Final
```bash
git add public/js/shared/file-item.js public/css/df/components.css public/formular.html public/js/formular/doc.js public/js/formular/core.js public/sw.js package.json
git commit -m "refactor(ui) faza2b: chip atasamente DF/ORD -> renderFileItem (.att-chip retras), preview/download/sterge/eroare unificate"
git push origin develop
```
**STOP. NU merge/push pe `main`.**

## Raportează
- confirmarea că `remAttServer` și autosave sunt neatinse;
- că `remAtt` folosește acum `closest('.df-file-item')`;
- `npm test` verde; guardrail-urile ✅.
