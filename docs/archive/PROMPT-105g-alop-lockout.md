---
prompt: "#105g"
titlu: "Lockout ALOP → filtru org null-tolerant la cei 3 apelanți (fără reindexare de parametri)"
model_suggested: "Opus 4.8"
target_version: "v3.9.732"
branch: "develop"
migratii: "nu"
cache_bump: "nu"
depinde_de: "#105a..#105f (e605a13)"
---

# ⚠️ BRANCH: `develop` EXCLUSIV
`main` = PRODUCȚIE, MANUAL. Zero push/merge pe `main`. Push DOAR pe `origin develop`.
⚠️ Interogări de BANI (ALOP). Editări chirurgicale, exact old_str/new_str, fără reindexare.

---

## Context (de ce)

Lockout-ul ALOP NU e în `buildAlopVisibilityWhere` (aia întoarce `''` pentru admin/org_admin) — e la
cei **3 apelanți** care hardcodează `a.org_id=$1` pe `actor.orgId`:
`routes/alop.mjs` — `/api/alop/stats` (~295), `/api/alop` (~323), `/api/alop/facturi` (CTE ~489).
Un platform-admin (`org_id=NULL`) primește `a.org_id=NULL` ⇒ 0 rânduri (lockout).

**Fix minimal, fără reindexare** (pattern-ul deja folosit în `admin/audit.mjs`): păstrăm `$1` ca
parametru de org, dar îl facem null-tolerant — `($1::int IS NULL OR a.org_id=$1)` — și trimitem
`null` ca `$1` pentru platform-admin:

- `params = [actor.orgId]` → `params = [isPlatformAdmin(actor) ? null : actor.orgId]`
- `a.org_id=$1` → `($1::int IS NULL OR a.org_id=$1)`

`$1` rămâne org peste tot; indexarea downstream din `buildAlopVisibilityWhere` (dinamică,
`params.length`) și restul query-ului ($2..$9 în ALTE handlere) NU se ating. **Dormant la o org**
(admin.org_id=1 ⇒ `$1=1` ⇒ `a.org_id=1`, neschimbat). Se aprinde la flip-ul `org_id=NULL`.

---

## PAS 1 — Preflight

```bash
cd <repo>
git rev-parse --abbrev-ref HEAD          # develop
grep '"version"' package.json            # "version": "3.9.731",
test -f server/services/authz-scope.mjs && echo OK
```

---

## PAS 2 — Import în `server/routes/alop.mjs`
- old_str:
```
import { sendNotif } from '../services/formular-shared.mjs';
import { computeAlopCapabilities } from '../services/alop-capabilities.mjs';
```
- new_str:
```
import { sendNotif } from '../services/formular-shared.mjs';
import { computeAlopCapabilities } from '../services/alop-capabilities.mjs';
import { isPlatformAdmin } from '../services/authz-scope.mjs';
```

## PAS 3 — Apelant 1: `/api/alop/stats`
- old_str:
```
    const params = [actor.orgId];
    let where = 'a.org_id=$1 AND a.cancelled_at IS NULL';
```
- new_str:
```
    const params = [isPlatformAdmin(actor) ? null : actor.orgId];
    let where = '($1::int IS NULL OR a.org_id=$1) AND a.cancelled_at IS NULL';
```

## PAS 4 — Apelant 2: `/api/alop`
- old_str:
```
    const params = [actor.orgId];
    let where = 'a.org_id = $1 AND a.cancelled_at IS NULL';
```
- new_str:
```
    const params = [isPlatformAdmin(actor) ? null : actor.orgId];
    let where = '($1::int IS NULL OR a.org_id = $1) AND a.cancelled_at IS NULL';
```

## PAS 5 — Apelant 3: `/api/alop/facturi` (params + CTE)

### 5a. params
- old_str:
```
    const params = [actor.orgId];
    // CTE cu ALOP-urile vizibile actorului (aceeași regulă ca lista ALOP)
```
- new_str:
```
    const params = [isPlatformAdmin(actor) ? null : actor.orgId];
    // CTE cu ALOP-urile vizibile actorului (aceeași regulă ca lista ALOP)
```

### 5b. WHERE-ul din CTE
- old_str:
```
         WHERE a.org_id = $1 AND a.cancelled_at IS NULL${visWhere}
```
- new_str:
```
         WHERE ($1::int IS NULL OR a.org_id = $1) AND a.cancelled_at IS NULL${visWhere}
```

```bash
node --check server/routes/alop.mjs
grep -n "a.org_id=\$1\|a.org_id = \$1" server/routes/alop.mjs
# Așteptat: cele 3 apariții sunt acum în forma `(\$1::int IS NULL OR a.org_id...=\$1)`.
# Dacă mai există `a.org_id=$1`/`a.org_id = $1` fără paranteza null-tolerant, raportează linia.
```

