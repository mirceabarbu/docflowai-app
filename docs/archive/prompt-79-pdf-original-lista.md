---
prompt: 79
titlu: "feat(preview): „PDF original" în kebab-ul „Fluxurile mele" (modal preview, ca în detaliu)"
model_suggested: Sonnet 4.6 (Default)
branch: develop
zona: UX preview PDF · kebab listă
---

# ⛔ BRANCH DISCIPLINE — pornește sesiunea pe `develop`
> EXCLUSIV pe `develop`. NU merge/push/checkout pe `main`.

---

## Cerință (owner)
În detaliu, „PDF original" se deschide în modalul de preview (din #67). Vrem același buton și în **kebab-ul din „Fluxurile mele"** (lângă „PDF semnat" / „Raport conformitate").

## Analiză
- Kebab-ul (`semdoc-initiator/main.js:1280-1282`, `dlActions`) are „PDF semnat" (`data-signed-action="preview"`) + „Raport conformitate", cu listener delegat pe `data-signed-action` (~1178) și `data-audit-action` (~1187).
- „PDF original" = endpoint `/flows/:id/pdf` (întoarce PDF). `openAttPreview` face `fetch→blob→preview`. Butonul e util oricând (originalul există de la crearea fluxului).

## Fix — `public/js/semdoc-initiator/main.js`

### 1. Buton în kebab (lângă `dlActions`)
Adaugă un item „PDF original" disponibil oricând (nu gated pe `pdfReady`):
```js
const origAction = `<button type="button" class="df-action-btn df-kebab-item" data-orig-action="preview" data-orig-url="/flows/${encodeURIComponent(f.flowId)}/pdf" data-orig-name="${esc((f.docName || ('DocFlowAI_' + f.flowId)))}.pdf"><svg class="df-ic" viewBox="0 0 24 24"><use href="/icons.svg?v=3.9.475#ico-file"/></svg>PDF original</button>`;
```
Include `origAction` în markup-ul kebab-ului (ex. lângă `dlActions`, în aceeași ordine ca în detaliu: PDF semnat, PDF original, Raport conformitate). Verifică numele iconului în sprite (`ico-file`/`ico-file-text`) și folosește cel corect.

### 2. Handler delegat (oglindește `data-signed-action`, ~1178-1181)
```js
{
  const b = ev.target.closest('[data-orig-action="preview"]');
  if (b) {
    if (typeof window.openAttPreview !== 'function') { window.open(b.getAttribute('data-orig-url'), '_blank'); return; }
    window.openAttPreview(b.getAttribute('data-orig-url'), b.getAttribute('data-orig-name'), 'application/pdf');
    return;
  }
}
```
(Adaugă-l în același listener delegat unde sunt `data-signed-action`/`data-audit-action`, ca să nu dublezi listenerii.)

## Ce NU atingem
- ⛔ Backend / endpoint `/flows/:id/pdf` (există). ⛔ `att-preview.js`. ⛔ STS/PAdES. ⛔ „PDF semnat"/„Raport conformitate"/„Audit PDF" existente.

## Cache busting + versiune
- Bump `?v=` la `semdoc-initiator/main.js` în paginile care-l referă. `sw.js` `CACHE_VERSION` ++. `package.json`.

## Guardrails diff
EXCLUSIV: `public/js/semdoc-initiator/main.js`, HTML cu `?v=`, `public/sw.js`, `package.json`.
```bash
git diff --name-only | grep -iE "\.mjs$|att-preview|pades|signing|STSCloud" && echo "⛔ STOP!" || echo "✅ doar FE kebab"
```

## Verificare (owner, staging)
- „Fluxurile mele" → kebab → apare „PDF original" → se deschide în modal (Descarcă+Print), ca în detaliu.
- Restul acțiunilor din kebab — neschimbate.

## Final
```bash
git add public/js/semdoc-initiator/main.js public/*.html public/sw.js package.json
git commit -m "feat(preview): PDF original in kebab Fluxurile mele (modal)"
git push origin develop
```
**STOP. NU merge/push pe `main`.**
