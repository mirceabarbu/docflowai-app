---
prompt: "#105d"
titlu: "Listări formulare → contract platform-admin (org-scope vs. vizibilitate în-org) — shared/df/ord"
model_suggested: "Opus 4.8"
target_version: "v3.9.729"
branch: "develop"
migratii: "nu"
cache_bump: "nu"
depinde_de: "#105a..#105c (806ac6b)"
---

# ⚠️ BRANCH: `develop` EXCLUSIV
`main` = PRODUCȚIE, MANUAL de Mircea. Zero push/merge pe `main`. Push DOAR pe `origin develop`.

---

## Context (de ce) — ATENȚIE, două predicate diferite

Trei liste de formulare folosesc semantica (a) `role==='admin'` → fără filtru org:
`shared.mjs` (`/api/formulare/list`), `df.mjs` (`/api/formulare-df`), `ord.mjs` (`/api/formulare-ord`).

**Capcana**: în `shared.mjs`, `isAdmin` amestecă DOUĂ concerne:
1. **scoparea pe org** — admin trebuie scopat dacă are `org_id` (doar platform-admin fără org vede tot);
2. **vizibilitatea în-org** (compartiment + can_delete) — un admin trebuie să vadă TOT org-ul, ca org_admin (pe ROL, nu pe org).

Un replace naiv `isAdmin → isPlatformAdmin` ar regresa admin-ul la „doar compartimentul lui".
Soluția: două variabile — `isPlatform = isPlatformAdmin(actor)` pentru scopare, `isOrgManager =
isAdminOrOrgAdmin(actor)` pentru vizibilitatea în-org.

La `df.mjs`/`ord.mjs`, structura `if admin / else if org_admin / else compartiment` trebuie
restructurată ca admin-cu-org să cadă pe ramura **org-scoped** (ca org_admin), nu pe compartiment.

**Invizibil la o org** (admin.org_id=1): scoparea pe org 1 = toate rândurile. Testele existente din
`formulare-list.test.mjs` folosesc un admin cu `orgId:null` (= platform-admin) ⇒ rămân verzi.

---

## PAS 1 — Preflight

```bash
cd <repo>
git rev-parse --abbrev-ref HEAD          # develop
git status --short
grep '"version"' package.json            # "version": "3.9.728",
test -f server/services/authz-scope.mjs && echo OK
```

---

## PAS 2 — `server/routes/formulare/shared.mjs`

### 2a. Import (după importul isAdminOrOrgAdmin)
- old_str:
```
import { isAdminOrOrgAdmin } from '../admin/_helpers.mjs';
```
- new_str:
```
import { isAdminOrOrgAdmin } from '../admin/_helpers.mjs';
import { isPlatformAdmin } from '../../services/authz-scope.mjs';
```

### 2b. Cele două variabile (în handler `/api/formulare/list`)
- old_str:
```
  const isAdmin    = actor.role === 'admin';
  const isOrgAdmin = actor.role === 'org_admin';
```
- new_str:
```
  // #105d: două predicate — scopare pe org (doar platform-admin sare) vs. vizibilitate în-org (pe rol)
  const isPlatform   = isPlatformAdmin(actor);
  const isOrgManager = isAdminOrOrgAdmin(actor);
```

### 2c. Bloc DF — org-scope + compartiment
- old_str:
```
      if (!isAdmin) {
        conds.push(`fd.org_id=$${params.push(actor.orgId)}`);
        if (!isOrgAdmin) {
          // FEAT ALOP-CAB: membrul CAB al org-ului vede TOT org-ul (doar scoparea fd.org_id de mai
          // sus, fără filtru de compartiment/inițiator). isAdmin rămâne NEATINS (inconsistența #105).
```
- new_str:
```
      if (!isPlatform) {
        conds.push(`fd.org_id=$${params.push(actor.orgId)}`);
        if (!isOrgManager) {
          // FEAT ALOP-CAB: membrul CAB al org-ului vede TOT org-ul (doar scoparea fd.org_id de mai
          // sus, fără filtru de compartiment/inițiator). #105d: org-scope=isPlatform, vizibilitate în-org=isOrgManager.
```

### 2d. Bloc DF — can_delete
- old_str:
```
            ${(isAdmin || isOrgAdmin) ? 'TRUE' : `fd.created_by = $${params.push(actor.userId)}`}
```
- new_str:
```
            ${isOrgManager ? 'TRUE' : `fd.created_by = $${params.push(actor.userId)}`}
```

### 2e. Bloc ORD — org-scope + compartiment
- old_str:
```
      if (!isAdmin) {
        conds.push(`fo.org_id=$${params.push(actor.orgId)}`);
        if (!isOrgAdmin) {
          // FEAT ALOP-CAB: membrul CAB al org-ului vede TOT org-ul (doar scoparea fo.org_id de mai
          // sus, fără filtru de compartiment/inițiator). isAdmin rămâne NEATINS (inconsistența #105).
```
- new_str:
```
      if (!isPlatform) {
        conds.push(`fo.org_id=$${params.push(actor.orgId)}`);
        if (!isOrgManager) {
          // FEAT ALOP-CAB: membrul CAB al org-ului vede TOT org-ul (doar scoparea fo.org_id de mai
          // sus, fără filtru de compartiment/inițiator). #105d: org-scope=isPlatform, vizibilitate în-org=isOrgManager.
```

