---
prompt: "#105i"
titlu: "Write guards signing + attachments → contract platform-admin (4 situri)"
model_suggested: "Opus 4.8"
target_version: "v3.9.734"
branch: "develop"
migratii: "nu"
cache_bump: "nu"
depinde_de: "#105a..#105h (21cb224)"
---

# ⚠️ BRANCH: `develop` EXCLUSIV
`main` = PRODUCȚIE, MANUAL. Zero push/merge pe `main`. Push DOAR pe `origin develop`.
⚠️ `flows/signing.mjs` = rutele de semnare (resend/regenerate-token) — NU e zona NO-TOUCH
`server/signing/*` (core PAdES). Editări chirurgicale, exact old_str/new_str.

---

## Context (de ce)

Ultimele 4 write guards cu ramura admin necondiționată. Fix identic cu #105h:
`isAdmin = isAdminOrOrgAdmin(actor) && actorCanAccessOrg(actor, data.orgId)`.
Platform-admin cross-org; admin/org_admin doar same-org (fail-closed). Invizibil la o org.

Situri: `signing.mjs` — resend (~486), regenerate-token (~508); `attachments.mjs` — attach (~62),
delete-attachment (~176).

---

## ⚠️ AȘTEPTAT: teste existente care codifică VECHIUL contract

La fel ca #105h (unde `flows.test.mjs:makeAdminToken` avea `orgId:999` pe flux org 1), `npm test`
poate pica pe teste preexistente care lovesc resend/regenerate-token/attach/delete cu un **admin
cross-org** (orgId ≠ org-ul fluxului) așteptând succes. Sub contractul nou primesc corect 403 —
exact leak-ul închis. **Ai voie** să corectezi acele teste, semantic:
- intenția „admin global acționează pe orice flux" ⇒ token-ul devine `orgId: null` (platform-admin);
- intenția „org_admin al acestei instituții" ⇒ aliniază `orgId` la org-ul fluxului (ex. 1).
Adaugă un comentariu `#105i` și **raportează fiecare fișier de test atins**. NU slăbi contractul
(nu readuce bypass necondiționat, nu șterge aserții de izolare).

---

## PAS 1 — Preflight
```bash
cd <repo>
git rev-parse --abbrev-ref HEAD          # develop
grep '"version"' package.json            # "version": "3.9.733",
test -f server/services/authz-scope.mjs && echo OK
```

---

## PAS 2 — `server/routes/flows/signing.mjs`

### 2a. Import
- old_str:
```
import { logger } from '../../middleware/logger.mjs';
```
- new_str:
```
import { logger } from '../../middleware/logger.mjs';
import { isAdminOrOrgAdmin, actorCanAccessOrg } from '../../services/authz-scope.mjs';
```

### 2b. Sit resend (mesaj „retrimite notificarea")
- old_str:
```
    const isAdmin = actor.role === 'admin' || (actor.role === 'org_admin' && data.orgId != null && actor.orgId != null && Number(data.orgId) === Number(actor.orgId));
    const isInit = (data.initEmail || '').toLowerCase() === actor.email.toLowerCase();
    if (!isAdmin && !isInit) return res.status(403).json({ error: 'forbidden', message: 'Doar inițiatorul sau un administrator poate retrimite notificarea.' });
```
- new_str:
```
    const isAdmin = isAdminOrOrgAdmin(actor) && actorCanAccessOrg(actor, data.orgId);
    const isInit = (data.initEmail || '').toLowerCase() === actor.email.toLowerCase();
    if (!isAdmin && !isInit) return res.status(403).json({ error: 'forbidden', message: 'Doar inițiatorul sau un administrator poate retrimite notificarea.' });
```

### 2c. Sit regenerate-token (mesaj „regenera token-ul")
- old_str:
```
    const isAdmin = actor.role === 'admin' || (actor.role === 'org_admin' && data.orgId != null && actor.orgId != null && Number(data.orgId) === Number(actor.orgId));
    if (!isAdmin) return res.status(403).json({ error: 'forbidden', message: 'Doar un administrator poate regenera token-ul.' });
```
- new_str:
```
    const isAdmin = isAdminOrOrgAdmin(actor) && actorCanAccessOrg(actor, data.orgId);
    if (!isAdmin) return res.status(403).json({ error: 'forbidden', message: 'Doar un administrator poate regenera token-ul.' });
```

```bash
node --check server/routes/flows/signing.mjs
```

---

## PAS 3 — `server/routes/flows/attachments.mjs`

