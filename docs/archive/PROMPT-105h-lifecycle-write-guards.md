---
prompt: "#105h"
titlu: "Write guards lifecycle → contract platform-admin (reinit/review/delegate/cancel), 5 situri"
model_suggested: "Opus 4.8"
target_version: "v3.9.733"
branch: "develop"
migratii: "nu"
cache_bump: "nu"
depinde_de: "#105a..#105g (1613ed3)"
---

# ⚠️ BRANCH: `develop` EXCLUSIV
`main` = PRODUCȚIE, MANUAL. Zero push/merge pe `main`. Push DOAR pe `origin develop`.
⚠️ Mutații de FLUX (reiniție/revizuire/delegare/anulare). Editări chirurgicale, exact old_str/new_str.

---

## Context (de ce)

`routes/flows/lifecycle.mjs` are 5 guard-uri de scriere cu pattern:

```js
const isAdmin = actor.role === 'admin' || (actor.role === 'org_admin' && ...sameOrg...);
```

Ramura `role==='admin'` e **necondiționată** ⇒ un admin-cu-org_id ar putea muta fluxuri
cross-org (leak latent). Ramura `org_admin` are deja `sameOrg`. Contract canonic uniform:
platform-admin (fără org) face tot cross-org; admin/org_admin doar pe același org.

Fix identic la toate 5: `isAdmin = isAdminOrOrgAdmin(actor) && actorCanAccessOrg(actor, data.orgId)`.
- platform-admin ⇒ true (cross-org); admin/org_admin same-org ⇒ true; cross-org ⇒ false (fail-closed).
- pentru siturile cu `actor?.` (request-review/delegate, unde actor poate fi null pe cale token),
  `isAdminOrOrgAdmin(null)=false` ⇒ isAdmin=false, iar guardul e `if (actor && ...)` ⇒ neschimbat.

**Invizibil la o org** (admin.org_id=1 ⇒ actorCanAccessOrg same-org = true, ca ramura admin de azi).

---

## PAS 1 — Preflight

```bash
cd <repo>
git rev-parse --abbrev-ref HEAD          # develop
grep '"version"' package.json            # "version": "3.9.732",
test -f server/services/authz-scope.mjs && echo OK
```

---

## PAS 2 — Import în `server/routes/flows/lifecycle.mjs`
- old_str:
```
import { logger } from '../../middleware/logger.mjs';
import crypto from 'crypto';
```
- new_str:
```
import { logger } from '../../middleware/logger.mjs';
import { isAdminOrOrgAdmin, actorCanAccessOrg } from '../../services/authz-scope.mjs';
import crypto from 'crypto';
```

## PAS 3 — Sit 1: `/reinitiate` (mesaj „reiniția fluxul")
- old_str:
```
    const isAdmin = actor.role === 'admin' || (actor.role === 'org_admin' && data.orgId != null && actor.orgId != null && Number(data.orgId) === Number(actor.orgId));
    const isInit = (data.initEmail || '').toLowerCase() === actor.email.toLowerCase();
    if (!isAdmin && !isInit) return res.status(403).json({ error: 'forbidden', message: 'Doar inițiatorul sau un administrator poate reiniția fluxul.' });
```
- new_str:
```
    const isAdmin = isAdminOrOrgAdmin(actor) && actorCanAccessOrg(actor, data.orgId);
    const isInit = (data.initEmail || '').toLowerCase() === actor.email.toLowerCase();
    if (!isAdmin && !isInit) return res.status(403).json({ error: 'forbidden', message: 'Doar inițiatorul sau un administrator poate reiniția fluxul.' });
```

## PAS 4 — Sit 2: `/request-review` (mesaj „trimite spre revizuire")
- old_str:
```
    const isAdmin = actor?.role === 'admin' || (actor?.role === 'org_admin' && Number(data.orgId) === Number(actor?.orgId));
    const isCurrentSignerActor = !!actor && ((signers[idx].email || '').toLowerCase() === (actor.email || '').toLowerCase());
    if (actor && !isAdmin && !isCurrentSignerActor) return res.status(403).json({ error: 'forbidden', message: 'Doar semnatarul curent sau un admin poate trimite spre revizuire.' });
```
- new_str:
```
    const isAdmin = isAdminOrOrgAdmin(actor) && actorCanAccessOrg(actor, data.orgId);
    const isCurrentSignerActor = !!actor && ((signers[idx].email || '').toLowerCase() === (actor.email || '').toLowerCase());
    if (actor && !isAdmin && !isCurrentSignerActor) return res.status(403).json({ error: 'forbidden', message: 'Doar semnatarul curent sau un admin poate trimite spre revizuire.' });
```

