---
prompt: "#105b"
titlu: "Închide leak-ul cross-org pe report/email (org_admin fără sameOrg) — #19/#20"
model_suggested: "Opus 4.8"
target_version: "v3.9.727"
branch: "develop"
migratii: "nu"
cache_bump: "nu (niciun fișier din PRECACHE_ASSETS atins)"
depinde_de: "#105a (authz-scope.mjs trebuie să existe deja, commit 71f7b25)"
---

# ⚠️ BRANCH: `develop` EXCLUSIV
`main` = PRODUCȚIE, gestionat MANUAL de Mircea. Zero checkout/merge/push pe `main`.

---

## Context (de ce)

`email.mjs` (email-stats) și `report.mjs` (`/report`, `/report/json`) au azi poarta:

```js
const isAdmin = actor.role === 'admin' || actor.role === 'org_admin';
if (!isAdmin && !isInit && !isSigner) return 403;
```

`isAdmin` e adevărat pentru **orice** `org_admin`, **fără** verificare de organizație — iar
`getFlowData(id)` ia fluxul strict după `id`, fără filtru org. Rezultat: **un `org_admin` al
org B poate citi raportul / statisticile de email ale unui flux din org A** după flowId. E
singurul leak care se activează la a doua primărie fără nicio precondiție (nu cere un `admin`
cu `org_id`). Îl închidem acum, aliniind poarta la contractul canonic din #105a.

Contract aplicat: acces = **(admin/org_admin CU acces la org-ul fluxului)** OR inițiator OR
semnatar. Platform-admin (`role==='admin'` fără `org_id`) trece prin `actorCanAccessOrg`
(vede tot); org_admin/admin trec doar pe același org; orice lipsă de `org_id` non-platform
fail-uiește CLOSED. Inițiatorul și semnatarii NU sunt afectați.

> NOTĂ separată (NU în acest prompt): `GET /api/flows/:flowId/report/status` (report.mjs:164)
> nu are NICIUN guard de acces — întoarce existența + `conclusion` pentru orice flowId, oricărui
> user autentificat. Leak minor (existență + concluzie). Îl tratăm separat; nu-l atinge aici.

---

## PAS 1 — Preflight