### 3a. Import
- old_str:
```
import { logger } from '../../middleware/logger.mjs';
```
- new_str:
```
import { logger } from '../../middleware/logger.mjs';
import { isAdminOrOrgAdmin, actorCanAccessOrg } from '../../services/authz-scope.mjs';
```

### 3b. Sit attach (urmat de `if (data.status === 'cancelled')`)
- old_str:
```
    const isInit = (data.initEmail || '').toLowerCase() === actor.email.toLowerCase();
    const isAdmin = actor.role === 'admin' || (actor.role === 'org_admin' && data.orgId != null && actor.orgId != null && Number(data.orgId) === Number(actor.orgId));
    if (!isInit && !isAdmin) return res.status(403).json({ error: 'forbidden' });
    if (data.status === 'cancelled') return res.status(409).json({ error: 'flow_cancelled' });
```
- new_str:
```
    const isInit = (data.initEmail || '').toLowerCase() === actor.email.toLowerCase();
    const isAdmin = isAdminOrOrgAdmin(actor) && actorCanAccessOrg(actor, data.orgId);
    if (!isInit && !isAdmin) return res.status(403).json({ error: 'forbidden' });
    if (data.status === 'cancelled') return res.status(409).json({ error: 'flow_cancelled' });
```

### 3c. Sit delete-attachment (urmat de `DELETE FROM flow_attachments`)
- old_str:
```
    const isInit = (data.initEmail || '').toLowerCase() === actor.email.toLowerCase();
    const isAdmin = actor.role === 'admin' || (actor.role === 'org_admin' && data.orgId != null && actor.orgId != null && Number(data.orgId) === Number(actor.orgId));
    if (!isInit && !isAdmin) return res.status(403).json({ error: 'forbidden' });
    const { rowCount } = await pool.query('DELETE FROM flow_attachments WHERE id=$1 AND flow_id=$2', [parseInt(attId), flowId]);
```
- new_str:
```
    const isInit = (data.initEmail || '').toLowerCase() === actor.email.toLowerCase();
    const isAdmin = isAdminOrOrgAdmin(actor) && actorCanAccessOrg(actor, data.orgId);
    if (!isInit && !isAdmin) return res.status(403).json({ error: 'forbidden' });
    const { rowCount } = await pool.query('DELETE FROM flow_attachments WHERE id=$1 AND flow_id=$2', [parseInt(attId), flowId]);
```

```bash
node --check server/routes/flows/attachments.mjs
grep -cn "actor.role === 'admin' || (actor" server/routes/flows/signing.mjs server/routes/flows/attachments.mjs
# Așteptat: 0 pe ambele (toate 4 comutate).
```

---

## PAS 4 — Test nou: `server/tests/integration/signing-attachments-org-guard.test.mjs`

Actor setabil, montează ambele routere. Conținut EXACT:

