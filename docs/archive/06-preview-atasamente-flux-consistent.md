---
fix: Preview inline consistent pentru atașamentele de FLUX (detaliu flux + listă „Fluxurile mele")
target_branch: develop
model_suggested: Sonnet 4.6 (randare frontend read-only, fără logică financiară; dar respectă strict guardrails-urile)
risk: SCĂZUT — doar afișare/randare a atașamentelor de flux deja existente; zero backend, zero write-path
version: 3.9.585 → 3.9.586  (confirmă întâi că `package.json` e pe 585; dacă diferă, bump +1 de la valoarea curentă)
---

# ⚠️ BRANCH `develop` EXCLUSIV
Toate comenzile pe `develop`. NU `checkout/merge/push` pe `main`. `main` = producție, manual de owner. La final `git push origin develop` și STOP.

## NO-TOUCH semnare (standard)
`STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`. `git diff` curat.

## ⛔ NO-TOUCH EXTINS — sistemul de atașamente FORMULAR (zona fix 11)
Atașarea documentelor din formulare în flux a costat mult efort (race condition fix 11) și e separată de acest task. **`git diff` TREBUIE să fie CURAT** pe toate următoarele — dacă apare orice diff aici, OPREȘTE:
```
server/routes/formulare/shared.mjs          (endpoint /api/formulare-atasamente)
server/routes/formulare/df.mjs              (copiere formulare_atasamente la revizie)
server/services/formular-flow-attachments.mjs  (copiere formulare_atasamente → flow_attachments)
server/services/formular-shared.mjs         (linkFlowFormular)
server/routes/flows/crud.mjs                (fix 11 — pre-set flow_id + copiere)
server/routes/flows/lifecycle.mjs           (INSERT flow_attachments la revizie)
server/routes/flows/attachments.mjs         (endpoint flux — NU se modifică, preview există deja)
public/js/formular/doc.js                   (add/remove atașamente formular)
```
Și, în `public/js/semdoc-initiator/main.js`, blocul de **preview atașamente FORMULAR** (în jur de linia 1940–1965, cel care folosește `/api/formulare-atasamente` și `data-att-action="preview"`) rămâne **BYTE-IDENTIC**. NU-l atinge. Modificăm DOAR blocul de documente-suport de flux (în jur de linia 1174, care folosește `/flows/.../attachments`).

## Context — două sisteme separate
- **Atașamente FORMULAR** = tabela `formulare_atasamente`, endpoint `/api/formulare-atasamente/...`. **NU se atinge.**
- **Atașamente FLUX** = tabela `flow_attachments`, endpoint `/flows/:flowId/attachments/:attId`. **DOAR aici lucrăm**, și doar pe afișare.

Componenta de preview există deja, self-contained: `public/js/shared/att-preview.js` expune `window.openAttPreview(url, filename, mimeType)` (randează PDF via pdf.js, imagini direct, restul → mesaj „indisponibil + descarcă"). Își creează singură modalul dacă nu există în DOM. Endpoint-ul flux suportă deja `?preview=1` → `Content-Disposition: inline` (PDF). **Zero backend de modificat.**

## Obiectiv
Consistență: atașamentele de flux să poată fi previzualizate fără descărcare, exact ca pe pagina de semnatar (care deja o face). Două locuri lipsesc:
1. **Detaliu flux** (`flow.html` / `flow.js` `loadAttachments`).
2. **Listă „Fluxurile mele"** (`semdoc-initiator/main.js`, blocul `attRow` ~1174).

## Caracterizare-întâi (confirmă înainte să modifici)
```bash
# 1. Blocul listă (DOAR acesta în main.js) — folosește /flows/.../attachments
grep -n "attRow_\|Documente suport\|/flows/\${encodeURIComponent(f.flowId)}/attachments" public/js/semdoc-initiator/main.js
# 2. Blocul FORMULAR din același fișier (NU-l atinge) — folosește /api/formulare-atasamente + data-att-action
grep -n "/api/formulare-atasamente\|data-att-action" public/js/semdoc-initiator/main.js
# 3. Detaliu flux
grep -n "loadAttachments\|/attachments?\|attachmentsList\|⬇ Descarcă" public/js/flow/flow.js
# 4. Endpoint preview deja existent (read-only, NU-l modifica)
grep -n "preview === '1'\|Content-Disposition" server/routes/flows/attachments.mjs
# 5. Stack pdf.js pe pagina-analog (semdoc-signer) — îl replicăm pe flow.html
grep -n "pdf.min.js\|pdfjs-worker\|att-preview\|components.css" public/semdoc-signer.html
# 6. flow.html: are components.css, NU are pdf.js / att-preview
grep -n "pdf\|att-preview\|components.css" public/flow.html
```
Dacă harta diferă de cele de mai sus → OPREȘTE și raportează.

## Regulă comună de randare (ambele locuri)
Pentru fiecare atașament `flow_attachments`:
- **Afișează butonul „Previzualizează" DOAR dacă** mime e PDF (`application/pdf`) sau imagine (`image/*`). Pentru zip/rar/alte tipuri → doar descărcare (nu un buton de preview care duce la „indisponibil").
- **Păstrează ÎNTOTDEAUNA descărcarea** (link `⬇` / „Descarcă"), neschimbată.
- **CSP-safe**: NU pune `onclick` inline cu date utilizator (filename). Folosește delegare cu `data-*`, exact ca blocul formular existent: pe element pui `data-preview-url`, `data-filename`, `data-mime`; un singur listener delegat pe containerul listei citește atributele și apelează `window.openAttPreview(url, filename, mime)`.
- URL preview: `…/attachments/{id}?preview=1` (+ `&token=…` dacă există token de semnatar în context). URL descărcare: `…/attachments/{id}` (+ `?token=…` ca azi).
- Verifică defensiv `typeof window.openAttPreview === 'function'` înainte de apel (non-fatal dacă lipsește).

## Etapa A — Listă „Fluxurile mele" (risc zero, fără dependențe noi)
Pagina `semdoc-initiator.html` are deja pdf.js + `att-preview.js` + `components.css`. Doar randarea e download-only.

În `public/js/semdoc-initiator/main.js`, blocul `attRow` (~1174): înlocuiește `<a href=… download>…⬇</a>` per atașament cu randarea conform „Regulii comune": nume = „Previzualizează" (pentru PDF/imagine) + `⬇` descărcare separat. Adaugă un listener delegat pe `row` (`attRow_${f.flowId}`) care, la clic pe `[data-att-action="preview"]`, apelează `openAttPreview` cu `data-preview-url`/`data-filename`/`data-mime`. Restul logicii (fetch lista, `iconByMime`, `KB`) rămâne.

## Etapa B — Detaliu flux (adaugă pdf.js pe flow.html)
1. **`public/flow.html`** — adaugă în `<head>`/înainte de scripturi, replicând stack-ul de pe `semdoc-signer.html` (FĂRĂ `pdf-lib-loader`, care e doar pentru generare):
   ```html
   <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
   <script src="/js/common/pdfjs-worker.js?v=3.9.586"></script>
   ```
   și înainte de `</body>` (sau lângă celelalte scripturi, cu `defer`):
   ```html
   <script src="/js/shared/att-preview.js?v=3.9.586" defer></script>
   ```
   `components.css` e deja prezent. CSP-ul global permite `cdnjs.cloudflare.com` (îl folosesc celelalte 3 pagini) — verifică totuși că nu apare violare în consolă.
2. **`public/js/flow/flow.js`** — în `loadAttachments`, rescrie `list.innerHTML` conform „Regulii comune": nume → preview (PDF/imagine), `⬇ Descarcă` păstrat. Propagă `linkToken` în URL-ul de preview când există. Adaugă listener delegat pe `attachmentsList`.
3. (Opțional) `public/js/common/pdfjs-worker.js` — extinde comentariul de antet să menționeze și `flow.html`. Fără schimbare de logică.

## Guardrails diff (verifică ÎNAINTE de commit)
`git diff --stat` trebuie să atingă **EXCLUSIV**:
```
public/js/flow/flow.js
public/flow.html
public/js/semdoc-initiator/main.js   (DOAR blocul attRow ~1174)
public/js/common/pdfjs-worker.js     (opțional, doar comentariu)
package.json  public/sw.js           (cache-bust)
```
Rulează și confirmă ZERO diff pe lista NO-TOUCH EXTINS de mai sus:
```bash
git diff --name-only | grep -E "formulare_atasamente|formulare/shared|formular-flow-attachments|formular-shared|flows/crud|flows/lifecycle|flows/attachments|formular/doc.js" && echo "⛔ STOP: ai atins zona formular!" || echo "✅ zona formular intactă"
git diff public/js/semdoc-initiator/main.js | grep -n "/api/formulare-atasamente" && echo "⛔ STOP: ai atins blocul formular din main.js!" || echo "✅ blocul formular neatins"
```

## Teste
`npm test verde, fără regresii`. (Task pur de randare frontend — nu se adaugă teste DB; nu slăbi nimic existent.) `npm run check` syntax OK.

## Cache busting + versiune
- bump `package.json`: `3.9.585` → `3.9.586` (confirmă valoarea curentă întâi);
- incrementează `CACHE_VERSION` în `public/sw.js`;
- `?v=3.9.586` pe scripturile noi/atinse: `att-preview.js` și `pdfjs-worker.js` în `flow.html`; și pe `main.js` în `semdoc-initiator.html` (fișier modificat).

## La final
```bash
git add .
git commit -m "feat(preview): preview inline consistent pentru atașamente flux (detaliu + listă) (v3.9.586)"
git push origin develop
```
STOP. NU merge/push pe `main`. Raportează: fișierele atinse, output-ul celor 2 verificări de guardrails (zona formular intactă), status `npm test`. Confirmare vizuală pe staging rămâne la owner: preview PDF + imagine pe detaliu flux ȘI pe lista „Fluxurile mele", descărcarea încă funcțională, zip/rar fără buton de preview.
