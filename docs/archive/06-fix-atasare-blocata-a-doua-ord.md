---
fix: 6 — Atașare fișiere blocată pe a doua ORD (stare `disabled` persistentă în SPA)
target_branch: develop
model_suggested: Sonnet 4.6 (fix localizat, frontend, diagnostic deja confirmat)
risk: SCĂZUT — 2 apeluri idempotente; singurul risc = să NU deblocăm documente care trebuie blocate
---

# ⚠️ BRANCH `develop` EXCLUSIV
Toate comenzile rulează pe `develop`. NU `checkout/merge/push` pe `main`. `main` = producție, manual de owner.

## NO-TOUCH
`STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`. `git diff` gol (oricum nu le atinge — fix pur frontend formular).

## Cauză (deja diagnosticată read-only)
`lockCaptureAndAttachments(ft, true)` (`public/js/formular/doc.js:327-338`) dezactivează butonul `.att-btn` + input-ul de fișier (`o-ainp` la ORD, `n-fdai`/`n-ainp` la DF) când documentul e `completed`/`aprobat` (apelat din doc.js:721 și doc.js:748). **NU e apelat NICĂIERI cu `false`.** Fiind SPA, `#form-ordnt` nu se recreează între documente, deci `disabled=true` rămas de la prima ORD finalizată persistă pe element la a doua ORD → butonul „Atașează" e mort (click-ul nu declanșează nimic). `lockAll(ft,false)` nu rezolvă: exclude explicit `input[type=file]` (`:not([type=file])`) și nu atinge `.att-btn`.

Simptom confirmat: buton mort (fără request, fără eroare consolă), doar pe a doua ORD. Nu e regresie din fix 3 (`fc0fff5`) — bug latent preexistent.

## Fix (reset-apoi-reblochează-condiționat)
Mirror la `lockAll(ft,false)`, adaugă `lockCaptureAndAttachments(ft, false)` în cele două căi unde documentul devine editabil:
1. **`newDoc(ft)`** (în jur de doc.js:836, lângă `lockAll(ft,false)`) — document nou e mereu editabil → deblochează mereu.
2. **`loadDoc`** (în jur de doc.js:717, lângă `lockAll(ft,false)`, **ÎNAINTE** de ramurile `if` care decid lock-ul) — resetează la `false`, apoi ramurile existente `ST.docAprobat[ft]` (721) și `status==='completed'` (748) reaplică `lock=true` dacă e cazul.

⚠️ **GARD DE REGRESIE CRITIC:** resetul TREBUIE să fie poziționat **înainte** de ramurile care reaplică `lock=true`. Verifică ordinea după edit: pentru un document `completed`/`aprobat` deschis după fix, butonul „Atașează" + zona de captură trebuie să rămână **DEZACTIVATE** (reset → relock condiționat = locked). Dacă resetul ajunge după relock, ai deblocat greșit documente finalizate — inacceptabil.

Verifică întâi că `newDoc` + `loadDoc` sunt singurele căi care comută documentul activ (nu există un al treilea entry, ex. `showFormSection`, care să ocolească ambele):
```
grep -n "function newDoc\|function loadDoc\|showFormSection\|lockAll(\|lockCaptureAndAttachments(" public/js/formular/doc.js
```
Dacă există un chokepoint comun apelat de ambele, preferă un singur apel acolo (DRY). Altfel, cele 2 call-site-uri sunt corecte (oglindesc `lockAll`).

## Teste / verificări manuale
- **Repro (înainte):** finalizează o ORD → „nouă ordonanțare" → „Atașează fișiere" e mort. (După fix → funcționează.)
- **Fix (după):** a doua ORD din „nouă ordonanțare" → „Atașează" deschide selectorul, fișierul se atașează, chip apare, persistă la salvare.
- **GARD regresie #1 (cel mai important):** deschide un ORD/DF `completed` sau `aprobat` → „Atașează" + captura rămân **DEZACTIVATE**. Documentele finalizate NU devin editabile.
- **GARD regresie #2 (DF):** același bug-class pe DF (`n-fdai`/`n-ainp`) — deschide un DF draft după un DF aprobat în aceeași sesiune → atașarea DF merge; deschide un DF aprobat → atașarea DF blocată.
- Captura (zona „sistemul de control") re-activată corect doar pe documente editabile.
- `node --check public/js/formular/doc.js`; `npm test` → verde, fără regresii.

## Acceptare
- `npm test` verde, fără regresii.
- Gardul de regresie #1 verificat manual (documente finalizate rămân blocate).
- `git diff` NO-TOUCH gol.
- Cache-bust țintit: `?v=` pe `doc.js` + bump `package.json` patch. Dacă `doc.js` e în precache-ul `sw.js` → bump și `CACHE_VERSION` (verifică).
- CLAUDE.md: o linie („`lockCaptureAndAttachments(ft,false)` trebuie resetat în `newDoc`/`loadDoc` înainte de relock-ul condiționat — altfel atașarea rămâne blocată pe documentele următoare din aceeași sesiune SPA").

## Finalizare
```
git add <doar fișierele acestei sarcini>
git commit -m "fix(formulare): resetează blocajul atașare/captură în newDoc+loadDoc — atașarea nu mai rămâne blocată pe a doua ORD (bug latent SPA)"
git push origin develop
```