```js
/**
 * #105i — write guards signing/attachments: contract platform-admin.
 * DELETE attachment (attachments.mjs) + regenerate-token (signing.mjs), reprezentative.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

let CURRENT_ACTOR = null;

vi.mock('../../middleware/auth.mjs', async () => {
  const actual = await vi.importActual('../../middleware/auth.mjs');
  return {
    ...actual,
    AUTH_COOKIE: 'auth_token',
    requireAuth(req, res, next) {
      if (typeof next === 'function') { req.actor = CURRENT_ACTOR; next(); return; }
      return CURRENT_ACTOR;
    },
    requireAdmin: vi.fn((req, res, next) => { if (typeof next === 'function') next(); }),
    getOptionalActor: () => CURRENT_ACTOR,
  };
});

vi.mock('../../db/index.mjs', () => ({
  pool:             { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  DB_READY:         true,
  requireDb:        vi.fn(() => false),
  saveFlow:         vi.fn().mockResolvedValue(undefined),
  getFlowData:      vi.fn(),
  writeAuditEvent:  vi.fn().mockResolvedValue(undefined),
  getDefaultOrgId:  vi.fn().mockResolvedValue(1),
  getUserMapForOrg: vi.fn().mockResolvedValue({}),
  DB_LAST_ERROR:    null,
}));

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
}));

import * as dbModule from '../../db/index.mjs';
import signingRouter from '../../routes/flows/signing.mjs';
import attachmentsRouter from '../../routes/flows/attachments.mjs';

function makeApp() {
  const a = express(); a.use(express.json()); a.use(cookieParser());
  a.use('/', signingRouter); a.use('/', attachmentsRouter);
  return a;
}
const app = makeApp();
const flow = (o = {}) => ({ flowId: 'F1', docName: 'X', initEmail: 'init@x.ro', orgId: 1, status: 'active', completed: false, signers: [{ name: 'S', email: 's@x.ro', token: 't', status: 'current' }], ...o });

describe('#105i — signing/attachments org guard', () => {
  beforeEach(() => { vi.clearAllMocks(); dbModule.getFlowData.mockResolvedValue(flow()); });

  it('DELETE attachment: org_admin din ALT org → 403', async () => {
    CURRENT_ACTOR = { email: 'oa@y.ro', role: 'org_admin', orgId: 2, userId: 9 };
    expect((await request(app).delete('/flows/F1/attachments/1')).status).toBe(403);
  });
  it('DELETE attachment: admin CU org_id cross-org → 403 (fail-closed)', async () => {
    CURRENT_ACTOR = { email: 'admin@y.ro', role: 'admin', orgId: 2, userId: 1 };
    expect((await request(app).delete('/flows/F1/attachments/1')).status).toBe(403);
  });
  it('DELETE attachment: platform-admin (fără org_id) → NU 403', async () => {
    CURRENT_ACTOR = { email: 'super@z.ro', role: 'admin', orgId: null, userId: 1 };
    expect((await request(app).delete('/flows/F1/attachments/1')).status).not.toBe(403);
  });

  it('regenerate-token: org_admin din ALT org → 403', async () => {
    CURRENT_ACTOR = { email: 'oa@y.ro', role: 'org_admin', orgId: 2, userId: 9 };
    const res = await request(app).post('/flows/F1/regenerate-token').send({ signerEmail: 'nomatch@z.ro' });
    expect(res.status).toBe(403);
  });
  it('regenerate-token: platform-admin → NU 403 (trece de guard; 404 signer_not_found)', async () => {
    CURRENT_ACTOR = { email: 'super@z.ro', role: 'admin', orgId: null, userId: 1 };
    const res = await request(app).post('/flows/F1/regenerate-token').send({ signerEmail: 'nomatch@z.ro' });
    expect(res.status).not.toBe(403);
  });
});
```

```bash
node --check server/tests/integration/signing-attachments-org-guard.test.mjs
```

> Dacă montarea unui router cere `_injectDeps` sau un mock lipsă (crapă la montare, nu la assert),
> adaugă minimul necesar (fără a schimba producția) și raportează.

---

## PAS 5 — Suită + bump + commit + push

```bash
npm test
# Așteptat: verde DUPĂ eventualele corecții de token din secțiunea „AȘTEPTAT" de mai sus.
# 5 cazuri noi trec.
```

- old_str: `  "version": "3.9.733",`
- new_str: `  "version": "3.9.734",`

```bash
git add server/routes/flows/signing.mjs server/routes/flows/attachments.mjs \
        server/tests/integration/signing-attachments-org-guard.test.mjs package.json
# + orice fișier de test preexistent corectat pentru semantica de token (raportează-l)
git status --short
git commit -m "#105i: write guards signing + attachments → contract platform-admin (4 situri) (v3.9.734)"
git push origin develop
```

---

## RAPORT FINAL (completează)

- signing.mjs: import + resend + regenerate-token comutate: da/nu
- attachments.mjs: import + attach + delete comutate: da/nu
- grep PAS 3: 0 pe ambele fișiere: da/nu
- node --check pe cele 3 fișiere sursă/test: OK
- 5 cazuri noi trec: da/nu
- Teste preexistente corectate pt semantica de token (listează fișierele + de ce): ______
- npm test: PASSED (nr. fișiere/teste)
- Bump 3.9.733 → 3.9.734: da/nu
- Commit (hash): ______  Push origin/develop (range): ______
- Abateri/surprize: ______

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ Branch `develop`. Push DOAR `origin develop`. NICIODATĂ `main`.
- ⛔ Producție atinsă DOAR: `signing.mjs`, `attachments.mjs` (import + cele 4 situri isAdmin).
- ⛔ Teste: fișierul nou + eventuale corecții de semantică token pe teste preexistente (raportate).
  NU slăbi contractul, NU șterge aserții de izolare.
- ⛔ NU modifica `authz-scope.mjs`. Zona NO-TOUCH `server/signing/*` (PAdES) — neatinsă.
- ⛔ Fără migrații, fără cache/`?v=`.
- ⛔ Orice `old_str` care nu se potrivește (whitespace): NU forța, raportează linia reală.