```bash
cd <repo>
git rev-parse --abbrev-ref HEAD          # Așteptat: develop
git status --short                        # working tree curat (untracked-uri pre-existente OK)
git log --oneline -1                      # Așteptat: 71f7b25 (#105a) în istoric recent
grep '"version"' package.json             # Așteptat: "version": "3.9.726",
test -f server/services/authz-scope.mjs && echo "authz-scope OK"   # Așteptat: authz-scope OK
```
Dacă `authz-scope.mjs` lipsește (#105a nu e aplicat), **oprește-te**.

---

## PAS 2 — Import helper în `server/routes/flows/email.mjs`

După linia 9 (`import { logger } ...`), adaugă importul. old_str → new_str:

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

## PAS 3 — Fixează poarta email-stats în `email.mjs`

- old_str:
```
    // Verificare acces: inițiator, semnatar sau admin/org_admin
    const isAdmin = actor.role === 'admin' || actor.role === 'org_admin';
    const isInitiator = (data.initEmail || '').toLowerCase() === actor.email.toLowerCase();
```
- new_str:
```
    // Verificare acces: inițiator, semnatar sau admin/org_admin CU acces la org-ul fluxului
    // #105b: platform-admin (fără org_id) vede tot; org_admin/admin doar pe același org (fail-closed)
    const isAdmin = isAdminOrOrgAdmin(actor) && actorCanAccessOrg(actor, data.orgId);
    const isInitiator = (data.initEmail || '').toLowerCase() === actor.email.toLowerCase();
```

```bash
node --check server/routes/flows/email.mjs   # Așteptat: fără output
```

---

## PAS 4 — Import helper în `server/routes/report.mjs`

- old_str:
```
import { requireAuth } from '../middleware/auth.mjs';
import { logger } from '../middleware/logger.mjs';
```
- new_str:
```
import { requireAuth } from '../middleware/auth.mjs';
import { isAdminOrOrgAdmin, actorCanAccessOrg } from '../services/authz-scope.mjs';
import { logger } from '../middleware/logger.mjs';
```

## PAS 5 — Fixează poarta `/report` în `report.mjs`

- old_str:
```
    // Verificăm că actorul e inițiatorul sau admin
    const isAdmin = actor.role === 'admin' || actor.role === 'org_admin';
    const isInit  = (data.initEmail || '').toLowerCase() === actor.email.toLowerCase();
```
- new_str:
```
    // Verificăm accesul: inițiator, semnatar sau admin/org_admin CU acces la org-ul fluxului
    // #105b: platform-admin (fără org_id) vede tot; org_admin/admin doar pe același org (fail-closed)
    const isAdmin = isAdminOrOrgAdmin(actor) && actorCanAccessOrg(actor, data.orgId);
    const isInit  = (data.initEmail || '').toLowerCase() === actor.email.toLowerCase();
```

> `isAdmin` e refolosit mai jos la `forceRegen = req.query.force === '1' && (isAdmin || isInit)`.
> Cu noua semantică e corect: un org_admin cross-org nu mai poate nici regenera forțat. Nu-l atinge.

## PAS 6 — Fixează poarta `/report/json` în `report.mjs`

- old_str:
```
    const isAdmin  = actor.role === 'admin' || actor.role === 'org_admin';
    const isInit   = (data.initEmail || '').toLowerCase() === actor.email.toLowerCase();
    const isSigner = (data.signers || []).some(s => (s.email||'').toLowerCase() === actor.email.toLowerCase());
    if (!isAdmin && !isInit && !isSigner)
      return res.status(403).json({ error: 'forbidden' });
```
- new_str:
```
    // #105b: platform-admin (fără org_id) vede tot; org_admin/admin doar pe același org (fail-closed)
    const isAdmin  = isAdminOrOrgAdmin(actor) && actorCanAccessOrg(actor, data.orgId);
    const isInit   = (data.initEmail || '').toLowerCase() === actor.email.toLowerCase();
    const isSigner = (data.signers || []).some(s => (s.email||'').toLowerCase() === actor.email.toLowerCase());
    if (!isAdmin && !isInit && !isSigner)
      return res.status(403).json({ error: 'forbidden' });
```

```bash
node --check server/routes/report.mjs   # Așteptat: fără output
grep -n "actor.role === 'admin' || actor.role === 'org_admin'" server/routes/report.mjs server/routes/flows/email.mjs
# Așteptat: NICIUN rezultat pe cele 3 situri fixate (dacă mai apare vreunul, e alt endpoint neatins — raportează)
```

---

## PAS 7 — Test de izolare (fișier NOU)

Creează `server/tests/integration/tenant-isolation-report.test.mjs`. Modelat pe
`flow-acl-canread.test.mjs` (mock pe `db/index.mjs`, `makeAuth`, `makeFlowData`). Conținut EXACT:

```js
/**
 * #105b — tenant isolation pe report/json.
 * Fluxul e în org 1. Un org_admin din org 2 NU trebuie să-i vadă raportul (#20).
 * Platform-admin (role='admin', fără org_id) vede tot. Inițiator/semnatar neafectați.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

vi.mock('../../db/index.mjs', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
  getFlowData: vi.fn(),
}));
vi.mock('../../services/sign-trust-report.mjs', () => ({
  generateTrustReport: vi.fn().mockResolvedValue({ report: { ok: true } }),
}));
vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import * as dbModule from '../../db/index.mjs';
import reportRouter from '../../routes/report.mjs';
import { JWT_SECRET } from '../../middleware/auth.mjs';

const FLOW_ID = 'FLOW_REP01';
const URL = `/api/flows/${FLOW_ID}/report/json`;

function makeAuth(email, userId, role, orgId) {
  return `auth_token=${jwt.sign({ email, userId, role, orgId }, JWT_SECRET, { expiresIn: '1h' })}`;
}
function makeFlowData(orgId = 1) {
  return {
    flowId: FLOW_ID, docName: 'X', initEmail: 'init@a.ro', orgId,
    status: 'active', completed: false,
    signers: [{ name: 'S', email: 'sig@a.ro', token: 't', status: 'current', order: 1 }],
    signedPdfB64: null, pdfB64: null,
  };
}
function app() {
  const a = express();
  a.use(cookieParser());
  a.use('/', reportRouter);
  return a;
}

beforeEach(() => { vi.clearAllMocks(); dbModule.getFlowData.mockReset(); });

describe('#105b tenant isolation — /report/json (flux org 1)', () => {
  it('org_admin din ALT org (2) → 403 (leak #20 închis)', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData(1));
    const res = await request(app()).get(URL).set('Cookie', makeAuth('oa@b.ro', 9, 'org_admin', 2));
    expect(res.status).toBe(403);
  });
  it('org_admin din ACELAȘI org (1) → nu 403', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData(1));
    const res = await request(app()).get(URL).set('Cookie', makeAuth('oa@a.ro', 8, 'org_admin', 1));
    expect(res.status).not.toBe(403);
  });
  it('platform-admin (role admin, fără org_id) → nu 403 (cross-org)', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData(1));
    const res = await request(app()).get(URL).set('Cookie', makeAuth('admin@docflowai.ro', 1, 'admin', null));
    expect(res.status).not.toBe(403);
  });
  it('admin CU org_id=1 (starea prod azi) pe flux org 1 → nu 403', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData(1));
    const res = await request(app()).get(URL).set('Cookie', makeAuth('admin@docflowai.ro', 1, 'admin', 1));
    expect(res.status).not.toBe(403);
  });
  it('admin CU org_id=1 pe flux ALT org (2) → 403 (fail-closed până la null org_id)', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData(2));
    const res = await request(app()).get(URL).set('Cookie', makeAuth('admin@docflowai.ro', 1, 'admin', 1));
    expect(res.status).toBe(403);
  });
  it('inițiator (chiar din alt org) → nu 403', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData(1));
    const res = await request(app()).get(URL).set('Cookie', makeAuth('init@a.ro', 7, 'user', 2));
    expect(res.status).not.toBe(403);
  });
  it('semnatar → nu 403', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData(1));
    const res = await request(app()).get(URL).set('Cookie', makeAuth('sig@a.ro', 6, 'user', 2));
    expect(res.status).not.toBe(403);
  });
  it('user oarecare non-init/non-signer, chiar același org → 403', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData(1));
    const res = await request(app()).get(URL).set('Cookie', makeAuth('rando@a.ro', 5, 'user', 1));
    expect(res.status).toBe(403);
  });
});
```

```bash
node --check server/tests/integration/tenant-isolation-report.test.mjs   # Așteptat: fără output
```

> Dacă la rulare `report.mjs` importă la load un modul ne-mock-uit și testul crapă la montare
> (nu la assert), adaugă mock-ul minim necesar pentru acel import (NU schimba producția) și
> raportează ce ai adăugat.

---

## PAS 8 — Rulează suita

```bash
npm test
# Așteptat: verde. Noul fișier trece (8 cazuri). Testele existente rămân verzi.
```

---

## PAS 9 — Bump + commit

- old_str: `  "version": "3.9.726",`
- new_str: `  "version": "3.9.727",`

```bash
git add server/routes/flows/email.mjs server/routes/report.mjs \
        server/tests/integration/tenant-isolation-report.test.mjs package.json
git status --short          # Așteptat: exact 4 intrări
git commit -m "#105b: acces report/email cere sameOrg (platform-admin exceptat) — leak cross-org #19/#20 (v3.9.727)"
```

---

## RAPORT FINAL (completează)

- Import helper adăugat în email.mjs și report.mjs (căi `../../` resp. `../`): da/nu
- Cele 3 guard-uri comutate la `isAdminOrOrgAdmin(actor) && actorCanAccessOrg(actor, data.orgId)`: da/nu
- `grep` de la PAS 6 confirmă zero situri rămase cu vechiul pattern pe cele 2 fișiere: da/nu
- `node --check` pe cele 3 fișiere: OK
- Fișier nou de test creat: da/nu
- `npm test`: PASSED (nr. fișiere/teste); cele 8 cazuri noi trec; niciun test existent nu s-a rupt
- git status înainte de commit: exact 4 intrări? da/nu
- Bump 3.9.726 → 3.9.727: da/nu
- Commit pe develop (hash): ______
- Ai adăugat vreun mock suplimentar la PAS 7 (dacă da, care): ______
- Abateri/surprize: ______

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ Branch `develop` EXCLUSIV. Zero push/merge pe `main`.
- ⛔ Atingi DOAR: `email.mjs` (import + 1 guard), `report.mjs` (import + 2 guard-uri), fișierul de
  test nou, `package.json`. NIMIC altceva. NU atinge `/report/status` (îl tratăm separat).
- ⛔ NU modifica `authz-scope.mjs` (e înghețat din #105a). Doar îl imporți.
- ⛔ NU consolida încă report/email pe `canActorReadFlow` — aia are lockout-ul de reparat în #105d;
  aici rămânem pe fix-ul chirurgical.
- ⛔ Inițiatorul și semnatarii trebuie să rămână neafectați (testele o dovedesc).
- ⛔ Fără migrații, fără cache bump, fără `?v=`. Zona NO-TOUCH (`server/signing/*`) neatinsă.
- ⛔ Dacă un guard nu se potrivește exact la old_str (whitespace), NU forța — raportează linia reală.
