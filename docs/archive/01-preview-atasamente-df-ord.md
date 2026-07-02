---
fix: 1 / 4 — Preview inline pentru atașamentele din DF/ORD (fără descărcare)
target_branch: develop
model_suggested: Sonnet 4.6 (frontend, reutilizare componentă existentă)
risk: SCĂZUT — doar afișare, fără schimbare de stocare, fără migrare
---

# ⚠️ BRANCH `develop` EXCLUSIV
Toate comenzile rulează pe `develop`. NU propune și NU executa `checkout/merge/push` pe `main`. `main` = producție, se gestionează manual de owner.

## NO-TOUCH (git diff trebuie curat pe acestea)
`STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`. Nu atinge nimic din lanțul de semnare.

## Obiectiv
În formularele DF și ORD, atașamentele uploadate (ex. „declaratie interese 2026.pdf", „declaratie avere 2026.pdf") apar acum ca **chip-uri cu link de descărcare**. Cel care verifică e nevoit să descarce ca să le vadă. Vrem **preview inline** — exact ca în signer/initiator (`semdoc-signer.html`, `pdfPagesContainer` cu pdf.js) — printr-un click pe chip se deschide un modal cu randarea documentului. **Read-only. Nu modificăm stocarea, nu adăugăm migrare.**

## Caracterizare-întâi (obligatoriu, înainte de orice modificare)
```
# unde se randează chip-urile de atașament în DF/ORD
grep -n "addAtt\|remAtt\|atasament\|attachment" public/js/formular/core.js public/js/formular/doc.js
# endpoint-ul care servește bytes-ul atașamentului de formular (DF/ORD)
grep -rn "atasamente\|attachment" server/routes/formulare-db.mjs server/routes/formulare*.mjs
# cum face signer-ul preview-ul (componenta de reutilizat)
grep -n "pdfPagesContainer\|pdfjsLib\|getDocument\|render" public/semdoc-signer.html
# este pdf.js deja încărcat pe formular.html?
grep -n "pdf.js\|pdfjs\|pdf.min" public/formular.html
```

## Implementare
1. **Reutilizează viewer-ul din signer.** Dacă pdf.js NU e încărcat pe `formular.html`, încarcă **exact aceeași sursă** ca în `semdoc-signer.html` (același CDN/local, aceeași versiune — verifică în signer, nu inventa). Nu duplica logica de randare; extrage-o într-un helper mic dacă e nevoie, dar fără refactor mare.
2. **Modal de preview** declanșat la click pe chip (numele fișierului devine clickabil; păstrează un buton/icon separat de descărcare pentru fallback):
   - **PDF** → randare cu pdf.js, container scrollabil cu `max-height` ca în signer (≈ comportamentul `pdfPagesContainer`), fără să se extindă la infinit.
   - **Imagine** (png/jpg/webp) → `<img>` în modal.
   - **Alt tip** (docx/xlsx etc.) → fallback la descărcare (mesaj scurt „Previzualizare indisponibilă pentru acest tip — descarcă").
3. **Sursa bytes-ului**: folosește endpoint-ul existent de atașament al formularului (cel găsit la caracterizare). NU crea endpoint nou dacă există deja unul care întoarce conținutul.
4. **Funcționează în ambele**: DF și ORD (verifică că lista de atașamente e randată din același cod sau din module paralele — aplică în ambele).
5. Respectă design system-ul existent: clase scoped (`.df-*`), sprite SVG pentru iconițe, fără `!important` pe selectori bare. Modal-ul să folosească stilul de modal deja prezent în formular dacă există.

## Teste
- Caracterizare frontend dacă există infra de test UI; altfel, cel puțin asigură-te că `npm test` rămâne verde (nu introduci regresii pe backend).
- Manual (staging): DF salvat cu 2 atașamente PDF → click pe chip → preview inline, scroll, fără descărcare. Atașament imagine → preview `<img>`. Atașament non-previewabil → fallback descărcare. Idem pe ORD.

## Acceptare
- `npm test` → **verde, fără regresii**.
- `git diff` pe NO-TOUCH = gol.
- Cache-bust **țintit** doar pe fișierele atinse (`core.js`/`doc.js` + `formular.html` `?v=`), bump `version` în `package.json` (patch).

## Finalizare
```
git add -A
git commit -m "feat(formulare): preview inline atașamente DF/ORD (reuse pdf.js din signer), fără descărcare"
git push origin develop
```