---

## PAS 6 — Extinde `server/tests/integration/alop.test.mjs`

Adaugă la SFÂRȘITUL fișierului (după ultimul `});`), self-contained (își face app-ul local din
`alopRouter` deja importat). Conținut EXACT:

```js

// ── #105g — org-scope vizibilitate ALOP (platform-admin vs. org-scoped) ────────
function app105g() {
  const a = express();
  a.use(cookieParser());
  a.use(alopRouter);
  return a;
}
function tok105g(role, orgId, userId = 90) {
  return jwt.sign({ userId, email: `${role}@x.ro`, role, orgId, nume: role }, JWT_SECRET, { expiresIn: '2h' });
}
function captureAlop() {
  const calls = [];
  dbModule.pool.query.mockImplementation((sql, params) => {
    calls.push({ sql: String(sql), params: params || [] });
    return Promise.resolve({ rows: [] });
  });
  return { list: () => calls.find(c => c.sql.includes('FROM alop_instances a')) || { sql: '', params: [] } };
}

describe('#105g — org-scope /api/alop (listă)', () => {
  beforeEach(() => { dbModule.pool.query.mockReset(); });

  it('platform-admin (admin fără org_id) → $1 null-tolerant + params[0]=null (vede tot)', async () => {
    const cap = captureAlop();
    await request(app105g()).get('/api/alop').set('Cookie', `auth_token=${tok105g('admin', null, 99)}`).expect(200);
    const c = cap.list();
    expect(c.sql).toContain('$1::int IS NULL');
    expect(c.params[0]).toBe(null);
  });

  it('admin CU org_id → params[0]=org (scopat)', async () => {
    const cap = captureAlop();
    await request(app105g()).get('/api/alop').set('Cookie', `auth_token=${tok105g('admin', 1, 5)}`).expect(200);
    expect(cap.list().params[0]).toBe(1);
  });

  it('org_admin → params[0]=org (scopat)', async () => {
    const cap = captureAlop();
    await request(app105g()).get('/api/alop').set('Cookie', `auth_token=${tok105g('org_admin', 2, 6)}`).expect(200);
    expect(cap.list().params[0]).toBe(2);
  });
});
```

```bash
node --check server/tests/integration/alop.test.mjs
```

> Dacă `express`/`cookieParser` nu sunt deja importate în fișier, folosește app-ul/utilitarul
> existent din test în loc de `app105g()` și raportează ce ai ajustat.

---

## PAS 7 — Suită + bump + commit + push

```bash
npm test
# Așteptat: verde. Cele 3 cazuri noi trec. Testele ALOP existente (inclusiv „din altă org → 404”)
# rămân verzi — pentru admin/org_admin cu org_id comportamentul e neschimbat ($1=org).
```

- old_str: `  "version": "3.9.731",`
- new_str: `  "version": "3.9.732",`

```bash
git add server/routes/alop.mjs server/tests/integration/alop.test.mjs package.json
git status --short          # exact 3 intrări
git commit -m "#105g: lockout ALOP → filtru org null-tolerant la cei 3 apelanți (dormant la o org) (v3.9.732)"
git push origin develop
```

---

## RAPORT FINAL (completează)

- Import isPlatformAdmin în alop.mjs: da/nu
- Cei 3 apelanți comutați la `params=[isPlatformAdmin?null:orgId]` + `($1::int IS NULL OR a.org_id...=$1)`: da/nu
- grep PAS 5: zero `a.org_id=$1` fără paranteza null-tolerant: da/nu
- node --check pe alop.mjs + fișierul de test: OK
- 3 cazuri noi trec; testele ALOP existente rămân verzi: da/nu
- npm test: PASSED (nr. fișiere/teste)
- Ai ajustat app-ul de test (PAS 6): ______
- Bump 3.9.731 → 3.9.732: da/nu
- Commit (hash): ______  Push origin/develop (range): ______
- Abateri/surprize: ______

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ Branch `develop`. Push DOAR `origin develop`. NICIODATĂ `main`.
- ⛔ Atingi DOAR: `routes/alop.mjs` (import + 3 apelanți + CTE where), `alop.test.mjs`, `package.json`.
- ⛔ NU reindexa parametri. `$1` rămâne org peste tot. NU atinge `$2..$9` din alte handlere.
- ⛔ NU modifica `buildAlopVisibilityWhere` (întoarce deja '' pentru admin — corect).
- ⛔ NU modifica `authz-scope.mjs`. NU atinge write guards (vin în #105h). Zona NO-TOUCH neatinsă.
- ⛔ Orice `old_str` care nu se potrivește (whitespace): NU forța, raportează linia reală.
