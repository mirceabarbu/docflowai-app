---
prompt: 70
titlu: "refactor(UI) faza 1: helper partajat renderFileItem + .df-file-item — uniformizează afișarea fișierelor atașate (site-uri read-only)"
model_suggested: Sonnet 4.6 (Default)
branch: develop
zona: UX consecvență fișiere atașate · prezentare (wiring neatins)
---

# ⛔ BRANCH DISCIPLINE — pornește sesiunea pe `develop`
> EXCLUSIV pe `develop`. NU merge/push/checkout pe `main`.

---

# ⚠️ REGULĂ: DOAR PREZENTARE, funcționalitatea rămâne identică
> Wiring-ul (preview/download) NU se schimbă — doar prezentarea devine consecventă. Preview-ul prin `data-att-action="preview"` (listener delegat existent) și `previewSupportAtt` rămân neatinse. `att-preview.js` neatins. Zero backend.

---

## Context
Fișierele atașate se afișează diferit în 7 locuri (iconițe emoji diferite, „Descarcă" uneori text uneori „↓/⬇", stiluri diferite). **Faza 1**: creăm un component vizual partajat și migrăm **doar cele 3 site-uri read-only** (fără ștergere), ca să validăm vizual înainte de zonele editabile.

## 1. Helper nou — `public/js/shared/file-item.js`
```js
(function(){
  const esc = s => String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  // opts: { filename, sizeBytes, mimeType, canPreview, previewUrl, previewOnclick, downloadHref, downloadName }
  window.renderFileItem = function(opts){
    const o = opts || {};
    const name = esc(o.filename || '');
    const kb   = (o.sizeBytes != null) ? `<span class="df-file-item__size">· ${(o.sizeBytes/1024).toFixed(0)} KB</span>` : '';
    let preview = '';
    if (o.canPreview && o.previewUrl) {
      preview = `<button type="button" class="df-file-item__btn" data-att-action="preview" data-preview-url="${esc(o.previewUrl)}" data-filename="${name}" data-mime="${esc(o.mimeType||'')}"><svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg#ico-search"/></svg>Previzualizează</button>`;
    } else if (o.canPreview && o.previewOnclick) {
      preview = `<a href="#" class="df-file-item__btn" onclick="${o.previewOnclick}"><svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg#ico-search"/></svg>Previzualizează</a>`;
    }
    const download = o.downloadHref
      ? `<a class="df-file-item__btn" href="${esc(o.downloadHref)}" download="${esc((o.downloadName||o.filename||'').replace(/"/g,''))}"><svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg#ico-download"/></svg>Descarcă</a>`
      : '';
    return `<div class="df-file-item">
      <svg class="df-file-item__ico df-ic" viewBox="0 0 24 24"><use href="/icons.svg#ico-paperclip"/></svg>
      <span class="df-file-item__name" title="${name}">${name}</span>
      ${kb}
      <span class="df-file-item__actions">${preview}${download}</span>
    </div>`;
  };
})();
```
Include-l (`<script src="/js/shared/file-item.js?v=<versiune>" defer></script>`) în `flow.html`, `semdoc-initiator.html`, `semdoc-signer.html` — înainte de JS-ul paginii, lângă `att-preview.js`.

## 2. CSS — `public/css/df/components.css`
Adaugă (enterprise, cu tokenii existenți; icon+text):
```css
.df-file-item{display:flex;align-items:center;gap:10px;padding:6px 10px;background:rgba(124,92,255,.08);border:1px solid rgba(124,92,255,.2);border-radius:8px;font-size:.82rem;}
.df-file-item__ico{width:15px;height:15px;color:var(--df-text-3);flex:none;}
.df-file-item__name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--df-text);}
.df-file-item__size{color:var(--df-text-3);font-size:.76rem;flex:none;}
.df-file-item__actions{display:inline-flex;align-items:center;gap:6px;flex:none;}
.df-file-item__btn{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:6px;border:1px solid transparent;background:none;color:#b39dff;font-weight:600;font-size:.76rem;cursor:pointer;text-decoration:none;}
.df-file-item__btn:hover{background:rgba(124,92,255,.14);}
.df-file-item__btn .df-ic{width:13px;height:13px;}
.df-file-item + .df-file-item{margin-top:6px;}
```

## 3. Migrează cele 3 site-uri read-only (wiring păstrat 1:1)

### `public/js/flow/flow.js` (~565-578)
Înlocuiește markup-ul inline al item-ului cu:
```js
return renderFileItem({
  filename: a.filename, sizeBytes: a.sizeBytes, mimeType: a.mimeType,
  canPreview: isAttPreviewable(a.mimeType),
  previewUrl: `/flows/${encodeURIComponent(flowId)}/attachments/${a.id}?preview=1${tokenAnd}`,
  downloadHref: dlUrl, downloadName: a.filename,
});
```
(Listener-ul delegat `data-att-action="preview"` rămâne — helper-ul emite aceleași atribute.)

### `public/js/semdoc-initiator/main.js` (~1368-1375, lista Fluxurile mele)
Păstrează header-ul „Documente suport" (dar înlocuiește emoji 📎 din header cu SVG `ico-paperclip`, opțional). Item-urile:
```js
atts.map(a => {
  const dlUrl = `/flows/${encodeURIComponent(f.flowId)}/attachments/${a.id}`;
  return renderFileItem({
    filename: a.filename, sizeBytes: a.sizeBytes, mimeType: a.mimeType,
    canPreview: isPreviewable(a.mimeType),
    previewUrl: `${dlUrl}?preview=1`,
    downloadHref: dlUrl, downloadName: a.filename,
  });
}).join('')
```
(Item-urile se vor așeza acum unul sub altul — consecvent și mai lizibil; e o îmbunătățire intenționată.)

### `public/js/semdoc-signer/main.js` (~123-135)
Preview-ul folosește `previewSupportAtt(idx)` — pasează-l prin `previewOnclick` (păstrează funcția neatinsă):
```js
list.innerHTML = atts.map((a, idx) => {
  const attUrl = `/flows/${encodeURIComponent(flow)}/attachments/${a.id}?token=${encodeURIComponent(token||'')}`;
  return renderFileItem({
    filename: a.filename, sizeBytes: a.sizeBytes, mimeType: a.mimeType,
    canPreview: a.mimeType === 'application/pdf',
    previewOnclick: `previewSupportAtt(${idx});return false;`,
    downloadHref: attUrl, downloadName: a.filename,
  });
}).join('');
```

## Ce NU atingem
- ⛔ `att-preview.js`, `previewSupportAtt`, listener-ele delegate `data-att-action`. ⛔ Backend. ⛔ Zona STS/PAdES.
- ⛔ Site-urile editabile (chip DF/ORD, upload creare flux, email) — vin în **faza 2**.
- Dacă `ico-search`/`ico-paperclip` nu există în sprite, folosește alternativa cea mai apropiată din `icons.svg` (verifică).

## Cache busting + versiune
- `file-item.js` include nou cu `?v=` în cele 3 HTML-uri.
- Bump `?v=` la `flow.js`, `semdoc-initiator/main.js`, `semdoc-signer/main.js`, `components.css` în paginile care le referă.
- `sw.js` `CACHE_VERSION` ++. `package.json` următorul patch.

## Guardrails diff
EXCLUSIV: `public/js/shared/file-item.js` (nou), `public/css/df/components.css`, `public/js/flow/flow.js`, `public/js/semdoc-initiator/main.js`, `public/js/semdoc-signer/main.js`, HTML-urile (`flow.html`, `semdoc-initiator.html`, `semdoc-signer.html`), `public/sw.js`, `package.json`.
```bash
git diff --name-only | grep -iE "\.mjs$|att-preview\.js|pades|signing|STSCloud|formular/doc\.js|df-email-modal" && echo "⛔ STOP: zonă din faza 2 sau backend!" || echo "✅ doar faza 1 read-only"
```

## Verificare (owner, staging)
- Flow detaliu, Fluxurile mele, pagina de semnare: fișierele arată **identic** (icon SVG + nume + KB + „Previzualizează"/„Descarcă"), iar preview-ul și descărcarea **funcționează exact ca înainte**.
- `npm test verde, fără regresii`.

## Final
```bash
git add public/js/shared/file-item.js public/css/df/components.css public/js/flow/flow.js public/js/semdoc-initiator/main.js public/js/semdoc-signer/main.js public/flow.html public/semdoc-initiator.html public/semdoc-signer.html public/sw.js package.json
git commit -m "refactor(ui) faza1: renderFileItem partajat + .df-file-item pe site-urile read-only"
git push origin develop
```
**STOP. NU merge/push pe `main`.**