## PAS 5 — Sit 3: `/reinitiate-review` (mesaj „reiniția după revizuire")
- old_str:
```
    const isAdmin = actor.role === 'admin' || (actor.role === 'org_admin' && data.orgId != null && actor.orgId != null && Number(data.orgId) === Number(actor.orgId));
    const isInit = (data.initEmail || '').toLowerCase() === actor.email.toLowerCase();
    if (!isAdmin && !isInit) return res.status(403).json({ error: 'forbidden', message: 'Doar inițiatorul poate reiniția după revizuire.' });
```
- new_str:
```
    const isAdmin = isAdminOrOrgAdmin(actor) && actorCanAccessOrg(actor, data.orgId);
    const isInit = (data.initEmail || '').toLowerCase() === actor.email.toLowerCase();
    if (!isAdmin && !isInit) return res.status(403).json({ error: 'forbidden', message: 'Doar inițiatorul poate reiniția după revizuire.' });
```

## PAS 6 — Sit 4: `/delegate` (mesaj „poate delega")
- old_str:
```
    const isAdmin = actor?.role === 'admin' || (actor?.role === 'org_admin' && Number(data.orgId) === Number(actor?.orgId));
    const isCurrentSigner = !!actor && currentSignerEmail === (actor.email || '').toLowerCase();
    if (actor && !isAdmin && !isCurrentSigner) return res.status(403).json({ error: 'forbidden', message: 'Doar semnatarul curent sau un admin poate delega.' });
```
- new_str:
```
    const isAdmin = isAdminOrOrgAdmin(actor) && actorCanAccessOrg(actor, data.orgId);
    const isCurrentSigner = !!actor && currentSignerEmail === (actor.email || '').toLowerCase();
    if (actor && !isAdmin && !isCurrentSigner) return res.status(403).json({ error: 'forbidden', message: 'Doar semnatarul curent sau un admin poate delega.' });
```

## PAS 7 — Sit 5: `/cancel` (mesaj „anula fluxul")
- old_str:
```
    const isAdmin = actor.role === 'admin' || (actor.role === 'org_admin' && data.orgId != null && actor.orgId != null && Number(data.orgId) === Number(actor.orgId));
    const isInit = (data.initEmail || '').toLowerCase() === actor.email.toLowerCase();
    if (!isAdmin && !isInit) return res.status(403).json({ error: 'forbidden', message: 'Doar inițiatorul sau un admin poate anula fluxul.' });
```
- new_str:
```
    const isAdmin = isAdminOrOrgAdmin(actor) && actorCanAccessOrg(actor, data.orgId);
    const isInit = (data.initEmail || '').toLowerCase() === actor.email.toLowerCase();
    if (!isAdmin && !isInit) return res.status(403).json({ error: 'forbidden', message: 'Doar inițiatorul sau un admin poate anula fluxul.' });
```

```bash
node --check server/routes/flows/lifecycle.mjs
grep -cn "actor.role === 'admin' || (actor" server/routes/flows/lifecycle.mjs
# Așteptat: 0 (toate 5 comutate). Dacă > 0, un sit a rămas — raportează.
```

---

## PAS 8 — Test nou de wiring authz: `server/tests/integration/lifecycle-org-guard.test.mjs`

Endpoint reprezentativ `/cancel` (aceeași expresie de guard la toate 5). Actor setabil.
Conținut EXACT:

