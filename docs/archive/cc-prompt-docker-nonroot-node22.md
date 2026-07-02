---
target_branch: develop
model_suggested: Sonnet 4.6
risk: LOW-MEDIUM — non-root poate rupe căi de scriere la runtime (LibreOffice/PDF temp).
                   Verificare pe staging OBLIGATORIE; `npm test` NU acoperă asta.
---

# ⚠️ BRANCH: `develop` EXCLUSIV ⚠️
> NU atinge `main`. Checkout/merge/push DOAR pe `develop`.

# Task: Dockerfile — user non-root + aliniere Node 20→22

## Context (verificat)
`Dockerfile`:
- `FROM node:20-slim` — CI rulează pe Node 22 (`.github/workflows`), `.node-version` = 20. Mismatch.
- Instalează componente LibreOffice (writer/calc/impress/draw) + fonturi. `npm ci --omit=dev`.
- `ENV HOME=/tmp` DEJA setat (LibreOffice își scrie profilul în /tmp — bun pentru non-root).
- Rulează ca **root** (fără `USER`). Fără HEALTHCHECK.

## Modificări cerute
1. `FROM node:20-slim` → `FROM node:22-slim`.
2. `.node-version`: `20` → `22` (aliniere cu CI).
3. **User non-root.** Imaginile `node:*-slim` au deja userul `node` (uid 1000). După `COPY . .`,
   asigură-te că `/app` e citibil de `node` și adaugă `USER node` înainte de `CMD`.
   `HOME=/tmp` rămâne (scriibil de oricine), deci profilul LibreOffice merge.
4. (Opțional) `HEALTHCHECK` care lovește `/readyz` — NOTĂ: Railway folosește healthcheck-ul lui,
   nu pe cel din Dockerfile, deci e cosmetic. Include-l doar dacă nu complică build-ul.

## VERIFICARE CRITICĂ înainte de `USER node` (asta e tot riscul)
Non-root rupe orice scriere în afara /tmp. Înainte de a fixa `USER node`, CITEȘTE unde scrie
appul fișiere la runtime:
- `server/utils/convertToPdf.mjs` și orice cale de conversie LibreOffice — scriu în
  `os.tmpdir()` / `/tmp`, sau în `/app` / cwd?
- Generare PDF temporar, upload-uri pe disc, loguri pe fișier?
Dacă TOATE scrierile merg în `/tmp` (sau `os.tmpdir()`) → `USER node` e safe.
Dacă vreo cale scrie în `/app` sau cwd → fie redirijează spre `os.tmpdir()`, fie `chown`
directorul respectiv către `node` în Dockerfile. RAPORTEAZĂ ce-ai găsit înainte să comiți.

## Zone interzise
- NU atinge codul de semnare / NO-TOUCH. NU schimba lista de pachete LibreOffice în acest task
  (hardening LibreOffice — timeout, temp per-conversie, cleanup, limite — e TASK SEPARAT).
- NU schimba `CMD` / portul.

## Definition of done
- `Dockerfile` pe `node:22-slim`, `USER node`, `.node-version` = 22.
- `npm test verde` + `npm run check` verde (CI pe Node 22 oricum).
- **Verificare manuală pe staging (Railway):** o conversie LibreOffice reală (DOCX→PDF) ȘI o
  semnare cu generare PDF rulează cu succes ca non-root. Asta NU e acoperită de `npm test` —
  e gardul real al acestui task.
- Bump `package.json` patch +1. Commit + push DOAR pe `develop`. STOP înainte de `main`.
- Raport: ce căi de scriere ai găsit (toate /tmp?), ce ai schimbat în Dockerfile, confirmarea
  conversiei + semnării pe staging.
