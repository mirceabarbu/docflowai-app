---
prompt: 67
titlu: "feat(preview): „PDF original" și „Raport conformitate" se deschid în modalul de previzualizare (ca „PDF semnat"), în flow detaliu și în Fluxurile mele"
model_suggested: Sonnet 4.6 (Default)
branch: develop
zona: UX preview PDF · reutilizare openAttPreview
---

# ⛔ BRANCH DISCIPLINE — pornește sesiunea pe `develop`
> EXCLUSIV pe `develop`. NU merge/push/checkout pe `main`. `main` = producție, manual.

---

## Cerință (owner)
„PDF semnat" se deschide deja în modalul de previzualizare (fetch → blob → preview, cu Descarcă + Print în modal). Vrem **același comportament** pentru **„PDF original"** și **„Raport conformitate"**, în **ambele locuri**: flow detaliu și „Fluxurile mele".

## Analiză (confirmată în cod)
`window.openAttPreview(url, name, 'application/pdf')` face `fetch(url, {credentials:'include'}) → blob → preview` — merge cu orice URL care întoarce PDF-ul. „PDF semnat" îl folosește deja (`flow.js downloadSigned`, `main.js:1181`). Deci rutarea e curată; modalul are deja Descarcă + Print, deci nu se pierde descărcarea.

Stare curentă:
- **flow detaliu** (`public/js/flow/flow.js`): `downloadSigned` → preview ✅; `downloadOriginal` → **descarcă** ❌; „Raport conformitate" (`btnTrustReport`) → **descarcă** (anchor) ❌.
- **Fluxurile mele** (`public/js/semdoc-initiator/main.js`): PDF semnat → preview ✅; „Raport conformitate" (`downloadTrustReportInit`) → **descarcă** ❌. („PDF original" nu există în lista din kebab — doar în detaliu.)

## Fix

### 1. `public/js/flow/flow.js` — `downloadOriginal()`
Rutează prin modal, exact ca `downloadSigned` (cu fallback la descărcare):
```js
async function downloadOriginal(){
  const url   = `/flows/${encodeURIComponent(flowId)}/pdf`;
  const fname = `DocFlowAI_${flowId}.pdf`;
  if (typeof window.openAttPreview === 'function') { window.openAttPreview(url, fname, 'application/pdf'); return; }
  try { const blob = await apiFetchBlob(url); downloadBlob(blob, fname); }
  catch(e){ setMsg("error", "❌ Nu am putut deschide PDF-ul original: " + esc(String(e.message || e))); }
}
```

### 2. `public/js/flow/flow.js` — „Raport conformitate" (`btnTrustReport`)
Rutează prin modal (fetch-ul din `openAttPreview` acoperă generarea; modalul are propriul loading). Păstrează descărcarea ca fallback:
```js
_btnReport.addEventListener("click", () => {
  const url   = `/api/flows/${encodeURIComponent(flowId)}/report?force=1`;
  const fname = `TrustReport_${flowId}.pdf`;
  if (typeof window.openAttPreview === 'function') { window.openAttPreview(url, fname, 'application/pdf'); return; }
  /* fallback: logica actuală de generare + descărcare anchor */
});
```
(Endpoint-ul întoarce PDF pe GET — `openAttPreview` face GET, deci merge.)

### 3. `public/js/semdoc-initiator/main.js` — „Raport conformitate" din listă
Rutează `downloadTrustReportInit` prin modal: folosește **exact același URL de raport** pe care-l folosește acum, dar în loc de descărcare cheamă:
```js
window.openAttPreview(reportUrl, `TrustReport_${flowId}.pdf`, 'application/pdf');
```
cu fallback la descărcarea existentă dacă `openAttPreview` lipsește. (PDF semnat rămâne cum e — deja previzualizează.)

## Ce NU atingem
- ⛔ Backend / endpoint-uri PDF (întorc deja PDF-ul). ⛔ `att-preview.js` (modalul e gata, cu Descarcă+Print). ⛔ Zona STS/PAdES/semnare.
- Doar rerutarea celor 3 acțiuni prin `openAttPreview`, cu fallback păstrat.

## Cache busting + versiune
- `public/*.html` care referă `flow.js` și `semdoc-initiator/main.js` → bump `?v=`.
- `public/sw.js`: `CACHE_VERSION` ++. `package.json`: următorul patch (de la valoarea reală curentă).

## Guardrails diff
EXCLUSIV: `public/js/flow/flow.js`, `public/js/semdoc-initiator/main.js`, HTML-urile cu `?v=` aferent, `public/sw.js`, `package.json`.
```bash
git diff --name-only | grep -iE "\.mjs$|att-preview|pades|signing|STSCloud" && echo "⛔ STOP: zonă nepermisă!" || echo "✅ doar FE preview"
```

## Verificare (owner, staging)
- Flow detaliu: „PDF original" și „Raport conformitate" → se deschid în modal (cu Descarcă + Print), nu descarcă direct.
- Fluxurile mele: „Raport conformitate" din kebab → modal. „PDF semnat" neschimbat.
- Fallback: dacă modalul lipsește, se descarcă (ca înainte).

## Final
```bash
git add public/js/flow/flow.js public/js/semdoc-initiator/main.js public/*.html public/sw.js package.json
git commit -m "feat(preview): PDF original + Raport conformitate în modalul de previzualizare (flow + Fluxurile mele)"
git push origin develop
```
**STOP. NU merge/push pe `main`.**