### 2f. Bloc ORD — can_delete
- old_str:
```
            ${(isAdmin || isOrgAdmin) ? 'TRUE' : `fo.created_by = $${params.push(actor.userId)}`}
```
- new_str:
```
            ${isOrgManager ? 'TRUE' : `fo.created_by = $${params.push(actor.userId)}`}
```

```bash
node --check server/routes/formulare/shared.mjs
grep -n "isAdmin\b\|isOrgAdmin\b" server/routes/formulare/shared.mjs
# Așteptat: DOAR linia 20 (import isAdminOrOrgAdmin) + linia 674 (isAdminOrOrgAdmin(actor)).
# NICIUN isAdmin/isOrgAdmin ca variabilă locală. Dacă mai apare, raportează.
```

---

## PAS 3 — `server/routes/formulare/df.mjs`

### 3a. Import (după requireAuth)
- old_str:
```
import { requireAuth } from '../../middleware/auth.mjs';
import { csrfMiddleware } from '../../middleware/csrf.mjs';
```
- new_str:
```
import { requireAuth } from '../../middleware/auth.mjs';
import { isPlatformAdmin, isAdminOrOrgAdmin } from '../../services/authz-scope.mjs';
import { csrfMiddleware } from '../../middleware/csrf.mjs';
```

### 3b. Restructurare ramuri (lista `/api/formulare-df`)
- old_str:
```
    if (actor.role === 'admin') {
      orgFilter = '';
      params = [];
    } else if (actor.role === 'org_admin') {
      orgFilter = 'AND fd.org_id = $1';
      params = [actor.orgId];
    } else {
```
- new_str:
```
    if (isPlatformAdmin(actor)) {          // #105d: doar platform-admin (fără org_id) vede tot
      orgFilter = '';
      params = [];
    } else if (isAdminOrOrgAdmin(actor)) { // admin-cu-org SAU org_admin → org-scoped (tot org-ul)
      orgFilter = 'AND fd.org_id = $1';
      params = [actor.orgId];
    } else {
```

```bash
node --check server/routes/formulare/df.mjs
```

---

## PAS 4 — `server/routes/formulare/ord.mjs`

### 4a. Import (după requireAuth)
- old_str:
```
import { requireAuth } from '../../middleware/auth.mjs';
import { csrfMiddleware } from '../../middleware/csrf.mjs';
```
- new_str:
```
import { requireAuth } from '../../middleware/auth.mjs';
import { isPlatformAdmin, isAdminOrOrgAdmin } from '../../services/authz-scope.mjs';
import { csrfMiddleware } from '../../middleware/csrf.mjs';
```

### 4b. Restructurare ramuri (lista `/api/formulare-ord`)
- old_str:
```
    if (actor.role === 'admin') {
      orgFilter = '';
      params = [];
    } else if (actor.role === 'org_admin') {
      orgFilter = 'AND fo.org_id = $1';
      params = [actor.orgId];
    } else {
```
- new_str:
```
    if (isPlatformAdmin(actor)) {          // #105d: doar platform-admin (fără org_id) vede tot
      orgFilter = '';
      params = [];
    } else if (isAdminOrOrgAdmin(actor)) { // admin-cu-org SAU org_admin → org-scoped (tot org-ul)
      orgFilter = 'AND fo.org_id = $1';
      params = [actor.orgId];
    } else {
```

```bash
node --check server/routes/formulare/ord.mjs
```

---

## PAS 5 — Extinde testul `server/tests/integration/formulare-list.test.mjs`

Adaugă la SFÂRȘITUL fișierului (după ultimul `});` de nivel top), folosind helperii deja definiți
în fișier (`captureListQuery`, `app`, `JWT_SECRET`, `jwt`, `request`). Conținut EXACT:

