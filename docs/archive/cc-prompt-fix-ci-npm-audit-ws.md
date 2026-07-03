---
target_branch: develop
model_suggested: Sonnet 4.6 (task mecanic, fără logică de business)
risk: LOW-MEDIUM — bump dependență + ajustare workflow CI. Zero cod de runtime atins.
---

# ⚠️ BRANCH: `develop` EXCLUSIV ⚠️

> NU atinge `main`. Checkout/merge/push DOAR pe `develop`.

# Task: repară CI-ul roșu pe `npm audit` (ws high + scoping dev)

## Context (verificat)
Jobul `npm audit` din `.github/workflows/*.yml` rulează `npm audit --audit-level=high`
pe arborele COMPLET (cu devDependencies, pentru că `npm ci` instalează și dev) și
pică build-ul (`test` are `needs: audit`). Două cauze distincte:

1. **`ws` — vulnerabilitate de PRODUCȚIE, reală.** Advisory-uri
   GHSA-58qx-3vcg-4xpx (uninitialized memory disclosure) + GHSA-96hv-2xvq-fx4p
   (memory exhaustion DoS), afectează `ws 8.0.0 – 8.20.1`. Lockfile-ul are 8.19.0.
   `ws` e dependență DIRECTĂ (nu transitivă). Latest pe linia 8 e **8.21.0**, în
   afara intervalului afectat, în `^8` ⇒ fără breaking change.

2. **`vite` — DEV-ONLY.** `vite 8.0.8` e `dev=True`, tras de `vitest`. Dockerfile
   rulează `npm ci --omit=dev`, deci vite NU ajunge în producție. Nu e o
   vulnerabilitate a artefactului livrat — dar poarta de audit pe tot arborele o
   raportează ca high și blochează deploy-ul.

## Modificări cerute

### A. Bump `ws` (fix de securitate real)
```bash
npm install ws@^8.21.0
```
Verifică în `package-lock.json` că `node_modules/ws` e rezolvat la 8.21.0.
NU modifica nimic altceva în lockfile manual.

### B. Restrânge poarta BLOCANTĂ la ce se livrează (`--omit=dev`)
În workflow-ul de audit:
- pasul care BLOCHEAZĂ (`needs: audit` depinde de el) devine:
  ```yaml
  - name: Security audit (production deps — blochează la high/critical)
    run: npm audit --omit=dev --audit-level=high
  ```
- adaugă DUPĂ el un pas NE-blocant pentru vizibilitate pe dev tooling:
  ```yaml
  - name: Security audit (full tree — informativ, nu blochează)
    run: npm audit --audit-level=high || true
  ```
Rațiune (pune-o ca și comentariu în YAML): artefactul de producție e
`npm ci --omit=dev`; poarta blocantă auditează exact ce rulează în prod.
Advisory-urile de pe sculele de build/test rămân vizibile, dar nu opresc deploy-ul.

## Verificare locală (OBLIGATORIE înainte de push)
```bash
npm audit --omit=dev --audit-level=high   # TREBUIE să iasă cu exit 0 (zero high în prod)
npm run check                             # verde
npm test                                  # verde, fără regresii
```
Dacă `npm audit --omit=dev --audit-level=high` mai raportează ceva high în
producție după bump-ul ws, OPREȘTE-TE și raportează exact ce pachet — NU forța
`npm audit fix --force` (poate face bump-uri major care strică runtime-ul).

## Zone interzise
- Fișierele NO-TOUCH de signing — neatinse.
- `migrate.mjs` — neatins.
- NU schimba pragul de la `high` la altceva. NU adăuga `continue-on-error` pe
  pasul blocant. Singura relaxare permisă e `--omit=dev`, justificată mai sus.

## Definition of done
- `package-lock.json`: ws = 8.21.0.
- Workflow: pas blocant pe `--omit=dev`, pas informativ ne-blocant pe tot arborele.
- `npm audit --omit=dev --audit-level=high` local = exit 0.
- `npm test verde, fără regresii` + `npm run check` verde.
- Bump `package.json` patch +1 (3.9.559 → 3.9.560). Fără frontend ⇒ fără CACHE_VERSION.
- Commit + push DOAR pe `develop`. Confirmă apoi că jobul `npm audit` din GitHub
  Actions e VERDE pe develop. STOP înainte de orice gând spre `main`.
- Raport: versiunea ws înainte/după, ce a rămas în auditul informativ (dev), link
  la run-ul CI verde.
