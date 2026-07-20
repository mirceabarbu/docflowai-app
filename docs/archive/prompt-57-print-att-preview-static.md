---
prompt: 57
titlu: "fix(preview): butonul Print lipsește la previzualizarea atașamentelor DF/ORD — markup static din formular.html rămas fără #att-preview-print"
model_suggested: Sonnet 4.6 (Default)
branch: develop
zona: UX · preview atașamente · sincronizare markup static↔JS
---

# ⛔ BRANCH DISCIPLINE — CITEȘTE ÎNTÂI
> **EXCLUSIV pe `develop`.** NU face `merge` / `push` / `checkout` pe `main`.
> `main` = producție, gestionat manual de owner. Deploy staging = push pe `develop`.
> Dacă vreun pas te-ar duce spre `main`, **OPREȘTE-TE** și raportează.

---

## Simptom (owner)
La previzualizarea unui atașament al unui **DF** (modalul „Previzualizare atașament", ex. `deseuri.pdf`), în footer apar doar **Descarcă** și **Închide** — **butonul Print lipsește**. Pe pagina de semnare (`semdoc-signer.html`) Print-ul apare corect.

## Cauză-rădăcină (confirmată în cod)
Componenta shared `public/js/shared/att-preview.js` are **două surse de markup** pentru modalul `#att-preview-modal`:
1. **JS-injected** (`ensureModal()`, ~linia 40) — folosit de `semdoc-signer.html`, care **NU** are modalul static. Aici Print-ul (`#att-preview-print`) **există** (adăugat la #54).
2. **Static în `public/formular.html`** (liniile ~1551–1567) — folosit de **DF/ORD**. `ensureModal()` face `if (modal) return modal;` când găsește modalul static → **NU injectează niciodată varianta JS**. Footer-ul static a rămas cu doar `Descarcă` + `Închide`.

Deci #54 a modificat doar markup-ul JS, iar copia statică din `formular.html` a rămas nesincronizată. `window.printAttPreview` e global și folosește `_lastPreviewBlob` (independent de markup) — deci butonul va funcționa imediat ce e prezent în DOM.

## Fix (o singură zonă, pur HTML)
### `public/formular.html` — footer-ul modalului static `#att-preview-modal`
Între `<a id="att-preview-download">…Descarcă</a>` și `<button …primary…>Închide</button>`, inserează butonul Print **byte-identic** cu cel din `att-preview.js:53–54` (SVG inline, NU sprite — ca să nu depindă de `ico-print`):

```html
      <button type="button" id="att-preview-print" class="df-action-btn" onclick="printAttPreview()" title="Printează">
        <svg class="df-ico" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg> Print
      </button>
```

Footer-ul rezultat: `Descarcă` · `Print` · `Închide` — aceeași ordine ca în varianta JS.

**Note:**
- NU modifica `att-preview.js` (varianta JS e deja corectă) și NU atinge logica `printAttPreview` / `ensureModal`.
- Nu adăuga CSS nou (CSP-safe) — `.df-action-btn` există deja.
- (Opțional, ieftin) adaugă un comentariu scurt lângă footer-ul static în `formular.html` gen `<!-- ținut sincron cu att-preview.js ensureModal() footer -->`, ca să nu mai driftăm la o viitoare editare.

## Cache busting + versiune
Schimbarea e într-o pagină HTML cacheată de SW:
- bump `package.json`: patch următor (ex. `3.9.636` → `3.9.637` — dacă versiunea curentă diferă, incrementează de la ea).
- bump `CACHE_VERSION` în `public/sw.js` (ex. `docflowai-v265` → `docflowai-v266`).
- `att-preview.js` **neschimbat** ⇒ NU-i schimba `?v=`.

## Guardrails diff (rulează înainte de commit)
`git diff --name-only` trebuie să atingă **EXCLUSIV**: `public/formular.html`, `public/sw.js`, `package.json`.

```bash
git diff --name-only | grep -vE "^(public/formular\.html|public/sw\.js|package\.json)$" \
  && echo "⛔ STOP: fișier nepermis în diff!" || echo "✅ doar formular.html + sw.js + package.json"
git diff public/js/shared/att-preview.js | grep . \
  && echo "⛔ STOP: att-preview.js NU trebuie atins!" || echo "✅ att-preview.js neatins"
```

## Verificare (owner, pe staging după deploy)
- Deschide un DF cu atașament → „Previzualizare" → footer-ul arată **Descarcă · Print · Închide**.
- Click Print → deschide dialogul de printare pentru PDF-ul previzualizat.
- Același comportament pe ORD (același modal static).
- Nicio regresie pe `semdoc-signer.html` (Print-ul de acolo funcționează în continuare).

## Teste
`npm test verde, fără regresii`. `npm run check` OK. (Schimbarea e HTML static — fără test unitar dedicat; verificarea e vizuală pe staging.)

## La final
```bash
git add public/formular.html public/sw.js package.json
git commit -m "fix(preview): buton Print în modalul static de atașamente DF/ORD (sincron cu att-preview.js) (v3.9.637)"
git push origin develop
```
**STOP. NU merge/push pe `main`.**

## Raportează
- confirmarea că diff-ul atinge doar cele 3 fișiere și `att-preview.js` e neatins;
- `npm test` verde, fără regresii;
- versiunea nouă + `CACHE_VERSION` bumpate.
