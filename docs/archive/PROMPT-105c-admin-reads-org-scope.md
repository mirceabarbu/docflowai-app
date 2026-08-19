---
prompt: "#105c"
titlu: "Admin-panel reads → contract platform-admin (actorOrgFilter + audit) — invizibil la o org"
model_suggested: "Opus 4.8"
target_version: "v3.9.728"
branch: "develop"
migratii: "nu"
cache_bump: "nu (backend-only; niciun PRECACHE_ASSETS atins)"
depinde_de: "#105a (authz-scope.mjs), #105b (e019a0c)"
---

# ⚠️ BRANCH: `develop` EXCLUSIV
`main` = PRODUCȚIE, gestionat MANUAL de Mircea. Zero checkout/merge/push pe `main`.
Push permis DOAR pe `origin develop` (declanșează staging).

---

## Context (de ce)

Helperul canonic `admin/_helpers.mjs:actorOrgFilter()` codifică azi semantica (a): pentru
`role==='admin'` întoarce `null` = **fără filtru**, indiferent de `org_id`. E folosit de
`admin/analytics.mjs` (×2) și `admin/flows.mjs` (×2). Același pattern e inline în
`admin/audit.mjs` (×2): `orgId = actor.role === 'admin' ? null : actor.orgId`.

Contract canonic (decis 22.07): **doar platform-admin** (`role==='admin'` **fără** `org_id`)
vede tot; orice actor CU `org_id` (inclusiv un `admin` cu `org_id`) e scopat la propriul org.

**Invizibil în producție azi**: singurul `admin` are `org_id=1` și există o singură org, deci
scoparea la `org_id=1` întoarce exact aceleași rânduri ca „fără filtru". Testul negativ
„admin-cu-org_id e scopat, nu vede tot" devine REAL (admin-ul live are org_id=1). Când
`admin.org_id` va deveni `NULL` (flip ulterior), `isPlatformAdmin` devine adevărat și admin-ul
redevine cross-org — automat, prin acest contract.

---

## PAS 1 — Preflight

```bash
cd <repo>
git rev-parse --abbrev-ref HEAD          # Așteptat: develop
git status --short                        # working tree curat (untracked pre-existente OK)
grep '"version"' package.json             # Așteptat: "version": "3.9.727",
test -f server/services/authz-scope.mjs && echo "authz-scope OK"
```

---

## PAS 2 — Rescrie `actorOrgFilter` în `server/routes/admin/_helpers.mjs`

### 2a. Adaugă importul (fișierul nu are azi importuri)

- old_str:
```
/**
 * DocFlowAI — Admin shared helpers
 * Extrase din admin.mjs pentru reutilizare în sub-module.
 */

// Acceptă atât admin cât și org_admin
```
- new_str:
```
/**
 * DocFlowAI — Admin shared helpers
 * Extrase din admin.mjs pentru reutilizare în sub-module.
 */

import { isPlatformAdmin } from '../../services/authz-scope.mjs';

// Acceptă atât admin cât și org_admin
```

### 2b. Rescrie funcția

- old_str:
```
// Returnează orgId filtru pentru query (null = toate, number = filtrat)
export function actorOrgFilter(actor) {
  if (actor?.role === 'org_admin') return actor.orgId || null;
  return null; // admin = fără filtru
}
```
- new_str:
```
// Returnează orgId filtru pentru query (null = fără filtru/vede tot, number = scopat pe org)
// #105c: contract canonic — DOAR platform-admin (admin fără org_id) vede tot (null).
// Orice actor cu org_id (inclusiv un admin cu org_id) e scopat la propriul org.
// (Apelanții gatează upstream pe isAdminOrOrgAdmin; org_admin are mereu org_id.)
export function actorOrgFilter(actor) {
  if (isPlatformAdmin(actor)) return null;
  return actor?.orgId ?? null;
}
```

```bash
node --check server/routes/admin/_helpers.mjs   # Așteptat: fără output
```

---

## PAS 3 — Fixează cele 2 situri inline din `server/routes/admin/audit.mjs`

### 3a. Import

- old_str:
```
import { logger } from '../../middleware/logger.mjs';

const router = Router();
```
- new_str:
```
import { logger } from '../../middleware/logger.mjs';
import { isPlatformAdmin } from '../../services/authz-scope.mjs';

const router = Router();
```

### 3b. Sit 1 — `/admin/audit-events/types` (2 spații după `orgId`)

- old_str:
```
    const orgId  = actor.role === 'admin' ? null : actor.orgId;
```
- new_str:
```
    const orgId  = isPlatformAdmin(actor) ? null : (actor.orgId ?? null);
```

### 3c. Sit 2 — `/admin/audit-events` (4 spații după `orgId`)

- old_str:
```
    const orgId    = actor.role === 'admin' ? null : actor.orgId;
```
- new_str:
```
    const orgId    = isPlatformAdmin(actor) ? null : (actor.orgId ?? null);
```

