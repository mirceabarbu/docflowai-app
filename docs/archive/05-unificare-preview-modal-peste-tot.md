---
fix: 5 — Unificare preview atașamente: modal peste tot (DF/ORD + signer/flux), componentă self-contained
target_branch: develop
model_suggested: Opus 4.8 (atinge pagina de signer — adiacent semnării; bara e „zero regresie pe app curat")
risk: SCĂZUT-MEDIU — UI-only, dar atinge o pagină critică care funcționează perfect azi
---

# ⚠️ BRANCH `develop` EXCLUSIV
Toate comenzile rulează pe `develop`. NU `checkout/merge/push` pe `main`. `main` = producție, manual de owner.

# 🎯 CERINȚĂ CENTRALĂ: ZERO REGRESIE
Aplicația e curată, fără buguri identificate. Preview-ul modal din DF/ORD (fix 1) funcționează perfect și **trebuie să rămână identic**. Sarcina asta NU schimbă comportamentul de pe DF/ORD — doar îl extinde la signer/flux și unifică sursa. Dacă orice pas riscă să modifice randarea modalului din DF/ORD, alege varianta mai conservatoare.

## NO-TOUCH (critic — suntem pe pagina de signer)
`STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`. `git diff` gol pe ele. NU atinge randarea documentului principal de semnare (pdf.js-ul de signing) și nimic din lanțul de semnare — DOAR butonul „Previzualizează" al documentelor suport.

## Obiectiv
Azi: preview-ul atașamentelor din **DF/ORD** deschide **modal** (frumos, dorit); cel din **flux/signer** („Documente suport" → „Previzualizează") deschide o **pagină HTML nouă** (`window.open`). Vrem **modal peste tot**, identic. Fără „deschide în filă nouă", fără portiță — doar **modal + Descarcă** (decizie owner).

## Caracterizare-întâi (obligatoriu — determină scope-ul)
```
# componenta actuală de preview (fix 1) și de ce depinde
grep -n "previewAtt\|df-modal\|df-modal-bg\|getDocument\|pdfjsLib" public/js/formular/att-preview.js public/formular.html
# TOATE locurile care fac window.open pentru preview doc suport (signer + flux intern)
grep -rn "Previzualizeaz\|window.open\|preview" public/semdoc-signer.html public/flow.html public/js/ 2>/dev/null | grep -i "preview\|window.open"
# ce pagină e captura 1? signer public (token) sau flow.html intern? are pdf.js încărcat?
grep -n "pdfjsLib\|pdf.min\|pdf.worker\|token\|public" public/semdoc-signer.html public/flow.html
# unde stau stilurile modalului (fix 1 le-a pus în formular.css)
grep -n "df-modal\|df-modal-bg" public/css/formular.css public/css/*.css
```
Identifică exact: (a) câte pagini au „Previzualizează" cu `window.open`; (b) dacă vreuna e pagina publică de signer (token, fără SPA/auth) — contează pentru self-containment; (c) versiunea pdf.js deja prezentă pe acea pagină (refolosește-o, NU adăuga altă versiune — relevant și pentru CSP report-only).

## Implementare
1. **Fă componenta self-contained.** Refactorizează `att-preview.js` astfel încât `previewAtt(url, filename, mime)`:
   - **își creează singur** containerul modal + butoanele (Descarcă / ✕) la primul apel dacă nu există deja în DOM (idempotent — dacă markup-ul există, îl reutilizează; nu creează dublură, nu dublează ID-uri);
   - nu depinde de markup injectat într-o pagină anume → merge pe orice pagină care include doar `<script>`-ul + pdf.js.
   - **Backward-compatible obligatoriu:** pe DF/ORD, dacă markup-ul există deja din fix 1, comportamentul rămâne byte-identic (aceleași clase, aceleași stiluri, ESC/backdrop/✕, fallback non-previewabil, ⬇ Descarcă).
   - Preferabil mut-o în `public/js/shared/att-preview.js` (nu mai e specifică formularului). Mutarea = doar schimbarea referinței în `formular.html` + cache-bust. Dacă mutarea riscă regresie pe DF/ORD, las-o pe loc și include-o și pe pagina de signer — coerența contează, locația fișierului nu.
2. **Wire pe signer/flux:** înlocuiește handler-ul „Previzualizează" de la `window.open(...)` la `previewAtt(...)` pe TOATE paginile găsite la caracterizare. Include `<script>`-ul componentei + asigură pdf.js prezent (refolosește versiunea existentă a paginii).
3. **CSS fără inline (CSP-safe):** nu injecta `<style>` inline din JS (CSP intri pe Phase 1 mai târziu). Stilul modalului stă într-un fișier CSS încărcat pe ambele pagini. Preferat: extrage regulile `.df-modal/.df-modal-bg` într-un `public/css/att-preview.css` shared, încărcat pe DF/ORD ȘI pe signer, și elimină duplicatul din `formular.css`. Dacă extragerea riscă să schimbe randarea pe DF/ORD, lasă `formular.css` neatins și adaugă CSS-ul DOAR pe pagina de signer (duplicare minoră acceptabilă < regresie).
4. **Nu șterge** vechea pagină/rută de preview HTML în această sarcină (chiar dacă devine nefolosită) — ștergerea unei rute poate regresa linkuri vechi. Doar oprește `window.open` către ea. Cleanup-ul rutei moarte = task opțional ulterior.

## Teste / verificări manuale (regresie = prioritate)
- **DF/ORD (must be identical):** modal PDF + scroll; imagine → `<img>`; non-previewabil → „Previzualizare indisponibilă… descarcă"; ESC / backdrop / ✕ închid; ⬇ Descarcă descarcă direct. **Nimic schimbat vs azi.**
- **Signer/flux:** „Previzualizează" deschide acum **modal** (nu filă nouă); Descarcă merge; documentul principal de semnare se randează la fel; **fluxul de semnare merge cap-coadă** (semnare reală pe staging).
- Dacă e pagina publică de signer (token): preview-ul merge fără login/SPA.
- `node --check` pe fișierele JS atinse; `npm test` verde, fără regresii.

## Acceptare
- `npm test` → **verde, fără regresii**.
- `git diff` NO-TOUCH (semnare/PAdES) = gol; randarea doc. principal de semnare neatinsă.
- Comportament DF/ORD identic cu azi (caracterizat înainte/după).
- Cache-bust țintit pe fișierele atinse (`att-preview.js`/shared, `formular.html`, pagina signer, CSS-ul) + bump `package.json` patch. Dacă vreun asset atins e în precache-ul `sw.js` → bump și `CACHE_VERSION`.
- CLAUDE.md: o linie („preview atașamente = modal unic `previewAtt` self-contained, folosit pe DF/ORD + signer/flux; fără pagină nouă").

## Finalizare
```
git add <doar fișierele acestei sarcini>
git commit -m "refactor(preview): modal unic self-contained pentru atașamente pe DF/ORD + signer/flux (înlocuiește window.open), zero regresie"
git push origin develop
```