```js

// ── #105d — contract org-scope (platform-admin vs. org-scoped) ────────────────
function tok105d(role, orgId, userId = 77) {
  return jwt.sign({ userId, email: `${role}@x.ro`, role, orgId, nume: role }, JWT_SECRET, { expiresIn: '2h' });
}

describe('#105d — org-scope /api/formulare/list (shared)', () => {
  beforeEach(() => { dbModule.pool.query.mockReset(); });

  it('platform-admin (admin fără org_id) → fără scopare org (vede tot)', async () => {
    const { getSql } = captureListQuery();
    await request(app).get('/api/formulare/list?type=df')
      .set('Cookie', `auth_token=${tok105d('admin', null, 99)}`).expect(200);
    expect(getSql()).not.toContain('fd.org_id=$');
  });

  it('admin CU org_id → scopat pe org, DAR fără filtru de compartiment (vede tot org-ul)', async () => {
    const { getSql, getParams } = captureListQuery();
    await request(app).get('/api/formulare/list?type=df')
      .set('Cookie', `auth_token=${tok105d('admin', 1, 5)}`).expect(200);
    expect(getSql()).toContain('fd.org_id=$1');
    expect(getParams()).toContain(1);
    expect(getSql()).not.toContain('TRIM(uc.compartiment)');
  });

  it('org_admin → scopat pe org, fără compartiment', async () => {
    const { getSql, getParams } = captureListQuery();
    await request(app).get('/api/formulare/list?type=df')
      .set('Cookie', `auth_token=${tok105d('org_admin', 2, 6)}`).expect(200);
    expect(getSql()).toContain('fd.org_id=$1');
    expect(getParams()).toContain(2);
    expect(getSql()).not.toContain('TRIM(uc.compartiment)');
  });

  it('user obișnuit → scopat pe org (non-manager)', async () => {
    const { getSql, getParams } = captureListQuery();
    await request(app).get('/api/formulare/list?type=df')
      .set('Cookie', `auth_token=${tok105d('user', 2, 7)}`).expect(200);
    expect(getSql()).toContain('fd.org_id=$1');
    expect(getParams()).toContain(2);
  });
});

describe('#105d — org-scope /api/formulare-df (listă paralelă)', () => {
  beforeEach(() => { dbModule.pool.query.mockReset(); });

  it('platform-admin → orgFilter gol (fără fd.org_id = $1)', async () => {
    const { getSql } = captureListQuery();
    await request(app).get('/api/formulare-df')
      .set('Cookie', `auth_token=${tok105d('admin', null, 99)}`).expect(200);
    expect(getSql()).not.toContain('fd.org_id = $1');
  });

  it('admin CU org_id → scopat pe org (ca org_admin)', async () => {
    const { getSql, getParams } = captureListQuery();
    await request(app).get('/api/formulare-df')
      .set('Cookie', `auth_token=${tok105d('admin', 1, 5)}`).expect(200);
    expect(getSql()).toContain('fd.org_id = $1');
    expect(getParams()).toContain(1);
  });

  it('user obișnuit → ramura compartiment (u_p1.compartiment prezent)', async () => {
    const { getSql } = captureListQuery();
    await request(app).get('/api/formulare-df')
      .set('Cookie', `auth_token=${tok105d('user', 2, 7)}`).expect(200);
    expect(getSql()).toContain('u_p1.compartiment');
  });
});
```

```bash
node --check server/tests/integration/formulare-list.test.mjs
```

---

## PAS 6 — Suită

```bash
npm test
# Așteptat: verde. Testele EXISTENTE din formulare-list.test.mjs rămân verzi (admin-ul lor are
# orgId:null = platform-admin, deci comportament neschimbat). Cele 7 cazuri noi trec.
```

---

## PAS 7 — Bump + commit + push

- old_str: `  "version": "3.9.728",`
- new_str: `  "version": "3.9.729",`

```bash
git add server/routes/formulare/shared.mjs server/routes/formulare/df.mjs \
        server/routes/formulare/ord.mjs server/tests/integration/formulare-list.test.mjs package.json
git status --short          # Așteptat: exact 5 intrări
git commit -m "#105d: listări formulare → contract platform-admin (org-scope vs vizibilitate în-org) (v3.9.729)"
git push origin develop
```

---

## RAPORT FINAL (completează)

- shared.mjs: import + 2 variabile + 4 blocuri (DF/ORD org-scope + can_delete) comutate: da/nu
- grep PAS 2: doar liniile 20 + 674 rămân cu isAdminOrOrgAdmin; zero isAdmin/isOrgAdmin local: da/nu
- df.mjs + ord.mjs: import + restructurare ramuri (isPlatformAdmin / isAdminOrOrgAdmin): da/nu
- node --check pe cele 4 fișiere sursă + fișierul de test: OK
- Cele 7 cazuri noi trec; testele existente din formulare-list.test.mjs rămân verzi: da/nu
- npm test: PASSED (nr. fișiere/teste)
- git status înainte de commit: exact 5 intrări? da/nu
- Bump 3.9.728 → 3.9.729: da/nu
- Commit (hash): ______  Push origin/develop (range): ______
- Abateri/surprize: ______

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ Branch `develop`. Push DOAR `origin develop`. NICIODATĂ `main`.
- ⛔ Atingi DOAR: `shared.mjs`, `df.mjs`, `ord.mjs`, `formulare-list.test.mjs`, `package.json`.
- ⛔ NU confunda cele două predicate: scoparea pe org = `isPlatform`; vizibilitatea în-org
  (compartiment + can_delete) = `isOrgManager`. Un admin-cu-org_id TREBUIE să vadă tot org-ul lui
  (nu doar compartimentul) — dacă un test arată altfel, e greșit wiring-ul, raportează.
- ⛔ NU modifica `authz-scope.mjs` (înghețat). NU atinge `formular-shared.mjs`, `opme.mjs`,
  `/report/status` — vin în #105e.
- ⛔ Fără migrații, fără cache/`?v=`. Zona NO-TOUCH (`server/signing/*`) neatinsă.
- ⛔ Orice `old_str` care nu se potrivește la whitespace: NU forța, raportează linia reală.
