---
fix: CI roșu — fișier de test obsolet (`ord-display-status-list`) asertează `display_status` eliminat la v3.9.598; șterge-l
target_branch: develop
model_suggested: Sonnet 4.6 (ștergere fișier redundant + verificare referințe reziduale)
risk: FOARTE SCĂZUT — ștergere test obsolet (subsumat de matricea de 14); zero cod de producție
version: 3.9.598 → 3.9.599
---

# ⚠️ BRANCH `develop` EXCLUSIV
Toate comenzile pe `develop`. NU `checkout/merge/push` pe `main`. La final `git push origin develop` și STOP.

## NO-TOUCH
TOT codul de producție + `formulare-status-display.test.mjs` (matricea de 14, e corectă și verde — NU o atinge). Acest task atinge doar ștergerea fișierului obsolet + `package.json`.

## Context — de ce e CI roșu (deși 598 e corect)
Consolidarea `badge_status` (v3.9.598) a eliminat corect `display_status` din răspunsul `/api/formulare/list`. Matricea nouă `server/tests/db/formulare-status-display.test.mjs` (14 cazuri) e verde. DAR a rămas fișierul VECHI `server/tests/db/ord-display-status-list.test.mjs` (din fix-urile 13–16) care încă asertează `row.display_status` — câmp care nu mai există → 5 eșecuri în CI (`expected undefined to be 'transmis_flux'` / `to be null`). Local nu s-a văzut: testele DB se auto-skip fără Postgres.

Fișierul vechi e **redundant** — cele 5 cazuri ale lui (transmis_flux, aprobat, completed, cancelled, șters) sunt complet acoperite de matricea de 14 din `formulare-status-display.test.mjs`.

## Implementare
### 1. Șterge fișierul obsolet
```bash
git rm server/tests/db/ord-display-status-list.test.mjs
```

### 2. Verifică referințe reziduale la `display_status` în TOATE testele (insurance)
```bash
grep -rn "display_status" server/tests/ public/js/ && echo "⚠️ mai există referințe la display_status — verifică-le" || echo "✅ nicio referință reziduală la display_status"
```
Dacă apare orice altă referință la `display_status` în teste (sau în frontend), raporteaz-o ÎNAINTE de a continua — nu o repara orbește; confirmăm că nu e altă scăpare de la consolidare. (Frontend-ul ar trebui să folosească doar `badge_status` după 598.)

### 3. Confirmă că matricea de 14 e singura sursă rămasă pentru status
```bash
ls server/tests/db/ | grep -iE "status|display"   # ar trebui să rămână DOAR formulare-status-display.test.mjs
```

## Teste
`npm test verde, fără regresii`. **Atenție:** suita mock NU include testele DB. Confirmarea reală e CI pe acest push (Postgres real) — raportează că suita DB e verde în CI, nu doar mock-ul local. `npm run check` OK.

## Guardrails diff
```bash
git diff --name-only --cached; git status --short
# trebuie să arate DOAR: deleted ord-display-status-list.test.mjs + modified package.json
git diff --name-only | grep -vE "package\.json" ; git diff --cached --name-only | grep -vE "ord-display-status-list" && echo "verifică" || echo "✅"
```
Nimic din `server/routes/`, `server/services/`, `public/`, sau `formulare-status-display.test.mjs`.

## Versiune
- bump `package.json`: `3.9.598` → `3.9.599`.

## La final
```bash
git add -u server/tests/db/ord-display-status-list.test.mjs package.json
git commit -m "test(status): șterge fișierul obsolet ord-display-status-list (asertează display_status eliminat la 598); matricea de 14 rămâne sursa unică (v3.9.599)"
git push origin develop
```
STOP. NU merge/push pe `main`. Raportează: confirmarea că suita DB e VERDE în CI (nu doar mock-ul local), că nu mai există referințe reziduale la `display_status`, și că `formulare-status-display.test.mjs` (14 cazuri) e singurul test de status rămas.
