---
prompt: "#105f"
titlu: "Lockout flow-access → ramură platform-admin în canActorReadFlow (dormant la o org)"
model_suggested: "Opus 4.8"
target_version: "v3.9.731"
branch: "develop"
migratii: "nu"
cache_bump: "nu"
depinde_de: "#105a..#105e (76258a6)"
---

# ⚠️ BRANCH: `develop` EXCLUSIV
`main` = PRODUCȚIE, MANUAL. Zero push/merge pe `main`. Push DOAR pe `origin develop`.

---

## Context (de ce)

`services/flow-access.mjs:canActorReadFlow` (poarta canonică de citire a fluxurilor, folosită de
GET /flows/:flowId + signed-pdf/pdf/attachments + email + transmit) cere azi `sameOrg` pentru
admin:

```js
const sameOrg = actor.orgId && data.orgId && String(actor.orgId) === String(data.orgId);
const isAdmin = actor.role === 'admin' || actor.role === 'org_admin';
return isInit || isSigner || (isAdmin && sameOrg);
```

Un **platform-admin** (`role==='admin'`, fără `org_id`) are `sameOrg=false` mereu ⇒ ar fi EXCLUS de
la citirea fluxurilor (dacă nu e init/semnatar). Contract: platform-admin vede tot cross-org.

**Dormant la o org**: admin-ul curent are `org_id=1`, deci `sameOrg` cu fluxurile org 1 e `true` —
poarta funcționează azi neschimbat. Ramura platform-admin se „aprinde" la flip-ul `org_id=NULL`.
Un admin-cu-org rămâne fail-closed cross-org (nu vede alt org) până la flip.

---

## PAS 1 — Preflight

```bash
cd <repo>
git rev-parse --abbrev-ref HEAD          # develop
grep '"version"' package.json            # "version": "3.9.730",
test -f server/services/authz-scope.mjs && echo OK
```

---

## PAS 2 — `server/services/flow-access.mjs`

### 2a. Import (authz-scope e în același folder `services/`)
- old_str:
```
import { isFlowRecipient } from './flow-transmit.mjs';
```
- new_str:
```
import { isFlowRecipient } from './flow-transmit.mjs';
import { isPlatformAdmin } from './authz-scope.mjs';
```

### 2b. Ramura platform-admin în return
- old_str:
```
  return isInit || isSigner || (isAdmin && sameOrg);
```
- new_str:
```
  // #105f: platform-admin (admin fără org_id) vede tot cross-org; altfel same-org (fail-closed)
  return isInit || isSigner || (isAdmin && (isPlatformAdmin(actor) || sameOrg));
```

```bash
node --check server/services/flow-access.mjs
```

---

## PAS 3 — Extinde `server/tests/unit/flow-access.test.mjs`

Adaugă cele 3 cazuri ÎNAINTE de `});`-ul final al describe-ului `canActorReadFlow (pur)`,
reutilizând helperii `actor` și `makeData` (flux în org 1). Conținut EXACT:

```js
  it('platform-admin (admin fără org_id) cross-org → true (lockout reparat)', () => {
    expect(canActorReadFlow(actor('super@z.ro', 'admin', null), makeData(), null)).toBe(true);
  });
  it('admin CU org_id, cross-org → false (fail-closed până la flip)', () => {
    expect(canActorReadFlow(actor('admin@y.ro', 'admin', 99), makeData(), null)).toBe(false);
  });
  it('admin CU org_id, same-org → true', () => {
    expect(canActorReadFlow(actor('admin@x.ro', 'admin', 1), makeData(), null)).toBe(true);
  });
```

```bash
node --check server/tests/unit/flow-access.test.mjs
```

---

## PAS 4 — Suită + bump + commit + push

```bash
npm test
# Așteptat: verde. Cele 3 cazuri noi trec. Cazurile EXISTENTE (org_admin same-org→true,
# org_admin cross-org→false, străini→false) rămân neschimbate.
```

- old_str: `  "version": "3.9.730",`
- new_str: `  "version": "3.9.731",`

```bash
git add server/services/flow-access.mjs server/tests/unit/flow-access.test.mjs package.json
git status --short          # Așteptat: exact 3 intrări
git commit -m "#105f: lockout flow-access → ramură platform-admin în canActorReadFlow (dormant la o org) (v3.9.731)"
git push origin develop
```

---

## RAPORT FINAL (completează)

- flow-access.mjs: import isPlatformAdmin + return cu ramura `(isAdmin && (isPlatformAdmin || sameOrg))`: da/nu
- node --check pe cele 2 fișiere: OK
- 3 cazuri noi trec; cazurile existente rămân verzi: da/nu
- npm test: PASSED (nr. fișiere/teste); niciun test existent rupt
- Bump 3.9.730 → 3.9.731: da/nu
- Commit (hash): ______  Push origin/develop (range): ______
- Abateri/surprize: ______

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ Branch `develop`. Push DOAR `origin develop`. NICIODATĂ `main`.
- ⛔ Atingi DOAR: `flow-access.mjs` (import + 1 linie return), `flow-access.test.mjs`, `package.json`.
- ⛔ NU atinge ALOP (`routes/alop.mjs`) — lockout-ul lui vine separat în #105g (chirurgie pe apelanți).
- ⛔ NU atinge write guards (lifecycle/signing/attachments) — vin în #105h.
- ⛔ NU modifica `authz-scope.mjs` (înghețat). Zona NO-TOUCH (`server/signing/*`) neatinsă.
- ⛔ Orice `old_str` care nu se potrivește (whitespace): NU forța, raportează.