```bash
node --check server/routes/admin/audit.mjs
grep -n "role === 'admin' ? null" server/routes/admin/audit.mjs
# Așteptat: NICIUN rezultat (ambele situri comutate). Dacă mai apare, raportează linia.
```

---

## PAS 4 — Test unit pe `actorOrgFilter` (fișier NOU)

Creează `server/tests/unit/actor-org-filter.test.mjs`. Importă din producție. Conținut EXACT:

```js
/**
 * #105c — actorOrgFilter: contract platform-admin vs. org-scoped.
 * Doar platform-admin (admin fără org_id) → null (fără filtru). Restul → propriul org.
 */
import { describe, it, expect } from 'vitest';
import { actorOrgFilter } from '../../routes/admin/_helpers.mjs';

describe('actorOrgFilter (#105c)', () => {
  it('platform-admin (admin fără org_id) ⇒ null (vede tot)', () => {
    expect(actorOrgFilter({ role: 'admin', orgId: null })).toBe(null);
    expect(actorOrgFilter({ role: 'admin' })).toBe(null);
  });
  it('admin CU org_id ⇒ scopat la propriul org (NU null) — fixul central', () => {
    expect(actorOrgFilter({ role: 'admin', orgId: 1 })).toBe(1);
    expect(actorOrgFilter({ role: 'admin', orgId: 2 })).toBe(2);
  });
  it('org_admin ⇒ propriul org', () => {
    expect(actorOrgFilter({ role: 'org_admin', orgId: 5 })).toBe(5);
  });
  it('org_admin fără org_id (nu apare în practică) ⇒ null', () => {
    // Documentăm comportamentul; apelanții gatează pe isAdminOrOrgAdmin, iar org_admin
    // are întotdeauna org_id la creare. Fail-closed real trăiește în orgScopeSql (authz-scope).
    expect(actorOrgFilter({ role: 'org_admin', orgId: null })).toBe(null);
  });
});
```

```bash
node --check server/tests/unit/actor-org-filter.test.mjs
```

---

## PAS 5 — Suită

```bash
npm test
# Așteptat: verde. Noul fișier trece. Testele existente rămân verzi (nimic vizibil nu se schimbă
# la o singură org — actorOrgFilter(admin org_id=1) → 1, iar WHERE org_id=1 = toate rândurile).
```

---

## PAS 6 — Bump + commit + push

- old_str: `  "version": "3.9.727",`
- new_str: `  "version": "3.9.728",`

```bash
git add server/routes/admin/_helpers.mjs server/routes/admin/audit.mjs \
        server/tests/unit/actor-org-filter.test.mjs package.json
git status --short          # Așteptat: exact 4 intrări
git commit -m "#105c: admin-panel reads → contract platform-admin (actorOrgFilter + audit), invizibil la o org (v3.9.728)"
git push origin develop     # DOAR develop (staging). NICIODATĂ main.
```

---

## RAPORT FINAL (completează)

- `actorOrgFilter` rescris + import isPlatformAdmin în _helpers.mjs: da/nu
- audit.mjs: import adăugat + ambele situri comutate (grep PAS 3 gol): da/nu
- `node --check` pe cele 3 fișiere: OK
- Test nou creat și trece (4 cazuri): da/nu
- `npm test`: PASSED (nr. fișiere/teste); niciun test existent rupt
- git status înainte de commit: exact 4 intrări? da/nu
- Bump 3.9.727 → 3.9.728: da/nu
- Commit (hash): ______   Push pe origin/develop (range): ______
- Abateri/surprize: ______

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ Branch `develop` EXCLUSIV. Push DOAR pe `origin develop`. NICIODATĂ `main`.
- ⛔ Atingi DOAR: `_helpers.mjs` (import + actorOrgFilter), `audit.mjs` (import + 2 situri),
  testul nou, `package.json`. NIMIC altceva.
- ⛔ NU atinge `analytics.mjs`/`flows.mjs` — ele beneficiază automat de rewrite-ul lui
  `actorOrgFilter` (nicio linie de schimbat acolo). NU atinge `admin/users.mjs` (nu folosește
  actorOrgFilter — comentariu explicit la linia 60).
- ⛔ NU modifica `authz-scope.mjs` (înghețat din #105a). Doar `isPlatformAdmin` importat.
- ⛔ NU dedup-a `isAdminOrOrgAdmin` (există în _helpers ȘI authz-scope) — cosmetic, îl lăsăm.
- ⛔ NU atinge `/report/status` aici (merge în #105d cu citirile de flux).
- ⛔ Fără migrații, fără cache/`?v=`. Zona NO-TOUCH (`server/signing/*`) neatinsă.
- ⛔ Dacă un `old_str` nu se potrivește (whitespace), NU forța — raportează linia reală.
