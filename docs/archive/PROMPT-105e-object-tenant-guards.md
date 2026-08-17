---
prompt: "#105e"
titlu: "Guard-uri de obiect: delete tenant (stergeFormular) + /report/status — contract platform-admin"
model_suggested: "Opus 4.8"
target_version: "v3.9.730"
branch: "develop"
migratii: "nu"
cache_bump: "nu"
depinde_de: "#105a..#105d (4dc1ce1)"
---

# ⚠️ BRANCH: `develop` EXCLUSIV
`main` = PRODUCȚIE, MANUAL. Zero push/merge pe `main`. Push DOAR pe `origin develop`.

---

## Context (de ce)

Două guard-uri de acces pe obiect mai folosesc semantica (a):

1. `services/formular-shared.mjs:696` (în `stergeFormular`): `actor.role !== 'admin' && doc.org_id
   !== actor.orgId` → un `admin` sare peste bariera de tenant la soft-delete. Corect: doar
   **platform-admin** (fără org_id) sare; un admin-cu-org trebuie să fie pe același org.
2. `routes/report.mjs` `GET /report/status` — **niciun** guard de acces: întoarce existența +
   `conclusion` pentru orice flowId, oricărui user autentificat. Îl aliniem la `/report/json`.

**Exclus intenționat: `opme.mjs:57`.** La citire nu e leak de tenant — importul OPME e org-scopat
dur (`/api/opme/import` linia 97 cere `actor.orgId`, altfel 403; toată logica lucrează pe
`actor.orgId`). `role==='admin'` de la 57 e un check de ROL, nu o barieră de tenant; un swap naiv
ar regresa admin-ul curent (org_id=1) din import, iar cazul „platform-admin importă OPME" cere o
decizie de produs (care org țintă?). Îl lăsăm neatins.

**Invizibil la o org**: admin.org_id=1 = doc.org_id=1 → guardul de delete trece; `/report/status`
pentru admin same-org trece.

---

## PAS 1 — Preflight

```bash
cd <repo>
git rev-parse --abbrev-ref HEAD          # develop
grep '"version"' package.json            # "version": "3.9.729",
test -f server/services/authz-scope.mjs && echo OK
```

---

## PAS 2 — `server/services/formular-shared.mjs`

### 2a. Import (authz-scope e în ACELAȘI folder `services/` → `./authz-scope.mjs`)
- old_str:
```
import { pool } from '../db/index.mjs';
import { logger } from '../middleware/logger.mjs';
```
- new_str:
```
import { pool } from '../db/index.mjs';
import { isPlatformAdmin } from './authz-scope.mjs';
import { logger } from '../middleware/logger.mjs';
```

### 2b. Guard de tenant la delete
- old_str:
```
    if (actor.role !== 'admin' && doc.org_id !== actor.orgId)
```
- new_str:
```
    if (!isPlatformAdmin(actor) && doc.org_id !== actor.orgId)
```

```bash
node --check server/services/formular-shared.mjs
```

---

## PAS 3 — `server/routes/report.mjs` — guard pe `/report/status`

