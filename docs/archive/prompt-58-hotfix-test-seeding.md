---
prompt: 58-hotfix
titlu: "test(fix): alop-titlu-editabil.test.mjs — seeding corect (un seedOrgUser + seedUser cu id-uri reale)"
model_suggested: Sonnet 4.6 (Default)
branch: develop
zona: DOAR test harness (fără cod de producție)
---

# ⛔ BRANCH DISCIPLINE
> EXCLUSIV pe `develop`. NU merge/push/checkout pe `main`.

---

## Context
CI (Postgres real) a picat 2 teste în `server/tests/db/alop-titlu-editabil.test.mjs`. **Endpoint-ul e corect** (983 mock verzi). Eșecurile sunt de **seeding în test**:

1. `duplicate key ... organizations_name_key` — testul cheamă `seedOrgUser` de mai multe ori; fiecare apel face `INSERT INTO organizations (name) VALUES ('Org Test')` cu nume fix → al doilea = duplicat.
2. `expected 500 to be 200` (admin) — cookie cu `userId: 99` **neseedat**; `alop_instances.created_by`/`updated_by` referă `users(id)` → FK/authz eșuează → 500.

## Fix (DOAR fișierul de test)
Rescrie seeding-ul după tiparul din `server/tests/db/alop-link-flow-attachments.test.mjs`:

- În `beforeEach`: `await truncateAll();` apoi **un singur** `await seedOrgUser({ role:'user', email:'p1@x.ro' });` → creează **org 1 + user 1** (creatorul).
- Userii adiționali cu `seedUser({ orgId:1, ... })` (returnează id real), NU cu `seedOrgUser`:
  - „alt user fără compartiment": `const otherId = await seedUser({ orgId:1, email:'other@x.ro', role:'user', compartiment:'' });`
  - „admin": `const adminId = await seedUser({ orgId:1, email:'admin@x.ro', role:'admin' });`
- `makeAuthCookie({ userId:<id real>, role, orgId:1 })` — folosește id-urile reale (creator=1, otherId, adminId). **Elimină `userId:99`.**
- Seedează ALOP-ul cu `createdBy: 1` (via `seedAlop({ orgId:1, createdBy:1, titlu:'Titlu inițial', ... })`) — respectă semnătura reală a helper-ului `seedAlop` din `db-real.mjs`.
- Păstrează cele 4 aserții (titlu gol → 400; creator → 200 + persistă pe ALOP finalizat; other user → 403; admin → 200 indiferent de creator). `getAlop`/query-ul local rămâne.

## Interdicții
- ⛔ NU modifica `server/routes/alop.mjs` (producția e corectă).
- ⛔ NU modifica alte fișiere de test sau helperul `db-real.mjs`.
- Diff = EXCLUSIV `server/tests/db/alop-titlu-editabil.test.mjs` + `package.json` (bump patch).

## Versiune
`package.json`: `3.9.638` → `3.9.639` (dacă valoarea curentă diferă, incrementează de la ea). **Fără** bump `sw.js` (doar test).
> Notă: dacă rulezi apoi #59, pornește versiunea/`CACHE_VERSION` de la valoarea reală de după acest hotfix.

## Verificare
- `npm test` (mock) verde.
- CI DB suite: cele 2 cazuri devin verzi; suita fără regresii.

```bash
git add server/tests/db/alop-titlu-editabil.test.mjs package.json
git commit -m "test(fix): alop-titlu-editabil seeding corect — un seedOrgUser + seedUser id-uri reale (v3.9.639)"
git push origin develop
```
**STOP. NU merge/push pe `main`.**