```js
/**
 * #105h — lifecycle write guards: contract platform-admin pe POST /flows/:id/cancel
 * (aceeași expresie de guard la reinitiate/request-review/reinitiate-review/delegate).
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
import lifecycleRouter, { _injectDeps } from '../../routes/flows/lifecycle.mjs';

function makeApp() {
  _injectDeps({
    notify: vi.fn().mockResolvedValue(undefined), fireWebhook: null, wsPush: vi.fn(),
    PDFLib: null, stampFooterOnPdf: vi.fn(), isSignerTokenExpired: () => false,
    newFlowId: () => 'NEW', buildSignerLink: () => '', stripSensitive: x => x,
    stripPdfB64: x => x, sendSignerEmail: vi.fn().mockResolvedValue(undefined),
  });
  const a = express(); a.use(express.json()); a.use(cookieParser()); a.use('/', lifecycleRouter);
  return a;
}
const app = makeApp();
const flow = (o = {}) => ({ flowId: 'F1', docName: 'X', initEmail: 'init@x.ro', orgId: 1, status: 'active', completed: false, signers: [], ...o });

describe('#105h — POST /flows/:id/cancel org guard', () => {
  beforeEach(() => { vi.clearAllMocks(); dbModule.getFlowData.mockResolvedValue(flow()); });

  it('org_admin din ALT org (2) → 403', async () => {
    CURRENT_ACTOR = { email: 'oa@y.ro', role: 'org_admin', orgId: 2, userId: 9 };
    expect((await request(app).post('/flows/F1/cancel').send({})).status).toBe(403);
  });
  it('admin CU org_id, ALT org (2) → 403 (fail-closed până la flip)', async () => {
    CURRENT_ACTOR = { email: 'admin@y.ro', role: 'admin', orgId: 2, userId: 1 };
    expect((await request(app).post('/flows/F1/cancel').send({})).status).toBe(403);
  });
  it('platform-admin (fără org_id) → NU 403 (cross-org permis)', async () => {
    CURRENT_ACTOR = { email: 'super@z.ro', role: 'admin', orgId: null, userId: 1 };
    expect((await request(app).post('/flows/F1/cancel').send({})).status).not.toBe(403);
  });
  it('admin CU org_id, ACELAȘI org (1) → NU 403', async () => {
    CURRENT_ACTOR = { email: 'admin@x.ro', role: 'admin', orgId: 1, userId: 1 };
    expect((await request(app).post('/flows/F1/cancel').send({})).status).not.toBe(403);
  });
  it('inițiator (alt org irelevant) → NU 403', async () => {
    CURRENT_ACTOR = { email: 'init@x.ro', role: 'user', orgId: 2, userId: 5 };
    expect((await request(app).post('/flows/F1/cancel').send({})).status).not.toBe(403);
  });
});
```

```bash
node --check server/tests/integration/lifecycle-org-guard.test.mjs
```

> Dacă `_injectDeps` cere alte chei sau `/cancel` atinge un dep ne-stubuit pe calea „NU 403",
> aliniază stub-urile la ce cere handlerul (fără a schimba producția) și raportează.

---

## PAS 9 — Suită + bump + commit + push

```bash
npm test
# Așteptat: verde. 5 cazuri noi trec. Testele lifecycle existente (cancel-restore, state-machine)
# rămân verzi — calea inițiator (isInit) e neschimbată.
```

- old_str: `  "version": "3.9.732",`
- new_str: `  "version": "3.9.733",`

```bash
git add server/routes/flows/lifecycle.mjs server/tests/integration/lifecycle-org-guard.test.mjs package.json
git status --short          # exact 3 intrări
git commit -m "#105h: write guards lifecycle → contract platform-admin (5 situri) (v3.9.733)"
git push origin develop
```

---

## RAPORT FINAL (completează)

- Import + cele 5 situri comutate la `isAdminOrOrgAdmin(actor) && actorCanAccessOrg(actor, data.orgId)`: da/nu
- grep PAS 7: 0 apariții rămase cu vechiul pattern: da/nu
- node --check pe lifecycle.mjs + test: OK
- 5 cazuri noi trec; testele lifecycle existente (cancel-restore/state-machine) rămân verzi: da/nu
- Ai ajustat stub-urile _injectDeps (PAS 8): ______
- npm test: PASSED (nr. fișiere/teste)
- Bump 3.9.732 → 3.9.733: da/nu
- Commit (hash): ______  Push origin/develop (range): ______
- Abateri/surprize: ______

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ Branch `develop`. Push DOAR `origin develop`. NICIODATĂ `main`.
- ⛔ Atingi DOAR: `lifecycle.mjs` (import + 5 situri isAdmin), testul nou, `package.json`.
- ⛔ Schimbi DOAR linia `isAdmin = ...` la fiecare sit; liniile isInit/isCurrentSigner/403 rămân IDENTICE.
- ⛔ NU atinge signing.mjs/attachments.mjs (vin în #105i). NU modifica `authz-scope.mjs`.
- ⛔ Zona NO-TOUCH `server/signing/*` (PAdES core) — neatinsă. (lifecycle.mjs NU e acolo.)
- ⛔ Fără migrații, fără cache/`?v=`.
- ⛔ Orice `old_str` care nu se potrivește (whitespace): NU forța, raportează linia reală.