`getFlowData`, `isAdminOrOrgAdmin`, `actorCanAccessOrg` sunt DEJA importate (din #105b) — fără import nou.

- old_str:
```
    const actor = requireAuth(req, res); if (!actor) return;
    const { flowId } = req.params;
    const { rows } = await pool.query(
      `SELECT generated_at, conclusion FROM trust_reports WHERE flow_id = $1`, [flowId]
    ).catch(() => ({ rows: [] }));
    return res.json({ exists: rows.length > 0, generatedAt: rows[0]?.generated_at, conclusion: rows[0]?.conclusion });
```
- new_str:
```
    const actor = requireAuth(req, res); if (!actor) return;
    const { flowId } = req.params;
    const data = await getFlowData(flowId);
    if (!data) return res.json({ exists: false });
    // #105e: același contract de acces ca /report/json (platform-admin/same-org/init/semnatar)
    const isAdmin  = isAdminOrOrgAdmin(actor) && actorCanAccessOrg(actor, data.orgId);
    const isInit   = (data.initEmail || '').toLowerCase() === actor.email.toLowerCase();
    const isSigner = (data.signers || []).some(s => (s.email||'').toLowerCase() === actor.email.toLowerCase());
    if (!isAdmin && !isInit && !isSigner)
      return res.status(403).json({ error: 'forbidden' });
    const { rows } = await pool.query(
      `SELECT generated_at, conclusion FROM trust_reports WHERE flow_id = $1`, [flowId]
    ).catch(() => ({ rows: [] }));
    return res.json({ exists: rows.length > 0, generatedAt: rows[0]?.generated_at, conclusion: rows[0]?.conclusion });
```

```bash
node --check server/routes/report.mjs
```

---

## PAS 4 — Test nou: guard tenant la delete (`server/tests/unit/sterge-org-guard.test.mjs`)

Fișier NOU. Mock pe `pool` + `canDestroyOnly` (întoarce `allowed:false` ⇒ dacă se trece de guardul
de tenant, eroarea NU e `forbidden`, ci `not_destroyable` — așa dovedim că tenant-guardul a fost
sărit). Conținut EXACT:

```js
/**
 * #105e — stergeFormular: guard de tenant.
 * Platform-admin sare peste bariera de org; admin-cu-org și org_admin doar pe același org.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../db/index.mjs', () => ({ pool: { query: vi.fn() } }));
vi.mock('../../services/authz-formular.mjs', () => ({
  loadActorComp:   vi.fn(),
  canEditFormular: vi.fn(),
  canDestroyOnly:  vi.fn(() => ({ allowed: false, reason: 'not_destroyable' })),
}));
vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import * as dbModule from '../../db/index.mjs';
import { stergeFormular } from '../../services/formular-shared.mjs';

function mockDoc(orgId) {
  dbModule.pool.query.mockResolvedValueOnce({ rows: [{ id: 'x', org_id: orgId, flow_id: null }] });
}

describe('#105e — stergeFormular tenant guard', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('org_admin din ALT org → 403 forbidden (tenant)', async () => {
    mockDoc(1);
    const r = await stergeFormular({ type: 'df', id: 'x', actor: { role: 'org_admin', orgId: 2, userId: 5 } });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('forbidden');
  });

  it('platform-admin (fără org_id) → sare peste tenant guard (eroarea NU e forbidden)', async () => {
    mockDoc(1);
    const r = await stergeFormular({ type: 'df', id: 'x', actor: { role: 'admin', orgId: null, userId: 1 } });
    expect(r.body.error).not.toBe('forbidden');
  });

  it('admin CU org_id, ACELAȘI org → trece de tenant guard', async () => {
    mockDoc(1);
    const r = await stergeFormular({ type: 'df', id: 'x', actor: { role: 'admin', orgId: 1, userId: 1 } });
    expect(r.body.error).not.toBe('forbidden');
  });

  it('admin CU org_id, ALT org → 403 forbidden (fail-closed)', async () => {
    mockDoc(1);
    const r = await stergeFormular({ type: 'df', id: 'x', actor: { role: 'admin', orgId: 2, userId: 1 } });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('forbidden');
  });
});
```

```bash
node --check server/tests/unit/sterge-org-guard.test.mjs
```

> Dacă `stergeFormular` crapă la IMPORT din cauza vreunui modul ne-mock-uit cu efect la load,
> adaugă mock-ul minim pentru acel import (NU schimba producția) și raportează.

---

## PAS 5 — Extinde `server/tests/integration/tenant-isolation-report.test.mjs` (de la #105b)

Adaugă la SFÂRȘITUL fișierului (după ultimul `});`), reutilizând `makeAuth`, `makeFlowData`,
`app`, `dbModule`, `FLOW_ID`. Conținut EXACT:

```js

describe('#105e tenant isolation — /report/status (flux org 1)', () => {
  const SURL = `/api/flows/${FLOW_ID}/report/status`;
  it('org_admin din ALT org (2) → 403', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData(1));
    const res = await request(app()).get(SURL).set('Cookie', makeAuth('oa@b.ro', 9, 'org_admin', 2));
    expect(res.status).toBe(403);
  });
  it('org_admin din ACELAȘI org (1) → nu 403', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData(1));
    const res = await request(app()).get(SURL).set('Cookie', makeAuth('oa@a.ro', 8, 'org_admin', 1));
    expect(res.status).not.toBe(403);
  });
  it('platform-admin (fără org_id) → nu 403', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData(1));
    const res = await request(app()).get(SURL).set('Cookie', makeAuth('admin@docflowai.ro', 1, 'admin', null));
    expect(res.status).not.toBe(403);
  });
  it('inițiator → nu 403', async () => {
    dbModule.getFlowData.mockResolvedValue(makeFlowData(1));
    const res = await request(app()).get(SURL).set('Cookie', makeAuth('init@a.ro', 7, 'user', 2));
    expect(res.status).not.toBe(403);
  });
});
```

```bash
node --check server/tests/integration/tenant-isolation-report.test.mjs
```

---

## PAS 6 — Suită + bump + commit + push

```bash
npm test
# Așteptat: verde. 4 cazuri noi (sterge-org-guard) + 4 cazuri noi (report/status) trec.
```

- old_str: `  "version": "3.9.729",`
- new_str: `  "version": "3.9.730",`

```bash
git add server/services/formular-shared.mjs server/routes/report.mjs \
        server/tests/unit/sterge-org-guard.test.mjs \
        server/tests/integration/tenant-isolation-report.test.mjs package.json
git status --short          # Așteptat: exact 5 intrări
git commit -m "#105e: guard-uri de obiect (stergeFormular tenant + /report/status) → contract platform-admin (v3.9.730)"
git push origin develop
```

---

## RAPORT FINAL (completează)

- formular-shared.mjs: import + guard delete comutat la `!isPlatformAdmin(...)`: da/nu
- report.mjs `/report/status`: guard adăugat (getFlowData + isAdmin/init/signer): da/nu
- opme.mjs NEATINS (fals-pozitiv documentat): da/nu
- node --check pe cele 2 fișiere sursă + 2 fișiere test: OK
- Test nou sterge-org-guard (4 cazuri) trece: da/nu
- tenant-isolation-report extins (4 cazuri /report/status) trece: da/nu
- npm test: PASSED (nr. fișiere/teste); niciun test existent rupt
- Ai adăugat mock suplimentar la PAS 4 (care): ______
- Bump 3.9.729 → 3.9.730: da/nu
- Commit (hash): ______  Push origin/develop (range): ______
- Abateri/surprize: ______

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ Branch `develop`. Push DOAR `origin develop`. NICIODATĂ `main`.
- ⛔ Atingi DOAR: `formular-shared.mjs`, `report.mjs`, cele 2 fișiere de test, `package.json`.
- ⛔ NU atinge `opme.mjs` (fals-pozitiv, ar regresa admin-ul curent).
- ⛔ NU modifica `authz-scope.mjs` (înghețat). NU atinge lockout/lifecycle/signing/attachments (vin în #105f).
- ⛔ Guardul delete: doar `!isPlatformAdmin(actor)` sare bariera; un admin-cu-org TREBUIE să fie same-org.
- ⛔ Fără migrații, fără cache/`?v=`. Zona NO-TOUCH (`server/signing/*`) neatinsă.
- ⛔ Orice `old_str` care nu se potrivește (whitespace): NU forța, raportează linia reală.
